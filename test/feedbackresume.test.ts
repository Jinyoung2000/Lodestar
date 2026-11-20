// FBREDO: 데몬이 재시작될 때 돌고 있던 피드백을 이어 가는 흐름 단독 시험(임시 git 저장소와 임시 홈, 모델 호출 없음).
// 판단 함수(resumePlan, canRunAgain)와, 새 FeedbackRunner(= 재시작한 데몬)가 같은 홈의 state.json 을 읽고 resumeInterrupted 로 이어 가는 경로를 본다.
// 실행: npm test
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const root = realpathSync(mkdtempSync(join(tmpdir(), "fbresume-")));
process.env.AGENT_NAV_HOME = join(root, "home");

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed++;
};

const { FeedbackRunner } = await import("../server/feedback");
const { MAX_RESUMES, canRunAgain, isInterruptible, resumePlan } = await import("../shared/feedbackResume");
type Runner = InstanceType<typeof FeedbackRunner>;

// 1. 판단 함수
{
  const base = { status: "running" as const, resumeCount: 0, worktreeExists: true, baselineExists: true, agentExists: true, hasSession: true };
  check("running with a session record continues", resumePlan(base).action === "continue");
  check("fixing with a session record continues", resumePlan({ ...base, status: "fixing" }).action === "continue");
  check("checking needs no session record", resumePlan({ ...base, status: "checking", hasSession: false }).action === "recheck");
  const noSession = resumePlan({ ...base, hasSession: false });
  check("running without a session record gives up", noSession.action === "giveUp" && noSession.reason === "noSession");
  const noTree = resumePlan({ ...base, worktreeExists: false });
  check("a missing worktree gives up, even when checking", noTree.action === "giveUp" && noTree.reason === "noWorktree" && resumePlan({ ...base, status: "checking", worktreeExists: false }).action === "giveUp");
  check("a missing baseline gives up", resumePlan({ ...base, baselineExists: false }).action === "giveUp");
  const noAgent = resumePlan({ ...base, agentExists: false });
  check("a missing agent gives up", noAgent.action === "giveUp" && noAgent.reason === "noAgent");
  const many = resumePlan({ ...base, resumeCount: MAX_RESUMES });
  check(`after ${MAX_RESUMES} resumes it gives up`, many.action === "giveUp" && many.reason === "tooMany" && resumePlan({ ...base, resumeCount: MAX_RESUMES - 1 }).action === "continue");
  check("only running, checking and fixing are cut by a restart", (["running", "checking", "fixing"] as const).every(isInterruptible) && !(["applied", "failed", "needsInput", "noChanges", "awaitingRestart", "reverted"] as const).some(isInterruptible));
  check("Run Again only for a failed feedback the restart cut", canRunAgain({ status: "failed", interrupted: true }) && !canRunAgain({ status: "failed" }) && !canRunAgain({ status: "applied", interrupted: true }));
}

// 재시작 확인 창이 세는 것: 개선 세션은 세션 수에서 빼고 따로 센다. 검사 중인 피드백(세션은 쉼)도 잡힌다.
{
  const { runningWork } = await import("../shared/feedbackResume");
  const agents = [
    { status: "running" as const, feedbackId: null },
    { status: "waiting" as const, feedbackId: null },
    { status: "idle" as const, feedbackId: null },
    { status: "running" as const, feedbackId: "f1" },
    { status: "idle" as const, feedbackId: "f2" },
  ];
  const feedbacks = [{ status: "running" as const }, { status: "checking" as const }, { status: "fixing" as const }, { status: "applied" as const }, { status: "failed" as const }];
  const work = runningWork(agents, feedbacks);
  check("sessions: running and waiting ones, without improvement sessions", work.sessions === 2, JSON.stringify(work));
  check("improvements: running, checking and fixing, including one whose session is idle", work.improvements === 3, JSON.stringify(work));
  const quiet = runningWork([{ status: "idle", feedbackId: null }], [{ status: "applied" }, { status: "needsInput" }]);
  check("nothing running: nothing to warn about", quiet.sessions === 0 && quiet.improvements === 0);
}

const VERIFY = `import { mkdirSync, writeFileSync } from "node:fs";
mkdirSync("dist", { recursive: true });
writeFileSync("dist/index.html", "built");
`;

function sourceRepo(name: string) {
  const dir = join(root, name);
  const put = (rel: string, text: string) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  };
  mkdirSync(dir, { recursive: true });
  put("verify.mjs", VERIFY);
  put("web/ui.txt", "before\n");
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

type Agent = { id: string; cwd: string; sessionId: string | null; status: string };

// 데몬 하나. agents 는 가짜 개선 세션: send 가 불리면 정해 둔 동작을 worktree 에 하고 잠시 뒤 턴이 끝난 것처럼 afterTurn 을 부른다.
function daemon(src: string, agent: Agent | null, options: { hasTranscript?: boolean; finishes?: boolean } = {}) {
  const notices: string[] = [];
  const sent: { prompt: string; display: string | undefined }[] = [];
  const statuses: string[] = [];
  const holder: { runner: Runner | null; worktree: string; agentId: string } = { runner: null, worktree: "", agentId: "" };
  const agents = {
    adopt: () => undefined,
    send: async (_id: string, prompt: string, shown: { display?: string } = {}) => {
      if (!holder.worktree) return { queued: false };
      sent.push({ prompt, display: shown.display });
      if (options.finishes !== false) {
        writeFileSync(join(holder.worktree, "web/ui.txt"), "after\n");
        setTimeout(() => holder.runner?.afterTurn(holder.agentId), 100);
      }
      return { queued: false };
    },
    notice: (_id: string, text: string) => void notices.push(text),
  };
  const store = {
    settings: { feedbackModel: "haiku" },
    addWorkspace: () => ({ id: "w" }),
    workspaces: [],
    agent: () => {
      if (!agent) throw new Error("unknown agent");
      return agent;
    },
    timeline: () => [],
  };
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
    checks: [{ name: "verify", command: "node", args: ["verify.mjs"], timeoutMs: 30_000 }],
    hasTranscript: () => options.hasTranscript !== false,
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

// 첫 데몬이 피드백을 만들고 턴이 도는 중에 죽은 상태를 만든다(afterTurn 이 불리지 않는다). state.json 이 남는다.
async function startAndCrash(src: string, status: "running" | "checking" | "fixing") {
  const first = daemon(src, null, { finishes: false });
  const feedback = await first.runner.create({ text: "change the ui text", element: null, screenshot: null, screenshotNote: null });
  first.holder.worktree = feedback.worktree;
  const file = join(root, "home", "feedback", feedback.id, "state.json");
  const state = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(file, JSON.stringify({ ...state, status }, null, 2));
  return { id: feedback.id, agentId: feedback.agentId, worktree: feedback.worktree, file };
}

const patchState = (file: string, patch: Record<string, unknown>) => writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), ...patch }, null, 2));

// 2. 턴이 도는 중에 죽음 -> 같은 세션을 resume 해서 이어 쓰고 반영
{
  const src = sourceRepo("resume-running");
  const crashed = await startAndCrash(src, "running");
  const agent: Agent = { id: crashed.agentId, cwd: crashed.worktree, sessionId: "sess-1", status: "idle" };
  const d = daemon(src, agent);
  d.holder.worktree = crashed.worktree;
  d.holder.agentId = crashed.agentId;
  check("a restarted daemon keeps the running status instead of failing it", d.runner.get(crashed.id).status === "running" && d.runner.get(crashed.id).interrupted === true);
  await d.runner.resumeInterrupted();
  check("one resume turn was sent to the same session", d.sent.length === 1);
  check("the turn says it was cut off and to finish", d.sent[0].prompt.includes("cut off") && d.sent[0].prompt.includes("finish the feedback") && d.sent[0].prompt.includes("Do not start over"));
  check("the chat shows a short line, not the whole prompt", (d.sent[0].display ?? "").startsWith("The app restarted") && !(d.sent[0].display ?? "").includes("Read the files"));
  check("a notice says the session continues", d.notices.some((n) => n.includes("continues where it stopped")));
  check("the resume was counted", d.runner.get(crashed.id).resumeCount === 1);
  await until(d.runner, crashed.id, (s) => s === "applied" || s === "failed");
  const done = d.runner.get(crashed.id);
  check("the continued turn goes through the checks and is applied", done.status === "applied" && done.checks.every((c) => c.ok), `${done.status} ${done.failure ?? ""}`);
  check("a normal finish clears the interrupted mark and the resume count", done.interrupted === false && !done.resumeCount, JSON.stringify({ i: done.interrupted, c: done.resumeCount }));
  check("main folder got the change", readFileSync(join(src, "web/ui.txt"), "utf8") === "after\n");
  check("status goes running, checking, applied", d.statuses.filter((s) => ["running", "checking", "applied"].includes(s)).join(",") === "running,checking,applied", d.statuses.join(","));
}

// 3. 검사 중에 죽음 -> 세션 턴 없이 검사부터 다시
{
  const src = sourceRepo("resume-checking");
  const crashed = await startAndCrash(src, "checking");
  writeFileSync(join(crashed.worktree, "web/ui.txt"), "after\n");
  // 이 세션은 기록이 없어도 된다(검사만 다시 돈다)
  const d = daemon(src, { id: crashed.agentId, cwd: crashed.worktree, sessionId: null, status: "idle" }, { hasTranscript: false });
  d.holder.worktree = crashed.worktree;
  await d.runner.resumeInterrupted();
  await until(d.runner, crashed.id, (s) => s === "applied" || s === "failed");
  const done = d.runner.get(crashed.id);
  check("checking at the restart: checks run again and apply, no session turn", done.status === "applied" && d.sent.length === 0, `${done.status} ${done.failure ?? ""}`);
  check("a notice says the checks run again", d.notices.some((n) => n.includes("Running them again")));
  check("main folder got the change", readFileSync(join(src, "web/ui.txt"), "utf8") === "after\n");
}

// 4. 세션 기록이 없음 -> 실패 + Run Again, Run Again 은 같은 요청의 새 피드백을 만든다
{
  const src = sourceRepo("resume-nosession");
  const crashed = await startAndCrash(src, "running");
  const d = daemon(src, { id: crashed.agentId, cwd: crashed.worktree, sessionId: "sess-gone", status: "idle" }, { hasTranscript: false });
  d.holder.worktree = crashed.worktree;
  await d.runner.resumeInterrupted();
  const failedOne = d.runner.get(crashed.id);
  check("no session record: failed, nothing was sent", failedOne.status === "failed" && d.sent.length === 0);
  check("the failure says it could not continue and offers Run Again", (failedOne.failure ?? "").includes("no saved record") && (failedOne.failure ?? "").includes("Run it again"), failedOne.failure ?? "");
  check("it is marked interrupted and Run Again is offered, Retry Checks is not", failedOne.interrupted === true && canRunAgain(failedOne) && failedOne.checks.length === 0);
  const again = await d.runner.runAgain(crashed.id);
  check("Run Again starts a new feedback with the same request", again.id !== crashed.id && again.text === "change the ui text" && again.status === "running", `${again.id} ${again.status}`);
  check("the new feedback got its own worktree", again.worktree !== crashed.worktree);
  check("the old one no longer offers Run Again", !canRunAgain(d.runner.get(crashed.id)));
  let refused = "";
  try {
    await d.runner.runAgain(crashed.id);
  } catch (error) {
    refused = (error as Error).message;
  }
  check("running it again a second time is refused", refused.includes("can be run again"), refused);
}

// 5. worktree 가 사라짐, 너무 여러 번 끊김
{
  const src = sourceRepo("resume-gone");
  const crashed = await startAndCrash(src, "running");
  rmSync(crashed.worktree, { recursive: true, force: true });
  const d = daemon(src, { id: crashed.agentId, cwd: crashed.worktree, sessionId: "s", status: "idle" });
  await d.runner.resumeInterrupted();
  const one = d.runner.get(crashed.id);
  check("a missing worktree fails with Run Again", one.status === "failed" && (one.failure ?? "").includes("working copy is gone") && canRunAgain(one), one.failure ?? "");
}
{
  const src = sourceRepo("resume-many");
  const crashed = await startAndCrash(src, "running");
  patchState(crashed.file, { resumeCount: MAX_RESUMES });
  const d = daemon(src, { id: crashed.agentId, cwd: crashed.worktree, sessionId: "s", status: "idle" });
  await d.runner.resumeInterrupted();
  const one = d.runner.get(crashed.id);
  check("cut again and again: not continued a third time", one.status === "failed" && d.sent.length === 0 && (one.failure ?? "").includes("again and again") && canRunAgain(one), one.failure ?? "");
}

// 6. 이미 끝난 피드백은 재시작이 건드리지 않는다
{
  const src = sourceRepo("resume-terminal");
  const crashed = await startAndCrash(src, "running");
  patchState(crashed.file, { status: "applied" });
  const d = daemon(src, { id: crashed.agentId, cwd: crashed.worktree, sessionId: "s", status: "idle" });
  await d.runner.resumeInterrupted();
  check("an applied feedback is left alone", d.runner.get(crashed.id).status === "applied" && d.sent.length === 0 && !d.runner.get(crashed.id).interrupted);
}

console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
