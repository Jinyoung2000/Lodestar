// FBBLOCK: 코드 탓이 아니라 환경(npm 을 못 찾음)이나 인증(Claude 로그인 만료) 탓에 멈춘 피드백 단독 시험(임시 git 저장소와 임시 홈, 모델 호출 없음).
// 실패 분류, 자동 재시도 일정, blocked 에서 자동 수정 턴을 보내지 않는 것, 환경 오류 재시도 뒤 통과, 인증 복구 뒤 세션 재시작, 횟수를 다 쓰면 failed 와 단추.
// 실행: npm test
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const root = realpathSync(mkdtempSync(join(tmpdir(), "fbblock-")));
process.env.AGENT_NAV_HOME = join(root, "home");

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed++;
};

const { FeedbackRunner } = await import("../server/feedback");
const { AUTH_MAX_RETRIES, ENV_RETRY_DELAYS_MS, authRetriesLeft, classifyFailure, classifySessionError, endedInSessionError, envRetryDelay, missingTool } = await import("../shared/feedbackBlock");
const { canRetryChecks } = await import("../shared/feedbackRetry");
const { canRunAgain } = await import("../shared/feedbackResume");
const { T } = await import("../server/strings");
const { feedbackBadge } = await import("../web/feedbackBadge");
const { matchesImprovement, notAppliedCount } = await import("../web/improvementRows");
type Runner = InstanceType<typeof FeedbackRunner>;

// 1. 실패 분류
{
  const spawn = { code: "ENOENT", syscall: "spawn npm", text: "spawn npm ENOENT" };
  check("spawn npm ENOENT is an environment error", classifyFailure(spawn) === "environment");
  check("ENOENT without syscall still needs the spawn text", classifyFailure({ code: "ENOENT", text: "spawn npx ENOENT" }) === "environment" && classifyFailure({ code: "ENOENT", text: "ENOENT: no such file or directory, open 'a.json'" }) === "code");
  check("exit 127 (sh could not find the command) is an environment error", classifyFailure({ code: 127, text: "" }) === "environment");
  check("a test that exits 1 is a code error", classifyFailure({ code: 1, text: "FAIL something" }) === "code");
  check("sh: 1: tsx: not found is an environment error", classifyFailure({ code: 1, text: "sh: 1: tsx: not found" }) === "environment");
  check("zsh style command not found is an environment error", classifyFailure({ code: 1, text: "sh: vite: command not found" }) === "environment");
  check("env: node: No such file or directory is an environment error", classifyFailure({ text: "env: node: No such file or directory" }) === "environment");
  check("Failed to authenticate is an auth error", classifyFailure({ code: 1, text: "Failed to authenticate: OAuth session expired and could not be refreshed" }) === "auth");
  check("DNS failures are network errors", classifyFailure({ text: "getaddrinfo ENOTFOUND registry.npmjs.org" }) === "network" && classifyFailure({ text: "npm ERR! network request failed" }) === "network");
  check("ECONNREFUSED and fetch failed stay code errors (a broken test daemon prints them)", classifyFailure({ code: 1, text: "TypeError: fetch failed\nECONNREFUSED 127.0.0.1:7788" }) === "code");
  check("a plain tsc error is a code error", classifyFailure({ code: 2, text: "web/App.tsx(1,1): error TS2304: Cannot find name 'x'." }) === "code");
  check("missingTool reads the tool from each message form", missingTool("spawn npm ENOENT") === "npm" && missingTool("sh: 1: tsx: not found") === "tsx" && missingTool("sh: vite: command not found") === "vite" && missingTool("env: node: No such file or directory") === "node" && missingTool("all good") === null);
  check("session errors: auth flag wins, connection text is network, anything else is other", classifySessionError({ text: "x", auth: true }) === "auth" && classifySessionError({ text: "Unable to connect to API (ENOTFOUND)", auth: false }) === "network" && classifySessionError({ text: "Process ended unexpectedly", auth: false }) === "other" && classifySessionError(null) === "other");
}

// 2. 자동 재시도 일정과 단추 판단
{
  check("environment retries wait 1, 5 and 15 minutes", ENV_RETRY_DELAYS_MS.join(",") === "60000,300000,900000");
  check("after the third retry there is no delay left", envRetryDelay(0) === 60_000 && envRetryDelay(1) === 300_000 && envRetryDelay(2) === 900_000 && envRetryDelay(3) === null);
  check("a test can pass its own delays", envRetryDelay(1, [5, 6]) === 6 && envRetryDelay(2, [5, 6]) === null);
  check("auth retries stop after the maximum", authRetriesLeft(AUTH_MAX_RETRIES - 1) && !authRetriesLeft(AUTH_MAX_RETRIES));
  const blocked = (stage: "checks" | "session", reason: "environment" | "auth" = "environment") => ({ status: "blocked" as const, checks: [], retrying: false, blocked: { reason, stage, nextRetryAt: null } });
  check("blocked at the checks stage can retry checks now, not run again", canRetryChecks(blocked("checks")) && !canRunAgain(blocked("checks")));
  check("blocked at the session stage can run again now, not retry checks", canRunAgain(blocked("session", "auth")) && !canRetryChecks(blocked("session", "auth")));
  check("a failed feedback whose session ended in an error can run again", canRunAgain({ status: "failed", sessionFailed: true }) && !canRunAgain({ status: "failed" }));
  check("an older record with no flag is recognised by its failure sentence", endedInSessionError(T.fbErrAgent) && canRunAgain({ status: "failed", checks: [], failure: T.fbErrAgent }) && !canRunAgain({ status: "failed", checks: [{ name: "x", ok: false, output: "" }], failure: T.fbErrAgent }));
  check("once it was run again the old record stops offering it", !canRunAgain({ status: "failed", sessionFailed: false, checks: [], failure: T.fbErrAgent }));
  check("interrupted feedback keep working as before", canRunAgain({ status: "failed", interrupted: true }) && !canRunAgain({ status: "applied", interrupted: true }));
}

// 3. 화면: 대기 표시는 실패와 갈라지고 Not applied 개수에 안 든다
{
  const env = { status: "blocked" as const, retrying: false, restartPending: false, failure: "x", blocked: { reason: "environment" as const, stage: "checks" as const, nextRetryAt: null } };
  const auth = { ...env, blocked: { reason: "auth" as const, stage: "session" as const, nextRetryAt: null } };
  check("environment wait label and calm tone", feedbackBadge(env)?.label === "Waiting to retry" && feedbackBadge(env)?.tone === "muted" && feedbackBadge(env)?.icon === "watch");
  check("auth wait label", feedbackBadge(auth)?.label === "Waiting for sign-in");
  check("blocked is listed under All but not under Not applied or Applied", matchesImprovement(env, "all") && !matchesImprovement(env, "notApplied") && !matchesImprovement(env, "applied") && !matchesImprovement(env, "dismissed"));
  check("the sidebar count of not applied ignores blocked", notAppliedCount({ b: { ...env, id: "b", agentId: "a", checks: [], createdAt: "x", updatedAt: "y" } }, [{ id: "a", feedbackId: "b", status: "idle" }]) === 0);
}

// 4. FeedbackRunner: 환경 오류와 인증 오류
const VERIFY = `import { mkdirSync, writeFileSync } from "node:fs";
mkdirSync("dist", { recursive: true });
writeFileSync("dist/index.html", "built");
`;

function sourceRepo(name: string) {
  const dir = join(root, name);
  mkdirSync(join(dir, "web"), { recursive: true });
  writeFileSync(join(dir, "verify.mjs"), VERIFY);
  writeFileSync(join(dir, "web/ui.txt"), "before\n");
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

type Setup = {
  checks: { name: string; command: string; args: string[]; timeoutMs: number; kind?: "tsc" | "tests" | "build" }[];
  binDir?: string;
  retryDelaysMs?: number[];
  // 개선 세션의 마지막 오류. 있으면 세션이 오류로 끝난 것으로 본다.
  sessionError?: { text: string; auth: boolean };
  authProbe?: () => Promise<boolean>;
  authProbeMs?: number;
};

// 가짜 개선 세션: send 로 시작된 턴은 곧 끝난 것처럼 afterTurn 을 부른다. 새 세션도 같은 방식이라 Run Again 이 만든 세션이 바로 다음 결과를 낸다.
function daemon(src: string, setup: Setup) {
  const notices: string[] = [];
  const sent: { agentId: string; prompt: string }[] = [];
  const statuses: string[] = [];
  const forced: boolean[] = [];
  const worktrees = new Map<string, string>();
  const holder: { runner: Runner | null; holdNext: boolean } = { runner: null, holdNext: false };
  const agents = {
    adopt: () => undefined,
    send: async (agentId: string, prompt: string) => {
      sent.push({ agentId, prompt });
      // start() 가 만든 첫 세션의 턴은 시험이 직접 끝낸다(afterTurn 을 두 번 부르지 않는다)
      if (holder.holdNext) {
        holder.holdNext = false;
        return { queued: false };
      }
      const worktree = [...worktrees.entries()].find(([id]) => id === agentId)?.[1];
      if (worktree) writeFileSync(join(worktree, "web/ui.txt"), "after\n");
      setTimeout(() => holder.runner?.afterTurn(agentId), 40);
      return { queued: false };
    },
    notice: (_id: string, text: string) => void notices.push(text),
  };
  const store = {
    settings: { feedbackModel: "haiku" },
    addWorkspace: () => ({ id: "w" }),
    workspaces: [],
    agent: () => ({ status: setup.sessionError ? "error" : "idle" }),
    timeline: () => (setup.sessionError ? [{ id: "e", kind: "error", text: setup.sessionError.text, auth: setup.sessionError.auth }] : []),
  };
  const runner = new FeedbackRunner({
    store: store as never,
    agents: agents as never,
    emit: (event) => {
      const feedback = (event as { feedback?: { status: string; agentId: string; worktree: string } }).feedback;
      if (feedback) worktrees.set(feedback.agentId, feedback.worktree);
      if (feedback && statuses[statuses.length - 1] !== feedback.status) statuses.push(feedback.status);
    },
    srcRoot: src,
    port: 0,
    restart: () => undefined,
    busyCount: () => 0,
    checks: setup.checks,
    // 로그인 셸 대신 PATH 를 직접 준다. binDir 는 처음부터 PATH 에 있지만 안에 파일은 나중에 생긴다(설치되거나 PATH 가 고쳐진 것처럼).
    readEnv: async (force) => {
      forced.push(force);
      return { ...process.env, PATH: [setup.binDir, process.env.PATH].filter(Boolean).join(delimiter) };
    },
    retryDelaysMs: setup.retryDelaysMs ?? [60, 80, 100],
    authProbe: setup.authProbe,
    authProbeMs: setup.authProbeMs ?? 40,
  });
  holder.runner = runner;
  return { runner, notices, sent, statuses, forced, holder };
}

async function waitFor(done: () => boolean, ms = 15_000) {
  for (let i = 0; i < ms / 25 && !done(); i++) await new Promise((r) => setTimeout(r, 25));
  if (!done()) throw new Error("timed out");
}

async function until(runner: Runner, id: string, done: (f: ReturnType<Runner["get"]>) => boolean, ms = 15_000) {
  for (let i = 0; i < ms / 25; i++) {
    if (done(runner.get(id))) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out at ${runner.get(id).status} ${runner.get(id).failure ?? ""}`);
}

async function start(d: ReturnType<typeof daemon>) {
  d.holder.holdNext = true;
  const feedback = await d.runner.create({ text: "change the ui text", element: null, screenshot: null, screenshotNote: null });
  d.sent.length = 0;
  writeFileSync(join(feedback.worktree, "web/ui.txt"), "after\n");
  d.runner.afterTurn(feedback.agentId);
  return feedback.id;
}

function installTool(binDir: string, name: string) {
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, name), '#!/bin/sh\nexec node "$@"\n');
  chmodSync(join(binDir, name), 0o755);
}

const CHECK = (command: string, kind?: "tsc" | "tests" | "build") => ({ name: "verify", command, args: ["verify.mjs"], timeoutMs: 30_000, kind });

// 4a. npm 같은 도구를 못 찾으면: 검사를 돌리지 않고 기다린다, 모델 턴 없음, 설치되면 자동 재시도로 통과
{
  const src = sourceRepo("env-retry");
  const binDir = join(root, "env-retry-bin");
  const d = daemon(src, { checks: [CHECK("fakenpm")], binDir });
  const id = await start(d);
  await until(d.runner, id, (f) => f.status === "blocked");
  const f = d.runner.get(id);
  const head = (f.failure ?? "").split("\n")[0];
  check("a missing tool blocks instead of failing", f.status === "blocked" && f.blocked?.reason === "environment" && f.blocked.stage === "checks", JSON.stringify(f.blocked));
  check("the sentence is the plain one from the spec", head === "Lodestar couldn't find fakenpm. Checks will retry automatically.", head);
  check("the login shell was read again before giving up on the tool", d.forced.includes(true), d.forced.join(","));
  check("the next try is scheduled", !!f.blocked?.nextRetryAt && Date.parse(f.blocked.nextRetryAt) > Date.now() - 1000);
  check("no model turn was spent on it", d.sent.length === 0);
  check("nothing was marked as failed and the checks list is not empty (Retry stays possible)", f.checks.length > 0 && !f.seen === true);
  check("the chat got one notice", d.notices.filter((n) => n.startsWith("Lodestar couldn't find")).length === 1);
  installTool(binDir, "fakenpm");
  await until(d.runner, id, (x) => x.status === "applied" || x.status === "failed");
  const done = d.runner.get(id);
  check("after the tool appears the automatic retry runs the checks and applies", done.status === "applied" && done.checks.every((c) => c.ok), `${done.status} ${done.failure ?? ""}`);
  check("the retry re-read the PATH first", d.forced.filter((x) => x).length >= 2, d.forced.join(","));
  check("status went blocked, checking, applied without a fixing step", d.statuses.filter((s) => ["blocked", "checking", "fixing", "applied"].includes(s)).join(",") === "checking,blocked,checking,applied", d.statuses.join(","));
  check("still no model turn, and the retry counters are cleared by the apply", d.sent.length === 0 && done.blocked === null && done.blockTries === 0);
}

// 4b. 끝내 못 찾으면: 1, 5, 15분 대신 시험용 간격 세 번 뒤 failed, 단추가 보인다
{
  const src = sourceRepo("env-exhaust");
  const d = daemon(src, { checks: [CHECK("fakenpm2")], binDir: join(root, "env-exhaust-bin") });
  const id = await start(d);
  await until(d.runner, id, (f) => f.status === "failed");
  const f = d.runner.get(id);
  check("after three automatic tries it fails", f.status === "failed" && f.blockTries === 3, `${f.status} ${f.blockTries}`);
  check("the failure says how many tries were made", (f.failure ?? "").startsWith("Not applied: Lodestar couldn't find fakenpm2 on 3 automatic tries."), (f.failure ?? "").split("\n")[0]);
  check("Retry Checks is offered (a check row exists), Run Again is not", canRetryChecks(f) && !canRunAgain(f));
  check("every wait was silent: one notice for the first block and one for the failure", d.notices.length === 2, d.notices.join(" | "));
  check("no model turn was spent on any try", d.sent.length === 0);
  installTool(join(root, "env-exhaust-bin"), "fakenpm2");
  d.runner.retryChecks(id);
  await until(d.runner, id, (x) => x.status === "applied" || x.status === "failed");
  check("Retry Checks by hand resets the count and passes once the tool exists", d.runner.get(id).status === "applied" && d.runner.get(id).blockTries === 0);
}

// 4c. 검사 실행 중 "command not found"(종료 코드 127)도 기준선과 비교하거나 수정 턴을 보내지 않고 기다린다
{
  const src = sourceRepo("env-127");
  const d = daemon(src, { checks: [{ name: "build step", command: "sh", args: ["-c", "definitely-not-a-command-xyz"], timeoutMs: 30_000, kind: "build" }], retryDelaysMs: [60_000] });
  const id = await start(d);
  await until(d.runner, id, (f) => f.status === "blocked");
  const f = d.runner.get(id);
  check("exit 127 blocks as an environment error", f.blocked?.reason === "environment" && (f.failure ?? "").startsWith("Lodestar couldn't find definitely-not-a-command-xyz."), (f.failure ?? "").split("\n")[0]);
  check("no fix turn and no fix attempts were counted", d.sent.length === 0 && !f.fixAttempts);
  check("the failing check is recorded as not ok", f.checks.length === 1 && f.checks[0].ok === false);
}

// 4d. 개선 세션이 인증 만료로 끝났다: 기다리고, 인증이 돌아오면 새 세션으로 다시 시작, 횟수를 다 쓰면 failed 와 Run Again
{
  const src = sourceRepo("auth-loop");
  const d = daemon(src, {
    checks: [CHECK("node")],
    sessionError: { text: "Failed to authenticate: OAuth session expired and could not be refreshed", auth: true },
    authProbe: async () => true,
  });
  const since = new Date().toISOString();
  const id = await start(d);
  // 같은 홈을 쓰는 앞 시험의 항목이 목록에 섞이므로 이 시험이 시작한 뒤에 만든 것만 본다.
  const mine = () => d.runner.list().filter((f) => f.createdAt >= since);
  await waitFor(() => mine().some((f) => f.status === "failed"));
  const all = mine();
  check("the first item waited for sign-in with the plain sentence", all[0].id === id && d.notices[0] === "Claude sign-in expired. Sign in again and the improvement will continue.", d.notices[0]);
  const final = all.find((f) => f.status === "failed")!;
  const failedItems = all.filter((f) => f.status === "failed");
  check("each restart made a new session: 1 original plus 3 retries", all.length === 4, String(all.length));
  check("earlier items were hidden (dismissed), only the last one is failed", failedItems.length === 1 && all.filter((f) => f.status === "dismissed").length === 3);
  check("the count carried over to each new item", final.blockTries === 3, String(final.blockTries));
  check("the last failure says sign-in did not come back", (final.failure ?? "").startsWith("Not applied: Claude sign-in did not come back after 3 tries."), (final.failure ?? "").split("\n")[0]);
  check("Run Again is offered for the failed item, Retry Checks is not", canRunAgain(final) && !canRetryChecks(final));
  check("no fix turns were sent to a session that never started", d.sent.every((s) => !s.prompt.includes("failed after your changes")));
}

// 4e. 다른 세션이 성공했다고 알리면(authRestored) 확인 주기를 기다리지 않고 바로 다시 시작한다
{
  const src = sourceRepo("auth-restored");
  let probes = 0;
  const d = daemon(src, {
    checks: [CHECK("node")],
    sessionError: { text: "Failed to authenticate", auth: true },
    authProbe: async () => {
      probes++;
      return false;
    },
    authProbeMs: 600_000,
  });
  const id = await start(d);
  await until(d.runner, id, (f) => f.status === "blocked");
  const blocked = d.runner.get(id);
  check("auth wait has no retry time and the stage is session", blocked.blocked?.reason === "auth" && blocked.blocked.stage === "session" && blocked.blocked.nextRetryAt === null);
  check("Run Again is available while waiting", canRunAgain(blocked));
  d.runner.authRestored();
  await until(d.runner, id, (f) => f.status === "dismissed");
  check("authRestored restarted it without waiting for the probe", probes === 0 && d.runner.list().length >= 2);
  check("the chat says sign-in is back", d.notices.includes(T.fbAuthResumed));
}

// 4f. 데몬이 재시작돼도 기다리던 환경 오류 항목은 다시 타이머를 걸고 끝까지 간다
{
  const src = sourceRepo("env-restart");
  const binDir = join(root, "env-restart-bin");
  const first = daemon(src, { checks: [CHECK("fakenpm3")], binDir, retryDelaysMs: [600_000] });
  const id = await start(first);
  await until(first.runner, id, (f) => f.status === "blocked");
  const state = JSON.parse(readFileSync(join(root, "home", "feedback", id, "state.json"), "utf8"));
  check("the wait is saved in state.json", state.status === "blocked" && state.blocked.reason === "environment" && !!state.blocked.nextRetryAt);
  // 같은 홈을 읽는 두 번째 데몬(= 재시작). 첫 데몬의 타이머는 시험이 끝날 때 프로세스가 끝나며 사라진다.
  installTool(binDir, "fakenpm3");
  const second = daemon(src, { checks: [CHECK("fakenpm3")], binDir, retryDelaysMs: [600_000] });
  const loaded = second.runner.get(id);
  check("the restarted daemon loads it as blocked, not as running", loaded.status === "blocked");
  loaded.blocked = { ...loaded.blocked!, nextRetryAt: new Date(Date.now() + 50).toISOString() };
  await second.runner.resumeInterrupted();
  await until(second.runner, id, (f) => f.status === "applied" || f.status === "failed");
  check("after the restart the retry runs and applies", second.runner.get(id).status === "applied", `${second.runner.get(id).status} ${second.runner.get(id).failure ?? ""}`);
}

// 4g. 코드 오류는 그대로 자동 수정 대상이다(분류가 너무 넓지 않다): 일반 실패는 blocked 가 되지 않는다
{
  const src = sourceRepo("code-failure");
  const d = daemon(src, { checks: [{ name: "verify", command: "node", args: ["-e", "console.error('data is broken'); process.exit(1)"], timeoutMs: 30_000 }] });
  const id = await start(d);
  await until(d.runner, id, (f) => f.status === "fixing" || f.status === "failed" || f.status === "blocked");
  check("an ordinary failing check is still sent back for a fix, not blocked", d.runner.get(id).status !== "blocked" && d.runner.get(id).blocked === null, d.runner.get(id).status);
}

if (failed) {
  console.error(`${failed} check(s) failed`);
  process.exit(1);
}
process.exit(0);
