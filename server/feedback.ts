import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { cp, copyFile, lstat, mkdir, readFile, readdir, rename, rm, rmdir, symlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { Agent, ChangedFile, EffortLevel, ElementInfo, Feedback, FeedbackCheck, ScreenContext, ServerEvent, TimelineItem, UserAttachment } from "../shared/protocol";
import { AUTH_PROBE_MS, authRetriesLeft, classifyFailure, classifySessionError, envRetryDelay, missingTool, type FailureKind } from "../shared/feedbackBlock";
import { canRetryChecks } from "../shared/feedbackRetry";
import { canRunAgain, isInterruptible, resumePlan } from "../shared/feedbackResume";
import { planRetention, withPolicy, protectedReason, type RetentionFacts, type RetentionPolicy, type TidyEntry, type TidyPlan, type TidyResult } from "../shared/feedbackRetention";
import { baselineKey, newFailures, plainFailures, quotedStrings, readBaselineCache, testFailures, tscFailures, writeBaselineCache, type CheckFailure, type CheckOutcome } from "./checkBaseline";
import { screenLines } from "../shared/feedbackScreen";
import { parseFeedbackReply } from "../shared/feedbackQuestion";
import { summarySource } from "../shared/feedbackSummary";
import type { RestartOutcome } from "../shared/restartGate";
import type { AgentRunner } from "./agents";
import * as gitOps from "./git";
import { claudeBin, claudeEnv, stripAppEnv } from "./claude";
import { findTranscript } from "./vscodeTimeline";
import { HOME, type Store } from "./store";
import { T } from "./strings";
import { findExecutable, loginShellPath, withLoginPath } from "./loginPath";

const execFileAsync = promisify(execFile);
const FEEDBACK_DIR = join(HOME, "feedback");
const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;
const MAX_OUTPUT = 4000;
const MAX_QUESTION = 600;
const WINDOW_PNG = "window.png";
const THUMB_URL = /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/;
const MAX_THUMB_CHARS = 60_000;
// 워크트리 사본에서 변경 비교와 복사 대상이 아닌 것. 최상위 폴더 이름과 어느 깊이에서든 건너뛰는 이름.
const SKIP_TOP = new Set(["dist", "dist-electron", "release", ".verify"]);
const SKIP_ANY = new Set(["node_modules", ".git", ".DS_Store"]);
const RESTART_DIRS = ["server/", "shared/", "electron/"];
const NEVER_APPLY = new Set(["package.json", "package-lock.json"]);
// CHKBASE: kind 는 실패를 기준선과 비교하는 방법이다. tsc 는 오류 목록, tests 는 실패한 시험 이름, build 와 없음은 성공/실패.
// tests 는 package.json 의 test 스크립트를 && 앞뒤로 나눠 파일마다 돌린다(npm test 는 첫 실패에서 멈춰 뒤 시험이 가려진다). after 는 기준선에서 먼저 있어야 하는 검사(dist/ 를 만드는 build).
type CheckSpec = { name: string; command: string; args: string[]; timeoutMs: number; kind?: "tsc" | "tests" | "build"; after?: string };
const CHECKS: CheckSpec[] = [
  { name: "npx tsc --noEmit", command: "npx", args: ["tsc", "-p", "tsconfig.json", "--noEmit"], timeoutMs: 180_000, kind: "tsc" },
  // build 를 test 보다 먼저 돈다. 데몬 시험 일부(단일 세션 화면 서빙)가 dist/ 를 읽는데, 새 worktree 에는 dist/ 가 없어 503 으로 실패했다.
  { name: "npm run build", command: "npm", args: ["run", "build"], timeoutMs: 300_000, kind: "build" },
  // 시험은 파일 수백 개를 차례로 돌고 제한 시간을 다 같이 쓴다. 180초는 전체가 못 끝나 "not run, time limit" 이 기준선과 다른 자리에 찍혀 이 피드백 탓 실패로 오판했다(2026-11-04).
  { name: "npm test", command: "npm", args: ["test"], timeoutMs: 900_000, kind: "tests", after: "npm run build" },
];
const BASELINE_CACHE_DIR = join(FEEDBACK_DIR, "baseline-cache");
// FBMERGE: 검사 중 본 작업 폴더가 또 바뀌어 반영이 충돌하면 sync + 병합 + 검사를 처음부터 다시 돈다. 이 횟수까지(처음 한 번 포함).
// FBREDO: 반영 직전 충돌이 "또 바뀜"(줄이 겹치지 않는 경쟁)이면 3번까지 돌고, 시도 사이에 짧게 쉰다(본 작업 폴더를 고치는 다른 에이전트의 쓰기가 끝나기를 기다린다).
const MAX_APPLY_ATTEMPTS = 3;
const APPLY_RETRY_WAIT_MS = 2000;
// 검사가 이 피드백 탓의 새 실패로 떨어지면 개선 세션에 되돌려 보내 고치게 하는 최대 횟수.
const MAX_AUTO_FIXES = 5;
// 개선 세션은 사람 승인 없이 끝까지 가는 세션이라 모델, effort, 권한 모드를 고정한다(설정 항목 없음).
const FEEDBACK_MODEL = "claude-opus-5-5";
const FEEDBACK_EFFORT: EffortLevel = "high";
// FBREBASE: 검사 전 병합이 같은 줄 충돌로 막히면 충돌 파일을 본 작업 폴더 내용으로 바꾸고, 개선 세션에 그 위에 다시 적용하라고 후속 턴을 보내는 최대 횟수. 다 쓰면 실패(Merge Again)로 확정한다.
const MAX_REAPPLIES = 2;
// 본 작업 폴더에 밀려 개선 세션의 옛 버전을 둔 곳(피드백 폴더 아래). 개선 세션이 참고용으로 읽는다. 앞의 것이 개선 세션의 버전, 뒤의 것이 개선 세션이 시작했을 때의 버전.
const DROPPED = "dropped";
const DROPPED_FROM = "dropped-from";

type Baseline = Record<string, string>;
// FBREBASE: reset 은 합치지 못한 파일을 충돌로 남기지 않고 본 작업 폴더 내용으로 바꿔 둔 목록(개선 세션의 버전은 dropped 로 옮겨 둔다).
type SyncResult = { conflicts: { rel: string; reason: string }[]; reset: { rel: string; reason: string }[] };
// reset: 합치지 못한 파일을 본 작업 폴더 내용으로 바꾼다. landed: 사용자가 이미 손으로 반영했다고 해결 처리한 피드백이라, 양쪽이 고친 파일은 합치지 않고 본 작업 폴더가 이긴다(병합은 손으로 옮긴 변경을 한 번 더 얹어 중복시킬 수 있다).
type SyncMode = { reset: boolean; landed: boolean };
type Manifest = {
  appliedAt: string;
  files: { rel: string; existed: boolean; applied: string | null }[];
  hadDist: boolean;
  hadDistElectron: boolean;
};

// FBNOEL: element 가 null 이면 요소를 고르지 않은 피드백이다. windowScreenshot 은 창 전체 PNG(base64), thumb 은 말풍선 칩에 보일 작은 JPEG data URL.
export type FeedbackRequest = {
  text: string;
  element: ElementInfo | null;
  screenshot: string | null;
  screenshotNote: string | null;
  screen?: ScreenContext | null;
  windowScreenshot?: string | null;
  thumb?: string | null;
  // FBBLOCK: Run Again 이 이어받는, 환경이나 인증 때문에 자동으로 다시 시도한 횟수
  blockTries?: number;
};

// 이 데몬 프로세스의 시작 시각과, 데몬이 읽은 파일(번들이면 dist-electron/daemon.mjs, tsx 로 띄웠으면 server/index.ts)의 수정 시각.
export type DaemonBuild = { startedAt: number; builtAt: number; bundled: boolean };

export type FeedbackDeps = {
  store: Store;
  agents: AgentRunner;
  emit: (event: ServerEvent) => void;
  srcRoot: string;
  port: number;
  // 데몬 재시작을 요청한다. 직전 재시작 뒤 쿨다운에 걸리면 deferred 로 돌려주고 데몬이 나중에 합쳐서 한다(shared/restartGate.ts). 반환이 없으면 바로 한 것으로 본다.
  restart: () => RestartOutcome | void;
  // 이 데몬이 어떤 빌드로 언제 떴는지. 있으면 시작할 때 settleOnStart 가 이미 이 빌드에 들어 있는 재시작 대기를 정리한다.
  daemon?: DaemonBuild;
  // 진행 중인 에이전트 턴, 빠른 질문, 곁다리 대화의 수
  busyCount: () => number;
  // 시험에서 검사 목록을 바꿔 끼운다. 비우면 CHECKS.
  checks?: CheckSpec[];
  // 시험에서 자동 수정 횟수를 바꾼다. 비우면 MAX_AUTO_FIXES.
  autoFixes?: number;
  // 시험에서 반영 재시도 사이의 대기를 바꾼다. 비우면 APPLY_RETRY_WAIT_MS.
  applyRetryWaitMs?: number;
  // FBREBASE: 시험에서 본 폴더 위 재적용 횟수를 바꾼다. 비우면 MAX_REAPPLIES. 0 이면 같은 줄 충돌은 바로 실패한다.
  reapplies?: number;
  // 시험에서 세션 기록 파일 검사를 바꿔 끼운다. 비우면 Claude 의 기록 폴더를 찾는다.
  hasTranscript?: (sessionId: string, cwd: string) => boolean;
  // FBBLOCK: 시험에서 검사 환경(PATH)을 읽는 길을 바꿔 끼운다. force 면 로그인 셸을 다시 읽는다. 비우면 로그인 셸.
  readEnv?: (force: boolean) => Promise<NodeJS.ProcessEnv>;
  // FBBLOCK: 시험에서 환경 오류 자동 재시도 간격(ms)을 바꾼다. 비우면 1분, 5분, 15분.
  retryDelaysMs?: number[];
  // FBBLOCK: Claude 로그인이 살아 있는지 가볍게 보는 길(모델 호출 없음)과 그 주기. 비우면 `claude auth status` 와 2분.
  authProbe?: () => Promise<boolean>;
  authProbeMs?: number;
};

// 화면에서 집은 요소를 보내면 agent-nav 레포의 별도 worktree 에서 고치는 세션을 돌리고, 검사가 통과한 변경만 본 작업 폴더로 옮긴다.
// 흐름: create → (worktree 사본 + 기준 해시) → 개선 세션 턴 → afterTurn → 변경 파일 해시 비교 → tsc, npm test, npm run build (worktree 안) → apply (백업 후 복사, dist 교체) → 화면 다시 읽기.
export class FeedbackRunner {
  private items = new Map<string, Feedback>();
  private pipelines = new Set<string>();
  private applying = false;
  private restartTimer: NodeJS.Timeout | null = null;
  // FBREDO: 이 데몬이 뜰 때 턴이나 검사 중으로 남아 있던 피드백. resumeInterrupted 가 이어 간다.
  private cutByRestart: string[] = [];
  // FBBLOCK: 환경 오류로 기다리는 피드백의 다음 자동 재시도 타이머, 인증 복구를 보는 주기 확인, 데몬이 뜰 때 이미 기다리던 피드백
  private blockTimers = new Map<string, NodeJS.Timeout>();
  private authTimer: NodeJS.Timeout | null = null;
  private probing = false;
  private blockedOnLoad: string[] = [];

  constructor(private deps: FeedbackDeps) {
    mkdirSync(FEEDBACK_DIR, { recursive: true });
    for (const name of readdirSync(FEEDBACK_DIR)) {
      const file = join(FEEDBACK_DIR, name, "state.json");
      if (!existsSync(file)) continue;
      // 읽을 수 없는 기록 하나 때문에 데몬이 뜨지 못하면 안 된다. 그 피드백만 건너뛰고 파일은 그대로 둔다.
      let feedback: Feedback;
      try {
        feedback = JSON.parse(readFileSync(file, "utf8")) as Feedback;
        if (!feedback || typeof feedback !== "object" || typeof feedback.id !== "string") throw new Error("not a feedback record");
      } catch (error) {
        console.error(`[feedback] skipped unreadable ${file}: ${(error as Error).message}`);
        continue;
      }
      // 데몬이 재시작되면 돌고 있던 턴과 검사는 사라진다. 상태는 그대로 두고 resumeInterrupted 가 이어 가거나 실패로 확정한다(index.ts 가 훅을 건 뒤에 부른다).
      if (isInterruptible(feedback.status)) {
        feedback.interrupted = true;
        this.cutByRestart.push(feedback.id);
      }
      if (feedback.status === "blocked") this.blockedOnLoad.push(feedback.id);
      feedback.restartRequested = false;
      feedback.retrying = false;
      this.items.set(feedback.id, feedback);
    }
  }

  list() {
    return [...this.items.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  // FBREDO: 반영 안 됨(failed)으로 남은 항목을 사람이 정리한다. 이미 다른 길로 해결됐으면 resolve(해결됨으로 표시), 더는 볼 필요 없으면 dismiss(목록에서 숨김, 필터로 다시 봄).
  // 실패한 항목만 되고, 검사나 세션 턴이 도는 중이면(Retry 중) 거절한다. 둘 다 알림은 다시 띄우지 않는다(seen).
  resolve(id: string) {
    return this.tidy(id, "resolved", T.fbResolved);
  }

  dismiss(id: string) {
    return this.tidy(id, "dismissed", T.fbDismissed);
  }

  private tidy(id: string, status: "resolved" | "dismissed", note: string) {
    const feedback = this.get(id);
    if (feedback.status !== "failed") throw new Error(T.fbErrTidyState);
    const agentStatus = (() => {
      try {
        return this.deps.store.agent(feedback.agentId).status;
      } catch {
        return "idle";
      }
    })();
    if (feedback.retrying || this.pipelines.has(id) || agentStatus === "running" || agentStatus === "waiting") throw new Error(T.fbErrTidyBusy);
    this.set(feedback, { status, seen: true, interrupted: false, resumeCount: 0 });
    this.deps.agents.notice(feedback.agentId, note);
    return feedback;
  }

  // 검사와 반영 중인 피드백 수. 데몬을 재시작해도 되는지 보는 busyCount 가 개선 세션 턴과 함께 센다.
  checkingCount() {
    return this.pipelines.size;
  }

  // 데몬이 뜬 직후: 재시작을 기다리던 피드백 중 이미 이 데몬의 빌드에 들어 있는 것을 정리한다. 어떤 길로 재시작했든(피드백의 Restart 단추, daemon.restartIfIdle, 메뉴 Restart Daemon, 앱 재실행) 같다.
  // 재시작 대기(awaitingRestart)는 두 가지로 풀린다: 1) 반영(applyOnce)이 manifest 를 쓰고 파일을 옮긴 뒤 상태를 applied 로 바꾸기 전에 데몬이 끊겼다(manifest.appliedAt 이 데몬 시작보다 앞선다).
  // 2) 반영 단추 없이 변경이 본 작업 폴더에 직접 들어갔다(파일 내용이 worktree 와 같고, 데몬이 읽은 번들이 그 변경 뒤에 만들어졌다).
  // 되돌린 뒤 재시작 대기(reverted + restartPending)는 되돌린 시각이 데몬 시작보다 앞서면 이미 되돌린 빌드로 떴다.
  async settleOnStart() {
    const build = this.deps.daemon;
    if (!build) return;
    for (const feedback of this.list()) {
      try {
        if (feedback.status === "awaitingRestart") await this.settleAwaiting(feedback, build);
        else if (feedback.status === "reverted" && feedback.restartPending && Date.parse(feedback.updatedAt) <= build.startedAt) {
          this.set(feedback, { restartPending: false, restartRequested: false, seen: true });
          this.deps.agents.notice(feedback.agentId, T.fbReverted);
        }
      } catch (error) {
        console.error(`[feedback] settle ${feedback.id} failed`, error);
      }
    }
  }

  private async settleAwaiting(feedback: Feedback, build: DaemonBuild) {
    const manifest = await readFile(join(this.dir(feedback.id), "manifest.json"), "utf8")
      .then((text) => JSON.parse(text) as Manifest)
      .catch(() => null);
    if (manifest) {
      if (Date.parse(manifest.appliedAt) > build.startedAt) return;
      this.markSettled(feedback);
      return;
    }
    const landed = await this.landedInMain(feedback, build);
    if (!landed) return;
    await this.writeManifest(feedback, landed.files, landed.at).catch((error) => console.error(`[feedback] manifest for ${feedback.id} not written`, error));
    this.markSettled(feedback);
  }

  private markSettled(feedback: Feedback) {
    const summary = feedback.summary ?? feedback.text.slice(0, 80);
    this.set(feedback, { status: "applied", failure: null, summary, restartRequested: false, restartPending: false });
    this.deps.agents.notice(feedback.agentId, T.fbSettledOnStart(summary), undefined, foldOf(feedback.checks));
  }

  // 이 피드백의 변경이 본 작업 폴더에 그대로 들어 있고 이 데몬의 빌드에 포함됐는지. 맞으면 변경 파일 목록과 들어간 시각(가장 늦은 파일 수정 시각).
  private async landedInMain(feedback: Feedback, build: DaemonBuild): Promise<{ files: Manifest["files"]; at: number } | null> {
    const baseline = await this.baseline(feedback);
    const changes = await this.diffWorktree(feedback);
    if (changes.length === 0) return null;
    const files: Manifest["files"] = [];
    let latestAny = 0;
    let latestDaemon = 0;
    for (const change of changes) {
      const target = join(this.deps.srcRoot, change.rel);
      const want = change.status === "D" ? null : await hashFile(join(feedback.worktree, change.rel));
      if ((await hashFile(target)) !== want) return null;
      if (want !== null) {
        const mtime = (await lstat(target)).mtimeMs;
        latestAny = Math.max(latestAny, mtime);
        if (RESTART_DIRS.some((d) => change.rel.startsWith(d))) latestDaemon = Math.max(latestDaemon, mtime);
      }
      files.push({ rel: change.rel, existed: change.rel in baseline, applied: want });
    }
    const inBuild = build.bundled ? build.builtAt >= latestDaemon && build.builtAt <= build.startedAt : latestDaemon <= build.startedAt;
    return inBuild ? { files, at: latestAny } : null;
  }

  // 반영 단추를 거치지 않고 들어간 변경도 되돌릴 수 있게 manifest 를 만든다. 수정 전 파일은 기준 해시의 blob 에서 꺼내 backup 에 쓴다. 수정 전 dist 는 없다(hadDist false).
  private async writeManifest(feedback: Feedback, files: Manifest["files"], at: number) {
    const dir = this.dir(feedback.id);
    const baseline = await this.baseline(feedback);
    for (const file of files) {
      if (!file.existed) continue;
      await mkdir(dirname(join(dir, "backup", file.rel)), { recursive: true });
      await writeFile(join(dir, "backup", file.rel), await catBlob(this.deps.srcRoot, baseline[file.rel]));
    }
    const manifest: Manifest = { appliedAt: new Date(at || Date.now()).toISOString(), files, hadDist: false, hadDistElectron: false };
    await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  }

  // FBREDO: 재시작에 끊긴 피드백을 이어 간다. 훅(options, afterTurn)이 걸린 뒤에 불러야 한다. 안 그러면 이어 가는 턴이 도구 제한(canUseTool) 없이 돈다.
  // 검사 중이었다면 검사와 반영을 처음부터 다시 돌고, 턴이 도는 중이었다면 같은 worktree 와 세션을 resume 해서 "중단됐으니 이어서 끝내라" 는 턴을 보낸다.
  // 이어 갈 수 없으면(worktree, 세션 기록이 없거나 계속 재시작에 끊김) 실패로 두고 Run Again 을 보인다.
  async resumeInterrupted() {
    // 전에 만들어진 개선 세션(Sonnet, 기본 effort, 승인 모드)도 Retry 나 후속 대화 때 같은 모델과 모드로 돈다. 열린 프로세스가 없는 시점이라 기록만 맞추면 된다.
    for (const feedback of this.items.values()) {
      try {
        const agent = this.deps.store.agent(feedback.agentId);
        if (agent.model !== FEEDBACK_MODEL || agent.effort !== FEEDBACK_EFFORT || agent.permissionMode !== "bypassPermissions") {
          this.deps.store.patchAgent(agent.id, { model: FEEDBACK_MODEL, effort: FEEDBACK_EFFORT, permissionMode: "bypassPermissions" });
        }
      } catch {
        // 세션 기록이 지워진 피드백은 건너뛴다.
      }
    }
    // FBBLOCK: 재시작 전에 환경이나 인증 때문에 기다리던 피드백은 타이머와 인증 확인을 다시 건다.
    for (const id of this.blockedOnLoad.splice(0)) {
      const waiting = this.items.get(id);
      if (waiting) this.arm(waiting);
    }
    const ids = this.cutByRestart.splice(0);
    for (const id of ids) {
      const feedback = this.items.get(id);
      if (!feedback || !isInterruptible(feedback.status) || this.pipelines.has(id)) continue;
      try {
        await this.resumeOne(feedback);
      } catch (error) {
        this.giveUp(feedback, (error as Error).message);
      }
    }
  }

  private async resumeOne(feedback: Feedback) {
    let agent: Agent | null = null;
    try {
      agent = this.deps.store.agent(feedback.agentId);
    } catch {
      agent = null;
    }
    const hasTranscript = this.deps.hasTranscript ?? ((sessionId: string, cwd: string) => findTranscript(sessionId, cwd) !== null);
    const plan = resumePlan({
      status: feedback.status,
      resumeCount: feedback.resumeCount ?? 0,
      worktreeExists: existsSync(feedback.worktree),
      baselineExists: existsSync(join(this.dir(feedback.id), "baseline.json")),
      agentExists: agent !== null,
      hasSession: !!agent?.sessionId && hasTranscript(agent.sessionId, agent.cwd),
    });
    if (plan.action === "giveUp") {
      this.giveUp(feedback, T.fbGiveUp(plan.reason));
      return;
    }
    const resumeCount = (feedback.resumeCount ?? 0) + 1;
    if (plan.action === "recheck") {
      this.set(feedback, { status: "checking", resumeCount, interrupted: true, failure: null, checks: [] });
      this.deps.agents.notice(feedback.agentId, T.fbResumedChecks);
      this.pipelines.add(feedback.id);
      void this.finalize(feedback, true)
        .then(() => (feedback.resumeCount ? this.set(feedback, { resumeCount: 0 }) : undefined))
        .catch((error) => this.fail(feedback, `${(error as Error).message}`))
        .finally(() => this.pipelines.delete(feedback.id));
      return;
    }
    // fixing 은 그대로 둔다. 바꾸면 afterTurn 이 자동 수정 횟수를 0 으로 되돌린다.
    this.set(feedback, { status: feedback.status === "fixing" ? "fixing" : "running", resumeCount, interrupted: true, failure: null });
    this.deps.agents.notice(feedback.agentId, T.fbResumed);
    await this.deps.agents.send(feedback.agentId, T.fbResumePrompt, { display: T.fbResumeShown });
  }

  // FBREDO: 본 작업 폴더와 합쳐지지 않아 실패한 것. 실패 카드의 재시도 단추가 Merge Again 으로 보인다(같은 retryChecks: 최신 본 작업 폴더로 다시 병합하고 검사).
  private failConflict(feedback: Feedback, message: string) {
    this.set(feedback, { conflict: true });
    this.fail(feedback, message);
  }

  private giveUp(feedback: Feedback, message: string) {
    this.set(feedback, { interrupted: true, checks: [] });
    this.fail(feedback, message);
  }

  // FBREDO: 재시작에 끊겨 이어 가지 못한 피드백을 같은 요청으로 새 개선 세션에서 처음부터 다시 돌린다. 소스는 지금 본 작업 폴더에서 새로 복사한다.
  // 글, 고른 요소, 화면 정보는 기록에 있고 스크린샷은 피드백 폴더의 PNG 에서 읽는다(말풍선 칩용 썸네일은 다시 만들지 않는다).
  // FBBLOCK: 세션 단계에서 기다리던 항목을 자동으로 다시 돌릴 때(carryTries)는 지금까지 센 자동 재시도 횟수를 새 항목이 이어받는다. 옛 항목은 목록에서 숨긴다(dismissed).
  async runAgain(id: string, carryTries = false): Promise<Feedback> {
    const old = this.get(id);
    if (!canRunAgain(old)) throw new Error(T.fbErrRunAgainState);
    const wasBlocked = old.status === "blocked";
    const blockTries = carryTries ? (old.blockTries ?? 0) : 0;
    const dir = this.dir(id);
    const png = async (name: string, wanted: boolean) => (wanted ? ((await readFile(join(dir, name)).catch(() => null))?.toString("base64") ?? null) : null);
    const [elementPng, windowPng] = await Promise.all([png("element.png", old.screenshot), png(WINDOW_PNG, !!old.windowScreenshot)]);
    if ((old.screenshot && !elementPng) || (old.windowScreenshot && !windowPng)) throw new Error(T.fbErrRunAgainFiles);
    const next = await this.create({ text: old.text, element: old.element, screenshot: elementPng, screenshotNote: old.screenshotNote, screen: old.screen ?? null, windowScreenshot: windowPng, blockTries });
    this.set(old, wasBlocked ? { status: "dismissed", interrupted: false, sessionFailed: false, seen: true } : { interrupted: false, sessionFailed: false, seen: true });
    this.deps.agents.notice(old.agentId, T.fbRanAgain(next.id));
    return next;
  }

  get(id: string) {
    const feedback = this.items.get(id);
    if (!feedback) throw new Error(T.fbErrUnknown(id));
    return feedback;
  }

  markSeen(id: string) {
    const feedback = this.get(id);
    feedback.seen = true;
    this.save(feedback);
  }

  // --- 만들기 ---

  async sourceReady() {
    return (await gitOps.repoRoot(this.deps.srcRoot)) === this.deps.srcRoot;
  }

  async create(request: FeedbackRequest): Promise<Feedback> {
    const text = request.text.trim().slice(0, 2000);
    if (!text) throw new Error(T.fbErrEmptyText);
    // 요청 자체의 오류(스크린샷 형식)는 환경(소스 폴더가 git 인지)과 무관하게 먼저 거절한다.
    const png = decodePng(request.screenshot);
    const windowPng = decodePng(request.windowScreenshot);
    const src = this.deps.srcRoot;
    if (!(await this.sourceReady())) throw new Error(T.fbErrNotGit(src));

    const thumb = request.thumb && THUMB_URL.test(request.thumb) && request.thumb.length <= MAX_THUMB_CHARS ? request.thumb : null;
    const id = randomBytes(4).toString("hex");
    const dir = this.dir(id);
    await mkdir(dir, { recursive: true });
    if (png) await writeFile(join(dir, "element.png"), png);
    if (windowPng) await writeFile(join(dir, WINDOW_PNG), windowPng);
    const screenshot = png !== null;
    if (request.element) await writeFile(join(dir, "element.json"), JSON.stringify(request.element, null, 2));
    if (request.screen) await writeFile(join(dir, "screen.json"), JSON.stringify(request.screen, null, 2));

    const worktree = await this.createWorktree(id);
    const baseline = await this.mirror(src, worktree);
    await writeFile(join(dir, "baseline.json"), JSON.stringify(baseline));

    const workspace = this.deps.store.addWorkspace(worktree, null, `Lodestar (feedback ${id})`, true);
    const now = new Date().toISOString();
    const agent: Agent = {
      id: randomUUID(),
      workspaceId: workspace.id,
      cwd: worktree,
      worktree: null,
      forkedFrom: null,
      resumeFrom: null,
      startCommit: null,
      feedbackId: id,
      title: T.fbTitle(text.replace(/\s+/g, " ").slice(0, 50)),
      sessionId: null,
      status: "idle",
      permissionMode: "bypassPermissions",
      model: FEEDBACK_MODEL,
      effort: FEEDBACK_EFFORT,
      activeModel: null,
      activeEffort: null,
      backgroundTasks: 0,
      createdAt: now,
      updatedAt: now,
    };
    const feedback: Feedback = {
      id,
      agentId: agent.id,
      text,
      element: request.element,
      screen: request.screen ?? null,
      windowScreenshot: windowPng !== null,
      screenshot,
      screenshotNote: screenshot ? null : request.screenshotNote,
      status: "running",
      summary: null,
      ...(request.blockTries ? { blockTries: request.blockTries } : {}),
      changedFiles: [],
      needsRestart: false,
      restartRequested: false,
      restartPending: false,
      checks: [],
      failure: null,
      worktree,
      seen: false,
      createdAt: now,
      updatedAt: now,
    };
    const prompt = composePrompt(feedback, dir);
    await writeFile(join(dir, "prompt.md"), prompt);
    this.items.set(id, feedback);
    this.save(feedback);
    this.deps.agents.adopt(agent, []);
    this.deps.emit({ type: "workspaces", workspaces: this.deps.store.workspaces });
    void this.deps.agents.send(agent.id, prompt, { display: text, attachments: chipsOf(request.element, windowPng ? thumb : null) }).catch((error) => console.error("[feedback] first turn failed", error));
    return feedback;
  }

  // --- SDK 옵션과 권한 ---

  // 개선 세션은 사람 승인을 기다리지 않는다(bypassPermissions). 도구 집합은 줄여 두고, CLI 자체 안전 검사에 걸려 canUseTool 로 오는 호출도
  // 막지 않고 통과시킨다(전에는 여기서 거절돼 세션이 중간에 멈췄다). worktree 밖 파일 쓰기만 거절한다.
  // 사용자 settings.json 의 훅과 허용 목록은 돌지 않게 settingSources 를 비운다.
  options(agent: Agent): Partial<Options> | null {
    const feedback = agent.feedbackId ? this.items.get(agent.feedbackId) : null;
    if (!feedback) return null;
    const root = feedback.worktree;
    const dir = this.dir(feedback.id);
    return {
      settingSources: [],
      tools: ["Read", "Glob", "Grep", "Edit", "Write", "Bash"],
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      additionalDirectories: [dir],
      systemPrompt: SYSTEM_PROMPT,
      canUseTool: async (toolName, input) => {
        const path = typeof input.file_path === "string" ? input.file_path : null;
        if ((toolName === "Edit" || toolName === "Write") && (!path || !isInside(root, path))) return { behavior: "deny" as const, message: T.fbDeniedPath(String(path)) };
        return { behavior: "allow" as const, updatedInput: input };
      },
    };
  }

  // --- 턴이 끝난 뒤 ---

  // 사용자가 답을 보내 후속 턴이 시작됐다: 답을 기다리던(또는 변경 없음으로 끝난) 피드백이 다시 도는 중으로 돌아온다. 끝나면 afterTurn 이 평소처럼 검사와 반영을 탄다.
  // FBREBASE: 실패, 해결, 숨김 처리된 피드백도 사용자가 이어서 말하면 다시 도는 중이 된다(전에는 failed 로 보이는 채 턴이 돌았다).
  turnStarted(agentId: string) {
    const feedback = this.list().find((f) => f.agentId === agentId);
    if (!feedback || this.pipelines.has(feedback.id)) return;
    const status = feedback.status;
    if (status === "needsInput" || status === "noChanges" || status === "blocked" || status === "failed" || status === "resolved" || status === "dismissed") {
      this.set(feedback, { status: "running", question: null, failure: null, sessionFailed: false, ...(status === "blocked" ? { blockTries: 0 } : {}) });
    }
  }

  // FBREBASE: 사용자가 이어서 보내는 턴이 모델에 가기 전에 작업 폴더를 본 작업 폴더의 현재 상태에 맞춘다(agents.startTurn 이 기다린다).
  // 전에는 개선 세션이 처음 복사한 기준 위에서 계속 고쳐서, 그 사이 본 작업 폴더가 같은 줄을 바꿨거나 변경이 손으로 반영된 피드백은 턴이 끝날 때마다 같은 충돌로 반영 안 됨이 됐다.
  // - 본 폴더가 바꾼 파일을 작업 폴더에 가져오고 기준 해시도 같이 올린다(syncSource). 합치지 못한 파일은 본 폴더 내용으로 바꾸고 개선 세션의 버전은 피드백 폴더의 dropped 아래에 둔다.
  // - 해결(resolved) 처리된 피드백은 양쪽이 고친 파일에서 본 폴더가 이긴다(이미 본 폴더에 들어간 변경이라 다시 합치면 중복된다).
  // - 아직 반영 안 된 이 피드백만의 변경은 지우지 않고 본 폴더 위에 3-way 로 올린다.
  // 바꾼 파일이 있으면 모델에게만 가는 안내를 메시지 앞에 붙이고 대화에는 알림을 남긴다. 반영(applied)과 되돌림(reverted)은 건드리지 않는다: 후속 대화를 자동 반영하지 않고, 기준 해시가 변경 목록과 반영 내역의 근거라서다.
  async beforeTurn(agentId: string, prompt: string): Promise<string> {
    const feedback = this.list().find((f) => f.agentId === agentId);
    if (!feedback) return prompt;
    // 서버가 보내는 턴(첫 요청, 자동 수정, 재적용, 재시작 뒤 이어 가기)은 status 가 running 이나 fixing 이라 여기서 걸러진다.
    const status = feedback.status;
    if (this.pipelines.has(feedback.id) || status === "running" || status === "checking" || status === "fixing" || status === "applied" || status === "reverted") return prompt;
    if (!existsSync(feedback.worktree) || !existsSync(join(this.dir(feedback.id), "baseline.json"))) return prompt;
    this.pipelines.add(feedback.id);
    try {
      const landed = status === "resolved";
      const sync = await this.syncSource(feedback, { reset: true, landed });
      if (sync.reset.length === 0) return prompt;
      const dropped = join(this.dir(feedback.id), DROPPED);
      this.deps.agents.notice(feedback.agentId, T.fbSynced(sync.reset.map((f) => f.rel)));
      return `${T.fbSyncNote(landed, sync.reset, dropped)}\n\n${prompt}`;
    } finally {
      this.pipelines.delete(feedback.id);
    }
  }

  afterTurn(agentId: string) {
    const feedback = this.list().find((f) => f.agentId === agentId);
    if (!feedback || this.pipelines.has(feedback.id)) return;
    // 이미 반영했거나 되돌린 피드백의 후속 대화는 자동 반영하지 않는다.
    if (feedback.status === "applied" || feedback.status === "reverted") return;
    // FBREDO: 턴이 끝까지 돌았다. 재시작에 끊긴 횟수를 0 부터 다시 센다.
    if (feedback.resumeCount) this.set(feedback, { resumeCount: 0 });
    // 자동 수정으로 시작한 턴(fixing)이 아니면 처음 턴이거나 사용자가 보낸 턴이라 자동 수정 횟수를 다시 센다.
    // FBREBASE: 재적용 횟수도 같다(재적용 턴도 status 가 fixing 이다).
    if (feedback.status !== "fixing" && (feedback.fixAttempts || feedback.reapplyTries)) this.set(feedback, { fixAttempts: 0, reapplyTries: 0 });

    this.pipelines.add(feedback.id);
    void this.finalize(feedback)
      .catch((error) => this.fail(feedback, `${(error as Error).message}`))
      .finally(() => this.pipelines.delete(feedback.id));
  }

  // retry 면 개선 세션의 결과는 이미 나와 있으니 에러 확인을 건너뛴다.
  // 검사 전에 매번 본 작업 폴더의 현재 코드를 worktree 에 맞춘다(syncSource, 같은 파일을 둘 다 고쳤으면 3-way 병합). 검사와 반영 사이에 본 작업 폴더가 또 바뀌어 반영이 충돌하면 처음부터 한 번 더 돈다.
  private async finalize(feedback: Feedback, retry = false) {
    if (!retry && this.deps.store.agent(feedback.agentId).status === "error") {
      // FBBLOCK: 로그인 만료나 모델 서버 연결 실패는 코드 탓이 아니니 실패로 확정하지 않고 기다린다. 마지막 오류 항목의 auth 표시가 기준이다.
      const last = lastSessionError(this.deps.store.timeline(feedback.agentId));
      const kind = classifySessionError(last);
      if (kind === "auth") this.block(feedback, { reason: "auth", stage: "session", problem: T.fbBlockedAuth, detail: last?.text });
      else if (kind === "network") this.block(feedback, { reason: "environment", stage: "session", problem: T.fbProblemConnect, detail: last?.text });
      else {
        this.set(feedback, { sessionFailed: true });
        this.fail(feedback, T.fbErrAgent);
      }
      return;
    }
    for (let attempt = 1; ; attempt++) {
      this.set(feedback, { status: "checking", failure: null, checks: [] });
      let sync = await this.syncSource(feedback);
      // FBREBASE: 같은 줄 충돌만 남았고 재적용 횟수가 남았으면 실패로 끝내지 않는다. 충돌 파일을 본 폴더 내용으로 바꾸고 개선 세션이 그 위에 다시 적용하게 한다(그 턴이 끝나면 afterTurn 이 이 흐름을 처음부터 다시 돈다).
      if (sync.conflicts.length && this.canReapply(feedback) && sync.conflicts.every((c) => c.reason === T.fbConflictSameLines)) {
        sync = await this.syncSource(feedback, { reset: true, landed: false });
        if (sync.reset.length) {
          this.reapply(feedback, sync.reset);
          return;
        }
      }
      const stale = await this.checkAndApply(feedback, sync);
      if (!stale) return;
      if (attempt >= MAX_APPLY_ATTEMPTS) {
        this.failConflict(feedback, T.fbNotAppliedConflict(T.fbErrConflict(stale.join("\n"))));
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, this.deps.applyRetryWaitMs ?? APPLY_RETRY_WAIT_MS));
    }
  }

  // 검사 → 반영 한 바퀴. 끝났으면(반영, 재시작 대기, 실패 확정) null, 반영 직전 충돌이면 충돌 줄 목록을 돌려줘서 finalize 가 다시 돌게 한다.
  private async checkAndApply(feedback: Feedback, sync: SyncResult): Promise<string[] | null> {
    const changes = await this.diffWorktree(feedback);
    const files = changes.map((c) => c.rel);
    const needsRestart = files.some((f) => RESTART_DIRS.some((d) => f.startsWith(d)));
    this.set(feedback, { changedFiles: files, needsRestart, summary: this.summaryOf(feedback) });
    if (files.length === 0) {
      // 바꾼 것이 없는데 마지막 답이 사용자에게 묻는 말이면 끝난 것이 아니라 답을 기다리는 것이다. 질문 자체가 세션의 마지막 말풍선이라 타임라인 알림은 덧붙이지 않는다.
      const question = this.questionOf(feedback);
      if (question) {
        this.set(feedback, { status: "needsInput", question, failure: null });
        return null;
      }
      this.set(feedback, { status: "noChanges", question: null, failure: null });
      this.deps.agents.notice(feedback.agentId, T.fbNoChanges);
      return null;
    }
    if (files.some((f) => NEVER_APPLY.has(f))) {
      this.fail(feedback, T.fbErrDependency);
      return null;
    }
    // 병합이 못 합친 파일이 있으면 검사를 돌려도 반영은 충돌이다. 검사 전에 실패시키고, 병합을 검사 한 줄로 남겨 Retry 가 보이게 한다.
    if (sync.conflicts.length) {
      this.failMerge(
        feedback,
        sync.conflicts.map((c) => `${c.rel} (${c.reason})`),
      );
      return null;
    }

    const specs = this.deps.checks ?? CHECKS;
    // FBBLOCK: 검사를 돌리기 전에 npm 같은 실행 파일을 PATH 에서 실제로 찾아 본다. 없으면 로그인 셸을 다시 읽고 한 번 더 찾고, 그래도 없으면 검사를 돌리지 않고 기다린다.
    const { env, missing } = await this.preflight(specs);
    if (missing) {
      const detail = T.fbSearchedPath(env.PATH ?? "");
      this.set(feedback, { checks: [{ name: T.fbEnvCheck, ok: false, output: `${T.fbProblemTool(missing)}\n${detail}` }] });
      this.block(feedback, { reason: "environment", stage: "checks", problem: T.fbProblemTool(missing), detail });
      return null;
    }
    // 검사는 데몬 전체에서 한 번에 하나만 돈다. 둘 이상이 겹치면 tsc, build, 시험 프로세스 수십 개가 CPU 와 시험 데몬 부팅 시간을 다퉈 시간 초과로 떨어지고, 같은 기준선을 두 번 돌린다.
    const outcome = await exclusive(() => this.runChecks(feedback, specs, env));
    // 환경이나 인증 오류는 코드로 고칠 수 없다. 기준선과 견주지도, 자동 수정 턴을 보내지도 않는다.
    if (outcome.blocked) {
      this.block(feedback, { stage: "checks", ...outcome.blocked });
      return null;
    }
    if (outcome.failed) {
      const { spec, result, verdict } = outcome.failed;
      const done = feedback.fixAttempts ?? 0;
      // 기준선과 견줘 이 피드백 탓이 확인된 실패만 개선 세션에 되돌려 보낸다. 기준선을 못 돌린 경우는 피드백 탓인지 모르니 사람이 본다.
      if (verdict.judged && done < this.maxAutoFixes()) return this.autoFix(feedback, spec, result, verdict, done + 1);
      const shown = verdict.ignored ? verdict.fresh.map((f) => f.text).join("\n") : result.output;
      this.fail(feedback, T.fbNotApplied(spec.name, shown, done), { label: T.fbBaselineLabel, text: verdict.summary });
      return null;
    }
    const checks = outcome.checks;

    if (needsRestart) {
      this.set(feedback, { status: "awaitingRestart", failure: null });
      this.deps.agents.notice(feedback.agentId, T.fbAwaitingRestart(ignoredOf(checks)), undefined, foldOf(checks));
      return null;
    }
    return this.applyOnce(feedback);
  }

  // 검사를 차례로 돌려 기록한다. 이 피드백 탓의 새 실패가 나오면 거기서 멈추고 돌려준다.
  private async runChecks(feedback: Feedback, specs: CheckSpec[], env: NodeJS.ProcessEnv) {
    const checks: FeedbackCheck[] = [];
    // 기준선 사본은 실패가 나서 필요해질 때 한 번만 만들고, 이 검사 묶음이 끝나면 지운다.
    const base: { dir: string | null } = { dir: null };
    try {
      for (const spec of specs) {
        const result = await runCheck(spec, feedback.worktree, env);
        if (result.ok) {
          checks.push({ name: spec.name, ok: true, output: result.output });
          this.set(feedback, { checks: [...checks] });
          continue;
        }
        // FBBLOCK: 기준선 비교 전에 가른다. npx 를 못 찾아 실패한 tsc 는 오류 목록이 비어 있어 기준선과 견주면 통과로 보였다.
        if (result.kind && result.kind !== "code") {
          checks.push({ name: spec.name, ok: false, output: result.output });
          this.set(feedback, { checks: [...checks] });
          return { checks, failed: null, blocked: blockOf(result.kind, result.output) };
        }
        const verdict = await this.judgeFailure(feedback, spec, specs, result, env, base);
        const fresh = verdict.fresh.length > 0;
        checks.push({ name: spec.name, ok: !fresh, output: result.output, ignored: verdict.ignored || undefined, baseline: verdict.summary });
        this.set(feedback, { checks: [...checks] });
        if (fresh) return { checks, failed: { spec, result, verdict }, blocked: null };
      }
    } finally {
      if (base.dir) await rm(base.dir, { recursive: true, force: true });
    }
    return { checks, failed: null, blocked: null };
  }

  private maxAutoFixes() {
    return this.deps.autoFixes ?? MAX_AUTO_FIXES;
  }

  private maxReapplies() {
    return this.deps.reapplies ?? MAX_REAPPLIES;
  }

  // FBREBASE: 개선 세션이 살아 있고(세션 기록이 있는 에이전트) 재적용 횟수가 남았는가
  private canReapply(feedback: Feedback) {
    if ((feedback.reapplyTries ?? 0) >= this.maxReapplies()) return false;
    try {
      this.deps.store.agent(feedback.agentId);
      return true;
    } catch {
      return false;
    }
  }

  // 병합이 못 합친 파일로 실패를 확정한다. 병합을 검사 한 줄로 남겨 Merge Again 이 보이게 한다.
  private failMerge(feedback: Feedback, lines: string[]) {
    this.set(feedback, { checks: [{ name: T.fbMergeCheck, ok: false, output: lines.join("\n") }] });
    this.failConflict(feedback, T.fbNotAppliedConflict(T.fbErrConflict(lines.join("\n"))));
  }

  // FBREBASE: 충돌한 파일을 본 작업 폴더 내용으로 바꿔 둔 채(syncSource reset), 개선 세션에 그 위에 변경을 다시 적용하라고 후속 메시지를 보낸다. autoFix 와 같은 모양이다: 보낸 뒤에는 기다리지 않고, 그 턴이 끝나면 afterTurn 이 검사부터 다시 탄다.
  // status 는 autoFix 와 같은 fixing 이고 reapplying 표시로 갈라 배지와 알림 문구가 "다시 적용하는 중" 으로 읽힌다.
  private reapply(feedback: Feedback, files: { rel: string; reason: string }[]) {
    const attempt = (feedback.reapplyTries ?? 0) + 1;
    const max = this.maxReapplies();
    this.set(feedback, { status: "fixing", reapplying: true, reapplyTries: attempt, failure: null, checks: [], conflict: false });
    this.deps.agents.notice(feedback.agentId, T.fbReapplying(attempt, max));
    void this.droppedDiff(feedback, files)
      .then((diff) => this.deps.agents.send(feedback.agentId, T.fbReapplyPrompt(attempt, max, files, join(this.dir(feedback.id), DROPPED), diff), { display: T.fbReapplyShown(attempt, max) }))
      .catch((error) => this.failMerge(feedback, [...files.map((f) => `${f.rel} (${f.reason})`), (error as Error).message]));
  }

  // 개선 세션이 시작했을 때의 버전과 개선 세션의 버전 사이 diff. 파일마다 앞부분만 두고 전체는 길이로 자른다(개선 세션이 옛 버전 파일을 직접 읽을 수도 있다).
  private async droppedDiff(feedback: Feedback, files: { rel: string }[]) {
    const dir = this.dir(feedback.id);
    const parts: string[] = [];
    for (const { rel } of files) {
      const from = existsSync(join(dir, DROPPED_FROM, rel)) ? join(DROPPED_FROM, rel) : "/dev/null";
      const to = existsSync(join(dir, DROPPED, rel)) ? join(DROPPED, rel) : "/dev/null";
      if (from === "/dev/null" && to === "/dev/null") continue;
      try {
        await execFileAsync("git", [...gitOps.GIT_PATH_FLAGS, "diff", "--no-index", "--no-color", "-U2", "--", from, to], { cwd: dir, maxBuffer: 16 * 1024 * 1024 });
      } catch (error) {
        // 차이가 있으면 git 이 종료 코드 1 로 끝나고 diff 는 stdout 에 있다.
        parts.push(String((error as { stdout?: string }).stdout ?? "").trim());
      }
    }
    const text = parts.filter(Boolean).join("\n");
    return text.length > 6000 ? `${text.slice(0, 6000)}\n…` : text;
  }

  // 새 실패를 개선 세션에 고치라는 후속 메시지로 보낸다. 보낸 뒤에는 기다리지 않는다: 그 턴이 끝나면 afterTurn 이 평소처럼 검사와 반영을 다시 탄다.
  private autoFix(feedback: Feedback, spec: CheckSpec, result: CheckRun, verdict: { fresh: CheckFailure[]; summary: string }, attempt: number): null {
    this.set(feedback, { status: "fixing", fixAttempts: attempt, failure: null });
    this.deps.agents.notice(feedback.agentId, T.fbFixing(attempt, this.maxAutoFixes(), spec.name));
    const message = T.fbFixPrompt(spec.name, verdict.fresh.map((f) => f.text).join("\n").slice(0, 2000), result.output, attempt, this.maxAutoFixes());
    void this.deps.agents
      .send(feedback.agentId, message, { display: T.fbFixShown(spec.name, attempt, this.maxAutoFixes()) })
      .catch((error) => this.fail(feedback, T.fbNotApplied(spec.name, (error as Error).message, attempt - 1)));
    return null;
  }

  // CHKBASE: 실패한 검사를 피드백 변경 없는 상태(기준선)의 같은 검사와 견준다. 기준선에도 있던 실패는 무시하고, 새로 생긴 것만 fresh 로 돌려준다.
  // 기준선 결과는 기준 상태의 파일 해시로 캐시한다. 기준선을 못 돌리면 모든 실패를 피드백 탓으로 본다(닫히는 쪽).
  private async judgeFailure(feedback: Feedback, spec: CheckSpec, specs: CheckSpec[], result: CheckRun, env: NodeJS.ProcessEnv, base: { dir: string | null }) {
    try {
      const outcome = await this.baselineOutcome(feedback, spec, specs, env, base);
      if (outcome.ok) return { fresh: result.failures, ignored: 0, judged: true, summary: "This check passes without this feedback's changes." };
      let fresh = newFailures(result.failures, outcome.failures);
      // 실패한 build 는 반영할 dist/ 를 못 만든다. 기준선도 실패였더라도 반영 단계가 깨지니 무시하지 않는다.
      if (spec.kind === "build" && !existsSync(join(feedback.worktree, "dist/index.html"))) fresh = result.failures;
      const ignoredList = result.failures.filter((f) => !fresh.includes(f));
      const head = [
        "This check also fails without this feedback's changes.",
        ...(ignoredList.length ? [`Ignored (${ignoredList.length}):`, ...ignoredList.map((f) => f.text)] : []),
        "",
        "Output without the feedback:",
      ].join("\n");
      // 실패 줄은 출력 맨 아래에 있으므로 길면 머리말을 두고 기준선 출력의 앞을 자른다.
      const room = Math.max(MAX_OUTPUT - head.length - 1, 500);
      const body = outcome.output.length > room ? `…${outcome.output.slice(-room)}` : outcome.output;
      return { fresh, ignored: ignoredList.length, judged: true, summary: `${head}\n${body}` };
    } catch (error) {
      return { fresh: result.failures, ignored: 0, judged: false, summary: `The baseline run did not finish: ${(error as Error).message}` };
    }
  }

  private async baselineOutcome(feedback: Feedback, spec: CheckSpec, specs: CheckSpec[], env: NodeJS.ProcessEnv, base: { dir: string | null }): Promise<CheckOutcome> {
    const key = baselineKey(await this.baseline(feedback));
    const cached = readBaselineCache(BASELINE_CACHE_DIR, key)[spec.name];
    if (cached) return cached;
    base.dir ??= await this.materializeBase(feedback);
    const before = spec.after ? specs.find((s) => s.name === spec.after) : undefined;
    if (before && !existsSync(join(base.dir, "dist/index.html"))) writeBaselineCache(BASELINE_CACHE_DIR, key, before.name, outcomeOf(await runCodeCheck(before, base.dir, env)));
    const outcome = outcomeOf(await runCodeCheck(spec, base.dir, env));
    writeBaselineCache(BASELINE_CACHE_DIR, key, spec.name, outcome);
    return outcome;
  }

  // 피드백 변경을 뺀 파일 사본: baseline.json 의 blob 으로 채운다. 피드백이 안 건드린 파일은 worktree 에서 그대로 복사하고, 바뀐 파일만 객체 저장소에서 꺼낸다.
  private async materializeBase(feedback: Feedback) {
    const dir = join(this.dir(feedback.id), "base");
    await rm(dir, { recursive: true, force: true });
    const baseline = await this.baseline(feedback);
    for (const [rel, sha] of Object.entries(baseline)) {
      const target = join(dir, rel);
      await mkdir(dirname(target), { recursive: true });
      const mine = join(feedback.worktree, rel);
      if ((await hashFile(mine)) === sha) await copyFile(mine, target);
      else {
        await writeFile(target, await catBlob(this.deps.srcRoot, sha));
      }
    }
    if (existsSync(join(this.deps.srcRoot, "node_modules"))) await symlink(join(this.deps.srcRoot, "node_modules"), join(dir, "node_modules"));
    // 시험이 소스 폴더를 git 저장소로 기대하므로(feedback.create 등) 사본도 빈 저장소로 만든다. .git 이 없으면 사본에서만 그 시험이 떨어졌다.
    await gitOps.git(dir, ["init", "-q"]);
    return dir;
  }

  // --- 검사 다시 돌리기 ---

  // 검사 단계에서 실패한 피드백의 검사만 다시 돌린다. 개선 세션은 건드리지 않고, 통과하면 finalize 의 나머지(반영 또는 재시작 대기)를 그대로 탄다.
  // FBBLOCK: 환경이나 인증 때문에 검사 단계에서 기다리는 중(blocked)인 것도 자동 재시도를 기다리지 않고 지금 다시 돌릴 수 있다.
  retryChecks(id: string) {
    const feedback = this.get(id);
    if (feedback.status !== "failed" && feedback.status !== "blocked") throw new Error(T.fbErrRetryState);
    if (!canRetryChecks(feedback)) throw new Error(T.fbErrRetryNotChecks);
    if (!existsSync(feedback.worktree) || !existsSync(join(this.dir(id), "baseline.json"))) throw new Error(T.fbErrRetryNoWorktree);
    const agentStatus = this.deps.store.agent(feedback.agentId).status;
    if (this.pipelines.has(id) || agentStatus === "running" || agentStatus === "waiting") throw new Error(T.fbErrRetryBusy);
    this.set(feedback, { blockTries: 0 });
    this.rerunChecks(feedback, true);
    this.deps.agents.notice(feedback.agentId, T.fbRetrying);
    return feedback;
  }

  // 개선 세션은 건드리지 않고 검사부터 다시 돈다. manual 이면 알림에 "Checking…" 이 뜬다(retrying), 자동 재시도는 조용히 돈다.
  private rerunChecks(feedback: Feedback, manual: boolean) {
    this.pipelines.add(feedback.id);
    this.set(feedback, { status: "checking", failure: null, checks: [], retrying: manual, fixAttempts: 0 });
    void this.finalize(feedback, true)
      .catch((error) => this.fail(feedback, `${(error as Error).message}`))
      .finally(() => this.pipelines.delete(feedback.id));
  }

  // --- 환경이나 인증 때문에 멈췄을 때 (FBBLOCK) ---

  // 멈춘 이유를 사람 말로 남기고 스스로 다시 시도하게 한다. 환경 오류는 1분, 5분, 15분 뒤에 PATH 를 다시 읽고, 인증 오류는 로그인이 돌아온 것이 확인되면 다시 시작한다.
  // 시도 횟수를 다 쓰면 실패로 확정하고, 단추(Retry Checks, Run Again)로 사람이 다시 돌리게 한다.
  private block(feedback: Feedback, b: { reason: "environment" | "auth"; stage: "checks" | "session"; problem: string; detail?: string }) {
    const tries = feedback.blockTries ?? 0;
    const delay = b.reason === "environment" ? envRetryDelay(tries, this.deps.retryDelaysMs) : null;
    const exhausted = b.reason === "environment" ? delay === null : !authRetriesLeft(tries);
    const detail = b.detail?.trim() ? tail(b.detail) : "";
    if (exhausted) {
      const head = T.fbBlockedGaveUp(b.reason, b.stage, b.problem, tries);
      // 검사 전에 멈춘 항목도 Retry Checks 가 보이게 검사 한 줄을 남긴다(병합 충돌과 같은 방식).
      if (b.stage === "checks" && feedback.checks.length === 0) this.set(feedback, { checks: [{ name: T.fbEnvCheck, ok: false, output: detail || b.problem }] });
      if (b.stage === "session") this.set(feedback, { sessionFailed: true });
      this.fail(feedback, detail ? `${head}\n${detail}` : head);
      return;
    }
    const head = b.reason === "auth" ? T.fbBlockedAuth : T.fbBlockedWait(b.stage, b.problem);
    const nextRetryAt = delay === null ? null : new Date(Date.now() + delay).toISOString();
    this.set(feedback, { status: "blocked", blocked: { reason: b.reason, stage: b.stage, nextRetryAt }, failure: detail ? `${head}\n${detail}` : head, ...(tries > 0 ? { seen: true } : {}) });
    // 다시 막힐 때마다 알림을 쌓지 않는다. 처음 한 번만 대화에 남긴다.
    if (tries === 0) this.deps.agents.notice(feedback.agentId, head, detail || undefined);
    this.arm(feedback);
  }

  private arm(feedback: Feedback) {
    this.disarm(feedback.id);
    const b = feedback.blocked;
    if (feedback.status !== "blocked" || !b) return;
    if (b.reason === "auth") {
      this.armAuthWatch();
      return;
    }
    const wait = Math.max(0, Date.parse(b.nextRetryAt ?? "") - Date.now()) || 0;
    const timer = setTimeout(() => {
      this.blockTimers.delete(feedback.id);
      void this.resumeBlocked(feedback);
    }, wait);
    timer.unref();
    this.blockTimers.set(feedback.id, timer);
  }

  private disarm(id: string) {
    const timer = this.blockTimers.get(id);
    if (timer) clearTimeout(timer);
    this.blockTimers.delete(id);
  }

  // 기다리던 항목을 다시 돌린다. 검사 단계는 PATH 를 다시 읽고 검사부터, 세션 단계는 새 개선 세션으로(Run Again 과 같은 길, 횟수는 이어받는다).
  private async resumeBlocked(feedback: Feedback) {
    const b = feedback.blocked;
    if (feedback.status !== "blocked" || !b || this.pipelines.has(feedback.id) || !this.items.has(feedback.id)) return;
    try {
      this.deps.store.agent(feedback.agentId);
    } catch {
      return;
    }
    this.set(feedback, { blockTries: (feedback.blockTries ?? 0) + 1 });
    try {
      if (b.stage === "session") {
        if (b.reason === "auth") this.deps.agents.notice(feedback.agentId, T.fbAuthResumed);
        await this.runAgain(feedback.id, true);
        return;
      }
      if (!existsSync(feedback.worktree) || !existsSync(join(this.dir(feedback.id), "baseline.json"))) throw new Error(T.fbErrRetryNoWorktree);
      if (b.reason === "environment") await this.checkEnv(true);
      this.rerunChecks(feedback, false);
    } catch (error) {
      this.fail(feedback, `${(error as Error).message}`);
    }
  }

  private armAuthWatch() {
    if (this.authTimer) return;
    this.authTimer = setInterval(() => void this.checkAuthNow(false), this.deps.authProbeMs ?? AUTH_PROBE_MS);
    this.authTimer.unref();
  }

  private authWaiting() {
    return this.list().filter((f) => f.status === "blocked" && f.blocked?.reason === "auth");
  }

  // 인증이 돌아왔는지 본다. restored 면 다른 세션이 방금 모델 턴을 성공해서 이미 아는 것이니 확인을 건너뛴다.
  async checkAuthNow(restored: boolean) {
    const waiting = this.authWaiting();
    if (waiting.length === 0 || this.probing) {
      if (waiting.length === 0 && this.authTimer) this.stopAuthWatch();
      return;
    }
    this.probing = true;
    try {
      if (restored || (await (this.deps.authProbe ?? probeClaudeAuth)())) for (const feedback of waiting) await this.resumeBlocked(feedback);
    } finally {
      this.probing = false;
      if (this.authWaiting().length === 0) this.stopAuthWatch();
    }
  }

  // 데몬 어딘가에서 모델 턴이 성공했다(로그인이 살아 있다). 인증 때문에 기다리는 피드백이 있으면 바로 다시 시작한다.
  authRestored() {
    void this.checkAuthNow(true);
  }

  private stopAuthWatch() {
    if (this.authTimer) clearInterval(this.authTimer);
    this.authTimer = null;
  }

  // 검사에 필요한 실행 파일을 찾는다. 첫 PATH 에 없으면 로그인 셸을 다시 읽고 한 번 더 찾는다.
  private async preflight(specs: CheckSpec[]): Promise<{ env: NodeJS.ProcessEnv; missing: string | null }> {
    let env = await this.checkEnv();
    let missing = firstMissing(specs, env.PATH);
    if (missing) {
      env = await this.checkEnv(true);
      missing = firstMissing(specs, env.PATH);
    }
    return { env, missing };
  }

  // 본 작업 폴더의 현재 코드를 worktree 에 맞추고 기준 해시도 같이 올린다. 그래야 검사가 "본 작업 폴더의 지금 코드 + 이 피드백의 변경"을 본다(= 반영 뒤 모습).
  // - 피드백이 손대지 않은 파일: 본 작업 폴더의 내용으로 덮는다.
  // - 둘 다 고친 파일: base(baseline.json 의 blob) / ours(worktree) / theirs(본 작업 폴더)로 git merge-file 3-way 병합. 충돌이 없으면 병합 결과를 worktree 에 쓰고 기준 해시를 본 작업 폴더의 현재 내용으로 올린다.
  //   충돌, 바이너리, 새 파일, 삭제는 합치지 않고 conflicts 로 돌려준다(파일은 그대로, 반영 단계의 충돌 검사가 막는다).
  //   FBREBASE: mode.reset 이면 합치지 못한 파일을 충돌로 남기지 않고 본 작업 폴더 내용으로 바꾼다(개선 세션의 버전은 dropped 로 옮기고, 기준 해시도 본 폴더 내용으로 올린다). 본 폴더가 지운 파일은 작업 폴더에서도 지운다.
  //   mode.landed 면 양쪽이 고친 파일을 합치지 않고 본 작업 폴더가 이긴다.
  private async syncSource(feedback: Feedback, mode: SyncMode = { reset: false, landed: false }): Promise<SyncResult> {
    const src = this.deps.srcRoot;
    const baseline = await this.baseline(feedback);
    const listed = new Set((await gitOps.git(src, ["ls-files", "-co", "--exclude-standard", "-z"])).split("\0").filter(Boolean));
    const result: SyncResult = { conflicts: [], reset: [] };
    let dirty = false;
    // 기준 blob 으로 올릴 파일: file 은 본 작업 폴더에서 읽은 내용 그대로(병합 때는 읽은 시점의 사본)
    const adopt: { rel: string; file: string }[] = [];
    const scratch = join(this.dir(feedback.id), "merge");
    try {
      for (const rel of listed) {
        const from = join(src, rel);
        if (!existsSync(from) || !lstatSync(from).isFile()) continue;
        const known = baseline[rel] ?? null;
        const theirs = await hashFile(from);
        if (theirs === known) continue;
        const mine = join(feedback.worktree, rel);
        const mineHash = await hashFile(mine);
        if (mineHash === known) {
          await mkdir(dirname(mine), { recursive: true });
          await copyFile(from, mine);
          adopt.push({ rel, file: from });
        } else if (mineHash === theirs) adopt.push({ rel, file: from });
        else if (mode.landed) {
          await this.setAside(feedback, rel, known, mineHash);
          await mkdir(dirname(mine), { recursive: true });
          await copyFile(from, mine);
          adopt.push({ rel, file: from });
          result.reset.push({ rel, reason: T.fbConflictLanded });
        } else {
          const merged = await this.mergeBoth(known, mineHash, from, mine, scratch, adopt.length);
          if ("reason" in merged && mode.reset) {
            await this.setAside(feedback, rel, known, mineHash);
            await mkdir(dirname(mine), { recursive: true });
            await copyFile(from, mine);
            adopt.push({ rel, file: from });
            result.reset.push({ rel, reason: merged.reason });
          } else if ("reason" in merged) result.conflicts.push({ rel, reason: merged.reason });
          else {
            await writeFile(mine, merged.content);
            adopt.push({ rel, file: merged.theirsCopy });
          }
        }
      }
      // 피드백이 고친 파일을 본 작업 폴더가 지웠으면 합칠 수 없다.
      for (const [rel, known] of Object.entries(baseline)) {
        if (listed.has(rel) || existsSync(join(src, rel))) continue;
        const mineHash = await hashFile(join(feedback.worktree, rel));
        if (mineHash === null || mineHash === known) continue;
        if (mode.reset || mode.landed) {
          await this.setAside(feedback, rel, known, mineHash);
          await rm(join(feedback.worktree, rel), { force: true });
          delete baseline[rel];
          dirty = true;
          result.reset.push({ rel, reason: mode.landed ? T.fbConflictLanded : T.fbConflictMainDeleted });
        } else result.conflicts.push({ rel, reason: T.fbConflictMainDeleted });
      }
      if (adopt.length) {
        const hashes = await hashObjects(src, adopt.map((a) => a.file));
        adopt.forEach((a, i) => (baseline[a.rel] = hashes[i]));
        dirty = true;
      }
      if (dirty) {
        // 기준 해시는 변경 목록, 반영, 되돌리기의 근거라 반쪽 파일이 남지 않게 임시 파일에 쓴 뒤 바꾼다.
        const file = join(this.dir(feedback.id), "baseline.json");
        await writeFile(`${file}.${process.pid}.tmp`, JSON.stringify(baseline));
        await rename(`${file}.${process.pid}.tmp`, file);
      }
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
    return result;
  }

  // FBREBASE: 본 작업 폴더에 자리를 내주는 파일의 개선 세션 버전(dropped)과 개선 세션이 시작했을 때의 버전(dropped-from)을 피드백 폴더에 둔다. 개선 세션이 다시 적용할 때 읽는다.
  private async setAside(feedback: Feedback, rel: string, known: string | null, mineHash: string | null) {
    const dir = this.dir(feedback.id);
    const mine = join(dir, DROPPED, rel);
    const from = join(dir, DROPPED_FROM, rel);
    await mkdir(dirname(mine), { recursive: true });
    await mkdir(dirname(from), { recursive: true });
    if (mineHash !== null) await copyFile(join(feedback.worktree, rel), mine);
    else await rm(mine, { force: true });
    if (known) await writeFile(from, await catBlob(this.deps.srcRoot, known));
    else await rm(from, { force: true });
  }

  // 한 파일의 3-way 병합. 합쳐지면 병합 결과와 theirs 사본 경로(기준 blob 으로 쓸 내용), 못 합치면 이유.
  private async mergeBoth(known: string | null, mineHash: string | null, from: string, mine: string, scratch: string, index: number): Promise<{ content: Buffer; theirsCopy: string } | { reason: string }> {
    if (known === null) return { reason: T.fbConflictBothNew };
    if (mineHash === null) return { reason: T.fbConflictFeedbackDeleted };
    const [base, ours, theirs] = await Promise.all([catBlob(this.deps.srcRoot, known), readFile(mine), readFile(from)]);
    if ([base, ours, theirs].some((data) => data.includes(0))) return { reason: T.fbConflictBinary };
    await mkdir(scratch, { recursive: true });
    const files = { ours: join(scratch, "ours"), base: join(scratch, "base"), theirs: join(scratch, `theirs-${index}`) };
    await Promise.all([writeFile(files.ours, ours), writeFile(files.base, base), writeFile(files.theirs, theirs)]);
    try {
      const { stdout } = await execFileAsync("git", ["merge-file", "-p", "-L", "feedback", "-L", "start", "-L", "main", files.ours, files.base, files.theirs], { maxBuffer: 64 * 1024 * 1024, encoding: "buffer" });
      return { content: stdout, theirsCopy: files.theirs };
    } catch (error) {
      // 종료 코드가 충돌 개수(1 이상 127 이하)면 같은 줄 충돌, 그 밖은 병합을 못 끝낸 것.
      const code = (error as { code?: unknown }).code;
      return { reason: typeof code === "number" && code > 0 && code < 128 ? T.fbConflictSameLines : T.fbConflictMergeFailed };
    }
  }

  // --- 반영 ---

  // 재시작 대기에서 풀려난 반영: 충돌하면 바로 실패로 확정한다(다시 돌리는 건 Retry).
  private async apply(feedback: Feedback) {
    const stale = await this.applyOnce(feedback);
    if (stale) this.failConflict(feedback, T.fbNotAppliedConflict(T.fbErrConflict(stale.join("\n"))));
  }

  // 백업(수정 전 파일과 dist) → 파일 복사 → worktree 에서 검증한 dist 로 교체 → 화면 다시 읽기.
  // 시작 뒤 본 작업 폴더에서 같은 파일이 바뀌었으면 아무것도 쓰지 않고 충돌 줄 목록을 돌려준다.
  private async applyOnce(feedback: Feedback): Promise<string[] | null> {
    if (this.applying) throw new Error(T.fbErrBusyApply);
    this.applying = true;
    try {
      const src = this.deps.srcRoot;
      const dir = this.dir(feedback.id);
      const baseline = await this.baseline(feedback);
      const changes = await this.diffWorktree(feedback);
      const conflicts: string[] = [];
      for (const change of changes) {
        const current = await hashFile(join(src, change.rel));
        if (current !== (baseline[change.rel] ?? null)) conflicts.push(`${change.rel} (${current === null ? T.fbConflictMainDeleted : T.fbConflictAgain})`);
      }
      if (conflicts.length) return conflicts;

      const manifest: Manifest = { appliedAt: new Date().toISOString(), files: [], hadDist: existsSync(join(src, "dist")), hadDistElectron: existsSync(join(src, "dist-electron")) };
      for (const change of changes) {
        const target = join(src, change.rel);
        const existed = existsSync(target);
        if (existed) {
          await mkdir(dirname(join(dir, "backup", change.rel)), { recursive: true });
          await copyFile(target, join(dir, "backup", change.rel));
        }
        manifest.files.push({ rel: change.rel, existed, applied: change.status === "D" ? null : await hashFile(join(feedback.worktree, change.rel)) });
      }
      await rm(join(dir, "backup-dist"), { recursive: true, force: true });
      await rm(join(dir, "backup-dist-electron"), { recursive: true, force: true });
      if (manifest.hadDist) await cp(join(src, "dist"), join(dir, "backup-dist"), { recursive: true });
      if (manifest.hadDistElectron) await cp(join(src, "dist-electron"), join(dir, "backup-dist-electron"), { recursive: true });
      await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));

      for (const change of changes) {
        const target = join(src, change.rel);
        if (change.status === "D") await rm(target, { force: true });
        else {
          await mkdir(dirname(target), { recursive: true });
          await copyFile(join(feedback.worktree, change.rel), target);
        }
      }
      await swapDir(join(feedback.worktree, "dist"), join(src, "dist"));
      if (existsSync(join(feedback.worktree, "dist-electron"))) await swapDir(join(feedback.worktree, "dist-electron"), join(src, "dist-electron"));

      // 설치된 앱의 데몬은 이제부터 소스 폴더의 dist/ 를 서빙한다.
      writeFileSync(join(FEEDBACK_DIR, "live-dist"), "");
      const summary = feedback.summary ?? feedback.text.slice(0, 80);
      this.set(feedback, { status: "applied", failure: null, summary, restartRequested: false });
      this.deps.agents.notice(feedback.agentId, T.fbApplied(summary, ignoredOf(feedback.checks)), undefined, foldOf(feedback.checks));
      if (!feedback.needsRestart) this.deps.emit({ type: "reload", restarting: false });
      return null;
    } finally {
      this.applying = false;
    }
  }

  // --- 되돌리기 ---

  // 이 피드백이 바꾼 파일만 수정 전으로 돌리고, 반영 때 백업해 둔 dist 로 되돌려 화면에 반영한다(같은 소스를 다시 빌드한 결과와 같다).
  async revert(id: string) {
    const feedback = this.get(id);
    if (feedback.status !== "applied") throw new Error(T.fbErrNotApplied);
    if (this.applying) throw new Error(T.fbErrBusyApply);
    this.applying = true;
    try {
      const src = this.deps.srcRoot;
      const dir = this.dir(id);
      if (existsSync(join(dir, BACKUP_PRUNED))) throw new Error(T.fbErrBackupPruned);
      const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")) as Manifest;
      const newer = this.list().find((f) => f.id !== id && f.status === "applied" && this.appliedAt(f) > manifest.appliedAt);
      if (newer) throw new Error(T.fbErrNewerApplied(newer.id));
      const conflicts: string[] = [];
      for (const file of manifest.files) {
        if ((await hashFile(join(src, file.rel))) !== file.applied) conflicts.push(file.rel);
      }
      if (conflicts.length) throw new Error(T.fbErrRevertConflict(conflicts.join("\n")));

      for (const file of manifest.files) {
        const target = join(src, file.rel);
        if (file.existed) {
          await mkdir(dirname(target), { recursive: true });
          await copyFile(join(dir, "backup", file.rel), target);
        } else await rm(target, { force: true });
      }
      if (manifest.hadDist) await swapDir(join(dir, "backup-dist"), join(src, "dist"));
      if (manifest.hadDistElectron) await swapDir(join(dir, "backup-dist-electron"), join(src, "dist-electron"));
      this.set(feedback, { status: "reverted", seen: !feedback.needsRestart, restartPending: feedback.needsRestart });
      this.deps.agents.notice(feedback.agentId, feedback.needsRestart ? T.fbRestartNeeded : T.fbReverted);
      // 되돌리기는 사람이 누른 것이라 바로 읽는다. 반영(applyOnce)은 화면이 쉬는 틈에 모아서 읽는다.
      if (!feedback.needsRestart) this.deps.emit({ type: "reload", restarting: false, immediate: true });
      return feedback;
    } finally {
      this.applying = false;
    }
  }

  private appliedAt(feedback: Feedback) {
    try {
      return (JSON.parse(readFileSync(join(this.dir(feedback.id), "manifest.json"), "utf8")) as Manifest).appliedAt;
    } catch {
      return "";
    }
  }

  // --- 데몬 재시작 ---

  // 재시작을 요청하면 진행 중인 턴이 없을 때까지 기다린다. 조건이 되면 (아직이면) 반영하고 데몬을 다시 띄운다.
  requestRestart(id: string) {
    const feedback = this.get(id);
    if (feedback.status !== "awaitingRestart" && !feedback.restartPending) throw new Error(T.fbErrNotApplied);
    this.set(feedback, { restartRequested: true });
    this.pollRestart(feedback);
    return feedback;
  }

  private pollRestart(feedback: Feedback) {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    if (!feedback.restartRequested) return;
    if (this.deps.busyCount() > 0 || this.applying) {
      this.restartTimer = setTimeout(() => this.pollRestart(feedback), 1000);
      return;
    }
    void (async () => {
      try {
        if (feedback.status === "awaitingRestart") await this.apply(feedback);
        if (feedback.status === "applied" || feedback.restartPending) {
          // 화면에 다시 읽으라고 알리는 일은 데몬의 재시작 합류점이 실제로 재시작할 때 한다. 쿨다운에 걸리면 그때까지 재시작 대기 표시를 유지한다.
          const outcome = this.deps.restart();
          const deferred = !!outcome && outcome.deferred;
          // 미뤄진 동안은 되돌린 항목의 재시작 대기 표시를 유지한다(목록과 뱃지가 restartPending 으로 판단한다). 새 데몬이 뜨면 settleOnStart 가 지운다.
          this.set(feedback, { restartRequested: deferred, restartPending: feedback.restartPending && deferred });
        }
      } catch (error) {
        this.fail(feedback, (error as Error).message);
      }
    })();
  }

  // --- 변경 목록 (변경 패널용) ---

  // worktree 사본과 시작 시점 기준을 비교한 변경 파일. 기준 커밋이 없는 레포에서도 같은 방식으로 된다.
  async changes(feedbackId: string): Promise<ChangedFile[]> {
    const feedback = this.get(feedbackId);
    // 정리돼 사본이 없는 피드백(tidyRun)은 변경 목록이 비어 있다.
    if (!existsSync(feedback.worktree)) return [];
    const changes = await this.diffWorktree(feedback);
    const files: ChangedFile[] = [];
    for (const change of changes) {
      const path = join(feedback.worktree, change.rel);
      const original = (await this.original(feedbackId, change.rel)) ?? "";
      const originalFile = join(this.dir(feedbackId), "original", change.rel);
      await mkdir(dirname(originalFile), { recursive: true });
      await writeFile(originalFile, original);
      const { additions, deletions } = await numstat(originalFile, change.status === "D" ? "/dev/null" : path);
      files.push({ path, rel: change.rel, status: change.status, additions, deletions });
    }
    return files.sort((a, b) => a.rel.localeCompare(b.rel));
  }

  // 시작 시점의 파일 내용(기준 해시의 blob). 그때 없던 파일이면 null.
  async original(feedbackId: string, rel: string): Promise<string | null> {
    const sha = (await this.baseline(this.get(feedbackId)))[rel];
    if (!sha) return null;
    return (await catBlob(this.deps.srcRoot, sha)).toString("utf8");
  }

  // 세션을 지울 때: 사본 안의 파일을 지운 뒤 git worktree remove (--force 없음). 기록은 되돌리기 백업을 위해 남긴다.
  async removeWorktree(agent: Agent) {
    const feedback = agent.feedbackId ? this.items.get(agent.feedbackId) : null;
    if (!feedback) return;
    // 세션이 사라졌으니 열려 있는 알림은 닫는다. 기록은 되돌리기 백업과 함께 남는다.
    if (!feedback.seen && feedback.status !== "awaitingRestart") this.set(feedback, { seen: true });
    await this.dropWorktree(feedback);
  }

  // 사본 안의 파일을 지운 뒤 git worktree remove (--force 없음)와 prune. 사본이 없거나 이 기능이 만든 경로가 아니면 아무것도 하지 않고 false.
  // 사본을 만들 때 쓴 orphan 브랜치(feedback/<id>)는 커밋이 없어 ref 가 없다. 혹시 ref 가 생겼으면 병합된 것만 안전 삭제(-d)한다.
  private async dropWorktree(feedback: Feedback): Promise<boolean> {
    const path = feedback.worktree;
    // 안전장치: 이 기능이 만든 경로(<repo>.worktrees/feedback-<id>)만 지운다.
    if (path !== this.worktreePath(feedback.id) || !existsSync(path)) return false;
    for (const name of await readdir(path)) if (name !== ".git") await rm(join(path, name), { recursive: true, force: true });
    await gitOps.git(this.deps.srcRoot, ["worktree", "remove", path]);
    await gitOps.git(this.deps.srcRoot, ["worktree", "prune"]);
    await gitOps.git(this.deps.srcRoot, ["branch", "-d", `feedback/${feedback.id}`]).catch(() => undefined);
    // 이 기능이 만든 <repo>.worktrees 폴더가 비었으면 같이 치운다 (비어 있지 않으면 rmdir 이 거절한다).
    await rmdir(dirname(path)).catch(() => undefined);
    await this.dropGenerated(feedback.id);
    return true;
  }

  // 사본에서 다시 만들 수 있는 파일: 변경 패널용 원본(original), 본 폴더에 밀린 옛 버전(dropped), 기준선 사본(base)
  private async dropGenerated(id: string) {
    for (const name of ["original", DROPPED, DROPPED_FROM, "base"]) await rm(join(this.dir(id), name), { recursive: true, force: true });
  }

  // --- 끝난 피드백 정리 (PERFDAEMON) ---

  // 끝난 피드백의 worktree 와 되돌리기 백업을 얼마나 정리할 수 있는지. 아무것도 지우지 않는다.
  async tidyPlan(override: Partial<RetentionPolicy> = {}, now = Date.now()): Promise<TidyPlan> {
    const policy = withPolicy(override);
    const facts = this.list().map((feedback) => this.retentionFacts(feedback));
    const decided = new Map(planRetention(facts, now, policy).map((entry) => [entry.id, entry]));
    const entries: TidyEntry[] = [];
    for (const feedback of this.list()) {
      const decision = decided.get(feedback.id)!;
      const worktree = decision.action === "worktree" || decision.action === "both";
      const backup = decision.action === "backup" || decision.action === "both";
      const dir = this.dir(feedback.id);
      const sizes = await Promise.all([
        worktree ? dirBytes(feedback.worktree) : 0,
        backup ? Promise.all(BACKUP_DIRS.map((name) => dirBytes(join(dir, name)))).then((list) => list.reduce((a, b) => a + b, 0)) : 0,
        worktree ? Promise.all(["original", DROPPED, DROPPED_FROM, "base"].map((name) => dirBytes(join(dir, name)))).then((list) => list.reduce((a, b) => a + b, 0)) : 0,
      ]);
      entries.push({
        id: feedback.id,
        text: feedback.text.replace(/\s+/g, " ").slice(0, 60),
        status: feedback.status,
        updatedAt: feedback.updatedAt,
        action: decision.action,
        reason: decision.reason,
        worktree: worktree ? feedback.worktree : null,
        worktreeBytes: sizes[0],
        backupBytes: sizes[1],
        generatedBytes: sizes[2],
      });
    }
    const picked = entries.filter((e) => e.action !== "keep");
    return {
      policy,
      now,
      entries,
      totals: {
        feedbacks: entries.length,
        kept: entries.length - picked.length,
        worktrees: entries.filter((e) => e.worktree).length,
        worktreeBytes: entries.reduce((n, e) => n + e.worktreeBytes, 0),
        backups: entries.filter((e) => e.backupBytes > 0).length,
        backupBytes: entries.reduce((n, e) => n + e.backupBytes, 0),
        generatedBytes: entries.reduce((n, e) => n + e.generatedBytes, 0),
        workspaces: entries.filter((e) => e.worktree && this.workspaceIdOf(this.items.get(e.id)!) !== null).length,
      },
    };
  }

  // 계획대로 지운다. 실행 직전에 피드백마다 다시 보호 조건을 확인한다(계획을 계산한 뒤 Run Again 이나 재시작 대기가 생길 수 있다).
  async tidyRun(override: Partial<RetentionPolicy> = {}, now = Date.now()): Promise<TidyResult> {
    if (this.applying) throw new Error(T.fbErrBusyApply);
    const plan = await this.tidyPlan(override, now);
    const result: TidyResult = { worktrees: 0, backups: 0, workspaces: 0, freedBytes: 0, skipped: [], failed: [] };
    for (const entry of plan.entries) {
      if (entry.action === "keep") continue;
      const feedback = this.items.get(entry.id);
      if (!feedback) continue;
      if (protectedReason(this.retentionFacts(feedback)) !== null || this.applying) {
        result.skipped.push(entry.id);
        continue;
      }
      try {
        if (entry.action === "backup" || entry.action === "both") {
          for (const name of BACKUP_DIRS) await rm(join(this.dir(feedback.id), name), { recursive: true, force: true });
          await writeFile(join(this.dir(feedback.id), BACKUP_PRUNED), new Date(now).toISOString());
          result.backups++;
          result.freedBytes += entry.backupBytes;
        }
        if (entry.worktree && (await this.dropWorktree(feedback))) {
          result.worktrees++;
          result.freedBytes += entry.worktreeBytes + entry.generatedBytes;
          const workspaceId = this.workspaceIdOf(feedback);
          if (workspaceId && this.deps.store.archiveWorkspace(workspaceId)) result.workspaces++;
        }
      } catch (error) {
        result.failed.push({ id: feedback.id, error: (error as Error).message });
      }
    }
    if (result.workspaces > 0) this.deps.emit({ type: "workspaces", workspaces: this.deps.store.workspaces });
    return result;
  }

  private workspaceIdOf(feedback: Feedback): string | null {
    try {
      return this.deps.store.agent(feedback.agentId).workspaceId;
    } catch {
      return null;
    }
  }

  private retentionFacts(feedback: Feedback): RetentionFacts {
    const dir = this.dir(feedback.id);
    const agentStatus = (() => {
      try {
        return this.deps.store.agent(feedback.agentId).status;
      } catch {
        return "idle";
      }
    })();
    const applied = Date.parse(this.appliedAt(feedback));
    return {
      id: feedback.id,
      feedback,
      updatedAt: Date.parse(feedback.updatedAt) || 0,
      appliedAt: Number.isFinite(applied) ? applied : null,
      busy: this.pipelines.has(feedback.id) || agentStatus === "running" || agentStatus === "waiting",
      hasWorktree: feedback.worktree === this.worktreePath(feedback.id) && existsSync(feedback.worktree),
      hasBackup: BACKUP_DIRS.some((name) => existsSync(join(dir, name))),
    };
  }

  // --- 내부 ---

  private dir(id: string) {
    return join(FEEDBACK_DIR, id);
  }

  private worktreePath(id: string) {
    return join(`${this.deps.srcRoot}.worktrees`, `feedback-${id}`);
  }

  // 커밋이 없는 레포에서도 만들 수 있도록 orphan worktree 로 연다. 내용은 createWorktree 뒤 mirror 가 채운다.
  private async createWorktree(id: string) {
    const path = this.worktreePath(id);
    if (existsSync(path)) throw new Error(T.errWorktreeExists(path));
    await mkdir(dirname(path), { recursive: true });
    await gitOps.git(this.deps.srcRoot, ["worktree", "add", "--orphan", "-b", `feedback/${id}`, path]);
    return path;
  }

  // 본 작업 폴더의 현재 파일(추적 + 미추적, .gitignore 제외)을 worktree 로 복사하고 파일별 blob 해시를 기준으로 남긴다.
  // 커밋하지 않는 작업 중인 변경까지 포함해야 개선 세션이 사용자가 보는 코드를 고친다. node_modules 는 링크로 공유한다.
  private async mirror(src: string, worktree: string): Promise<Baseline> {
    const listed = (await gitOps.git(src, ["ls-files", "-co", "--exclude-standard", "-z"])).split("\0").filter(Boolean);
    const rels: string[] = [];
    for (const rel of new Set(listed)) {
      const from = join(src, rel);
      if (!existsSync(from) || !lstatSync(from).isFile()) continue;
      rels.push(rel);
      await mkdir(dirname(join(worktree, rel)), { recursive: true });
      await copyFile(from, join(worktree, rel));
    }
    if (existsSync(join(src, "node_modules"))) await symlink(join(src, "node_modules"), join(worktree, "node_modules"));
    // blob 을 객체 저장소에 써 두면 나중에 시작 시점의 원본을 그대로 꺼낼 수 있다(커밋이나 ref 는 만들지 않는다).
    const out = await hashObjects(src, rels.map((r) => join(src, r)));
    const baseline: Baseline = {};
    rels.forEach((rel, i) => (baseline[rel] = out[i]));
    return baseline;
  }

  private async baseline(feedback: Feedback): Promise<Baseline> {
    return JSON.parse(await readFile(join(this.dir(feedback.id), "baseline.json"), "utf8")) as Baseline;
  }

  private async diffWorktree(feedback: Feedback): Promise<{ rel: string; status: ChangedFile["status"] }[]> {
    const baseline = await this.baseline(feedback);
    const current = new Map<string, string>();
    const walk = async (dir: string) => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        const rel = relative(feedback.worktree, full);
        if (SKIP_ANY.has(entry.name) || (!rel.includes(sep) && SKIP_TOP.has(entry.name))) continue;
        if (entry.isDirectory()) await walk(full);
        // 읽지 못하면 "바뀌었다" 로 넘기지 않고 오류로 올린다. 변경 목록은 files.write 허용 판단에도 쓰이므로 실패 쪽이 닫힌다.
        else if (entry.isFile()) current.set(rel, await hashFileStrict(full));
      }
    };
    await walk(feedback.worktree);
    const changes: { rel: string; status: ChangedFile["status"] }[] = [];
    for (const [rel, sha] of current) {
      if (!(rel in baseline)) changes.push({ rel, status: "A" });
      else if (baseline[rel] !== sha) changes.push({ rel, status: "M" });
    }
    for (const rel of Object.keys(baseline)) if (!current.has(rel)) changes.push({ rel, status: "D" });
    return changes;
  }

  // 이번 턴의 마지막 답이 사용자에게 묻는 말이면 그 질문(표지 없음), 아니면 null. 이전 턴의 답은 보지 않는다.
  private questionOf(feedback: Feedback): string | null {
    const items = this.deps.store.timeline(feedback.agentId);
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (item.kind === "user") return null;
      if (item.kind !== "assistant" || !item.text.trim()) continue;
      const reply = parseFeedbackReply(item.text);
      if (!reply.question) return null;
      return reply.text.length > MAX_QUESTION ? `${reply.text.slice(0, MAX_QUESTION - 1).trimEnd()}…` : reply.text;
    }
    return null;
  }

  // 개선 세션의 마지막 답에서 한 줄 요약을 뽑는다 (첫 문장). 없으면 피드백 문장.
  // 자동 수정 턴의 답은 건너뛴다(shared/feedbackSummary.ts): 검사 실패에 대한 말이 요약으로 남지 않게.
  private summaryOf(feedback: Feedback) {
    const reply = summarySource(this.deps.store.timeline(feedback.agentId), T.fbIsFixShown);
    const first = reply === null ? "" : (parseFeedbackReply(reply).text.split("\n").find((l) => l.trim()) ?? "");
    const sentence = first.replace(/^[#>*\s-]+/, "").replace(/[*`]/g, "").trim().split(/(?<=[.!?])\s/)[0] ?? "";
    if (sentence) return sentence.length > 90 ? `${sentence.slice(0, 89).trimEnd()}…` : sentence;
    return feedback.text.slice(0, 80);
  }

  // 검사를 돌릴 환경. 데몬이 GUI 앱 안에서 뜨면 PATH 에 node 가 없어서, 로그인 셸의 PATH 를 한 번 읽어 쓴다.
  // force 면 로그인 셸을 다시 읽는다(방금 설치한 도구나 부팅 직후 실패한 읽기를 만회한다).
  private async checkEnv(force = false): Promise<NodeJS.ProcessEnv> {
    if (this.deps.readEnv) return this.deps.readEnv(force);
    await loginShellPath({ force });
    // 앱 내부 변수는 뺀다. AGENT_NAV_PORT 를 넘기면 npm test 의 접근 검사가 이 데몬(설치 앱이면 7788)을 시험 대상으로 보고 멈춘다. 빼면 검사가 자기 시험 데몬을 임시 홈과 빈 포트로 띄운다.
    return { ...stripAppEnv(process.env), PATH: withLoginPath(process.env.PATH) };
  }

  private fail(feedback: Feedback, failure: string, fold?: { label: string; text: string }) {
    // 첫 줄은 알림 문장, 나머지(검사 출력 등)는 대화에서 고정폭 상자로 보인다. 출력은 끝이 중요하므로(실패 줄은 맨 아래) 넘치면 앞을 자른다.
    const [head, ...rest] = failure.split("\n");
    let detail = rest.join("\n").trim();
    if (detail.length > MAX_OUTPUT) detail = `…${detail.slice(-MAX_OUTPUT)}`;
    // FBREBASE: 같은 사유로 연속 실패하면 대화에 알림을 새로 쌓지 않고 앞서 남긴 항목을 갱신하고, 이미 본 실패면 알림(seen)도 다시 띄우지 않는다.
    const repeat = feedback.failureNotice?.head === head ? feedback.failureNotice : null;
    const itemId = this.deps.agents.notice(feedback.agentId, head, detail || undefined, fold, repeat?.itemId ?? undefined);
    this.set(feedback, { status: "failed", failure: detail ? `${head}\n${detail}` : head, failureNotice: { head, itemId: itemId ?? null }, ...(repeat ? { seen: feedback.seen } : {}) });
  }

  private set(feedback: Feedback, patch: Partial<Feedback>) {
    Object.assign(feedback, patch, { updatedAt: new Date().toISOString() });
    if (patch.status && patch.status !== "checking") feedback.retrying = false;
    if (patch.status && patch.status !== "running" && patch.status !== "checking" && patch.status !== "fixing") feedback.seen = patch.seen ?? false;
    // FBREDO: 끊긴 흔적은 실패로 끝났을 때만 쓸모 있다(Run Again). 다른 끝(반영, 되돌림, 변경 없음, 질문 대기, 재시작 대기)이면 지운다.
    if (patch.status && patch.status !== "failed" && !isInterruptible(patch.status) && patch.interrupted === undefined) feedback.interrupted = false;
    // FBREDO: 충돌 표시는 실패한 동안만 쓴다(다시 돌기 시작하면 지운다)
    if (patch.status && patch.status !== "failed" && patch.conflict === undefined) feedback.conflict = false;
    // FBREBASE: 재적용 표시는 fixing 인 동안만 쓰고, 실패 알림 기억은 실패에서 벗어나 다른 끝(반영, 해결 등)에 닿으면 지운다(도는 중 running, checking, fixing 은 유지).
    if (patch.status && patch.status !== "fixing") feedback.reapplying = false;
    if (patch.status && !FAIL_KEEP.has(patch.status) && patch.failureNotice === undefined) feedback.failureNotice = null;
    // FBBLOCK: 기다리는 이유와 타이머는 blocked 인 동안만 쓴다. 끝이 난 상태에서는 자동 재시도 횟수도 0 으로 돌아간다(실패는 사람이 다시 돌릴 때까지 센 값을 둔다).
    if (patch.status && patch.status !== "blocked") {
      if (patch.blocked === undefined) feedback.blocked = null;
      this.disarm(feedback.id);
      if (BLOCK_RESET.has(patch.status) && patch.blockTries === undefined) feedback.blockTries = 0;
    }
    this.save(feedback);
  }

  // 임시 파일에 쓴 뒤 rename 으로 바꾼다. 쓰는 도중에 데몬이 끊겨도 반쪽 state.json 이 남지 않는다.
  private save(feedback: Feedback) {
    const file = join(this.dir(feedback.id), "state.json");
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(feedback, null, 2));
    renameSync(tmp, file);
    this.deps.emit({ type: "feedback", feedback });
  }
}

// PERFDAEMON: Revert 가 쓰는 백업 폴더(피드백 폴더 아래). 정리하면 BACKUP_PRUNED 표식을 남겨 Revert 가 이유를 말하게 한다.
const BACKUP_DIRS = ["backup", "backup-dist", "backup-dist-electron"];
const BACKUP_PRUNED = "backup-pruned";

// 폴더 크기(바이트). 심볼릭 링크는 따라가지 않는다(worktree 의 node_modules 는 링크). 없으면 0.
async function dirBytes(path: string): Promise<number> {
  let info;
  try {
    info = await lstat(path);
  } catch {
    return 0;
  }
  if (!info.isDirectory()) return info.size;
  let total = 0;
  for (const name of await readdir(path).catch(() => [])) total += await dirBytes(join(path, name));
  return total;
}

const FAIL_KEEP = new Set(["running", "checking", "fixing", "failed"]);
const BLOCK_RESET = new Set(["applied", "reverted", "noChanges", "needsInput", "awaitingRestart", "resolved", "dismissed"]);

// 개선 세션 타임라인의 마지막 오류 항목
function lastSessionError(timeline: TimelineItem[]): { text: string; auth: boolean } | null {
  for (let i = timeline.length - 1; i >= 0; i--) {
    const item = timeline[i];
    if (item.kind === "error") return { text: item.text, auth: item.auth };
  }
  return null;
}

// 검사 실패 출력이 환경 오류일 때 기다리는 이유와 문제 문장
function blockOf(kind: FailureKind, output: string): { reason: "environment" | "auth"; problem: string; detail: string } {
  if (kind === "auth") return { reason: "auth", problem: T.fbBlockedAuth, detail: output };
  const tool = missingTool(output);
  const problem = kind === "network" ? T.fbProblemNetwork : tool ? T.fbProblemTool(tool) : T.fbProblemStart;
  return { reason: "environment", problem, detail: output };
}

// 검사 명령이 쓰는 실행 파일. node 로 도는 명령(npm, npx, 시험의 tsx)은 node 도 있어야 한다.
function requiredTools(specs: CheckSpec[]): string[] {
  const names = new Set(specs.map((s) => s.command));
  if (specs.some((s) => s.kind === "tests" || ["npm", "npx", "node"].includes(s.command))) names.add("node");
  return [...names];
}

function firstMissing(specs: CheckSpec[], path: string | undefined): string | null {
  return requiredTools(specs).find((name) => !findExecutable(name, path)) ?? null;
}

// 모델 호출 없이 Claude 로그인이 살아 있는지만 본다.
async function probeClaudeAuth(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(claudeBin(), ["auth", "status"], { env: claudeEnv(), timeout: 15_000 });
    return (JSON.parse(stdout) as { loggedIn?: boolean }).loggedIn === true;
  } catch {
    return false;
  }
}

const SYSTEM_PROMPT = [
  "You change the UI code of the Lodestar app (React, Vite, Tailwind, a Node daemon) to match one piece of feedback.",
  "Your working directory is a private copy of the source (a git worktree). You may edit only files under web/, server/, shared/ and electron/. Never edit docs/, web/tokens.css (generated), package.json, the lockfile or any config. Never commit, push or stash.",
  "Read design-system/README.md and the component card that matches the element before changing styling. Use only design-system tokens: CSS variables from web/tokens.css, the Tailwind classes defined in web/tailwind.css, and the existing classes in web/styles.css. No raw px (except 1px borders), no hex or rgb colors, no spacing classes outside the eight steps.",
  "User-facing text stays in English and lives in web/strings.ts or server/strings.ts.",
  "Make the smallest change that satisfies the feedback. When you are done, run `npx tsc -p tsconfig.json --noEmit` and `npm run lint:tokens` and fix what they report. If either reports an error, fix it yourself and run it again until it is clean. Do not stop to report an error.",
  "Talk to the user in the language they write in (Korean for this user). The English rule above applies only to UI text you put in the code.",
  "Your last message of each turn must be exactly one sentence under 80 characters, in the user's language, that says what changed (or answers their follow-up), with no other text. It is shown to the user as the summary.",
  "Never ask the user a question and never stop to wait for an answer. If the feedback is vague, pick the most reasonable interpretation, make the change, and say in the one-sentence summary what you assumed. If something fails (a check, an edit, a command), work out the cause and fix it yourself instead of giving up.",
].join("\n");

export function composePrompt(feedback: Feedback, dir: string) {
  const e = feedback.element;
  const windowShot = feedback.windowScreenshot ? `- Screenshot of the whole window: ${join(dir, WINDOW_PNG)} (read it with the Read tool to see what the user was looking at)` : "- Whole-window screenshot: not attached";
  const lines = e
    ? [
        `Feedback: ${feedback.text}`,
        "",
        "The user picked this element in the running app:",
        `- Component: ${e.component ?? "unknown"} (<${e.tag}>)`,
        `- Source: ${e.sources.length ? e.sources.join(", ") : "unknown"} (line numbers are from the running build, so search nearby)`,
        `- Size: ${e.width}x${e.height}`,
        `- DOM path: ${e.domPath}`,
        e.text ? `- Text: ${e.text}` : null,
        `- Computed style: ${Object.entries(e.styles).map(([k, v]) => `${k}: ${v}`).join("; ")}`,
        feedback.screenshot ? `- Screenshot of the element: ${join(dir, "element.png")} (read it to see the element)` : `- Screenshot: not available${feedback.screenshotNote ? ` (${feedback.screenshotNote})` : ""}`,
        ...(feedback.windowScreenshot ? ["", "The screen when the feedback was sent:", ...(feedback.screen ? screenLines(feedback.screen) : []), windowShot] : []),
        "",
        "Change the source so the feedback is satisfied, within the design-system tokens.",
      ]
    : [
        `Feedback: ${feedback.text}`,
        "",
        "The user did not pick an element. Work out which part of the app they mean from the feedback text and the screen when it was sent, then find that code.",
        ...(feedback.screen ? screenLines(feedback.screen) : ["- Screen state: not available"]),
        windowShot,
        "",
        `Change the source so the feedback is satisfied, within the design-system tokens. If the feedback is vague, choose the most reasonable interpretation and make the change. Do not ask the user anything.`,
      ];
  return lines.filter((l) => l !== null).join("\n");
}

// 말풍선 위 칩: 고른 요소(소스 위치가 있으면 누르면 그 파일 줄로 열린다)와 창 스크린샷 썸네일.
export function chipsOf(element: ElementInfo | null, thumb: string | null): UserAttachment[] {
  const chips: UserAttachment[] = [];
  if (thumb) chips.push({ kind: "screenshot", label: "Screenshot", thumb });
  if (element) chips.push(elementChip(element));
  return chips;
}

function decodePng(base64: string | null | undefined) {
  if (!base64) return null;
  const png = Buffer.from(base64, "base64");
  if (png.length > MAX_SCREENSHOT_BYTES || png.subarray(1, 4).toString("latin1") !== "PNG") throw new Error(T.fbErrBadScreenshot);
  return png;
}

// 소스 위치("web/AgentView.tsx:142")가 있으면 칩이 그 파일 줄로 열린다. 줄 번호는 실행 중인 빌드 기준이라 근처를 가리킨다.
function elementChip(element: ElementInfo): UserAttachment {
  const match = /^(.*?):(\d+)(?::\d+)?$/.exec(element.sources[0] ?? "");
  return { kind: "element", label: element.component ?? `<${element.tag}>`, path: match ? match[1] : (element.sources[0] ?? null), line: match ? Number(match[2]) : null };
}

function isInside(root: string, path: string) {
  const rel = relative(root, resolve(root, path));
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep));
}

// git blob 과 같은 해시 (sha1 of "blob <size>\0" + content). 파일이 없으면 null.
async function hashFile(file: string): Promise<string | null> {
  try {
    const st = await lstat(file);
    if (!st.isFile()) return null;
    const data = await readFile(file);
    return createHash("sha1").update(`blob ${data.length}\0`).update(data).digest("hex");
  } catch {
    return null;
  }
}

async function hashFileStrict(file: string): Promise<string> {
  const data = await readFile(file);
  return createHash("sha1").update(`blob ${data.length}\0`).update(data).digest("hex");
}

async function catBlob(cwd: string, sha: string): Promise<Buffer> {
  const { stdout } = await execFileAsync("git", ["cat-file", "blob", sha], { cwd, maxBuffer: 64 * 1024 * 1024, encoding: "buffer" });
  return stdout;
}

async function hashObjects(cwd: string, files: string[]): Promise<string[]> {
  if (!files.length) return [];
  return new Promise((resolvePromise, reject) => {
    const child = execFile("git", ["hash-object", "-w", "--stdin-paths"], { cwd, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolvePromise(stdout.split("\n").filter(Boolean));
    });
    child.stdin?.end(files.join("\n") + "\n");
  });
}

async function numstat(before: string, after: string) {
  try {
    await execFileAsync("git", [...gitOps.GIT_PATH_FLAGS, "diff", "--no-index", "--numstat", "--", before, after], { maxBuffer: 16 * 1024 * 1024 });
    return { additions: 0, deletions: 0 };
  } catch (error) {
    // 차이가 있으면 git 이 종료 코드 1 로 끝난다.
    const stdout = String((error as { stdout?: string }).stdout ?? "");
    const [a, d] = stdout.split("\t");
    return { additions: Number(a) || 0, deletions: Number(d) || 0 };
  }
}

// full 은 자르지 않은 출력이다. tsc 오류 목록과 시험 이름은 끝이 잘리기 전의 전체에서 뽑는다.
async function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeout: number) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, { cwd, env, timeout, maxBuffer: 32 * 1024 * 1024 });
    return { ok: true, output: tail(`${stdout}${stderr}`), full: `${stdout}${stderr}` };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; message: string; killed?: boolean; code?: string | number; syscall?: string };
    const full = `${e.stdout ?? ""}${e.stderr ?? ""}` || e.message;
    return { ok: false, output: tail(full), full, code: e.code ?? null, syscall: e.syscall ?? null };
  }
}

// kind 는 실패의 성격: code 가 아니면(환경, 인증, 네트워크) 코드로 고칠 수 없는 오류다.
type CheckRun = { ok: boolean; output: string; failures: CheckFailure[]; kind?: FailureKind };

async function runCheck(spec: CheckSpec, cwd: string, env: NodeJS.ProcessEnv): Promise<CheckRun> {
  if (spec.kind === "tests") return runTests(spec, cwd, env);
  const result = await run(spec.command, spec.args, cwd, env, spec.timeoutMs);
  if (result.ok) return { ok: true, output: result.output, failures: [] };
  return { ok: false, output: result.output, failures: spec.kind === "tsc" ? tscFailures(result.full) : plainFailures(spec.name, result.full), kind: classifyFailure({ code: result.code, syscall: result.syscall, text: result.full }) };
}

// 기준선 검사. 환경이나 인증 오류로 못 돌았으면 그 결과를 기준선으로 캐시하지 않도록 던진다(캐시되면 진짜 실패가 계속 무시된다).
async function runCodeCheck(spec: CheckSpec, cwd: string, env: NodeJS.ProcessEnv): Promise<CheckRun> {
  const result = await runCheck(spec, cwd, env);
  if (result.kind && result.kind !== "code") throw new Error(`${spec.name} could not run here (${result.kind}): ${result.output.split("\n")[0]}`);
  return result;
}

// package.json 의 test 스크립트를 && 로 나눠 하나씩 돈다. 앞 시험이 떨어져도 뒤 시험을 계속 돌려서 실패한 이름을 전부 모은다.
async function runTests(spec: CheckSpec, cwd: string, env: NodeJS.ProcessEnv): Promise<CheckRun> {
  let script = "";
  try {
    script = (JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as { scripts?: { test?: string } }).scripts?.test ?? "";
  } catch {
    script = "";
  }
  const parts = script.split("&&").map((p) => p.trim()).filter(Boolean);
  if (!parts.length) {
    const result = await run(spec.command, spec.args, cwd, env, spec.timeoutMs);
    return { ok: result.ok, output: result.output, failures: result.ok ? [] : testFailures(spec.name, result.full), kind: result.ok ? undefined : classifyFailure({ code: result.code, syscall: result.syscall, text: result.full }) };
  }
  const withBin = { ...env, PATH: `${join(cwd, "node_modules/.bin")}:${env.PATH ?? ""}` };
  const deadline = Date.now() + spec.timeoutMs;
  const failures: CheckFailure[] = [];
  let full = "";
  // 시험 출력에는 시험이 찍는 문장이 섞이므로 종료 코드(명령을 못 찾으면 127, 실행 자체 실패는 ENOENT)로만 환경 오류를 가린다.
  let kind: FailureKind | undefined;
  for (const part of parts) {
    const left = deadline - Date.now();
    if (left <= 0) {
      failures.push({ key: `${part}: not run, time limit`, text: `${part}: not run, time limit` });
      break;
    }
    const result = await run("sh", ["-c", part], cwd, withBin, left);
    full += `$ ${part}\n${result.full}\n`;
    if (!result.ok) {
      failures.push(...testFailures(part, result.full, knownTestNames(cwd, part)));
      const partKind = classifyFailure({ code: result.code, syscall: result.syscall, text: "" });
      if (partKind !== "code") kind ??= partKind;
    }
  }
  return { ok: failures.length === 0, output: tail(full), failures, kind };
}

// 시험 명령(tsx test/x.test.ts)이 가리키는 파일에 적힌 문자열. FAIL 줄에서 이름과 오류를 가르는 데 쓴다.
function knownTestNames(cwd: string, command: string): string[] {
  const file = /\btest\/[\w.-]+\.ts\b/.exec(command)?.[0];
  if (!file) return [];
  try {
    return quotedStrings(readFileSync(join(cwd, file), "utf8"));
  } catch {
    return [];
  }
}

function outcomeOf(result: CheckRun): CheckOutcome {
  return { ok: result.ok, failures: result.failures, output: result.output };
}

function ignoredOf(checks: FeedbackCheck[]) {
  return checks.reduce((sum, c) => sum + (c.ignored ?? 0), 0);
}

// 반영 알림 아래에 접어 보이는 기준선 결과. 무시한 실패가 있던 검사만 모은다.
function foldOf(checks: FeedbackCheck[]) {
  const parts = checks.filter((c) => c.ignored && c.baseline).map((c) => `${c.name}\n${c.baseline}`);
  return parts.length ? { label: T.fbBaselineLabel, text: parts.join("\n\n") } : undefined;
}

// 데몬 전체에서 한 번에 하나만 도는 줄. 앞 작업이 실패해도 다음 작업은 돈다.
let lane: Promise<unknown> = Promise.resolve();
function exclusive<T>(work: () => Promise<T>): Promise<T> {
  const next = lane.then(work, work);
  lane = next.catch(() => undefined);
  return next;
}

function tail(text: string) {
  const clean = text.replace(/\u001b\[[0-9;]*m/g, "").trim();
  return clean.length > MAX_OUTPUT ? `…${clean.slice(-MAX_OUTPUT)}` : clean;
}

// from 을 to 자리로 옮긴다. to 가 있으면 잠깐 .old 로 비켜 두었다가 지운다 (읽는 쪽이 비어 있는 순간을 보지 않게 rename 두 번으로 끝낸다).
// from 은 그대로 두고 복사본을 넣는다.
async function swapDir(from: string, to: string) {
  const next = `${to}.next`;
  const old = `${to}.old`;
  await rm(next, { recursive: true, force: true });
  await rm(old, { recursive: true, force: true });
  await cp(from, next, { recursive: true });
  if (existsSync(to)) await rename(to, old);
  await rename(next, to);
  await rm(old, { recursive: true, force: true });
}
