import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const root = realpathSync(mkdtempSync(join(tmpdir(), "fbfix-")));
process.env.AGENT_NAV_HOME = join(root, "home");

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed++;
};

const { FeedbackRunner } = await import("../server/feedback");
type Runner = InstanceType<typeof FeedbackRunner>;

const VERIFY = `import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
const bad = readFileSync("test/data.txt", "utf8").trim() !== "ok";
mkdirSync("dist", { recursive: true });
writeFileSync("dist/index.html", "built");
if (bad && (existsSync("test/always.txt") || readFileSync("web/ui.txt", "utf8") === "after\\n")) {
  console.error("data is broken");
  process.exit(1);
}
`;

function sourceRepo(name: string, always: boolean) {
  const dir = join(root, name);
  const put = (rel: string, text: string) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  };
  mkdirSync(dir, { recursive: true });
  put("verify.mjs", VERIFY);
  put("test/data.txt", "broken");
  put("web/ui.txt", "before\n");
  if (always) put("test/always.txt", "1");
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

function harness(src: string, fixesOn: number) {
  const notices: string[] = [];
  const sent: { prompt: string; display: string | undefined }[] = [];
  const statuses: string[] = [];
  const holder: { runner: Runner | null; worktree: string; agentId: string } = { runner: null, worktree: "", agentId: "" };
  const agents = {
    adopt: () => undefined,
    send: async (_id: string, prompt: string, options: { display?: string } = {}) => {
      if (!holder.worktree) return { queued: false };
      sent.push({ prompt, display: options.display });
      if (sent.length === fixesOn) writeFileSync(join(holder.worktree, "test/data.txt"), "ok");
      setTimeout(() => holder.runner?.afterTurn(holder.agentId), 100);
      return { queued: false };
    },
    notice: (_id: string, text: string) => void notices.push(text),
  };
  const store = { settings: { feedbackModel: "haiku" }, addWorkspace: () => ({ id: "w" }), workspaces: [], agent: () => ({ status: "idle" }), timeline: () => [] };
  const runner = new FeedbackRunner({
    store: store as never,
    agents: agents as never,
    emit: (event) => {
      const feedback = (event as { feedback?: { status: string } }).feedback;
      if (feedback && statuses[statuses.length - 1] !== feedback.status) statuses.push(feedback.status);
    },
    srcRoot: src,
    port: 0,
    restart: () => undefined,
    busyCount: () => 0,
    autoFixes: 2,
    checks: [{ name: "verify", command: "node", args: ["verify.mjs"], timeoutMs: 30_000 }],
  });
  holder.runner = runner;
  return { runner, notices, sent, statuses, holder };
}

async function until(runner: Runner, id: string, done: (status: string) => boolean) {
  for (let i = 0; i < 600; i++) {
    if (done(runner.get(id).status)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out at ${runner.get(id).status}`);
}

async function start(h: ReturnType<typeof harness>) {
  const feedback = await h.runner.create({ text: "change the ui text", element: null, screenshot: null, screenshotNote: null });
  h.holder.worktree = feedback.worktree;
  h.holder.agentId = feedback.agentId;
  writeFileSync(join(feedback.worktree, "web/ui.txt"), "after\n");
  h.runner.afterTurn(feedback.agentId);
  return feedback.id;
}

{
  const src = sourceRepo("fix-once", false);
  const h = harness(src, 1);
  const id = await start(h);
  await until(h.runner, id, (s) => s === "applied" || s === "failed");
  const done = h.runner.get(id);
  check("new failure: fixed by the follow-up turn and applied", done.status === "applied" && done.checks.every((c) => c.ok), `${done.status} ${done.failure ?? ""}`);
  check("one follow-up message was sent", h.sent.length === 1);
  check("the message names the check, the new failure and the output", h.sent[0].prompt.includes('"verify"') && h.sent[0].prompt.includes("New failures:") && h.sent[0].prompt.includes("data is broken"));
  check("the message forbids weakening the test", h.sent[0].prompt.includes("Do not delete a test") && h.sent[0].prompt.includes("Test files are read-only"));
  check("the chat shows a short line, not the whole prompt", (h.sent[0].display ?? "").startsWith("verify failed because of your changes") && !(h.sent[0].display ?? "").includes("New failures"));
  check("status goes checking, fixing, checking, applied", h.statuses.filter((s) => ["checking", "fixing", "applied"].includes(s)).join(",") === "checking,fixing,checking,applied", h.statuses.join(","));
  check("the attempt is counted on the feedback", done.fixAttempts === 1);
  check("a notice says the session is fixing it", h.notices.some((n) => n.includes("is fixing it (1 of 2)")));
  check("main folder got the fix", readFileSync(join(src, "test/data.txt"), "utf8") === "ok" && readFileSync(join(src, "web/ui.txt"), "utf8") === "after\n");
}

{
  const src = sourceRepo("fix-never", false);
  const h = harness(src, 0);
  const id = await start(h);
  await until(h.runner, id, (s) => s === "failed");
  const done = h.runner.get(id);
  check("still failing after two fixes: Not applied", done.status === "failed" && done.checks.some((c) => !c.ok));
  check("exactly two follow-up messages", h.sent.length === 2 && done.fixAttempts === 2);
  check("the failure says it tried to fix twice", (done.failure ?? "").split("\n")[0] === "Not applied: verify failed. Tried to fix 2 times", done.failure ?? "");
  check("the second message says it is the second", h.sent[1].prompt.includes("automatic fix 2 of 2"));
  check("main folder is untouched", readFileSync(join(src, "web/ui.txt"), "utf8") === "before\n");
  h.runner.retryChecks(id);
  await until(h.runner, id, (s) => s === "failed");
  check("Retry starts counting again: two more follow-ups", h.sent.length === 4 && h.runner.get(id).fixAttempts === 2);
}

{
  const src = sourceRepo("fix-twice", false);
  const h = harness(src, 2);
  const id = await start(h);
  await until(h.runner, id, (s) => s === "applied" || s === "failed");
  check("fixed on the second try: applied after two follow-ups", h.runner.get(id).status === "applied" && h.sent.length === 2);
}

{
  const src = sourceRepo("pre-existing", true);
  const h = harness(src, 1);
  const id = await start(h);
  await until(h.runner, id, (s) => s === "applied" || s === "failed");
  const done = h.runner.get(id);
  check("pre-existing failure only: applied, nothing sent to the session", done.status === "applied" && h.sent.length === 0, `${done.status} sent=${h.sent.length} ${done.failure}`);
  check("the failure is marked ignored", done.checks.some((c) => c.ignored === 1));
}

{
  const src = sourceRepo("lane", false);
  const log = join(root, "lane.log");
  writeFileSync(join(src, "verify.mjs"), `import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
appendFileSync(${JSON.stringify(log)}, "start\\n");
await new Promise((r) => setTimeout(r, 400));
mkdirSync("dist", { recursive: true });
writeFileSync("dist/index.html", "built");
appendFileSync(${JSON.stringify(log)}, "end\\n");
`);
  const h = harness(src, 1);
  const a = await h.runner.create({ text: "first", element: null, screenshot: null, screenshotNote: null });
  const b = await h.runner.create({ text: "second", element: null, screenshot: null, screenshotNote: null });
  writeFileSync(join(a.worktree, "web/ui.txt"), "from a\n");
  writeFileSync(join(b.worktree, "web/other.txt"), "from b\n");
  h.runner.afterTurn(a.agentId);
  h.runner.afterTurn(b.agentId);
  await until(h.runner, a.id, (s) => s === "applied" || s === "failed");
  await until(h.runner, b.id, (s) => s === "applied" || s === "failed");
  check("both feedbacks finished", h.runner.get(a.id).status === "applied" && h.runner.get(b.id).status === "applied", `${h.runner.get(a.id).status} ${h.runner.get(b.id).status}`);
  check("checks ran one at a time", readFileSync(log, "utf8").trim().split("\n").join(",") === "start,end,start,end");
}

rmSync(root, { recursive: true, force: true });
if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("all passed");
