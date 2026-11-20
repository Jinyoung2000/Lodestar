// FBRETRY: 검사에서 떨어진 피드백의 검사만 다시 돌려 반영하는 흐름 단독 시험(임시 git 저장소와 임시 홈, 모델 호출 없음).
// 실행: npm test
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const root = realpathSync(mkdtempSync(join(tmpdir(), "fbretry-")));
process.env.AGENT_NAV_HOME = join(root, "home");

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed++;
};

const { FeedbackRunner } = await import("../server/feedback");
const { canRetryChecks } = await import("../shared/feedbackRetry");
type Runner = InstanceType<typeof FeedbackRunner>;

const VERIFY = `import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
// 피드백이 ui.txt 를 고쳤을 때만 시험 데이터를 본다. 기준선(ui.txt 가 before)에서는 데이터가 깨져 있어도 통과해서, 이 실패는 피드백 탓이다.
if (readFileSync("web/ui.txt", "utf8") === "after\\n" && readFileSync("test/data.txt", "utf8").trim() !== "ok") {
  console.error("data is broken");
  process.exit(1);
}
mkdirSync("dist", { recursive: true });
writeFileSync("dist/index.html", "built");
`;

function sourceRepo(name: string, data: string) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const put = (rel: string, text: string) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  };
  put("verify.mjs", VERIFY);
  put("test/data.txt", data);
  put("web/ui.txt", "before\n");
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return { dir, put, read: (rel: string) => readFileSync(join(dir, rel), "utf8") };
}

function harness(src: string) {
  const notices: string[] = [];
  const events: { type: string }[] = [];
  let agentStatus = "idle";
  const agents = { adopt: () => undefined, send: async () => undefined, notice: (_id: string, text: string) => void notices.push(text) };
  const store = { settings: { feedbackModel: "haiku" }, addWorkspace: () => ({ id: "w" }), workspaces: [], agent: () => ({ status: agentStatus }), timeline: () => [] };
  const runner = new FeedbackRunner({
    store: store as never,
    agents: agents as never,
    emit: (event) => void events.push(event),
    srcRoot: src,
    port: 0,
    restart: () => undefined,
    busyCount: () => 0,
    checks: [{ name: "verify", command: "node", args: ["verify.mjs"], timeoutMs: 30_000 }],
    autoFixes: 0,
    reapplies: 0,
  });
  return { runner, notices, setAgentStatus: (s: string) => (agentStatus = s) };
}

async function until(runner: Runner, id: string, done: (status: string) => boolean) {
  for (let i = 0; i < 600; i++) {
    if (done(runner.get(id).status)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out at ${runner.get(id).status}`);
}

// 개선 세션이 web/ui.txt 를 고친 뒤 턴이 끝난 상태까지 만든다.
async function failedAtCheck(runner: Runner, edit: (worktree: string) => void) {
  const feedback = await runner.create({ text: "change the ui text", element: null, screenshot: null, screenshotNote: null });
  writeFileSync(join(feedback.worktree, "web/ui.txt"), "after\n");
  edit(feedback.worktree);
  runner.afterTurn(feedback.agentId);
  await until(runner, feedback.id, (s) => s === "failed");
  return feedback.id;
}

const rejects = (fn: () => unknown) => {
  try {
    fn();
    return null;
  } catch (error) {
    return (error as Error).message;
  }
};

// 1. 본 작업 폴더의 시험 데이터가 깨져 있어 떨어졌다가, 본 작업 폴더를 고친 뒤 Retry 로 반영된다.
{
  const src = sourceRepo("src1", "broken");
  const { runner, notices } = harness(src.dir);
  const id = await failedAtCheck(runner, () => undefined);
  const first = runner.get(id);
  check("failed at the check step", first.status === "failed" && first.checks.length === 1 && !first.checks[0].ok && (first.failure ?? "").includes("data is broken"));
  check("canRetryChecks is true for a check failure", canRetryChecks(first));
  check("main folder is untouched by the failed run", src.read("web/ui.txt") === "before\n");

  const again = await (async () => {
    const result = runner.retryChecks(id);
    await until(runner, id, (s) => s === "failed");
    return result;
  })();
  check("retry with the cause still there fails again with fresh checks", runner.get(id).checks.length === 1 && !runner.get(id).checks[0].ok && again.id === id);
  check("retrying flag is cleared after the run", runner.get(id).retrying === false);

  src.put("test/data.txt", "ok");
  const returned = runner.retryChecks(id);
  check("retry answers at once with checking state", returned.status === "checking" && returned.retrying === true && returned.checks.length === 0 && returned.failure === null);
  check("second retry while running is refused", rejects(() => runner.retryChecks(id)) !== null);
  await until(runner, id, (s) => s === "applied");
  const done = runner.get(id);
  check("retry applies once the cause is fixed", done.status === "applied" && done.retrying === false && done.checks.every((c) => c.ok));
  check("applied the feedback change to the main folder", src.read("web/ui.txt") === "after\n");
  check("the fix made in the main folder stays", src.read("test/data.txt") === "ok");
  check("main folder got the verified dist", existsSync(join(src.dir, "dist/index.html")));
  check("notices: retry start, then applied", notices.includes("Running the checks again") && notices.some((n) => n.startsWith("Applied:")));
  check("an applied feedback cannot be retried", rejects(() => runner.retryChecks(id)) !== null);
}

// 2. 원인을 worktree 안에서 고쳐도(개선 세션의 후속 수정) Retry 가 그 파일까지 반영한다.
{
  const src = sourceRepo("src2", "broken");
  const { runner } = harness(src.dir);
  const id = await failedAtCheck(runner, () => undefined);
  writeFileSync(join(runner.get(id).worktree, "test/data.txt"), "ok");
  runner.retryChecks(id);
  await until(runner, id, (s) => s === "applied");
  check("a fix made inside the worktree is applied with the feedback", src.read("test/data.txt") === "ok" && src.read("web/ui.txt") === "after\n");
}

// 3. 본 작업 폴더도 같은 줄을 고쳤으면 병합이 못 합쳐 충돌로 실패하지만, 검사를 한 번 돌린 피드백이라 Retry 대상이다.
{
  const src = sourceRepo("src3", "broken");
  const { runner } = harness(src.dir);
  const id = await failedAtCheck(runner, () => undefined);
  src.put("test/data.txt", "ok");
  src.put("web/ui.txt", "edited in main\n");
  runner.retryChecks(id);
  await until(runner, id, (s) => s === "failed");
  const f = runner.get(id);
  check("conflict: not applied and main keeps its own edit", f.status === "failed" && (f.failure ?? "").includes("web/ui.txt (both changed the same lines)") && src.read("web/ui.txt") === "edited in main\n");
  check("conflict can be retried once the main folder drops the edit", canRetryChecks(f));
  src.put("web/ui.txt", "before\n");
  runner.retryChecks(id);
  await until(runner, id, (s) => s === "applied");
  check("retry after the conflicting edit is gone applies", src.read("web/ui.txt") === "after\n" && src.read("test/data.txt") === "ok");
}

// 4. 거절: 검사 전에 멈춘 것, 세션이 아직 도는 것, worktree 가 없는 것.
{
  const src = sourceRepo("src4", "broken");
  const { runner, setAgentStatus } = harness(src.dir);
  const running = await runner.create({ text: "still running", element: null, screenshot: null, screenshotNote: null });
  check("running feedback is refused", (rejects(() => runner.retryChecks(running.id)) ?? "").includes("not applied"));
  const id = await failedAtCheck(runner, () => undefined);
  setAgentStatus("running");
  check("refused while the improvement session is running", (rejects(() => runner.retryChecks(id)) ?? "").includes("still running"));
  setAgentStatus("idle");
  const feedback = runner.get(id);
  feedback.checks = [];
  check("failed before any check ran: refused with the reason", (rejects(() => runner.retryChecks(id)) ?? "").includes("did not stop at a check"));
  feedback.checks = [{ name: "verify", ok: false, output: "x" }];
  rmSync(feedback.worktree, { recursive: true, force: true });
  check("worktree gone: refused with the reason", (rejects(() => runner.retryChecks(id)) ?? "").includes("worktree is gone"));
}

rmSync(root, { recursive: true, force: true });
if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("all passed");
