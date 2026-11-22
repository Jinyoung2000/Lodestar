import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const root = realpathSync(mkdtempSync(join(tmpdir(), "fbmerge-")));
process.env.AGENT_NAV_HOME = join(root, "home");

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed++;
};

const { FeedbackRunner } = await import("../server/feedback");
const { canRetryChecks } = await import("../shared/feedbackRetry");
type Runner = InstanceType<typeof FeedbackRunner>;

const HOOK = join(root, "hook.mjs");
writeFileSync(
  HOOK,
  `import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const dir = process.argv[2];
appendFileSync(dir + ".seen", readFileSync("web/styles.css", "utf8").replace(/\\n/g, "|") + "\\n");
const hookFile = dir + ".hook.json";
if (existsSync(hookFile)) {
  const hook = JSON.parse(readFileSync(hookFile, "utf8"));
  const n = (hook.count ?? 0) + 1;
  for (const [rel, text] of Object.entries(hook.writes)) writeFileSync(join(dir, rel), text.replace("{n}", String(n)));
  if (hook.always && n < (hook.times ?? Infinity)) writeFileSync(hookFile, JSON.stringify({ ...hook, count: n }));
  else rmSync(hookFile);
}
mkdirSync("dist", { recursive: true });
writeFileSync("dist/index.html", "built");
`,
);

const styles = (over: Record<number, string> = {}) => Array.from({ length: 20 }, (_, i) => over[i + 1] ?? `l${i + 1}`).join("\n") + "\n";

function sourceRepo(name: string, extra: Record<string, string | Buffer> = {}) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const put = (rel: string, text: string | Buffer) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  };
  put("web/styles.css", styles());
  put("web/other.txt", "other\n");
  for (const [rel, text] of Object.entries(extra)) put(rel, text);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return {
    dir,
    put,
    read: (rel: string) => readFileSync(join(dir, rel), "utf8"),
    seen: () => (existsSync(`${dir}.seen`) ? readFileSync(`${dir}.seen`, "utf8").split("\n").filter(Boolean) : []),
    hook: (writes: Record<string, string>, always = false, times?: number) => writeFileSync(`${dir}.hook.json`, JSON.stringify({ writes, always, times })),
    clearHook: () => rmSync(`${dir}.hook.json`, { force: true }),
  };
}

function harness(src: string) {
  const notices: string[] = [];
  const agents = { adopt: () => undefined, send: async () => undefined, notice: (_id: string, text: string) => void notices.push(text) };
  const store = { settings: { feedbackModel: "haiku" }, addWorkspace: () => ({ id: "w" }), workspaces: [], agent: () => ({ status: "idle" }), timeline: () => [] };
  const runner = new FeedbackRunner({
    store: store as never,
    agents: agents as never,
    emit: () => undefined,
    srcRoot: src,
    port: 0,
    restart: () => undefined,
    busyCount: () => 0,
    checks: [{ name: "verify", command: "node", args: [HOOK, src], timeoutMs: 30_000 }],
    autoFixes: 0,
    reapplies: 0,
    applyRetryWaitMs: 20,
  });
  return { runner, notices };
}

async function settled(runner: Runner, id: string) {
  for (let i = 0; i < 800; i++) {
    const status = runner.get(id).status;
    if (status !== "running" && status !== "checking") return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out at ${runner.get(id).status}`);
}

async function runFeedback(runner: Runner, main: () => void, edit: (worktree: string) => void) {
  const feedback = await runner.create({ text: "change the styles", element: null, screenshot: null, screenshotNote: null });
  main();
  edit(feedback.worktree);
  runner.afterTurn(feedback.agentId);
  await settled(runner, feedback.id);
  return feedback.id;
}

const setLines = (worktree: string, over: Record<number, string>) => writeFileSync(join(worktree, "web/styles.css"), styles(over));

let applied: { src: ReturnType<typeof sourceRepo>; runner: Runner; id: string };
{
  const src = sourceRepo("src1");
  const { runner } = harness(src.dir);
  const id = await runFeedback(runner, () => src.put("web/styles.css", styles({ 15: "main-l15" })), (w) => setLines(w, { 3: "fb-l3" }));
  const f = runner.get(id);
  check("different lines: applied", f.status === "applied" && f.checks.length === 1 && f.checks[0].ok, `${f.status} ${f.failure ?? ""}`);
  check("applied file has both changes", src.read("web/styles.css") === styles({ 3: "fb-l3", 15: "main-l15" }));
  check("the check saw the merged file", src.seen().length === 1 && src.seen()[0].includes("fb-l3") && src.seen()[0].includes("main-l15"));
  check("only the merged file is listed as changed", f.changedFiles.join() === "web/styles.css");
  check("dist from the merged tree is in the main folder", existsSync(join(src.dir, "dist/index.html")));
  applied = { src, runner, id };
}

{
  const { src, runner, id } = applied;
  await runner.revert(id);
  check("revert after a merged apply restores the main folder's own version", runner.get(id).status === "reverted" && src.read("web/styles.css") === styles({ 15: "main-l15" }));
}

{
  const src = sourceRepo("src3");
  const { runner } = harness(src.dir);
  const mainEdit = styles({ 3: "main-l3", 15: "main-l15" });
  const id = await runFeedback(runner, () => src.put("web/styles.css", mainEdit), (w) => setLines(w, { 3: "fb-l3" }));
  const f = runner.get(id);
  check("same line: failed with the file and the reason", f.status === "failed" && (f.failure ?? "").includes("web/styles.css (both changed the same lines)") && (f.failure ?? "").includes("changed in the main folder since the feedback started"), f.failure ?? "");
  check("same line: main folder file is untouched", src.read("web/styles.css") === mainEdit);
  check("same line: no check ran on a tree that cannot be applied", src.seen().length === 0 && f.checks.length === 1 && !f.checks[0].ok);
  check("same line: Retry is offered", canRetryChecks(f));
  check("same line: marked as a conflict, so the button reads Merge Again", f.conflict === true);

  const stillSame = runner.retryChecks(id);
  check("retry answers at once with checking state", stillSame.status === "checking" && stillSame.retrying === true);
  await settled(runner, id);
  check("retry while the conflict is still there fails again and keeps the file", runner.get(id).status === "failed" && src.read("web/styles.css") === mainEdit && canRetryChecks(runner.get(id)));

  src.put("web/styles.css", styles({ 15: "main-l15" }));
  runner.retryChecks(id);
  await settled(runner, id);
  check("retry after the main folder dropped the conflicting line applies", runner.get(id).status === "applied", runner.get(id).failure ?? "");
  check("the conflict mark is gone once it applied", runner.get(id).conflict === false);
  check("result has the feedback line and the main folder's other line", src.read("web/styles.css") === styles({ 3: "fb-l3", 15: "main-l15" }));
}

{
  const src = sourceRepo("src4");
  const { runner } = harness(src.dir);
  src.hook({ "web/styles.css": styles({ 15: "main-l15" }) });
  const id = await runFeedback(runner, () => undefined, (w) => setLines(w, { 3: "fb-l3" }));
  const f = runner.get(id);
  check("changed right before apply: applied after one automatic rerun", f.status === "applied", `${f.status} ${f.failure ?? ""}`);
  check("checks ran twice, the second saw the new main change", src.seen().length === 2 && !src.seen()[0].includes("main-l15") && src.seen()[1].includes("main-l15") && src.seen()[1].includes("fb-l3"));
  check("both changes are in the main folder", src.read("web/styles.css") === styles({ 3: "fb-l3", 15: "main-l15" }));
}

{
  const src = sourceRepo("src4b");
  const { runner } = harness(src.dir);
  src.hook({ "web/styles.css": styles({ 15: "main-edit-{n}" }) }, true, 2);
  const id = await runFeedback(runner, () => undefined, (w) => setLines(w, { 3: "fb-l3" }));
  const f = runner.get(id);
  check("changed during two checks: applied on the third attempt", f.status === "applied" && src.seen().length === 3, `${f.status} seen=${src.seen().length} ${f.failure ?? ""}`);
  check("the result keeps the latest main edit and the feedback line", src.read("web/styles.css") === styles({ 3: "fb-l3", 15: "main-edit-2" }));
  check("a race is not marked as a conflict", !f.conflict);
}

{
  const src = sourceRepo("src5");
  const { runner } = harness(src.dir);
  src.hook({ "web/styles.css": styles({ 15: "main-edit-{n}" }) }, true);
  const id = await runFeedback(runner, () => undefined, (w) => setLines(w, { 3: "fb-l3" }));
  const f = runner.get(id);
  check("changed on every attempt: failed after three runs", f.status === "failed" && src.seen().length === 3, `${f.status} seen=${src.seen().length}`);
  check("failure names the file and says it changed again", (f.failure ?? "").includes("changed in the main folder since the feedback started") && (f.failure ?? "").includes("web/styles.css (changed again in the main folder)"), f.failure ?? "");
  check("the main folder keeps its latest edit and nothing of the feedback", src.read("web/styles.css") === styles({ 15: "main-edit-3" }));
  check("Retry is offered after all checks passed", canRetryChecks(f) && f.checks.every((c) => c.ok));
  check("it is marked as a conflict (Merge Again)", f.conflict === true);
  src.clearHook();
  runner.retryChecks(id);
  await settled(runner, id);
  check("retry applies once the main folder stops changing", runner.get(id).status === "applied" && src.read("web/styles.css") === styles({ 3: "fb-l3", 15: "main-edit-3" }), runner.get(id).failure ?? "");
}

{
  const src = sourceRepo("src5b");
  const { runner } = harness(src.dir);
  const first = await runFeedback(runner, () => undefined, (w) => setLines(w, { 3: "fb1-l3" }));
  const second = await runFeedback(runner, () => undefined, (w) => setLines(w, { 3: "fb1-l3", 18: "fb2-l18" }));
  check("two feedbacks on one file apply in order", runner.get(first).status === "applied" && runner.get(second).status === "applied" && src.read("web/styles.css") === styles({ 3: "fb1-l3", 18: "fb2-l18" }), `${runner.get(first).status} ${runner.get(first).failure ?? ""} / ${runner.get(second).status} ${runner.get(second).failure ?? ""}`);
}

{
  const src = sourceRepo("src6", { "web/bin.dat": Buffer.from([1, 0, 2, 3]), "web/gone.txt": "gone\n", "web/dead.txt": "dead\n" });
  const { runner } = harness(src.dir);
  const id = await runFeedback(
    runner,
    () => {
      src.put("web/bin.dat", Buffer.from([1, 0, 9, 9]));
      src.put("web/new.txt", "main new\n");
      src.put("web/gone.txt", "gone, edited in main\n");
      rmSync(join(src.dir, "web/dead.txt"));
    },
    (w) => {
      writeFileSync(join(w, "web/bin.dat"), Buffer.from([1, 0, 7, 7]));
      writeFileSync(join(w, "web/new.txt"), "feedback new\n");
      rmSync(join(w, "web/gone.txt"));
      writeFileSync(join(w, "web/dead.txt"), "dead, edited by feedback\n");
    },
  );
  const f = runner.get(id);
  const failure = f.failure ?? "";
  check("unmergeable cases fail", f.status === "failed");
  check("binary", failure.includes("web/bin.dat (binary file changed in both)"));
  check("created in both", failure.includes("web/new.txt (created in both)"));
  check("deleted by the feedback, changed in main", failure.includes("web/gone.txt (deleted by the feedback, changed in the main folder)"));
  check("changed by the feedback, deleted in main", failure.includes("web/dead.txt (changed by the feedback, deleted in the main folder)"));
  check("main folder files are untouched", src.read("web/new.txt") === "main new\n" && src.read("web/gone.txt") === "gone, edited in main\n" && !existsSync(join(src.dir, "web/dead.txt")) && [...readFileSync(join(src.dir, "web/bin.dat"))].join() === "1,0,9,9");
}

{
  const src = sourceRepo("src7");
  const { runner } = harness(src.dir);
  const id = await runFeedback(
    runner,
    () => src.put("web/other.txt", "same edit\n"),
    (w) => {
      writeFileSync(join(w, "web/other.txt"), "same edit\n");
      setLines(w, { 3: "fb-l3" });
    },
  );
  const f = runner.get(id);
  check("identical edits on both sides apply", f.status === "applied" && f.changedFiles.join() === "web/styles.css" && src.read("web/other.txt") === "same edit\n" && src.read("web/styles.css") === styles({ 3: "fb-l3" }), f.failure ?? "");
}

rmSync(root, { recursive: true, force: true });
if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("all passed");
