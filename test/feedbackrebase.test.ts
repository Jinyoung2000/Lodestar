import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const root = realpathSync(mkdtempSync(join(tmpdir(), "fbrebase-")));
process.env.AGENT_NAV_HOME = join(root, "home");

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed++;
};

const { FeedbackRunner } = await import("../server/feedback");
const { feedbackBadge } = await import("../web/feedbackBadge");
type Runner = InstanceType<typeof FeedbackRunner>;

const VERIFY = `import { mkdirSync, writeFileSync } from "node:fs";
mkdirSync("dist", { recursive: true });
writeFileSync("dist/index.html", "built");
`;

const styles = (over: Record<number, string> = {}) => Array.from({ length: 20 }, (_, i) => over[i + 1] ?? `l${i + 1}`).join("\n") + "\n";

const other = (over: Record<number, string> = {}) => Array.from({ length: 20 }, (_, i) => over[i + 1] ?? `o${i + 1}`).join("\n") + "\n";

function sourceRepo(name: string) {
  const dir = join(root, name);
  const put = (rel: string, text: string) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  };
  mkdirSync(dir, { recursive: true });
  put("verify.mjs", VERIFY);
  put("web/styles.css", styles());
  put("web/other.txt", other());
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return { dir, put, read: (rel: string) => readFileSync(join(dir, rel), "utf8") };
}

type Sent = { prompt: string; display: string | undefined };
type Item = { id: string; text: string; detail?: string };

function harness(src: string, opts: { reapplies?: number; onSend?: (n: number, prompt: string, worktree: string) => void } = {}) {
  const items: Item[] = [];
  const sent: Sent[] = [];
  const statuses: string[] = [];
  const holder: { runner: Runner | null; worktree: string; agentId: string } = { runner: null, worktree: "", agentId: "" };
  let counter = 0;
  const agents = {
    adopt: () => undefined,
    send: async (_id: string, prompt: string, options: { display?: string } = {}) => {
      if (!holder.worktree) return { queued: false };
      sent.push({ prompt, display: options.display });
      opts.onSend?.(sent.length, prompt, holder.worktree);
      setTimeout(() => holder.runner?.afterTurn(holder.agentId), 100);
      return { queued: false };
    },
    notice: (_agentId: string, text: string, detail?: string, _fold?: unknown, id?: string) => {
      const itemId = id ?? `n${++counter}`;
      const item: Item = { id: itemId, text, ...(detail ? { detail } : {}) };
      const at = items.findIndex((i) => i.id === itemId);
      if (at === -1) items.push(item);
      else items[at] = item;
      return itemId;
    },
  };
  const store = { settings: { feedbackModel: "haiku" }, addWorkspace: () => ({ id: "w" }), workspaces: [], agent: () => ({ status: "idle" }), timeline: () => [] };
  const runner = new FeedbackRunner({
    store: store as never,
    agents: agents as never,
    emit: (event) => {
      const feedback = (event as { feedback?: { status: string; reapplying?: boolean } }).feedback;
      const label = feedback ? `${feedback.status}${feedback.reapplying ? "*" : ""}` : null;
      if (label && statuses[statuses.length - 1] !== label) statuses.push(label);
    },
    srcRoot: src,
    port: 0,
    restart: () => undefined,
    busyCount: () => 0,
    checks: [{ name: "verify", command: "node", args: ["verify.mjs"], timeoutMs: 30_000 }],
    autoFixes: 0,
    applyRetryWaitMs: 20,
    ...(opts.reapplies !== undefined ? { reapplies: opts.reapplies } : {}),
  });
  holder.runner = runner;
  const create = async () => {
    const feedback = await runner.create({ text: "change the styles", element: null, screenshot: null, screenshotNote: null });
    holder.worktree = feedback.worktree;
    holder.agentId = feedback.agentId;
    return feedback;
  };
  return { runner, items, sent, statuses, create, holder };
}

async function settled(runner: Runner, id: string) {
  for (let i = 0; i < 800; i++) {
    const status = runner.get(id).status;
    if (status !== "running" && status !== "checking" && status !== "fixing") return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out at ${runner.get(id).status}`);
}

const setLines = (worktree: string, over: Record<number, string>) => writeFileSync(join(worktree, "web/styles.css"), styles(over));
const readWorktree = (worktree: string) => readFileSync(join(worktree, "web/styles.css"), "utf8");

async function userTurn(runner: Runner, agentId: string, text: string, work: () => void) {
  const modelPrompt = await runner.beforeTurn(agentId, text);
  runner.turnStarted(agentId);
  work();
  runner.afterTurn(agentId);
  return modelPrompt;
}

{
  const src = sourceRepo("src1");
  const h = harness(src.dir, { reapplies: 0 });
  const fb = await h.create();
  src.put("web/styles.css", styles({ 3: "main-l3", 15: "main-l15" }));
  setLines(fb.worktree, { 3: "fb1-l3" });
  h.runner.afterTurn(fb.agentId);
  await settled(h.runner, fb.id);
  check("control: the first turn fails on the same lines", h.runner.get(fb.id).status === "failed" && (h.runner.get(fb.id).failure ?? "").includes("both changed the same lines"));

  src.put("web/styles.css", styles({ 3: "main-l3+fb1", 15: "main-l15" }));
  h.runner.resolve(fb.id);
  check("resolved by hand", h.runner.get(fb.id).status === "resolved");

  setLines(fb.worktree, { 3: "fb1-l3", 5: "fb2-l5" });
  h.runner.afterTurn(fb.agentId);
  await settled(h.runner, fb.id);
  check("control: continuing without the rebase fails again with the same conflict", h.runner.get(fb.id).status === "failed" && (h.runner.get(fb.id).failure ?? "").includes("web/styles.css (both changed the same lines)"), h.runner.get(fb.id).failure ?? "");
}

{
  const src = sourceRepo("src2");
  const h = harness(src.dir, { reapplies: 0 });
  const fb = await h.create();
  src.put("web/styles.css", styles({ 3: "main-l3", 15: "main-l15" }));
  setLines(fb.worktree, { 3: "fb1-l3" });
  h.runner.afterTurn(fb.agentId);
  await settled(h.runner, fb.id);
  const handLanded = styles({ 3: "main-l3+fb1", 15: "main-l15" });
  src.put("web/styles.css", handLanded);
  h.runner.resolve(fb.id);

  const modelPrompt = await userTurn(h.runner, fb.agentId, "1. 누르고 shift엔터누르니깐 문제가 생기네", () => {
    check("the working copy took the main folder's file before the model read anything", readWorktree(fb.worktree) === handLanded);
    setLines(fb.worktree, { 3: "main-l3+fb1", 5: "fb2-l5", 15: "main-l15" });
  });
  check("a resolved feedback runs again while the new turn works", h.runner.get(fb.id).status === "checking" || h.runner.get(fb.id).status === "running");
  check("the model prompt names the file and says it was handled by hand", modelPrompt.includes("web/styles.css") && modelPrompt.includes("already handled by hand") && modelPrompt.endsWith("1. 누르고 shift엔터누르니깐 문제가 생기네"), modelPrompt);
  check("the old version of the file is kept for reference", existsSync(join(root, "home", "feedback", fb.id, "dropped/web/styles.css")) && readFileSync(join(root, "home", "feedback", fb.id, "dropped/web/styles.css"), "utf8") === styles({ 3: "fb1-l3" }));
  check("the conversation gets one notice about the sync", h.items.some((i) => i.text.startsWith("Brought the working copy up to date")));
  await settled(h.runner, fb.id);
  const f = h.runner.get(fb.id);
  check("only the new turn's change is listed", f.status === "applied" && f.changedFiles.join() === "web/styles.css", `${f.status} ${f.failure ?? ""}`);
  check("main keeps the hand landing and gets the new line", src.read("web/styles.css") === styles({ 3: "main-l3+fb1", 5: "fb2-l5", 15: "main-l15" }));
  check("the baseline moved to the main folder's content", (await h.runner.original(fb.id, "web/styles.css")) === handLanded);
}

{
  const src = sourceRepo("src2b");
  const h = harness(src.dir, { reapplies: 0 });
  const fb = await h.create();
  setLines(fb.worktree, { 3: "fb-change" });
  h.runner.afterTurn(fb.agentId);
  await settled(h.runner, fb.id);
  const landed = styles({ 8: "fb-change (by hand)" });
  src.put("web/styles.css", landed);
  (h.runner as unknown as { fail: (f: unknown, m: string) => void }).fail(h.runner.get(fb.id), "Not applied: something");
  h.runner.resolve(fb.id);
  const modelPrompt = await h.runner.beforeTurn(fb.agentId, "again");
  check("resolved: the main folder wins, the change is not merged in twice", readWorktree(fb.worktree) === landed && modelPrompt.includes("web/styles.css"), readWorktree(fb.worktree));
}

{
  const src = sourceRepo("src3");
  const h = harness(src.dir, { reapplies: 0 });
  const fb = await h.create();
  src.put("web/styles.css", styles({ 3: "main-l3", 15: "main-l15" }));
  src.put("web/other.txt", other({ 15: "main-o15" }));
  setLines(fb.worktree, { 3: "fb1-l3" });
  writeFileSync(join(fb.worktree, "web/other.txt"), other({ 3: "fb-o3" }));
  h.runner.afterTurn(fb.agentId);
  await settled(h.runner, fb.id);
  check("setup: failed on the conflict", h.runner.get(fb.id).status === "failed");

  const modelPrompt = await h.runner.beforeTurn(fb.agentId, "continue please");
  check("the conflicting file took the main folder's content", readWorktree(fb.worktree) === styles({ 3: "main-l3", 15: "main-l15" }));
  check("the prompt says the main folder changed the same places and does not claim a hand landing", modelPrompt.includes("changed in the same places") && !modelPrompt.includes("handled by hand"));
  check("the file that merges cleanly keeps both sides", readFileSync(join(fb.worktree, "web/other.txt"), "utf8") === other({ 3: "fb-o3", 15: "main-o15" }));
  check("the clean file is not listed as replaced", !modelPrompt.includes("web/other.txt"));
  h.runner.turnStarted(fb.agentId);
  setLines(fb.worktree, { 3: "main-l3+fb", 15: "main-l15" });
  h.runner.afterTurn(fb.agentId);
  await settled(h.runner, fb.id);
  check("after the model re-applies on top, it applies", h.runner.get(fb.id).status === "applied" && src.read("web/styles.css") === styles({ 3: "main-l3+fb", 15: "main-l15" }), h.runner.get(fb.id).failure ?? "");
}

{
  const src = sourceRepo("src3b");
  const h = harness(src.dir, { reapplies: 0 });
  const fb = await h.create();
  src.put("web/styles.css", styles({ 3: "main-l3" }));
  setLines(fb.worktree, { 3: "fb1-l3" });
  check("a running feedback is left alone", (await h.runner.beforeTurn(fb.agentId, "hi")) === "hi" && readWorktree(fb.worktree) === styles({ 3: "fb1-l3" }));
  h.runner.afterTurn(fb.agentId);
  await settled(h.runner, fb.id);
  const manual = styles({ 3: "fb1-l3" });
  src.put("web/styles.css", manual);
  (h.runner as unknown as { set: (f: unknown, p: unknown) => void }).set(h.runner.get(fb.id), { status: "applied" });
  src.put("web/styles.css", styles({ 3: "fb1-l3", 15: "main-l15" }));
  check("an applied feedback is left alone", (await h.runner.beforeTurn(fb.agentId, "hi")) === "hi" && readWorktree(fb.worktree) === styles({ 3: "fb1-l3" }));
}

{
  const src = sourceRepo("src4");
  const h = harness(src.dir, {
    onSend: (_n, prompt, worktree) => {
      check("the re-apply turn finds the main folder's file in the working copy", readFileSync(join(worktree, "web/styles.css"), "utf8") === styles({ 3: "main-l3", 15: "main-l15" }));
      check("the prompt names the file, the reason and the diff of its own change", prompt.includes("web/styles.css (both changed the same lines)") && prompt.includes("-l3") && prompt.includes("+fb-l3") && prompt.includes("dropped"), prompt);
      writeFileSync(join(worktree, "web/styles.css"), styles({ 3: "main-l3+fb", 15: "main-l15" }));
    },
  });
  const fb = await h.create();
  src.put("web/styles.css", styles({ 3: "main-l3", 15: "main-l15" }));
  setLines(fb.worktree, { 3: "fb-l3" });
  h.runner.afterTurn(fb.agentId);
  for (let i = 0; i < 100 && h.sent.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
  const during = h.runner.get(fb.id);
  check("while it re-applies the feedback is fixing, marked reapplying, and the badge says Re-applying", during.status === "fixing" && during.reapplying === true && feedbackBadge(during)?.label === "Re-applying", `${during.status} ${during.reapplying}`);
  await settled(h.runner, fb.id);
  const f = h.runner.get(fb.id);
  check("one re-apply turn, then applied", f.status === "applied" && h.sent.length === 1 && f.reapplyTries === 1, `${f.status} sent=${h.sent.length} tries=${f.reapplyTries} ${f.failure ?? ""}`);
  check("the turn's screen text says it is a re-apply", /^The main folder changed and your edits collided with it\. Apply them again on top of it \(1 of 2\)$/.test(h.sent[0]?.display ?? ""), h.sent[0]?.display ?? "");
  check("main has the main folder's edit and the re-applied change", src.read("web/styles.css") === styles({ 3: "main-l3+fb", 15: "main-l15" }));
  check("the conversation says it is re-applying, and no Not applied was posted", h.items.some((i) => i.text.startsWith("The main folder changed under this feedback's edits")) && !h.items.some((i) => i.text.startsWith("Not applied")));
  check("the flag is gone once checks start again", f.reapplying === false && h.statuses.includes("fixing*") && !h.statuses.slice(h.statuses.indexOf("fixing*") + 1).includes("fixing*"));
}

{
  const src = sourceRepo("src5");
  const h = harness(src.dir, {
    onSend: (n, _prompt, worktree) => {
      src.put("web/styles.css", styles({ 3: `main-v${n + 1}` }));
      setLines(worktree, { 3: `fb-v${n}` });
    },
  });
  const fb = await h.create();
  src.put("web/styles.css", styles({ 3: "main-v1" }));
  setLines(fb.worktree, { 3: "fb-v0" });
  h.runner.afterTurn(fb.agentId);
  await settled(h.runner, fb.id);
  const f = h.runner.get(fb.id);
  check("two re-apply turns were sent, then it failed", f.status === "failed" && h.sent.length === 2 && f.reapplyTries === 2, `${f.status} sent=${h.sent.length} tries=${f.reapplyTries}`);
  check("it fails as a conflict, so the button reads Merge Again", f.conflict === true && f.checks.length === 1 && !f.checks[0].ok && (f.failure ?? "").includes("web/styles.css (both changed the same lines)"), f.failure ?? "");
  check("the main folder is untouched by the failure", src.read("web/styles.css") === styles({ 3: "main-v3" }));
  check("the second turn said 2 of 2", (h.sent[1]?.display ?? "").endsWith("(2 of 2)"));
  const failures = h.items.filter((i) => i.text.startsWith("Not applied"));
  check("one failure notice", failures.length === 1, String(failures.length));
}

{
  const src = sourceRepo("src5b");
  src.put("web/bin.dat", "x");
  writeFileSync(join(src.dir, "web/bin.dat"), Buffer.from([1, 0, 2, 3]));
  const h = harness(src.dir);
  const fb = await h.create();
  writeFileSync(join(src.dir, "web/bin.dat"), Buffer.from([1, 0, 9, 9]));
  writeFileSync(join(fb.worktree, "web/bin.dat"), Buffer.from([1, 0, 7, 7]));
  h.runner.afterTurn(fb.agentId);
  await settled(h.runner, fb.id);
  check("a binary conflict is not sent back to the session", h.runner.get(fb.id).status === "failed" && h.sent.length === 0 && [...readFileSync(join(h.runner.get(fb.id).worktree, "web/bin.dat"))].join() === "1,0,7,7");
}

{
  const src = sourceRepo("src6");
  const h = harness(src.dir, {
    onSend: (n, _prompt, worktree) => {
      src.put("web/styles.css", styles({ 3: `main-again${n}` }));
      setLines(worktree, { 3: `fb-again${n}` });
    },
  });
  const fb = await h.create();
  src.put("web/styles.css", styles({ 3: "main-l3" }));
  setLines(fb.worktree, { 3: "fb-l3" });
  h.runner.afterTurn(fb.agentId);
  await settled(h.runner, fb.id);
  check("setup: it used its two re-applies", h.runner.get(fb.id).reapplyTries === 2 && h.runner.get(fb.id).status === "failed");
  await userTurn(h.runner, fb.agentId, "try again", () => undefined);
  check("a turn the user sent starts the count over", h.runner.get(fb.id).reapplyTries === 0, `tries=${h.runner.get(fb.id).reapplyTries}`);
  await settled(h.runner, fb.id);
}

{
  const src = sourceRepo("src7");
  const h = harness(src.dir, { reapplies: 0 });
  const fb = await h.create();
  src.put("web/styles.css", styles({ 3: "main-l3" }));
  setLines(fb.worktree, { 3: "fb-l3" });
  h.runner.afterTurn(fb.agentId);
  await settled(h.runner, fb.id);
  const notApplied = () => h.items.filter((i) => i.text.startsWith("Not applied"));
  check("first failure: one notice", notApplied().length === 1);
  h.runner.markSeen(fb.id);

  for (const line of ["fb-2", "fb-3"]) {
    h.runner.turnStarted(fb.agentId);
    setLines(fb.worktree, { 3: line });
    h.runner.afterTurn(fb.agentId);
    await settled(h.runner, fb.id);
  }
  check("two more turns with the same reason: still one notice", notApplied().length === 1, String(notApplied().length));
  check("a failure the user already saw does not pop up again", h.runner.get(fb.id).seen === true);
  check("the card still shows the failure", h.runner.get(fb.id).status === "failed" && (h.runner.get(fb.id).failure ?? "").includes("both changed the same lines"));

  src.put("web/other.txt", other({ 5: "main-o5" }));
  writeFileSync(join(fb.worktree, "web/other.txt"), other({ 5: "fb-o5" }));
  h.runner.afterTurn(fb.agentId);
  await settled(h.runner, fb.id);
  check("a different reason adds a new notice", notApplied().length === 2, String(notApplied().length));

  const before = notApplied().length;
  h.runner.resolve(fb.id);
  h.runner.turnStarted(fb.agentId);
  h.runner.afterTurn(fb.agentId);
  await settled(h.runner, fb.id);
  check("after it was resolved, the same reason is a new failure again", notApplied().length === before + 1, `${before} -> ${notApplied().length}`);
}

rmSync(root, { recursive: true, force: true });
if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("all passed");
