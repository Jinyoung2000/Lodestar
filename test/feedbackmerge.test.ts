// FBMERGE: 피드백과 본 작업 폴더가 같은 파일을 둘 다 고쳤을 때 3-way 병합으로 합쳐 반영하는 흐름 단독 시험(임시 git 저장소와 임시 홈, 모델 호출 없음).
// 실행: npm test
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

// 검사 스크립트(루트에 한 벌, worktree 안에서 돈다): 검사가 본 styles.css 를 <repo>.seen 에 남기고,
// <repo>.hook.json 이 있으면 검사 도중 다른 에이전트가 본 작업 폴더를 고치는 것처럼 파일을 쓴다. always 면 매번(n 을 올리며), 아니면 한 번.
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

// l1..l20 한 줄씩. over 로 몇 줄만 바꾼다.
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

// 피드백을 만들고, 개선 세션이 worktree 를 고친 것처럼 edit 한 뒤 턴이 끝난 상태까지 돌린다. main 은 피드백이 시작된 뒤 본 작업 폴더에서 일어난 변경.
async function runFeedback(runner: Runner, main: () => void, edit: (worktree: string) => void) {
  const feedback = await runner.create({ text: "change the styles", element: null, screenshot: null, screenshotNote: null });
  main();
  edit(feedback.worktree);
  runner.afterTurn(feedback.agentId);
  await settled(runner, feedback.id);
  return feedback.id;
}

const setLines = (worktree: string, over: Record<number, string>) => writeFileSync(join(worktree, "web/styles.css"), styles(over));

// 1. 같은 파일의 다른 줄: 병합되고, 검사가 양쪽 변경을 본 채로 통과해 반영된다.
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

// 2. 병합 반영 뒤 revert: 반영 직전 본 작업 폴더의 파일로 돌아간다(본 작업 폴더의 변경은 남고 피드백 변경만 빠진다).
{
  const { src, runner, id } = applied;
  await runner.revert(id);
  check("revert after a merged apply restores the main folder's own version", runner.get(id).status === "reverted" && src.read("web/styles.css") === styles({ 15: "main-l15" }));
}

// 3. 같은 줄: 충돌로 실패, 본 작업 폴더 파일은 그대로. 그 사이 본 작업 폴더가 충돌 줄을 되돌리면 Retry 로 반영된다.
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

// 4. 검사와 반영 사이에 본 작업 폴더가 또 바뀌면 자동으로 sync + 병합 + 검사를 한 번 더 돌고 반영한다.
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

// 4b. 검사 도중 본 작업 폴더의 다른 줄이 두 번 바뀌어도(줄이 겹치지 않는 경쟁) 세 번째 시도에서 반영된다. 실패 카드를 거치지 않는다.
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

// 5. 세 번 시도해도 또 바뀌면 실패하고(Merge Again), 바뀌는 게 멈춘 뒤 다시 병합하면 반영된다.
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

// 5b. 반영 뒤 만든 다음 피드백은 반영된 파일을 기준으로 시작한다: 두 피드백이 같은 파일을 순서대로 반영한다.
{
  const src = sourceRepo("src5b");
  const { runner } = harness(src.dir);
  const first = await runFeedback(runner, () => undefined, (w) => setLines(w, { 3: "fb1-l3" }));
  const second = await runFeedback(runner, () => undefined, (w) => setLines(w, { 3: "fb1-l3", 18: "fb2-l18" }));
  check("two feedbacks on one file apply in order", runner.get(first).status === "applied" && runner.get(second).status === "applied" && src.read("web/styles.css") === styles({ 3: "fb1-l3", 18: "fb2-l18" }), `${runner.get(first).status} ${runner.get(first).failure ?? ""} / ${runner.get(second).status} ${runner.get(second).failure ?? ""}`);
}

// 6. 합치지 않는 경우(바이너리, 양쪽 새 파일, 한쪽 삭제)는 파일을 그대로 두고 이유와 함께 실패한다.
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

// 7. 양쪽이 똑같이 고친 파일은 충돌이 아니라 그대로 합쳐지고, 반영 목록에는 피드백만의 변경이 남는다.
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
