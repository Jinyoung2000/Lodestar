import { spawn } from "node:child_process";
import { allowProviderEnv } from "./claude";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { homedir, hostname } from "node:os";
import { fileURLToPath } from "node:url";
import { extname, join, relative, resolve } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import type { MobileStatus } from "../shared/mobile";
import { defaultChangeScope, type Agent, type ChangedFile, type ChangeScope, type GitInfo, type ImageRef, type UserAttachment, RuntimeInfo, RpcMethod, RpcMethods, RpcRequest, ServerEvent, ServerMessage } from "../shared/protocol";
import { AgentRunner } from "./agents";
import { BoardStore } from "./board";
import { NoteStore } from "./notes"; // NOTES
import { NotionPinStore } from "./notionPins";
import { createNotion } from "./notionHost"; // NOTION2
import { defaultsReader, describeDefaults } from "./defaults";
import { FeedbackRunner } from "./feedback";
import { IdleUpdater } from "./idleUpdate";
import { generateHandoff, readHandoff, saveHandoff } from "./handoff";
import { BrowserBridge } from "./browserBridge";
import { readBrowserShot, saveBrowserShot } from "./browserShot";
import { readAsideImage } from "./asideImages"; // ASIDEVIEW
import { probeFrame } from "./frameProbe";
import { InboxFetcher, InboxStore } from "./inbox";
import { realDir } from "./paths";
import { busyAgents } from "./removedFolders";
import { headTextOf } from "./headText";
import { blameOf } from "./gitBlame";
import { revealInFileManager } from "./reveal";
import { saveImage, saveImageBytes } from "./images";
import { mediaKey, mentionedMedia, resolveMediaBatch, type MediaContext } from "./media"; // INLINEMEDIA
import { handleMedia } from "./mediaHttp"; // INLINEMEDIA
import { discardUpload, handleUpload, resolveFiles } from "./fileAttach"; // FILEATTACH
import { lanHosts, makeOffer, MobileDevices, MobileServer, PairingCodes } from "./mobileAccess"; // MOBILE
import { listFolder } from "./mobileFolders"; // MOBILE
import { pageOfTimeline } from "../shared/mobile";
import { worktreeParentDir } from "../shared/openPath"; // OPENFOLDER
import { createWorkspaceEntry, listEmptyDirs, listFiles, listIgnoredFiles, openFolderInVSCode, openInVSCode, readWorkspaceBinary, readWorkspaceFileWithStat, resolveInside, renameWorkspaceEntry, resolveReadable, terminalDir, saveWorkspaceFile, statWorkspaceFile, trashWorkspaceEntry, writeWorkspaceFile } from "./files";
import { formatLanguages, formatOnSaveOf, readFormatSettings, runFormat } from "./format";
import * as gitOps from "./git";
import { forgetForkBase } from "./forkBase";
import { beginTurn as beginLastTurn, forget as forgetLastTurn, lastTurnOriginal } from "./lastTurn";
import { createWorkspaceWatch } from "./workspaceWatch";
import { perfNote, perfReset, perfSnapshot } from "./perfStats";
import { createCoalescer } from "./eventCoalescer";
import { createPullRequest, mergeInfo, mergeIntoBase, unmergedCount } from "./worktreeFlow";
import { beginTurn as beginTouchTurn, checkUndo, ensureLedger, forgetLedger, forgetTouched, isTouched, sessionFiles, TOUCH_BASE, touchedChanges, touchedLastTurn, touchedOriginal } from "./sessionTouch";
import { bridgeLsp } from "./lsp";
import { BUNDLED_LANGUAGE_SERVERS, languageServersFor } from "./lspRegistry";
import { ReviewCheckouts, runsFolderCode } from "./folderTrust";
import { prHandlers } from "./pr";
import { linearHandlers } from "./linear"; // LINEAR
import { simulatorHandlers } from "./simulator"; // CMDT
import { skillCatalogHandlers } from "./skillCatalog"; // SKILLS
import { scmHandlers } from "./scmHandlers";
import { runAnalysis } from "./mentionAnalyze";
import { judgeMentions } from "./mentionJudge";
import { MentionPipeline } from "./mentions";
import { MorningReviewService } from "./morningReview"; // MORNINGREVIEW
import { ReleaseCheck } from "./releaseCheck"; // RELEASE
import { mentionCollectionBlocked, morningReviewAutoBlocked } from "./mentionGate";
import { MetaService } from "./meta";
import { localCommands } from "./skills";
import { liveGroupLeaders, systemKillDeps, terminateGroups } from "./processGroups";
import { createDaemonShutdown } from "./shutdown";
import { RestartScheduler, restartWaitMs } from "../shared/restartGate";
import { detectWorktree, importActivity, importVscodeSessions, listVscodeSessions, markSynced, reconcileBeforeTurn, type ImportDeps } from "./vscodeImport";
import { bridgePty, ptyInfo } from "./pty";
import { TermAskRunner } from "./termask";
import { QuickRunner } from "./quick";
import { searchWorkspace } from "./search";
import { searchSettings } from "./searchSettings";
import { replaceInWorkspace } from "./searchReplace"; // SEARCHREPLACE
import { T } from "./strings";
import { SideRunner } from "./side";
import { applyKeptCounts, snapshotChanges, usesSnapshots } from "./snapshots";
import { HOME, Store, loadToken } from "./store";
import { RepoMirrors } from "./repoMirror";
import { primeLoginPath, withLoginPath } from "./loginPath";

// 로그인 셸 PATH 를 읽기 전에도 homebrew 위치는 바로 보이게 한다(GUI 로 뜬 데몬의 PATH 는 /usr/bin:/bin 정도다).
process.env.PATH = withLoginPath(process.env.PATH);

const PORT = Number(process.env.AGENT_NAV_PORT ?? 7788);
const DEV_WEB_PORT = 5173;
// Electron 번들에서는 import.meta.dirname 이 dist-electron 이라 AGENT_NAV_ROOT 로 앱 루트를 받는다.
const ROOT = process.env.AGENT_NAV_ROOT ?? resolve(import.meta.dirname, "..");
const DIST = join(ROOT, "dist");
// 피드백 개선 세션이 고치는 agent-nav 소스. 앱으로 설치돼 있으면 ROOT 는 앱 번들이라 소스가 아니므로, 환경 변수나 기본 위치를 쓴다.
// 설치된 앱은 반영된 결과를 소스 폴더의 dist/ 에서 읽는다 (처음 반영한 뒤부터).
// 피드백이 git 의 저장소 루트(실제 경로)와 비교하므로 심볼릭 링크를 푼 경로로 둔다.
const SRC_ROOT = realDir(process.env.AGENT_NAV_SRC ?? (existsSync(join(ROOT, "web", "App.tsx")) ? ROOT : join(homedir(), "Repository", "agent-nav")));
const SRC_DIST = join(SRC_ROOT, "dist");
const webDist = () => (SRC_ROOT !== ROOT && existsSync(join(HOME, "feedback", "live-dist")) && existsSync(join(SRC_DIST, "index.html")) ? SRC_DIST : DIST);
// Electron 이 어느 빌드로 데몬을 띄웠는지(AGENT_NAV_RUNTIME)를 Settings 에 보여 주기 위해 그대로 싣는다. 전달이 없으면 ROOT 가 소스 폴더인지로 판단한다.
const RUNTIME: RuntimeInfo = {
  kind: process.env.AGENT_NAV_RUNTIME === "repo" || process.env.AGENT_NAV_RUNTIME === "bundle" ? process.env.AGENT_NAV_RUNTIME : existsSync(join(ROOT, "web", "App.tsx")) ? "repo" : "bundle",
  root: ROOT,
  note: process.env.AGENT_NAV_RUNTIME_NOTE || null,
};
const TOKEN = loadToken();
const MEDIA_KEY = mediaKey(TOKEN); // INLINEMEDIA

const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const ALLOWED_ORIGINS = new Set([
  `http://127.0.0.1:${PORT}`,
  `http://localhost:${PORT}`,
  `http://127.0.0.1:${DEV_WEB_PORT}`,
  `http://localhost:${DEV_WEB_PORT}`,
]);

// 아래 패널의 Output 탭이 읽는 데몬 로그. 콘솔 출력을 링 버퍼에도 남긴다.
const LOG_LINES = 2000;
const logRing: string[] = [];
for (const level of ["log", "error", "warn"] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    original(...args);
    logRing.push(`${new Date().toISOString().slice(11, 19)} ${args.map((a) => (typeof a === "string" ? a : String(a))).join(" ")}`);
    if (logRing.length > LOG_LINES) logRing.splice(0, logRing.length - LOG_LINES);
  };
}

const store = new Store();
const clients = new Set<WebSocket>();
// MOBILE: iOS 앱용 별도 서버(server/mobileAccess.ts). 설정 mobileAccess 가 꺼져 있으면 만들기만 하고 포트는 열지 않는다.
const MOBILE_PORT = Number(process.env.AGENT_NAV_MOBILE_PORT ?? PORT + 1);
const MOBILE_BIND = process.env.AGENT_NAV_MOBILE_BIND ?? "0.0.0.0";
const mobilePairing = new PairingCodes();
const mobile = new MobileServer({
  devices: new MobileDevices(join(HOME, "mobile-devices.json")),
  pairing: mobilePairing,
  call: (method, params, client) => {
    const handler = (mobileHandlers[method] ?? handlers[method as RpcMethod]) as (params: unknown, client: WebSocket) => unknown;
    return handler(params, client);
  },
  saveImage: saveImageBytes,
  hostName: hostname().replace(/\.local$/, ""),
  allowedOrigins: new Set((process.env.AGENT_NAV_MOBILE_ALLOW_ORIGIN ?? "").split(",").filter(Boolean)),
  onClose: (client) => runner.dropOpenAgents(client),
  log: (line) => console.log(line),
});
// RESTARTGATE: 재시작 쿨다운 판단에 쓰는 이 데몬의 시작 시각과 첫 창이 연결한 시각
const daemonStartedAt = Math.round(Date.now() - process.uptime() * 1000);
let firstClientAt: number | null = null;
// FBBLOCK: 개선 세션이 아닌 세션이 모델 턴을 끝냈다(running 에서 idle). Claude 로그인이 살아 있다는 뜻이라, 로그인 만료로 기다리는 피드백을 바로 다시 시작하게 알린다.
const lastAgentStatus = new Map<string, string>();
let onModelTurnDone: (() => void) | null = null;
// PERFDAEMON: 스트리밍 초안 갱신은 server/eventCoalescer.ts 가 묶어서 deliver 에 넘긴다. 나머지 이벤트는 그대로 지나간다.
const coalescer = createCoalescer((event) => deliver(event));
// 대화가 GitHub 에서 읽은 저장소를 ~/Repository 에 클론하고 주기적으로 최신화한다. 시험 인스턴스는 클론하지 않는다.
// SRC_ROOT 는 클론 자리에서 뺀다: 그 폴더가 없는 맥에서 이름이 같은 남의 저장소가 그 자리에 클론되면 자동 업데이트(IdleUpdater)가 그것을 빌드한다.
const repoMirrors = new RepoMirrors(join(homedir(), "Repository"), join(HOME, "repo-mirrors.json"), () => process.env.AGENT_NAV_INACTIVE === "1" || !!process.env.AGENT_NAV_E2E_PORT, [SRC_ROOT]);
repoMirrors.start();
// 열린 폴더의 코드(그 폴더의 TypeScript, Relay, 포맷터)를 돌려도 되는가: 사용자가 추가한 워크스페이스와 그 worktree 만 된다. 앱이 받은 클론과 PR 리뷰 체크아웃은 안 된다(server/folderTrust.ts).
const reviewCheckouts = new ReviewCheckouts(join(HOME, "review-checkouts.json"));
const folderCodeAllowed = (dir: string) => runsFolderCode(dir, { workspaces: store.workspaces, reviews: reviewCheckouts.list(), downloads: repoMirrors.createdDirs() });
const broadcast = (event: ServerEvent) => {
  repoMirrors.observe(event);
  coalescer.push(event);
};
const deliver = (event: ServerEvent) => {
  const text = JSON.stringify({ event } satisfies ServerMessage);
  let delivered = 0;
  for (const client of clients) {
    if (client.readyState !== client.OPEN) continue;
    client.send(text);
    delivered++;
  }
  perfNote("event", event.type, text.length * delivered);
  mobile.broadcast(event);
  if (event.type === "agent") {
    const before = lastAgentStatus.get(event.agent.id);
    lastAgentStatus.set(event.agent.id, event.agent.status);
    if (before === "running" && event.agent.status === "idle" && !event.agent.feedbackId) onModelTurnDone?.();
  }
};
const runner = new AgentRunner(store, broadcast);
store.isLive = (agentId) => runner.isLive(agentId);
// FIX3-1: 이전 데몬이 죽을 때 응답 중이던 세션은 끊긴 것으로 표시한다(안 그러면 멈춘 글이 그냥 idle 로 보인다).
for (const agentId of store.cutOffOnStart) runner.markCutOff(agentId);
// WSMENU: 폴더를 다시 추가해 돌아온 세션을 열려 있는 화면들에 알린다
store.onRestored = (agents) => {
  for (const agent of agents) broadcast({ type: "agent", agent });
};
// G7: 에이전트의 Browser 도구가 공유된 탭까지 가는 길(server/browserBridge.ts)
const browserBridge = new BrowserBridge();
runner.setBrowserBridge(browserBridge);
const board = new BoardStore();
const notes = new NoteStore(join(HOME, "notes")); // NOTES
const notionPins = new NotionPinStore();
// FIX4A: 보고 있는 저장소의 파일 변화를 감시해 화면이 포커스 이벤트 없이도 Source Control 과 Changes 를 다시 읽게 한다.
// PERFDAEMON: 변화 알림마다 워크스페이스 전부(피드백 worktree 포함 119개)의 realpath 를 두 번씩 풀었다. 폴더의 실제 경로는 잠깐 기억한다.
const REAL_DIR_TTL_MS = 30_000;
const realDirMemo = new Map<string, { real: string; at: number }>();
const realDirCached = (dir: string) => {
  const hit = realDirMemo.get(dir);
  if (hit && Date.now() - hit.at < REAL_DIR_TTL_MS) return hit.real;
  const real = realDir(dir);
  realDirMemo.set(dir, { real, at: Date.now() });
  return real;
};
const workspaceWatch = createWorkspaceWatch((root) => {
  const start = performance.now();
  const inside = store.workspaces
    .filter((w) => {
      const real = realDirCached(w.dir);
      return real === root || real.startsWith(`${root}/`);
    })
    .map((w) => w.id);
  if (inside.length > 0) broadcast({ type: "workspaceChanged", workspaceIds: inside });
  perfNote("watch", "onChange", inside.length, performance.now() - start);
});
const publishBoard = () => broadcast({ type: "board", board: board.get() });
const publishNotes = () => broadcast({ type: "notes", notes: notes.list() }); // NOTES
// NOTION2: Notion 화면의 읽기, 승인된 쓰기, 페이지 전용 대화. 에이전트 세션에는 Notion 제안 도구가 붙는다 (server/notionHost.ts).
const notion = createNotion({ store, board, runner, broadcast, publishBoard });
runner.setNotionHooks(notion.hooks);
// 지워진 세션과 워크스페이스를 카드에서 뗀다.
const pruneBoard = () => {
  if (board.prune(store.allAgentIds, store.allWorkspaceIds)) publishBoard();
  // NOTION2: 지워진 세션에 묶인 Notion 페이지 대화도 정리한다
  if (notion.chats.prune(store.allAgentIds)) broadcast({ type: "notionChats", chats: notion.chats.wire() });
};
// Slack Inbox: 가져오기는 Slack 읽기 도구만 허용한 일회성 CLI 세션이 하고, 결과는 ~/.agent-nav/inbox.json 에 남는다.
const inboxStore = new InboxStore();
// 시험 인스턴스이거나 설정 showSlack 이 꺼져 있으면 Slack 을 읽지 않고 판단과 분석 모델도 부르지 않는다. 설정은 부를 때마다 읽어 데몬을 다시 띄우지 않아도 바로 적용된다.
const slackCollectionBlocked = () => mentionCollectionBlocked(process.env, store.settings);
// 새 멘션은 haiku 가 요청인지 판단하고, 요청이면 sonnet 이 읽기 전용으로 분석한 뒤 보드 카드를 만든다 (server/mentions.ts).
const mentions = new MentionPipeline({
  inbox: inboxStore,
  board,
  settings: () => store.settings,
  workspaces: () => store.workspaces,
  judge: judgeMentions,
  analyze: runAnalysis,
  emitInbox: () => broadcast({ type: "inbox", inbox: inbox.state() }),
  emitBoard: () => publishBoard(),
  blocked: slackCollectionBlocked,
});
const inbox: InboxFetcher = new InboxFetcher(inboxStore, (state) => broadcast({ type: "inbox", inbox: state }), () => mentions.judgeNew(), slackCollectionBlocked);
let inboxTimer: NodeJS.Timeout | null = null;
// 주기는 설정(inboxIntervalMinutes, 0 이면 끔)을 따른다. 앱(데몬)이 떠 있는 동안만 돌고, 이미 가져오는 중이면 건너뛴다.
function armInboxTimer() {
  if (inboxTimer) clearInterval(inboxTimer);
  inboxTimer = null;
  const minutes = store.settings.inboxIntervalMinutes;
  if (!minutes || slackCollectionBlocked()) {
    // 숨긴 상태라서 멈춘 것인지 로그에 남긴다(시험 인스턴스와 주기 0 은 평소처럼 조용히 둔다).
    if (minutes && store.settings.showSlack !== true) console.log("[inbox] auto fetch stays off: Show Slack is off");
    return;
  }
  inboxTimer = setInterval(() => {
    if (!inbox.fetching && !slackCollectionBlocked()) void inbox.refresh();
  }, minutes * 60_000);
  inboxTimer.unref();
}
armInboxTimer();
mentions.resume();
// MORNINGREVIEW: 평일 아침(설정 시각)에 보드와 세션을 훑어 리뷰를 만든다. 자동 실행은 시험 인스턴스에서는 하지 않고(AGENT_NAV_REVIEW_AUTO=1 이면 시험에서도 켠다), 수동 실행은 어디서나 된다.
const morningReview = new MorningReviewService({
  store,
  board,
  emit: broadcast,
  boardChanged: publishBoard,
  autoBlocked: () => morningReviewAutoBlocked(process.env, store.settings),
  modelName: () => defaultsReader.resolve(store.settings).model.value ?? undefined,
});
morningReview.start();
// RELEASE: 설정 New version available 이 켜져 있을 때만 GitHub 최신 릴리스를 하루 한 번 묻는다. 화면에서는 묻지 않는다.
const releaseCheck = new ReleaseCheck({ enabled: () => store.settings.notifyNewVersion === true, onChange: (release) => broadcast({ type: "release", release }) });
releaseCheck.start();
allowProviderEnv(store.settings.useProviderEnv === true);
const quick = new QuickRunner(store, runner, broadcast);
const side = new SideRunner(store, runner, broadcast);
const termAsk = new TermAskRunner(broadcast);
const feedback: FeedbackRunner = new FeedbackRunner({
  store,
  agents: runner,
  emit: broadcast,
  srcRoot: SRC_ROOT,
  port: PORT,
  restart: () => restartScheduler.request(),
  daemon: daemonBuild(),
  // FBREDO: 검사 중인 피드백(개선 세션은 쉬는 중)도 재시작에 끊기니 함께 센다
  busyCount: () => busyNow(),
});
onModelTurnDone = () => feedback.authRestored();
runner.setFeedbackHooks({ options: (agent) => feedback.options(agent), afterTurn: (id) => feedback.afterTurn(id), turnStarted: (id) => feedback.turnStarted(id), beforeTurn: (id, prompt) => feedback.beforeTurn(id, prompt), removeWorktree: (agent) => feedback.removeWorktree(agent) });
// FBREDO: 재시작에 끊긴 피드백을 이어 간다(훅이 걸린 뒤여야 개선 세션의 도구 제한이 적용된다)
void feedback.settleOnStart().catch((error) => console.error("[feedback] settle failed", error));
void feedback.resumeInterrupted().catch((error) => console.error("[feedback] resume failed", error));

// PERFDAEMON: 끝난 피드백 정리는 설정(feedbackAutoTidy)이 켜져 있을 때만 자동으로 돈다: 데몬이 뜬 1분 뒤 한 번, 그 뒤 6시간마다. 수동 실행은 feedback.tidyRun.
const TIDY_FIRST_MS = 60_000;
const TIDY_EVERY_MS = 6 * 3_600_000;
let tidyTimer: NodeJS.Timeout | null = null;
function armFeedbackTidy(delayMs = TIDY_FIRST_MS) {
  if (tidyTimer) clearTimeout(tidyTimer);
  tidyTimer = null;
  if (store.settings.feedbackAutoTidy !== true || process.env.AGENT_NAV_NO_TIDY === "1") return;
  tidyTimer = setTimeout(() => {
    feedback
      .tidyRun()
      .then((result) => {
        if (result.worktrees > 0 || result.backups > 0) console.log(`[feedback] tidy: ${result.worktrees} worktrees, ${result.backups} backups, ${Math.round(result.freedBytes / 1048576)} MB freed, ${result.skipped.length} skipped, ${result.failed.length} failed`);
      })
      .catch((error) => console.error("[feedback] tidy failed", error))
      .finally(() => armFeedbackTidy(TIDY_EVERY_MS));
  }, delayMs);
  tidyTimer.unref();
}
armFeedbackTidy();

// AUTODONE: 마지막 활동에서 평일 3일 지난 세션을 Done 으로 넘긴다(고정한 세션과 안 읽은 세션은 빼고, 판정은 server/agents.ts isAutoDoneDue). 데몬이 뜬 1분 뒤 한 번, 그 뒤 1시간마다.
const AUTO_DONE_FIRST_MS = 60_000;
const AUTO_DONE_EVERY_MS = 3_600_000;
function armAutoDone(delayMs = AUTO_DONE_FIRST_MS) {
  setTimeout(() => {
    try {
      const count = runner.autoDone();
      if (count > 0) console.log(`[agents] auto done: ${count} sessions idle for 3+ weekdays`);
    } catch (error) {
      console.error("[agents] auto done failed", error);
    }
    armAutoDone(AUTO_DONE_EVERY_MS);
  }, delayMs).unref();
}
armAutoDone();

const importDeps: ImportDeps = { store, runner, emit: broadcast };
runner.setImportHooks({ beforeTurn: (id) => reconcileBeforeTurn(importDeps, id), turnEnded: (id) => markSynced(importDeps, id) });

// 보드 자동 이동 (설정 boardAutoMove). 규칙은 열 이름이 아니라 역할(role)로 찾는다: 첫 실행이면 Backlog 또는 Todo 의 카드를 In Progress 로,
// 턴이 끝났을 때 변경 파일이 남아 있으면 In Progress 의 카드를 Review 로. Done 은 사람만 옮긴다.
runner.setBoardHooks({
  link: (agentId, cardId) => {
    board.linkAgent(cardId, agentId);
    publishBoard();
  },
  turnStarted: (agentId) => {
    void beginLastTurn(store.agent(agentId), store).catch((error) => console.error("[lastTurn] snapshot failed", error));
    beginTouchTurn(store.agent(agentId));
    if (!store.settings.boardAutoMove) return;
    if (board.moveToRole(board.cardsLinkedTo(agentId).map((c) => c.id), ["backlog", "todo"], "inProgress")) publishBoard();
  },
  turnEnded: (agentId) => {
    if (!store.settings.boardAutoMove) return;
    const cardIds = board.cardsLinkedTo(agentId).map((c) => c.id);
    if (!cardIds.length) return;
    void (async () => {
      try {
        const { files } = await changesOf(store.agent(agentId), "session");
        if (files.length && board.moveToRole(cardIds, ["inProgress"], "review")) publishBoard();
      } catch (error) {
        console.error("[board] auto-move to Review failed", error);
      }
    })();
  },
  removed: (agentId) => {
    void forgetLastTurn(agentId);
    void forgetForkBase(agentId);
    void forgetLedger(agentId);
    pruneBoard();
  },
});

// 이 데몬이 읽은 파일(번들이면 dist-electron/daemon.mjs)의 수정 시각. 읽지 못하면 없음으로 두어 시작 때 하는 재시작 대기 정리를 건너뛴다.
function daemonBuild() {
  try {
    const file = fileURLToPath(import.meta.url);
    return { startedAt: daemonStartedAt, builtAt: statSync(file).mtimeMs, bundled: file.endsWith(".mjs") };
  } catch {
    return undefined;
  }
}

// 도는 세션, 보조 질문, 검사 중인 피드백의 수. 0 이어야 데몬을 재시작해도 된다.
const busyNow = () => runner.activeCount() + quick.activeCount() + side.activeCount() + termAsk.activeCount() + feedback.checkingCount();

// IDLEUPDATE: 자리를 비운 사이 새 소스가 있으면 앱이 스스로 빌드하고 설치한 앱으로 갈아 끼운다(설정 autoUpdateWhenIdle, 기본 꺼짐).
// 설치된 앱이 띄운 데몬에서만 돈다(electron/main.ts 가 AGENT_NAV_PACKAGED=1 을 준다). tsx 로 띄운 개발 데몬과 AGENT_NAV_HOME 을 바꾼 시험 인스턴스는 건드리지 않는다.
if (process.env.AGENT_NAV_PACKAGED === "1" && !process.env.AGENT_NAV_HOME && process.env.AGENT_NAV_NO_AUTOUPDATE !== "1") {
  new IdleUpdater({ home: HOME, srcRoot: SRC_ROOT, enabled: () => store.settings.autoUpdateWhenIdle !== false, busy: busyNow, startedAt: daemonStartedAt, restart: () => restartScheduler.request(), log: console.log }).start();
}

// RESTARTGATE: 재시작 요청(daemon.restartIfIdle, feedback.restart)의 합류점. 직전 재시작으로 뜬 직후에는 창이 다시 읽히고 첫 연결을 맺는 중이라 바로 재시작하지 않는다.
// 쿨다운 동안 온 요청은 타이머 하나에 합쳐지고, 기다리는 동안에도 도는 세션이 있으면 끝날 때까지 더 기다린다. 실제로 재시작할 때 화면(브라우저로 붙은 창)에 다시 읽으라고 알린다.
const restartScheduler = new RestartScheduler({
  now: Date.now,
  wait: () => Math.max(restartWaitMs({ now: Date.now(), startedAt: daemonStartedAt, firstClientAt }), busyNow() > 0 ? 1000 : 0),
  run: () => {
    broadcast({ type: "reload", restarting: true });
    setTimeout(() => restartDaemon(), 300);
  },
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (handle) => clearTimeout(handle as NodeJS.Timeout),
});

// 데몬 재시작. Electron 안이면 main 이 다시 띄우고, 아니면 같은 명령으로 스스로 다시 띄운다 (새 프로세스는 포트가 풀릴 때까지 listen 을 재시도한다).
function restartDaemon() {
  console.log("[daemon] restarting");
  store.flush();
  if (process.parentPort) {
    process.parentPort.postMessage({ type: "restart" });
    return;
  }
  spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], { detached: true, stdio: "inherit", env: process.env, cwd: process.cwd() }).unref();
  setTimeout(() => process.exit(0), 300);
}

// 모델 목록, MCP 상태, 계정은 데몬이 뜰 때 CLI 를 한 번 띄워 받는다. 새 모델은 CLI 가 아는 대로 바로 보인다.
// 그 CLI 프로세스는 떠 둔 채로 MCP 재연결과 켜기/끄기를 받는다 (server/meta.ts).
const metaService = new MetaService(ROOT, (next) => broadcast({ type: "meta", meta: next }), () => runner.liveQueries());
process.once("exit", () => {
  store.flush();
  metaService.close();
  runner.closeAll();
  // PERFDAEMON: 프로세스를 닫는 중에 바뀐 상태(대기 중이던 끼어들기 메시지를 큐로 돌려보냄 등)는 저장이 묶이므로 닫은 뒤 한 번 더 쓴다.
  store.flush();
});
void metaService.refresh();
// FIX6A: 끝나기 전의 정리(타임라인 저장, CLI 와 그 자식 프로세스 정리). 아래 두 길이 같은 함수를 부른다.
// 1. Electron 메인의 shutdown 메시지(앱 종료, Developer: Restart Daemon). 2. SIGTERM, SIGINT, SIGHUP: 메인이 데몬을 kill() 하거나 터미널에서 끌 때.
// 신호 처리기가 없으면 Node 가 exit 처리 없이 즉사해서 저장 대기 중이던 답과 CLI 가 남았다. 메인이 SIGKILL 되면 Chromium 이 데몬을 끄므로 저장은 못 하고 CLI 는 입력이 닫혀 스스로 끝난다.
const daemonShutdown = createDaemonShutdown({
  flush: () => store.flush(),
  notifyFlushed: () => process.parentPort?.postMessage({ type: "shutdown-flushed" }),
  closeRuns: () => {
    runner.closeAll();
    store.flush();
  },
  closeMeta: () => metaService.close(),
  groupLeaders: liveGroupLeaders,
  terminate: (roots) => terminateGroups(roots, systemKillDeps),
  sleep: systemKillDeps.sleep,
  exit: (code) => process.exit(code),
  log: (message) => console.log(message),
  now: Date.now,
});
process.parentPort?.on("message", (event) => {
  if (event.data?.type === "shutdown") void daemonShutdown("shutdown message");
});
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, () => void daemonShutdown(`signal ${signal}`));
// 백그라운드 작업 하나의 처리되지 않은 거절이 데몬과 돌고 있는 세션 전부를 끝내지 않게 기록만 한다.
process.on("unhandledRejection", (reason) => console.error("[daemon] unhandled rejection:", reason instanceof Error ? (reason.stack ?? reason.message) : reason));

// 변경 패널의 기준 커밋: worktree 면 기준 브랜치와의 merge-base, 아니면 세션 시작 시점 HEAD.
async function baseOf(agent: Agent) {
  // 피드백 개선 세션: 시작 시점의 파일 해시가 기준이다 (커밋 없이도 된다). 실제 비교는 feedback.changes 가 한다.
  if (agent.feedbackId) return { ref: `feedback:${agent.feedbackId}`, label: T.baseFeedback };
  if (agent.worktree) {
    const ref = await gitOps.mergeBase(agent.cwd, agent.worktree.base);
    return ref ? { ref, label: agent.worktree.base } : null;
  }
  if (!agent.startCommit) return null;
  // 세션 시작 뒤 pull 로 들어온 남의 커밋은 세션의 변경이 아니라서 기준을 그만큼 앞으로 옮긴다
  const ref = await gitOps.sessionBase(agent.cwd, agent.startCommit);
  return { ref, label: T.baseLabel(ref.slice(0, 7)) };
}

// 쓰기(files.write, changes.undo)가 허용되는 파일: 세션의 변경 집합(장부, git 기준 커밋 대비, Uncommitted, Branch)에 들었거나 유지 기록이 있는 파일.
// 기준 커밋이 없는 레포(커밋 0개)는 모든 파일이 untracked 라 변경 집합이 곧 전체 파일이므로, 그때는 장부와 유지 기록만 인정한다.
async function changeSetHas(agent: Agent, absolute: string) {
  if (await isTouched(agent, store, absolute)) return true;
  if (store.change(agent.id, absolute)) return true;
  const base = (await baseOf(agent))?.ref ?? null;
  if (base === null) return false;
  if (agent.feedbackId) return (await feedback.changes(agent.feedbackId)).some((f) => f.path === absolute);
  return (await gitOps.changes(agent.cwd, base)).files.some((f) => f.path === absolute) || (await uncommittedHas(agent, absolute)) || (await branchHas(agent, absolute));
}

// Uncommitted Changes 범위(B4-04)에서 보이는 파일도 되돌릴 수 있어야 한다: HEAD 대비 바뀐 파일은 이미 변경 집합이다.
async function uncommittedHas(agent: Agent, absolute: string) {
  return (await gitOps.headCommit(agent.cwd)) ? (await gitOps.changes(agent.cwd, "HEAD")).files.some((f) => f.path === absolute) : false;
}

// 변경 패널의 처음 범위(Branch)에서 보이는 파일도 되돌릴 수 있어야 한다: 기준 브랜치와의 merge-base 대비 바뀐 파일이다.
async function branchHas(agent: Agent, absolute: string) {
  const base = await scopedBase(agent, "branch");
  return base ? (await gitOps.changes(agent.cwd, base)).files.some((f) => f.path === absolute) : false;
}

// 기준 커밋이 없을 때 변경 패널의 기준은 수정 직전 스냅샷이다. 패널이 "기준 없음" 으로 읽지 않게 base 를 채운다.
const SNAPSHOT_BASE = "snapshots";
function withSnapshotBase(agent: Agent, info: GitInfo): GitInfo {
  if (info.base || !usesSnapshots(agent)) return info;
  return { ...info, base: SNAPSHOT_BASE, baseLabel: T.baseSnapshots };
}

// 변경 패널과 칩(범위를 안 보내면 기본 범위 Branch), 사이드바 행과 보드 자동 이동("session")이 같이 쓰는 변경 파일 계산.
// 세션의 작업 폴더 밖 파일(모노레포의 다른 폴더)은 기본으로 뺀다. 빠진 개수는 outsideCount 로 알려, 패널이 "Show changes outside this folder" 를 보이게 한다.
async function changesOf(agent: Agent, requested?: ChangeScope, includeOutside = false) {
  return gitOps.limitToFolder(agent.cwd, await changesWithinRepo(agent, requested), includeOutside);
}

async function changesWithinRepo(agent: Agent, requested?: ChangeScope) {
  // 폴더 없는 세션(퀵 챗)은 변경 대상이 없다
  if (agent.workspaceId === null) return { base: null, files: [] };
  if (agent.feedbackId) return { base: `feedback:${agent.feedbackId}`, files: await feedback.changes(agent.feedbackId) };
  const scope = requested ?? defaultChangeScope(agent);
  // FIX4A: Session 범위는 이 세션의 에이전트가 만진 파일 장부(server/sessionTouch.ts)로 만든다. 폴더 전체를 비교하지 않는다.
  if (await listsFromLedger(agent, scope)) return withKeptCounts(agent, scope, await touchedChanges(agent, store));
  const scoped = await scopedBase(agent, scope);
  if (scope === "lastTurn") return touchedLastTurn(agent, store);
  if (scoped) return withKeptCounts(agent, scope, await gitOps.changes(agent.cwd, scoped));
  const base = (await baseOf(agent))?.ref ?? null;
  if (!base && usesSnapshots(agent)) return { base: SNAPSHOT_BASE, files: await snapshotChanges(agent, store) };
  return withKeptCounts(agent, scope, await gitOps.changes(agent.cwd, base));
}

// Keep 한 변경은 +/- 에서 빠진다. 유지 기록이 기준으로 쓰이는 Branch 와 Session 범위만(web/DiffView.tsx 의 useOriginal 과 같은 규칙)이다. Uncommitted 와 Last Turn 은 자기 기준이 따로 있다.
async function withKeptCounts<T extends { files: ChangedFile[] }>(agent: Agent, scope: ChangeScope, result: T): Promise<T> {
  if (scope !== "branch" && scope !== "session") return result;
  return { ...result, files: await applyKeptCounts(agent, store, result.files) };
}

// Session 범위의 목록을 장부로 만드는 세션: 일반 세션과 갈래. worktree 세션과 커밋 0개 폴더는 Branch 와 같은 git 기준(또는 수정 직전 스냅샷)이다. Branch 와 Uncommitted 는 git 기준 그대로다.
async function listsFromLedger(agent: Agent, scope: ChangeScope) {
  return scope === "session" && (await ensureLedger(agent, store))?.listsSession === true;
}

// 변경 범위 메뉴(B4-04)의 기준 커밋. session 과 git 이 아닌 폴더는 null 이라 기존 계산(baseOf)을 쓴다.
// branch: 기준 브랜치와 HEAD 의 merge-base, uncommitted: HEAD.
async function scopedBase(agent: Agent, scope: ChangeScope) {
  if (scope === "uncommitted") return (await gitOps.headCommit(agent.cwd)) ? "HEAD" : null;
  if (scope !== "branch") return null;
  if (agent.worktree) return (await gitOps.mergeBase(agent.cwd, agent.worktree.base)) ?? null;
  const base = await gitOps.defaultBase(agent.cwd);
  return base ? ((await gitOps.mergeBase(agent.cwd, base)) ?? null) : null;
}

// 패널 머리와 제목줄이 쓰는 git 상태. baseBranch 는 Branch Changes 메뉴 설명에 보인다.
async function infoOf(agent: Agent): Promise<GitInfo> {
  if (agent.workspaceId === null) return { repoRoot: null, hasHead: false, branch: null, upstream: null, ahead: 0, behind: 0, base: null, baseLabel: null, baseBranch: null };
  const gitInfo = withSnapshotBase(agent, await gitOps.info(agent.cwd, await baseOf(agent)));
  const info = (await listsFromLedger(agent, defaultChangeScope(agent))) ? { ...gitInfo, base: TOUCH_BASE, baseLabel: T.baseTouched } : gitInfo;
  return { ...info, baseBranch: agent.worktree?.base ?? (info.repoRoot ? await gitOps.defaultBase(agent.cwd) : null) };
}

// BRANCH-SWITCH: dir 와 같은 저장소 작업 트리를 쓰는 세션. 폴더가 저장소 안에 있는 세션만 git 으로 다시 확인한다(worktree 세션은 저장소 밖 폴더라 빠진다).
async function agentsSharingRepo(dir: string) {
  const root = await gitOps.repoRoot(dir);
  if (!root) return [];
  const realRoot = realDir(root);
  const inside = store.agents.filter((a) => {
    const cwd = realDir(a.cwd);
    return cwd === realRoot || cwd.startsWith(`${realRoot}/`);
  });
  const same = await Promise.all(inside.map(async (a) => ((await gitOps.repoRoot(a.cwd)) === root ? a : null)));
  return same.filter((a): a is Agent => a !== null);
}

// client 는 요청을 보낸 연결이다. 공유 목록과 도구 결과처럼 어느 화면이 보냈는지가 중요한 요청만 쓴다.
type Handlers = { [M in RpcMethod]: (params: RpcMethods[M]["params"], client: WebSocket) => Promise<RpcMethods[M]["result"]> | RpcMethods[M]["result"] };

const handlers: Handlers = {
  // CMDT: ⌘T 입력창의 Open in Simulator (server/simulator.ts). 모바일 허용 목록에는 없다.
  ...simulatorHandlers(),
  // SKILLS: 스킬 목록 화면. 피드백 워크스페이스는 사이드바에 없는 작업 폴더라 뺀다.
  ...skillCatalogHandlers(() => ({ home: process.env.AGENT_NAV_SKILLS_HOME ?? homedir(), workspaces: store.workspaces.filter((w) => !w.feedback && !w.archived && !w.parentId).map((w) => ({ id: w.id, name: w.name, dir: w.dir })) })),
  // LINEAR: Linear 이슈 읽기와 상태, 우선순위 쓰기 (server/linear.ts). 키는 키체인에만 있다. 모바일 허용 목록에는 없다.
  ...linearHandlers({
    setAgentIssue: (agentId, issue) => broadcast({ type: "agent", agent: store.patchAgent(agentId, { linearIssue: issue }) }),
  }),
  // NOTION2
  ...notion.handlers,
  // PR: GitHub Pull Requests (server/pr.ts). 쓰기 동작은 confirmed 가 없으면 거절한다.
  ...prHandlers({
    workspaces: () => store.workspaces,
    addWorkspace: (dir, parentId, name) => store.addWorkspace(dir, parentId, name),
    workspaceOfDir: (dir) => store.workspaces.find((w) => w.dir === realDir(dir)),
    markReview: (dir) => reviewCheckouts.add(dir),
    announce: () => broadcast({ type: "workspaces", workspaces: store.workspaces }),
  }),
  // SCM: Source Control 보기 (server/scm.ts)
  ...scmHandlers({
    agentDir: (agentId) => store.agent(agentId).cwd,
    workspaceDir: (workspaceId) => store.workspace(workspaceId).dir,
    workspaces: () => store.workspaces,
    addWorkspace: (dir, parentId, name) => store.addWorkspace(dir, parentId, name),
    announce: () => broadcast({ type: "workspaces", workspaces: store.workspaces }),
  }),
  "workspaces.list": () => store.workspaces,
  // SESSIONORDER: 사이드바 세션 순서. 바꾸면 모든 화면(다른 창 포함)에 새 목록을 보낸다. 모바일 허용 목록에는 없다.
  "sessionOrder.list": () => store.sessionOrders,
  "sessionOrder.set": ({ scope, ids }) => {
    const orders = store.setSessionOrder(scope, ids);
    broadcast({ type: "sessionOrders", orders });
    return orders;
  },
  "sessionOrder.reset": ({ scopes }) => {
    const orders = store.resetSessionOrders(scopes);
    broadcast({ type: "sessionOrders", orders });
    return orders;
  },
  "perf.stats": ({ reset }) => {
    const snapshot = perfSnapshot();
    if (reset) perfReset();
    return { ...snapshot, watch: workspaceWatch.stats() };
  },
  // MOBILE: 데스크톱 화면도 같은 조각 읽기를 쓸 수 있다. 폰 연결은 mobileHandlers 가 먼저 받는다.
  "agents.timelinePage": ({ agentId, limit, beforeId }) => pageOfTimeline(store.timeline(store.agent(agentId).id), limit, beforeId),
  "mobile.ping": () => ({ now: Date.now() }),
  "mobile.status": () => mobileStatus(),
  "mobile.pairingCode": () => {
    if (!mobile.listening) throw new Error(T.errMobileOff);
    return makeOffer(mobilePairing.issue(), lanHosts(), mobile.port, hostname().replace(/\.local$/, ""));
  },
  "mobile.revokeDevice": ({ id }) => {
    if (!mobile.deviceExists(id)) throw new Error(T.errMobileDevice);
    mobile.revokeDevice(id);
    return mobileStatus();
  },
  "workspaces.add": ({ dir }) => {
    const absolute = resolve(dir.replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
    if (!existsSync(absolute) || !statSync(absolute).isDirectory()) throw new Error(T.errFolderNotFound(absolute));
    const workspace = store.addWorkspace(absolute);
    // 사용자가 직접 추가한 폴더는 PR 리뷰 체크아웃이었더라도 이제 신뢰한다
    reviewCheckouts.forget(workspace.dir);
    broadcast({ type: "workspaces", workspaces: store.workspaces });
    return workspace;
  },
  "workspaces.open": async ({ dir }) => {
    const absolute = realDir(resolve(dir.replace(/^~(?=\/|$)/, process.env.HOME ?? "~")));
    if (!existsSync(absolute) || !statSync(absolute).isDirectory()) throw new Error(T.errFolderNotFound(absolute));
    let workspace = store.workspaces.find((w) => w.dir === absolute);
    if (!workspace) {
      const tree = await detectWorktree(absolute);
      if (tree) {
        const parent = store.addWorkspace(worktreeParentDir(absolute, tree));
        workspace = store.addWorkspace(absolute, parent.id, `${parent.name} (${tree.branch})`);
      } else workspace = store.addWorkspace(absolute);
    }
    reviewCheckouts.forget(workspace.dir);
    broadcast({ type: "workspaces", workspaces: store.workspaces });
    return workspace;
  },
  // fix5-3: 사라진 폴더를 새 경로에 다시 잇는다. 폴더를 지금 쓰는 세션이 돌고 있으면 그 작업 폴더가 바뀌므로 거절한다.
  "workspaces.relocate": ({ id, dir }) => {
    const absolute = resolve(String(dir).trim().replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
    if (!existsSync(absolute) || !statSync(absolute).isDirectory()) throw new Error(T.errFolderNotFound(absolute));
    const running = busyAgents(store.agents.filter((a) => a.workspaceId === id && !a.worktree));
    if (running.length) throw new Error(T.errRelocateBusy(running.length));
    const { workspace, moved } = store.relocateWorkspace(id, absolute);
    for (const agent of moved) {
      runner.closeIdle(agent.id);
      broadcast({ type: "agent", agent });
    }
    broadcast({ type: "workspaces", workspaces: store.workspaces });
    return workspace;
  },
  // WSMENU: 세션은 지우지 않고 숨긴다. 열려 있던 화면은 agentRemoved 로 그 세션 칸을 비우고, 폴더를 다시 추가하면 store.onRestored 가 돌려준다.
  "workspaces.remove": ({ id }) => {
    const { hidden, agents } = store.removeFolderFromList(id);
    for (const agent of agents) runner.closeIdle(agent.id);
    for (const agent of agents) broadcast({ type: "agentRemoved", agentId: agent.id });
    broadcast({ type: "workspaces", workspaces: store.workspaces });
    pruneBoard();
    return { hidden };
  },
  "workspaces.reveal": async ({ workspaceId }) => {
    await revealInFileManager(store.workspace(workspaceId).dir);
    return null;
  },
  "files.list": ({ workspaceId }) => listFiles(store.workspace(workspaceId).dir),
  "files.ignored": ({ workspaceId }) => listIgnoredFiles(store.workspace(workspaceId).dir),
  "browser.probe": ({ url }) => probeFrame(url),
  // NOTION: 사이드바 고정 페이지. 바뀔 때마다 목록 전체를 모든 화면에 보낸다.
  "notion.pins.list": () => notionPins.list(),
  "notion.pins.add": (params) => {
    const result = notionPins.add(params);
    if (result.added) broadcast({ type: "notionPins", pins: notionPins.list() });
    return result;
  },
  "notion.pins.update": ({ id, patch }) => {
    const pin = notionPins.update(String(id), patch);
    broadcast({ type: "notionPins", pins: notionPins.list() });
    return pin;
  },
  "notion.pins.remove": ({ id }) => {
    notionPins.remove(String(id));
    broadcast({ type: "notionPins", pins: notionPins.list() });
    return null;
  },
  "notion.pins.move": ({ id, index }) => {
    const pins = notionPins.move(String(id), index);
    broadcast({ type: "notionPins", pins });
    return pins;
  },
  "files.search": ({ workspaceId, query, matchCase, wholeWord, regex, context, include, exclude, ignore, ranges }) =>
    searchWorkspace(store.workspace(workspaceId).dir, { query: String(query ?? ""), matchCase: !!matchCase, wholeWord: !!wholeWord, regex: !!regex, context: Number(context), include: typeof include === "string" ? include : "", exclude: typeof exclude === "string" ? exclude : "", ignore: ignore !== false, ranges: ranges === true, excludeGlobs: searchSettings().exclude }),
  "search.settings": () => searchSettings(),
  // SEARCHREPLACE: Search 뷰의 바꾸기. 모바일 허용 목록(shared/mobile.ts)에도 에이전트 도구에도 없다.
  "search.replace": async ({ workspaceId, files }) => {
    const workspace = store.workspace(workspaceId);
    const response = await replaceInWorkspace(workspace.dir, files);
    if (response.results.some((result) => result.status === "applied" && result.applied > 0)) broadcast({ type: "workspaceChanged", workspaceIds: [workspace.id] });
    return response;
  },
  "browser.saveShot": ({ png }) => saveBrowserShot(String(png)),
  "browser.readShot": async ({ path }) => ({ png: await readBrowserShot(String(path)) }),
  "aside.readImage": ({ paths }) => readAsideImage(paths),
  "browser.setShares": ({ pages, open }, client) => {
    browserBridge.setShares(client, pages, open);
    return null;
  },
  "browser.toolResult": ({ id, result, error }, client) => {
    browserBridge.settle(client, String(id), result, error === undefined ? undefined : String(error));
    return null;
  },
  "files.read": ({ workspaceId, path }) => readWorkspaceFileWithStat(store.workspace(workspaceId).dir, path),
  "files.readBinary": ({ workspaceId, path }) => readWorkspaceBinary(store.workspace(workspaceId).dir, path),
  // INLINEMEDIA: 대화 속 이미지와 영상 경로 확인. 허용 규칙은 server/media.ts 머리말.
  "media.resolve": ({ agentId, paths }) => resolveMediaBatch(paths, mediaContext(agentId), MEDIA_KEY),
  "files.readOfAgent": async ({ agentId, path }) => ({ text: (await readWorkspaceFileWithStat(store.agent(agentId).cwd, path)).text }),
  "files.stat": ({ workspaceId, path }) => statWorkspaceFile(store.workspace(workspaceId).dir, path),
  "repos.mirrorDir": ({ repo, request }) => {
    if (request === true) repoMirrors.request(String(repo));
    return { dir: repoMirrors.dirOf(String(repo)) };
  },
  "files.headText": ({ workspaceId, path }) => headTextOf(store.workspace(workspaceId).dir, String(path)),
  "files.save": ({ workspaceId, path, text, baseMtimeMs, force }) => saveWorkspaceFile(store.workspace(workspaceId).dir, path, String(text), baseMtimeMs ?? null, force === true),
  "files.create": ({ workspaceId, path, kind, text }) => createWorkspaceEntry(store.workspace(workspaceId).dir, String(path), kind === "folder" ? "folder" : "file", typeof text === "string" ? text : ""),
  "files.dirs": ({ workspaceId }) => listEmptyDirs(store.workspace(workspaceId).dir),
  // R4FIX: Files 트리 우클릭 메뉴
  "files.rename": async ({ workspaceId, from, to }) => {
    await renameWorkspaceEntry(store.workspace(workspaceId).dir, String(from), String(to));
    return null;
  },
  "files.trash": ({ workspaceId, path }) => trashWorkspaceEntry(store.workspace(workspaceId).dir, String(path)),
  "files.reveal": async ({ workspaceId, path }) => {
    await revealInFileManager(resolveInside(store.workspace(workspaceId).dir, String(path)));
    return null;
  },
  "format.run": ({ workspaceId, path, text, range, formatter }) => {
    const dir = store.workspace(workspaceId).dir;
    const absolute = resolveInside(dir, path);
    // 파일이 워크스페이스 안의 받은 클론이나 리뷰 체크아웃에 들어 있어도 같다(포맷터는 파일 폴더에서 위로 도구와 설정을 찾는다)
    const own = folderCodeAllowed(dir) && folderCodeAllowed(absolute);
    return runFormat({ dir, absolute, text: String(text), range, formatter, settings: readFormatSettings(own ? dir : null), chosen: store.settings.formatters ?? {}, bundledOnly: !own });
  },
  "format.config": ({ workspaceId } = {}) => {
    const dir = workspaceId ? store.workspace(workspaceId).dir : null;
    const settings = readFormatSettings(dir && folderCodeAllowed(dir) ? dir : null);
    const languages = formatLanguages(settings, store.settings.formatters ?? {});
    const chosen = store.settings.formatOnSave;
    if (typeof chosen === "boolean") return { formatOnSave: chosen, source: "agent-nav" as const, languages };
    const fromVscode = formatOnSaveOf(settings);
    return fromVscode === null ? { formatOnSave: false, source: "builtin" as const, languages } : { formatOnSave: fromVscode, source: "vscode" as const, languages };
  },
  // 그 세션의 변경 집합(git 기준 커밋 대비)에 든 파일이나 유지 기록이 있는 파일만, 세션 cwd 안에서만 쓴다.
  // 기준 커밋이 없는 레포(커밋 0개)는 모든 파일이 untracked 라 변경 집합이 곧 전체 파일이므로, 그때는 유지 기록만 인정한다.
  "files.write": async ({ agentId, path, text }) => {
    const agent = store.agent(agentId);
    const absolute = resolveInside(agent.cwd, path);
    if (!(await changeSetHas(agent, absolute))) throw new Error(T.errNotChangedFile);
    await writeWorkspaceFile(agent.cwd, absolute, text);
    return null;
  },
  "workspaces.openInVSCode": async ({ agentId, workspaceId }) => {
    const dir = agentId ? store.agent(agentId).cwd : workspaceId ? store.workspace(workspaceId).dir : null;
    if (!dir) throw new Error(T.errNoFolderToOpen);
    await openFolderInVSCode(dir);
    return null;
  },
  "files.openInVSCode": async ({ workspaceId, path, line, column }) => {
    await openInVSCode(store.workspace(workspaceId).dir, path, line, column);
    return null;
  },
  "commands.local": ({ workspaceId }) => localCommands(store.workspace(workspaceId).dir),
  "meta.get": () => metaService.meta,
  // CODEX: Codex 앱 서버에서 모델 목록과 로그인 상태를 읽는다(server/codex/runner.ts)
  "codex.meta": ({ refresh }) => runner.codexMeta(refresh === true),
  "meta.refresh": () => metaService.refresh(),
  "mcp.reconnect": ({ name }) => metaService.reconnect(name),
  "mcp.toggle": ({ name, enabled }) => metaService.toggle(name, enabled),
  "runtime.info": () => RUNTIME,
  "settings.get": () => store.settings,
  "defaults.get": () => defaultsReader.resolve(store.settings, true),
  "settings.set": async (patch) => {
    const releaseWasOn = store.settings.notifyNewVersion === true;
    const settings = store.updateSettings(patch);
    // MOBILE: 켜기와 끄기는 포트를 열고 닫는 일이라 끝난 뒤에 답한다(화면이 바로 상태를 다시 읽는다).
    if (patch && typeof patch === "object" && "mobileAccess" in patch) await applyMobileAccess();
    // Slack 을 켜고 끄면 주기 가져오기를 다시 맞춘다. 켤 때는 꺼져 있는 동안 멈춰 있던 분석 큐도 이어서 돈다.
    if (patch && typeof patch === "object" && ("inboxIntervalMinutes" in patch || "showSlack" in patch)) armInboxTimer();
    if (patch && typeof patch === "object" && "showSlack" in patch) mentions.kick();
    if (patch && typeof patch === "object" && "keepIdleSessionsWarmMinutes" in patch) runner.rearmIdleCloses();
    if (patch && typeof patch === "object" && "maxWarmSessions" in patch) runner.enforceWarmCap();
    if (patch && typeof patch === "object" && "feedbackAutoTidy" in patch) armFeedbackTidy();
    // 끌 때는 타이머를 걷고, 꺼져 있다가 켤 때만 바로 한 번 묻는다
    if (releaseWasOn !== (settings.notifyNewVersion === true)) releaseCheck.settingChanged();
    allowProviderEnv(settings.useProviderEnv === true);
    // 자동 추가를 다시 켜면 꺼져 있는 동안 멈춰 있던 분석 큐가 이어서 돈다.
    if (patch && typeof patch === "object" && "autoAddRequests" in patch) mentions.kick();
    // NOTION3: Notion 쓰기를 "Apply automatically" 로 바꾸면 Bypass Permissions 세션에서 떠 있던 승인 카드도 바로 반영된다.
    if (patch && typeof patch === "object" && "notionBypassWrites" in patch) runner.releaseNotionCards();
    broadcast({ type: "settings", settings, defaults: defaultsReader.resolve(settings, true) });
    return settings;
  },
  "logs.tail": ({ lines }) => logRing.slice(-Math.max(1, Math.min(lines, LOG_LINES))),
  "agents.list": () => store.agents,
  "agents.create": (params) => {
    if (params.workspaceId !== null) store.workspace(params.workspaceId);
    if (params.boardCardId !== undefined) board.card(params.boardCardId);
    return runner.create(params);
  },
  // HANDOFF: 인계 문서. 만드는 데 모델을 한 번 부르므로 응답이 늦을 수 있다(화면이 칩에 진행 표시를 둔다).
  "handoff.create": async ({ agentId }) => {
    runner.assertClaude(agentId, "Handoff"); // CODEX
    const agent = store.agent(agentId);
    // FIX4A: 문서 질문이 이 세션이 만진 파일을 폴더 전체의 변경과 구분하게, Session 범위와 같은 장부의 목록을 넘긴다
    const files = agent.workspaceId === null ? null : (await sessionFiles(agent, store).catch(() => null))?.map((f) => f.rel) ?? null;
    return generateHandoff(agent, files);
  },
  "handoff.read": ({ id }) => readHandoff(id),
  "handoff.save": ({ id, text }) => {
    saveHandoff(id, text);
    return null;
  },
  // B3: 응답 중이면 steer 가 아닌 한 큐에 들어간다. 전송 자체(모델 호출)는 기다리지 않고, 큐에 들어갔는지만 바로 돌려준다.
  "agents.send": async ({ agentId, prompt, steer, images, files }) => {
    // FILEATTACH: 파일은 여기서 먼저 확인한다(사라졌으면 이 호출이 실패해 화면이 입력을 그대로 두고 알린다). 모델에는 글 뒤에 경로 블록이 붙은 메시지가 가고, 말풍선에는 글(display)과 파일 칩이 보인다.
    const attached = await resolveFiles(files);
    const queued = runner.willQueue(agentId, steer === true);
    // fixB: 이미지는 칩(말풍선 위 썸네일)과 모델에 가는 image 블록으로 함께 간다. 글이 없는 메시지의 말풍선은 칩만 둔다.
    const chips: UserAttachment[] = [...(images ?? []).map((image) => ({ kind: "image" as const, ...image })), ...attached.chips];
    const attach = chips.length ? { display: prompt, attachments: chips } : {};
    void runner.send(agentId, attached.model(prompt),{ steer: steer === true, ...attach }).catch((error) => console.error("[agent] send failed", error));
    return { queued };
  },
  // fixB: 입력창 이미지 저장
  "images.upload": (params) => saveImage(params),
  // FILEATTACH: 보내기 전에 칩을 지운 업로드 폴백 파일 정리
  "attachments.discard": ({ id }) => discardUpload(id),
  "agents.dequeue": ({ agentId, queueId }) => runner.dequeue(agentId, queueId),
  "agents.cancelSteering": ({ agentId, steeringId }) => runner.cancelSteering(agentId, steeringId),
  // DIFFFB: 쌓인 diff 피드백
  "diffFeedback.list": ({ agentId }) => store.diffFeedback(store.agent(agentId).id),
  "diffFeedback.add": ({ agentId, item }) => runner.addDiffFeedback(agentId, item),
  "diffFeedback.update": ({ agentId, id, text }) => {
    runner.updateDiffFeedback(agentId, id, text);
    return null;
  },
  "diffFeedback.remove": ({ agentId, id }) => {
    runner.removeDiffFeedback(agentId, id);
    return null;
  },
  "diffFeedback.clear": ({ agentId }) => {
    runner.clearDiffFeedback(agentId);
    return null;
  },
  "diffFeedback.send": ({ agentId, text, steer, ids }) => runner.sendDiffFeedback(agentId, { text, steer, ids }),
  "agents.sendQueuedNow": async ({ agentId, queueId }) => {
    void runner.sendQueuedNow(agentId, queueId).catch((error) => console.error("[agent] send queued failed", error));
    return null;
  },
  "agents.interrupt": async ({ agentId }) => {
    await runner.interrupt(agentId);
    return null;
  },
  "agents.timeline": ({ agentId }) => store.timeline(agentId),
  "agents.setPermissionMode": async ({ agentId, mode }) => {
    await runner.setPermissionMode(agentId, mode);
    return null;
  },
  "agents.setModel": ({ agentId, model }) => {
    runner.setModel(agentId, model);
    return null;
  },
  "agents.setEffort": ({ agentId, effort }) => {
    runner.setEffort(agentId, effort);
    return null;
  },
  "agents.respondPermission": ({ agentId, itemId, decision }) => {
    runner.respondPermission(agentId, itemId, decision);
    return null;
  },
  // fixB: 질문 답과 계획 승인
  "agents.answerQuestion": ({ agentId, itemId, answers }) => {
    runner.answerQuestion(agentId, itemId, answers);
    return null;
  },
  "agents.respondPlan": (params) => {
    runner.respondPlan(params.agentId, params.itemId, params.approve ? { approve: true, mode: params.mode } : { approve: false, feedback: params.feedback });
    return null;
  },
  "agents.remove": async ({ agentId, removeWorktree }) => {
    await runner.remove(agentId, removeWorktree);
    return null;
  },
  "agents.worktreeStatus": async ({ agentId }) => {
    const agent = store.agent(agentId);
    if (!agent.worktree) return null;
    return { ...(await gitOps.worktreeStatus(agent.worktree.root)), unmerged: await unmergedCount(agent.worktree), branch: agent.worktree.branch, base: agent.worktree.base };
  },
  "worktree.mergeInfo": async ({ agentId }) => {
    const { worktree } = store.agent(agentId);
    return worktree ? mergeInfo(worktree) : null;
  },
  "worktree.merge": async ({ agentId, confirmed }) => {
    if (confirmed !== true) throw new Error(T.errNotConfirmed);
    const { worktree } = store.agent(agentId);
    if (!worktree) throw new Error(T.errNotWorktreeSession);
    const merged = await mergeIntoBase(worktree);
    // 합친 작업 트리를 쓰는 세션들의 변경 목록이 바뀐다
    const affected = merged.dir ? (await agentsSharingRepo(merged.dir)).map((a) => a.id) : [];
    return { target: merged.target, fastForward: merged.fastForward, commits: merged.commits, affectedAgentIds: affected };
  },
  "worktree.createPr": async ({ agentId, confirmed }) => {
    if (confirmed !== true) throw new Error(T.errNotConfirmed);
    const { worktree } = store.agent(agentId);
    if (!worktree) throw new Error(T.errNotWorktreeSession);
    return createPullRequest(worktree);
  },
  "agents.fork": ({ agentId, beforeItemId }) => (beforeItemId ? runner.forkBefore(agentId, beforeItemId) : runner.fork(agentId)),
  // B2: 체크포인트 복원과 Redo
  "agents.restoreCheckpoint": ({ agentId, itemId }) => runner.restoreCheckpoint(agentId, itemId),
  "agents.previewCheckpoint": ({ agentId, itemId }) => runner.previewCheckpoint(agentId, itemId),
  "agents.cancelRestore": ({ agentId }) => {
    runner.cancelRestore(agentId);
    return null;
  },
  "agents.redoCheckpoint": ({ agentId }) => runner.redoCheckpoint(agentId),
  "agents.checkpointModes": ({ agentId }) => runner.checkpointModes(agentId),
  "app.showAgent": ({ agentId }) => {
    store.agent(agentId);
    broadcast({ type: "showAgent", agentId });
    return null;
  },
  "agents.markRead": ({ agentId, read }) => {
    runner.setRead(agentId, read);
    return null;
  },
  "workspaces.watch": async ({ workspaceIds }, client) => {
    const roots = new Set<string>();
    const linked: Record<string, string> = {};
    for (const id of Array.isArray(workspaceIds) ? workspaceIds : []) {
      const workspace = store.workspaces.find((w) => w.id === id);
      if (!workspace) continue;
      const root = realDir((await gitOps.repoRoot(workspace.dir)) ?? workspace.dir);
      roots.add(root);
      const gitDir = await gitOps.linkedGitDir(root);
      if (gitDir) linked[root] = gitDir;
    }
    workspaceWatch.setClient(client, [...roots], linked);
    return null;
  },
  "agents.setOpen": ({ agentIds }, client) => {
    runner.setOpenAgents(client, Array.isArray(agentIds) ? agentIds.filter((id) => typeof id === "string") : []);
    return null;
  },
  "agents.setPinned": ({ agentId, pinned }) => {
    runner.setPinned(agentId, pinned);
    return null;
  },
  "agents.setDone": ({ agentId, done }) => {
    runner.setDone(agentId, done);
    return null;
  },
  "agents.rename": ({ agentId, title }) => {
    runner.rename(agentId, title);
    return null;
  },
  "changes.list": ({ agentId }) => store.changes(agentId),
  "changes.setOriginal": ({ agentId, path, original }) => {
    broadcast({ type: "changes", agentId, changes: store.setChange(agentId, path, original) });
    return null;
  },
  "changes.clear": ({ agentId, path }) => {
    broadcast({ type: "changes", agentId, changes: store.clearChanges(agentId, path) });
    return null;
  },
  // FIX4A: Undo. 서버가 장부로 "에이전트의 마지막 쓰기 뒤 아무도 안 고친 파일" 만 허용한다(화면의 확인 창은 checkUndo 결과로 파일 이름을 보인다).
  "changes.checkUndo": ({ agentId, paths }) => {
    const agent = store.agent(agentId);
    return checkUndo(agent, store, paths.map((path) => resolveInside(agent.cwd, path)));
  },
  "changes.undo": async ({ agentId, items }) => {
    const agent = store.agent(agentId);
    const texts = new Map(items.map((item) => [resolveInside(agent.cwd, item.path), item.text]));
    const check = await checkUndo(agent, store, [...texts.keys()]);
    for (const path of check.allowed) if (!(await changeSetHas(agent, path))) throw new Error(T.errNotChangedFile);
    for (const path of check.allowed) await writeWorkspaceFile(agent.cwd, path, texts.get(path) ?? null);
    await forgetTouched(agent, store, check.allowed);
    for (const path of check.allowed) broadcast({ type: "changes", agentId, changes: store.clearChanges(agentId, path) });
    return { ...check, reverted: check.allowed };
  },
  "git.info": ({ agentId }) => infoOf(store.agent(agentId)),
  // fetch, push, pull 은 사용자가 버튼을 눌렀을 때만 온다. 강제 옵션은 없다.
  "git.fetch": async ({ agentId }) => {
    const agent = store.agent(agentId);
    await gitOps.fetch(agent.cwd);
    return infoOf(agent);
  },
  "git.push": async ({ agentId }) => ({ output: await gitOps.push(store.agent(agentId).cwd) }),
  "git.pull": async ({ agentId }) => ({ output: await gitOps.pull(store.agent(agentId).cwd) }),
  "git.changes": ({ agentId, scope, includeOutside }) => changesOf(store.agent(agentId), scope, includeOutside === true),
  "git.workspaceChanges": async ({ workspaceId }) => {
    const dir = store.workspace(workspaceId).dir;
    const result = gitOps.limitToFolder(dir, await gitOps.changes(dir, (await gitOps.headCommit(dir)) ? "HEAD" : null), false);
    return { files: result.files };
  },
  "git.original": async ({ agentId, path, scope, from }) => {
    const agent = store.agent(agentId);
    if (agent.feedbackId) return { text: await feedback.original(agent.feedbackId, relative(agent.cwd, resolveInside(agent.cwd, path))) };
    const absolute = await resolveReadable(agent.cwd, path);
    // 이름이 바뀐 파일(R)의 기준 내용은 옛 이름으로 읽는다
    const source = from ? await resolveReadable(agent.cwd, from) : absolute;
    const resolved = scope ?? defaultChangeScope(agent);
    if (resolved === "lastTurn") return { text: await lastTurnOriginal(agent, store, absolute) };
    if (await listsFromLedger(agent, resolved)) {
      const before = await touchedOriginal(agent, store, absolute);
      if (before !== undefined) return { text: before };
    }
    const scoped = await scopedBase(agent, resolved);
    if (scoped) return { text: await gitOps.original(agent.cwd, scoped, source, { strict: true }) };
    const base = (await baseOf(agent))?.ref ?? null;
    if (!base && usesSnapshots(agent)) return { text: store.change(agentId, absolute)?.original ?? null };
    return { text: await gitOps.original(agent.cwd, base, source, { strict: true }) };
  },
  "git.blame": async ({ workspaceId, path, text }) => ({ blame: await blameOf(store.workspace(workspaceId).dir, String(path), typeof text === "string" ? text : undefined) }),
  "git.checkBranchName": async ({ workspaceId, branch }) => {
    const root = await gitOps.repoRoot(store.workspace(workspaceId).dir);
    return { problem: root ? await gitOps.branchNameProblem(root, branch) : T.errNotGitRepoForWorktree };
  },
  "git.branches": ({ workspaceId }) => gitOps.branches(store.workspace(workspaceId).dir),
  "git.switchBranch": async ({ workspaceId, branch, allowBusy }) => {
    const dir = store.workspace(workspaceId).dir;
    const sharing = await agentsSharingRepo(dir);
    const busy = sharing.filter((a) => a.status === "running" || a.status === "waiting");
    if (busy.length > 0 && !allowBusy) return { switched: false, busy: busy.map((a) => a.title), affectedAgentIds: [], info: await gitOps.branches(dir) };
    await gitOps.switchBranch(dir, branch);
    return { switched: true, busy: [], affectedAgentIds: sharing.map((a) => a.id), info: await gitOps.branches(dir) };
  },
  "git.prs": ({ agentId }) => gitOps.pullRequests(store.agent(agentId).cwd),
  "quick.ask": ({ id, workspaceId, model, question, context }) => {
    quick.ask(id, workspaceId, model, question, context);
    return null;
  },
  "quick.cancel": ({ id }) => {
    quick.cancel(id);
    return null;
  },
  "quick.adopt": ({ id }) => quick.adopt(id),
  "termask.ask": ({ id, model, question, context }) => {
    termAsk.ask(id, model, question, context);
    return null;
  },
  "termask.cancel": ({ id }) => {
    termAsk.cancel(id);
    return null;
  },
  "pty.info": ({ ptyId }) => ptyInfo(ptyId),
  "side.ask": ({ id, agentId, model, question }) => {
    runner.assertClaude(agentId, "Side question (/btw)"); // CODEX
    side.ask(id, agentId, model, question);
    return null;
  },
  "side.cancel": ({ id }) => {
    side.cancel(id);
    return null;
  },
  "side.adopt": ({ id }) => side.adopt(id),
  "inbox.get": () => inbox.state(),
  "inbox.refresh": () => inbox.refresh(),
  "inbox.markRead": ({ ids, read }) => {
    const list = inboxIds(ids);
    if (typeof read !== "boolean") throw new Error(T.errInboxFlag("read"));
    inboxStore.setRead(list, read);
    return publishInbox();
  },
  "inbox.archive": ({ ids, archived }) => {
    const list = inboxIds(ids);
    if (typeof archived !== "boolean") throw new Error(T.errInboxFlag("archived"));
    inboxStore.setArchived(list, archived);
    return publishInbox();
  },
  "inbox.thread": ({ id }) => inbox.thread(id),
  "inbox.addToBoard": ({ id, workspaceId }) => mentions.addToBoard(id, topWorkspaceOf(workspaceId)),
  "inbox.reanalyze": ({ id }) => {
    mentions.reanalyze(id);
    return inbox.state();
  },
  "inbox.notRequest": ({ id }) => {
    mentions.notRequest(id);
    return inbox.state();
  },
  // NOTES: 메모장. 바뀐 뒤에는 전체 목록을 모든 창에 알린다(본문은 싣지 않는다).
  "notes.list": ({ query }) => notes.list(typeof query === "string" ? query : ""),
  "notes.get": ({ id }) => notes.get(id),
  "notes.create": ({ text }) => {
    const note = notes.create(text);
    publishNotes();
    return note;
  },
  "notes.save": ({ id, text }) => {
    const before = notes.get(id).rev;
    const note = notes.save(id, text);
    if (note.rev !== before) publishNotes();
    return note;
  },
  "notes.delete": ({ id }) => {
    notes.delete(id);
    publishNotes();
    return null;
  },
  "board.get": () => board.get(),
  "board.createCard": (params) => {
    const input = params && typeof params === "object" ? params : ({} as typeof params);
    const workspaceId = topWorkspaceOf(input.workspaceId);
    for (const agentId of Array.isArray(input.agentIds) ? input.agentIds : []) store.agent(agentId);
    if (input.source) store.agent(input.source.agentId);
    const card = board.createCard({ ...input, workspaceId });
    publishBoard();
    return card;
  },
  "board.updateCard": ({ id, patch }) => {
    const next = patch && typeof patch === "object" && patch.workspaceId !== undefined ? { ...patch, workspaceId: topWorkspaceOf(patch.workspaceId) } : patch;
    const card = board.updateCard(id, next);
    publishBoard();
    return card;
  },
  "board.deleteCard": ({ id }) => {
    board.deleteCard(id);
    publishBoard();
    return null;
  },
  "board.moveCard": ({ id, columnId, index }) => {
    const card = board.moveCard(id, columnId, index);
    publishBoard();
    return card;
  },
  "board.linkAgent": ({ cardId, agentId }) => {
    store.agent(agentId);
    const card = board.linkAgent(cardId, agentId);
    publishBoard();
    return card;
  },
  "board.unlinkAgent": ({ cardId, agentId }) => {
    const card = board.unlinkAgent(cardId, agentId);
    publishBoard();
    return card;
  },
  "board.addColumn": ({ name }) => {
    const column = board.addColumn(name);
    publishBoard();
    return column;
  },
  "board.renameColumn": ({ id, name }) => {
    const column = board.renameColumn(id, name);
    publishBoard();
    return column;
  },
  "board.deleteColumn": ({ id }) => {
    board.deleteColumn(id);
    publishBoard();
    return null;
  },
  "board.moveColumn": ({ id, index }) => {
    board.moveColumn(id, index);
    publishBoard();
    return null;
  },
  "board.setLabelColor": ({ label, color }) => {
    board.setLabelColor(label, color);
    publishBoard();
    return null;
  },
  "review.get": () => morningReview.state(),
  "release.get": () => releaseCheck.state(),
  "release.dismiss": ({ version }) => {
    if (typeof version !== "string" || !version || version.length > 64) throw new Error("bad version");
    return releaseCheck.dismiss(version);
  },
  "review.run": () => morningReview.run("manual"),
  "review.apply": ({ date, cardIds }) => {
    if (typeof date !== "string" || (cardIds !== null && !(Array.isArray(cardIds) && cardIds.every((id) => typeof id === "string")))) throw new Error(T.errReviewUnknown);
    return morningReview.apply(date, cardIds);
  },
  "review.markSeen": ({ date }) => morningReview.markSeen(String(date)),
  "import.vscodeList": () => listVscodeSessions(importDeps),
  "import.vscodeRun": ({ keys }) => importVscodeSessions(importDeps, Array.isArray(keys) ? keys.filter((k): k is string => typeof k === "string") : []),
  "import.activity": ({ agentId }) => importActivity(importDeps, agentId),
  "feedback.create": (params) => feedback.create(params),
  "feedback.sourceReady": async () => ({ ready: await feedback.sourceReady() }),
  "feedback.list": () => feedback.list(),
  "feedback.revert": ({ id }) => feedback.revert(id),
  "feedback.restart": ({ id }) => feedback.requestRestart(id),
  "feedback.retryChecks": ({ id }) => feedback.retryChecks(id),
  "feedback.runAgain": ({ id }) => feedback.runAgain(id),
  "feedback.resolve": ({ id }) => feedback.resolve(id),
  "feedback.dismiss": ({ id }) => feedback.dismiss(id),
  // 코디네이터 배포 감시가 새 빌드를 반영할 때 쓴다. 도는 세션이나 검사 중인 피드백이 있으면 거절한다.
  // 직전 재시작 뒤 쿨다운 안이면 지금 하지 않고 합쳐서 나중에 한다(deferred).
  "daemon.restartIfIdle": () => {
    const busy = busyNow();
    if (busy > 0) return { restarted: false, busy };
    const outcome = restartScheduler.request();
    return outcome.deferred ? { restarted: false, busy: 0, deferred: true, inMs: outcome.inMs } : { restarted: true, busy: 0 };
  },
  "feedback.markSeen": ({ id }) => {
    feedback.markSeen(id);
    return null;
  },
  "feedback.tidyPlan": ({ policy }) => feedback.tidyPlan(policy ?? {}),
  "feedback.tidyRun": ({ policy }) => feedback.tidyRun(policy ?? {}),
};

// MOBILE: 폰 연결이 데스크톱 핸들러보다 먼저 받는 호출. 폰에는 피드백 개선 세션을 보이지 않고, 새 세션은 폴더(와 worktree)와 첫 글만 받아 나머지는 데스크톱 기본값으로 채운다.
// 새 세션의 권한 모드는 기본값이 Auto 나 Bypass Permissions 여도 Ask Before Edits(default)로 낮춘다: 폰으로 만든 세션은 폰에서 승인 카드를 보고 답한다.
// 인자는 이 핸들러에 오기 전에 guardMobileCall(server/mobileAccess.ts)이 거른다. 여기서는 존재와 피드백 세션 여부 같은 데몬의 상태만 본다.
function phoneWorkspace(id: string) {
  const workspace = store.workspace(id);
  if (workspace.feedback) throw new Error(`Unknown workspace: ${id}`);
  return workspace;
}

function phoneAgent(id: string) {
  const agent = store.agent(id);
  if (agent.feedbackId) throw new Error(`Unknown agent: ${id}`);
  return agent;
}

const mobileHandlers: { [method: string]: (params: any, client: WebSocket) => unknown } = {
  "mobile.ping": () => ({ now: Date.now() }),
  "workspaces.list": () => store.workspaces.filter((w) => !w.feedback),
  "agents.list": () => store.agents.filter((a) => !a.feedbackId),
  "agents.timelinePage": ({ agentId, limit, beforeId }: { agentId: string; limit: number; beforeId?: string }) => {
    const agent = store.agent(agentId);
    if (agent.feedbackId) throw new Error(`Unknown agent: ${agentId}`);
    return pageOfTimeline(store.timeline(agent.id), limit, beforeId);
  },
  // 홈 아래 폴더 한 단계의 하위 디렉터리(이름과 git 여부, 이미 워크스페이스인지). 경로 검사는 가드에서 끝났다.
  "mobile.browse": ({ dir, display }: { dir: string; display: string }) =>
    listFolder({ dir, display }, new Map(store.workspaces.filter((w) => !w.feedback && !w.parentId).map((w) => [w.dir, w.id]))),
  // 목록에서 빼기: 파일과 git worktree 는 건드리지 않고 세션은 숨겨 두었다가 같은 폴더를 다시 추가하면 돌아온다. 최상위 폴더만(worktree 워크스페이스는 folderScope 가 거절한다).
  "workspaces.remove": ({ id }: { id: string }) => {
    phoneWorkspace(id);
    return handlers["workspaces.remove"]({ id }, null as never);
  },
  "git.branches": ({ workspaceId }: { workspaceId: string }) => gitOps.branches(phoneWorkspace(workspaceId).dir),
  "git.checkBranchName": ({ workspaceId, branch }: { workspaceId: string; branch: string }) => handlers["git.checkBranchName"]({ workspaceId: phoneWorkspace(workspaceId).id, branch }, null as never),
  "agents.setPinned": ({ agentId, pinned }: { agentId: string; pinned: boolean }) => {
    runner.setPinned(phoneAgent(agentId).id, pinned);
    return null;
  },
  "agents.setDone": ({ agentId, done }: { agentId: string; done: boolean }) => {
    runner.setDone(phoneAgent(agentId).id, done);
    return null;
  },
  "agents.rename": ({ agentId, title }: { agentId: string; title: string }) => {
    runner.rename(phoneAgent(agentId).id, title);
    return null;
  },
  "agents.create": async ({ workspaceId, prompt, images, worktree }: { workspaceId: string | null; prompt: string; images?: ImageRef[]; worktree?: { branch: string; base: string } }) => {
    const workspace = workspaceId === null ? null : phoneWorkspace(workspaceId);
    const resolved = defaultsReader.resolve(store.settings);
    const mode = resolved.permissionMode.value;
    let target = workspaceId;
    if (worktree && workspace) {
      // 새 worktree 는 항상 원래 프로젝트에서 만든다(worktree 안에서 다시 worktree 를 만들면 겹친다). 기준 브랜치는 실제로 있는 브랜치여야 한다.
      const top = workspace.parentId ? phoneWorkspace(workspace.parentId) : workspace;
      const info = await gitOps.branches(top.dir);
      if (!info.repoRoot) throw new Error(T.errNotGitRepoForWorktree);
      if (!info.branches.includes(worktree.base)) throw new Error(T.errMobileParam("base"));
      target = top.id;
    }
    return runner.create({ workspaceId: target, prompt, permissionMode: mode === "auto" || mode === "bypassPermissions" ? "default" : mode, model: resolved.model.value, effort: resolved.effort.value, worktree: worktree ?? null, ...(images?.length ? { images } : {}) });
  },
};

async function applyMobileAccess() {
  if (store.settings.mobileAccess === true) {
    if (!mobile.listening) await mobile.start(MOBILE_PORT, MOBILE_BIND).catch((error) => console.error("[mobile] could not listen", error));
  } else if (mobile.listening) {
    await mobile.stop();
  }
}

function mobileStatus(): MobileStatus {
  return { enabled: store.settings.mobileAccess === true, listening: mobile.listening, port: mobile.listening ? mobile.port : MOBILE_PORT, bind: mobile.listening ? mobile.bind : MOBILE_BIND, hosts: lanHosts(), devices: mobile.devices(), error: mobile.error };
}

function inboxIds(ids: unknown): string[] {
  if (!Array.isArray(ids) || ids.length > 1000 || ids.some((id) => typeof id !== "string")) throw new Error(T.errInboxIds);
  return ids as string[];
}

function publishInbox() {
  const state = inbox.state();
  broadcast({ type: "inbox", inbox: state });
  return state;
}

// 카드의 워크스페이스는 사이드바의 프로젝트 단위다. worktree 워크스페이스를 받으면 원래 프로젝트로 바꿔 저장한다.
function topWorkspaceOf(id: unknown): string | null {
  if (id === undefined || id === null) return null;
  if (typeof id !== "string") throw new Error(T.errCardField("workspaceId"));
  const workspace = store.workspace(id);
  return workspace.parentId ?? workspace.id;
}

// INLINEMEDIA: media.resolve 가 쓰는 허용 범위. 작업 폴더와 워크스페이스는 파일 읽기와 같은 규칙(resolveReadable)을 실제 경로에 적용한다.
function mediaContext(agentId: string): MediaContext {
  const agent = store.agent(agentId);
  const workspaceDir = (() => {
    try {
      return agent.workspaceId ? store.workspace(agent.workspaceId).dir : null;
    } catch {
      return null;
    }
  })();
  const readable = (dir: string, real: string) => resolveReadable(dir, real).then(() => true, () => false);
  return {
    cwd: agent.cwd,
    inWorkspace: async (real) => (await readable(agent.cwd, real)) || (!!workspaceDir && (await readable(workspaceDir, real))),
    daemonHome: HOME,
    mentioned: () => mentionedMedia(agentId, store.timeline(agentId)),
  };
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

const server = createServer((req, res) => {
  if (!ALLOWED_HOSTS.has(req.headers.host ?? "")) {
    res.writeHead(403).end("forbidden host");
    return;
  }
  // 요청 주소가 URL 로 읽히지 않으면(예: "//[") new URL 이 던진다. 잡지 않으면 토큰 없는 요청 하나(웹 페이지의 <img> 도 된다)로 데몬이 죽는다.
  const url = parseRequestUrl(req.url, `http://${req.headers.host}`);
  if (!url) {
    res.writeHead(400).end("bad request");
    return;
  }
  // FILEATTACH: 입력창 파일 업로드 폴백. Host 검사는 위에서 끝났고, Origin 과 토큰 검사는 handleUpload 가 한다.
  if (url.pathname === "/attachments") {
    void handleUpload(req, res, url, { token: TOKEN, origins: ALLOWED_ORIGINS }).catch((error) => {
      console.error("[attachments] upload failed", error);
      if (!res.headersSent) res.writeHead(500).end("upload failed");
    });
    return;
  }
  // INLINEMEDIA: 대화 속 이미지와 영상 미리보기. Origin 과 서명 검사는 handleMedia 가 한다.
  if (url.pathname === "/media") {
    void handleMedia(req, res, url, { key: MEDIA_KEY, origins: ALLOWED_ORIGINS }).catch((error) => {
      console.error("[media] serve failed", error);
      if (!res.headersSent) res.writeHead(500).end("media failed");
    });
    return;
  }
  const dist = webDist();
  const file = resolve(dist, `.${url.pathname === "/" ? "/index.html" : url.pathname}`);
  const target = file.startsWith(dist) && existsSync(file) && statSync(file).isFile() ? file : join(dist, "index.html");
  if (!existsSync(target)) {
    res.writeHead(503).end(T.webBuildMissing);
    return;
  }
  let body: string | Buffer = readFileSync(target);
  if (target.endsWith("index.html")) {
    // 토큰을 페이지에만 넣는다. 다른 출처의 페이지는 이 응답을 읽을 수 없고, Host 검사로 DNS rebinding 도 막는다.
    body = body.toString().replace("__AGENT_NAV_TOKEN__", TOKEN);
  }
  const framing = target.endsWith("index.html") && url.searchParams.get("embed") !== "session" ? { "content-security-policy": "frame-ancestors 'self'" } : {};
  res.writeHead(200, { "content-type": MIME[extname(target)] ?? "application/octet-stream", ...framing }).end(body);
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = parseRequestUrl(req.url, "http://localhost");
  if (!url || !isTrusted(req, url)) {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    try {
      if (url.pathname === "/ws/rpc") handleRpc(ws);
      else if (url.pathname === "/ws/lsp") {
        const dir = store.workspace(url.searchParams.get("workspaceId") ?? "").dir;
        bridgeLsp(ws, dir, folderCodeAllowed(dir) ? languageServersFor(folderCodeAllowed) : BUNDLED_LANGUAGE_SERVERS);
      }
      else if (url.pathname === "/ws/pty") {
        const agentId = url.searchParams.get("agentId");
        const workspaceId = url.searchParams.get("workspaceId");
        const base = agentId ? store.agent(agentId).cwd : workspaceId ? store.workspace(workspaceId).dir : homedir();
        // R4FIX: Files 트리의 Open in Integrated Terminal. dir 은 그 폴더 안의 하위 폴더일 때만 받고, 없는 폴더나 폴더 밖이면 거절한다.
        const sub = url.searchParams.get("dir");
        const cwd = sub && (agentId || workspaceId) ? terminalDir(base, sub) : base;
        bridgePty(ws, cwd, Number(url.searchParams.get("cols") ?? 80), Number(url.searchParams.get("rows") ?? 24), url.searchParams.get("ptyId")?.slice(0, 64) || null);
      } else ws.close(1008, "unknown endpoint");
    } catch (error) {
      ws.close(1008, String(error));
    }
  });
});

function parseRequestUrl(target: string | undefined, base: string): URL | null {
  try {
    return new URL(target ?? "/", base);
  } catch {
    return null;
  }
}

function isTrusted(req: IncomingMessage, url: URL) {
  const origin = req.headers.origin ?? "";
  return ALLOWED_ORIGINS.has(origin) && url.searchParams.get("token") === TOKEN;
}

function handleRpc(ws: WebSocket) {
  clients.add(ws);
  firstClientAt ??= Date.now();
  ws.on("close", () => {
    clients.delete(ws);
    browserBridge.dropClient(ws);
    runner.dropOpenAgents(ws);
    workspaceWatch.dropClient(ws);
  });
  ws.on("message", async (data) => {
    const request = JSON.parse(data.toString()) as RpcRequest;
    let message: ServerMessage;
    const startedAt = performance.now();
    try {
      const handler = handlers[request.method] as (params: unknown, client: WebSocket) => unknown;
      if (!handler) throw new Error(`Unknown method: ${request.method}`);
      message = { id: request.id, result: await handler(request.params ?? {}, ws) };
    } catch (error) {
      message = { id: request.id, error: error instanceof Error ? error.message : String(error) };
    }
    const reply = JSON.stringify(message);
    perfNote("rpc", request.method, reply.length, performance.now() - startedAt);
    ws.send(reply);
  });
}

// 재시작한 새 프로세스는 옛 프로세스가 포트를 놓을 때까지 기다린다.
let listenAttempts = 0;
server.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE" && listenAttempts++ < 40) setTimeout(() => server.listen(PORT, "127.0.0.1"), 250);
  else throw error;
});
server.listen(PORT, "127.0.0.1", () => {
  // 데몬이 직접 부르는 gh, git, 포맷터도 찾도록 데몬 자신의 PATH 도 로그인 셸 PATH 로 넓힌다.
  // 읽기에 실패하면 몇 번 더 읽어 본다. 결과는 node, npm 경로와 PATH 출처를 한 줄로 남긴다.
  void primeLoginPath(
    (line) => console.log(line),
    () => (process.env.PATH = withLoginPath(process.env.PATH)),
  );
  console.log(`agent-nav daemon: http://127.0.0.1:${PORT}`);
  void applyMobileAccess();
  console.log(`[defaults] ${describeDefaults(defaultsReader.resolve(store.settings, true))}`);
});
