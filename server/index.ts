import { spawn } from "node:child_process";
import { allowProviderEnv } from "./claude";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { homedir, hostname } from "node:os";
import { fileURLToPath } from "node:url";
import { extname, join, resolve } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import type { MobileStatus } from "../shared/mobile";
import { type ImageRef, RuntimeInfo, RpcMethod, RpcRequest, ServerEvent, ServerMessage } from "../shared/protocol";
import { AgentRunner } from "./agents";
import { BoardStore } from "./board";
import { NoteStore } from "./notes";
import { NotionPinStore } from "./notionPins";
import { createNotion } from "./notionHost";
import { defaultsReader, describeDefaults } from "./defaults";
import { FeedbackRunner } from "./feedback";
import { IdleUpdater } from "./idleUpdate";
import { BrowserBridge } from "./browserBridge";
import { readBrowserShot, saveBrowserShot } from "./browserShot";
import { readAsideImage } from "./asideImages";
import { probeFrame } from "./frameProbe";
import { InboxFetcher, InboxStore } from "./inbox";
import { realDir } from "./paths";
import { saveImageBytes } from "./images";
import { mediaKey, mentionedMedia, resolveMediaBatch, type MediaContext } from "./media";
import { handleMedia } from "./mediaHttp";
import { handleUpload } from "./fileAttach";
import { lanHosts, makeOffer, MobileDevices, MobileServer, PairingCodes } from "./mobileAccess";
import { mobilePreview } from "./mobilePreview";
import { listFolder } from "./mobileFolders";
import { pageOfTimeline } from "../shared/mobile";
import { resolveReadable, terminalDir } from "./files";
import * as gitOps from "./git";
import { forgetForkBase } from "./forkBase";
import { beginTurn as beginLastTurn, forget as forgetLastTurn } from "./lastTurn";
import { createWorkspaceWatch } from "./workspaceWatch";
import { perfNote, perfReset, perfSnapshot } from "./perfStats";
import { createCoalescer } from "./eventCoalescer";
import { beginTurn as beginTouchTurn, forgetLedger } from "./sessionTouch";
import { bridgeLsp } from "./lsp";
import { BUNDLED_LANGUAGE_SERVERS, languageServersFor } from "./lspRegistry";
import { ReviewCheckouts, runsFolderCode } from "./folderTrust";
import { prHandlers } from "./pr";
import { linearHandlers } from "./linear";
import { simulatorHandlers } from "./simulator";
import { skillCatalogHandlers } from "./skillCatalog";
import { scmHandlers } from "./scmHandlers";
import type { Handlers } from "./rpcHandlers";
import { agentHandlers } from "./agentHandlers";
import { boardHandlers } from "./boardHandlers";
import { feedbackHandlers } from "./feedbackHandlers";
import { fileHandlers } from "./fileHandlers";
import { gitHandlers } from "./gitHandlers";
import { inboxHandlers } from "./inboxHandlers";
import { notesHandlers } from "./notesHandlers";
import { notionPinHandlers } from "./notionPinHandlers";
import { settingsHandlers, type SettingsEffect } from "./settingsHandlers";
import { terminalHandlers } from "./terminalHandlers";
import { workspaceHandlers } from "./workspaceHandlers";
import { createSessionChanges } from "./sessionChanges";
import { runAnalysis } from "./mentionAnalyze";
import { judgeMentions } from "./mentionJudge";
import { MentionPipeline } from "./mentions";
import { MorningReviewService } from "./morningReview";
import { ReleaseCheck } from "./releaseCheck";
import { mentionCollectionBlocked, morningReviewAutoBlocked } from "./mentionGate";
import { MetaService } from "./meta";
import { localCommands } from "./skills";
import { liveGroupLeaders, systemKillDeps, terminateGroups } from "./processGroups";
import { createDaemonShutdown } from "./shutdown";
import { RestartScheduler, restartWaitMs } from "../shared/restartGate";
import { importActivity, importVscodeSessions, listVscodeSessions, markSynced, reconcileBeforeTurn, type ImportDeps } from "./vscodeImport";
import { bridgePty } from "./pty";
import { TermAskRunner } from "./termask";
import { QuickRunner } from "./quick";
import { T } from "./strings";
import { SideRunner } from "./side";
import { HOME, Store, loadToken } from "./store";
import { RepoMirrors } from "./repoMirror";
import { primeLoginPath, withLoginPath } from "./loginPath";
import { WebBuildWatch } from "./webBuildWatch";

process.env.PATH = withLoginPath(process.env.PATH);

const PORT = Number(process.env.AGENT_NAV_PORT ?? 7788);
const DEV_WEB_PORT = 5173;
const ROOT = process.env.AGENT_NAV_ROOT ?? resolve(import.meta.dirname, "..");
const DIST = join(ROOT, "dist");
const SRC_ROOT = realDir(process.env.AGENT_NAV_SRC ?? (existsSync(join(ROOT, "web", "App.tsx")) ? ROOT : join(homedir(), "Repository", "agent-nav")));
const SRC_DIST = join(SRC_ROOT, "dist");
const webDist = () => (SRC_ROOT !== ROOT && existsSync(join(HOME, "feedback", "live-dist")) && existsSync(join(SRC_DIST, "index.html")) ? SRC_DIST : DIST);
const RUNTIME: RuntimeInfo = {
  kind: process.env.AGENT_NAV_RUNTIME === "repo" || process.env.AGENT_NAV_RUNTIME === "bundle" ? process.env.AGENT_NAV_RUNTIME : existsSync(join(ROOT, "web", "App.tsx")) ? "repo" : "bundle",
  root: ROOT,
  note: process.env.AGENT_NAV_RUNTIME_NOTE || null,
};
const TOKEN = loadToken();
const MEDIA_KEY = mediaKey(TOKEN);

const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const ALLOWED_ORIGINS = new Set([
  `http://127.0.0.1:${PORT}`,
  `http://localhost:${PORT}`,
  `http://127.0.0.1:${DEV_WEB_PORT}`,
  `http://localhost:${DEV_WEB_PORT}`,
]);

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
const daemonStartedAt = Math.round(Date.now() - process.uptime() * 1000);
let firstClientAt: number | null = null;
const lastAgentStatus = new Map<string, string>();
let onModelTurnDone: (() => void) | null = null;
const coalescer = createCoalescer((event) => deliver(event));
const repoMirrors = new RepoMirrors(join(homedir(), "Repository"), join(HOME, "repo-mirrors.json"), () => process.env.AGENT_NAV_INACTIVE === "1" || !!process.env.AGENT_NAV_E2E_PORT, [SRC_ROOT]);
repoMirrors.start();
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
for (const agentId of store.cutOffOnStart) runner.markCutOff(agentId);
store.onRestored = (agents) => {
  for (const agent of agents) broadcast({ type: "agent", agent });
};
const browserBridge = new BrowserBridge();
runner.setBrowserBridge(browserBridge);
const board = new BoardStore();
const notes = new NoteStore(join(HOME, "notes"));
const notionPins = new NotionPinStore();
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
const publishNotes = () => broadcast({ type: "notes", notes: notes.list() });
const notion = createNotion({ store, board, runner, broadcast, publishBoard });
runner.setNotionHooks(notion.hooks);
const pruneBoard = () => {
  if (board.prune(store.allAgentIds, store.allWorkspaceIds)) publishBoard();
  if (notion.chats.prune(store.allAgentIds)) broadcast({ type: "notionChats", chats: notion.chats.wire() });
};
const inboxStore = new InboxStore();
const slackCollectionBlocked = () => mentionCollectionBlocked(process.env, store.settings);
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
function armInboxTimer() {
  if (inboxTimer) clearInterval(inboxTimer);
  inboxTimer = null;
  const minutes = store.settings.inboxIntervalMinutes;
  if (!minutes || slackCollectionBlocked()) {
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
const morningReview = new MorningReviewService({
  store,
  board,
  emit: broadcast,
  boardChanged: publishBoard,
  autoBlocked: () => morningReviewAutoBlocked(process.env, store.settings),
  modelName: () => defaultsReader.resolve(store.settings).model.value ?? undefined,
});
morningReview.start();
const releaseCheck = new ReleaseCheck({ enabled: () => store.settings.notifyNewVersion === true, onChange: (release) => broadcast({ type: "release", release }) });
releaseCheck.start();
allowProviderEnv(store.settings.useProviderEnv === true);
const quick = new QuickRunner(store, runner, broadcast);
const side = new SideRunner(store, runner, broadcast);
const termAsk = new TermAskRunner(broadcast);
const webBuildWatch = new WebBuildWatch({
  indexFile: () => join(webDist(), "index.html"),
  onChange: () => broadcast({ type: "reload", restarting: false }),
  skip: () => feedback.swappingDist,
});
const feedback: FeedbackRunner = new FeedbackRunner({
  store,
  agents: runner,
  emit: broadcast,
  srcRoot: SRC_ROOT,
  port: PORT,
  restart: () => restartScheduler.request(),
  daemon: daemonBuild(),
  busyCount: () => busyNow(),
  distSwapped: () => webBuildWatch.adopt(),
});
void webBuildWatch.start();
onModelTurnDone = () => feedback.authRestored();
runner.setFeedbackHooks({ options: (agent) => feedback.options(agent), afterTurn: (id) => feedback.afterTurn(id), turnStarted: (id) => feedback.turnStarted(id), beforeTurn: (id, prompt) => feedback.beforeTurn(id, prompt), removeWorktree: (agent) => feedback.removeWorktree(agent) });
void feedback.settleOnStart().catch((error) => console.error("[feedback] settle failed", error));
void feedback.resumeInterrupted().catch((error) => console.error("[feedback] resume failed", error));

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
        const { files } = await sessionChanges.changesOf(store.agent(agentId), "session");
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

function daemonBuild() {
  try {
    const file = fileURLToPath(import.meta.url);
    return { startedAt: daemonStartedAt, builtAt: statSync(file).mtimeMs, bundled: file.endsWith(".mjs") };
  } catch {
    return undefined;
  }
}

const busyNow = () => runner.activeCount() + quick.activeCount() + side.activeCount() + termAsk.activeCount() + feedback.checkingCount();

if (process.env.AGENT_NAV_PACKAGED === "1" && !process.env.AGENT_NAV_HOME && process.env.AGENT_NAV_NO_AUTOUPDATE !== "1") {
  new IdleUpdater({ home: HOME, srcRoot: SRC_ROOT, enabled: () => store.settings.autoUpdateWhenIdle !== false, busy: busyNow, startedAt: daemonStartedAt, restart: () => restartScheduler.request(), log: console.log }).start();
}

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

const metaService = new MetaService(ROOT, (next) => broadcast({ type: "meta", meta: next }), () => runner.liveQueries());
process.once("exit", () => {
  store.flush();
  metaService.close();
  runner.closeAll();
  store.flush();
});
void metaService.refresh();
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
process.on("unhandledRejection", (reason) => console.error("[daemon] unhandled rejection:", reason instanceof Error ? (reason.stack ?? reason.message) : reason));

const sessionChanges = createSessionChanges({ store, feedback });

const settingsEffects: SettingsEffect[] = [
  { keys: ["mobileAccess"], apply: () => applyMobileAccess() },
  { keys: ["inboxIntervalMinutes", "showSlack"], apply: () => armInboxTimer() },
  { keys: ["showSlack"], apply: () => mentions.kick() },
  { keys: ["keepIdleSessionsWarmMinutes"], apply: () => runner.rearmIdleCloses() },
  { keys: ["maxWarmSessions"], apply: () => runner.enforceWarmCap() },
  { keys: ["feedbackAutoTidy"], apply: () => armFeedbackTidy() },
  {
    apply: (next, previous) => {
      if ((previous.notifyNewVersion === true) !== (next.notifyNewVersion === true)) releaseCheck.settingChanged();
    },
  },
  { apply: (next) => allowProviderEnv(next.useProviderEnv === true) },
  { keys: ["autoAddRequests"], apply: () => mentions.kick() },
  { keys: ["notionBypassWrites"], apply: () => runner.releaseNotionCards() },
];

const handlers: Handlers = {
  ...simulatorHandlers(),
  ...skillCatalogHandlers(() => ({ home: process.env.AGENT_NAV_SKILLS_HOME ?? homedir(), workspaces: store.workspaces.filter((w) => !w.feedback && !w.archived && !w.parentId).map((w) => ({ id: w.id, name: w.name, dir: w.dir })) })),
  ...linearHandlers({
    setAgentIssue: (agentId, issue) => broadcast({ type: "agent", agent: store.patchAgent(agentId, { linearIssue: issue }) }),
  }),
  ...notion.handlers,
  ...prHandlers({
    workspaces: () => store.workspaces,
    addWorkspace: (dir, parentId, name) => store.addWorkspace(dir, parentId, name),
    workspaceOfDir: (dir) => store.workspaces.find((w) => w.dir === realDir(dir)),
    markReview: (dir) => reviewCheckouts.add(dir),
    announce: () => broadcast({ type: "workspaces", workspaces: store.workspaces }),
  }),
  ...scmHandlers({
    agentDir: (agentId) => store.agent(agentId).cwd,
    workspaceDir: (workspaceId) => store.workspace(workspaceId).dir,
    workspaces: () => store.workspaces,
    addWorkspace: (dir, parentId, name) => store.addWorkspace(dir, parentId, name),
    announce: () => broadcast({ type: "workspaces", workspaces: store.workspaces }),
  }),
  ...workspaceHandlers({ store, runner, broadcast, reviewCheckouts, workspaceWatch, pruneBoard }),
  ...agentHandlers({ store, runner, board, broadcast }),
  ...fileHandlers({ store, broadcast, folderCodeAllowed }),
  ...gitHandlers({ store, feedback, broadcast, sessionChanges }),
  ...settingsHandlers({ store, broadcast, effects: settingsEffects }),
  ...feedbackHandlers({ feedback }),
  ...boardHandlers({ store, board, publishBoard, topWorkspaceOf }),
  ...notesHandlers({ notes, publishNotes }),
  ...inboxHandlers({ inbox, inboxStore, mentions, broadcast, topWorkspaceOf }),
  ...notionPinHandlers({ notionPins, broadcast }),
  ...terminalHandlers({ termAsk }),
  "perf.stats": ({ reset }) => {
    const snapshot = perfSnapshot();
    if (reset) perfReset();
    return { ...snapshot, watch: workspaceWatch.stats() };
  },
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
  "browser.probe": ({ url }) => probeFrame(url),
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
  "media.resolve": ({ agentId, paths }) => resolveMediaBatch(paths, mediaContext(agentId), MEDIA_KEY),
  "repos.mirrorDir": ({ repo, request }) => {
    if (request === true) repoMirrors.request(String(repo));
    return { dir: repoMirrors.dirOf(String(repo)) };
  },
  "commands.local": ({ workspaceId }) => localCommands(store.workspace(workspaceId).dir),
  "meta.get": () => metaService.meta,
  "codex.meta": ({ refresh }) => runner.codexMeta(refresh === true),
  "antigravity.meta": ({ refresh }) => runner.antigravityMeta(refresh === true),
  "meta.refresh": () => metaService.refresh(),
  "mcp.reconnect": ({ name }) => metaService.reconnect(name),
  "mcp.toggle": ({ name, enabled }) => metaService.toggle(name, enabled),
  "runtime.info": () => RUNTIME,
  "logs.tail": ({ lines }) => logRing.slice(-Math.max(1, Math.min(lines, LOG_LINES))),
  "quick.ask": ({ id, workspaceId, model, question, context }) => {
    quick.ask(id, workspaceId, model, question, context);
    return null;
  },
  "quick.cancel": ({ id }) => {
    quick.cancel(id);
    return null;
  },
  "quick.adopt": ({ id }) => quick.adopt(id),
  "side.ask": ({ id, agentId, model, question }) => {
    runner.assertClaude(agentId, "Side question (/btw)");
    side.ask(id, agentId, model, question);
    return null;
  },
  "side.cancel": ({ id }) => {
    side.cancel(id);
    return null;
  },
  "side.adopt": ({ id }) => side.adopt(id),
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
  "daemon.restartIfIdle": () => {
    const busy = busyNow();
    if (busy > 0) return { restarted: false, busy };
    const outcome = restartScheduler.request();
    return outcome.deferred ? { restarted: false, busy: 0, deferred: true, inMs: outcome.inMs } : { restarted: true, busy: 0 };
  },
};

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

const mobileHandlers: Record<string, (params: never, client: WebSocket) => unknown> = {
  "mobile.ping": () => ({ now: Date.now() }),
  "workspaces.list": () => store.workspaces.filter((w) => !w.feedback),
  "agents.list": () => store.agents.filter((a) => !a.feedbackId),
  "agents.timelinePage": ({ agentId, limit, beforeId }: { agentId: string; limit: number; beforeId?: string }) => {
    const agent = store.agent(agentId);
    if (agent.feedbackId) throw new Error(`Unknown agent: ${agentId}`);
    return pageOfTimeline(store.timeline(agent.id), limit, beforeId);
  },
  "mobile.preview": ({ agentId, itemId, target }: { agentId: string; itemId: string; target: string }) => {
    const agent = phoneAgent(agentId);
    const item = store.timeline(agentId).find((entry) => entry.id === itemId);
    return mobilePreview(agent.workspaceId ? agent.worktree?.root ?? phoneWorkspace(agent.workspaceId).dir : null, item, target);
  },
  "mobile.browse": ({ dir, display }: { dir: string; display: string }) =>
    listFolder({ dir, display }, new Map(store.workspaces.filter((w) => !w.feedback && !w.parentId).map((w) => [w.dir, w.id]))),
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

function topWorkspaceOf(id: unknown): string | null {
  if (id === undefined || id === null) return null;
  if (typeof id !== "string") throw new Error(T.errCardField("workspaceId"));
  const workspace = store.workspace(id);
  return workspace.parentId ?? workspace.id;
}

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
    inWorkspace: async (real) => {
      for (const dir of [...store.agentRoots(agent), ...(workspaceDir ? [workspaceDir] : [])]) if (await readable(dir, real)) return true;
      return false;
    },
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
  const url = parseRequestUrl(req.url, `http://${req.headers.host}`);
  if (!url) {
    res.writeHead(400).end("bad request");
    return;
  }
  if (url.pathname === "/attachments") {
    void handleUpload(req, res, url, { token: TOKEN, origins: ALLOWED_ORIGINS }).catch((error) => {
      console.error("[attachments] upload failed", error);
      if (!res.headersSent) res.writeHead(500).end("upload failed");
    });
    return;
  }
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

let listenAttempts = 0;
server.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE" && listenAttempts++ < 40) setTimeout(() => server.listen(PORT, "127.0.0.1"), 250);
  else throw error;
});
server.listen(PORT, "127.0.0.1", () => {
  void primeLoginPath(
    (line) => console.log(line),
    () => (process.env.PATH = withLoginPath(process.env.PATH)),
  );
  console.log(`agent-nav daemon: http://127.0.0.1:${PORT}`);
  void applyMobileAccess();
  console.log(`[defaults] ${describeDefaults(defaultsReader.resolve(store.settings, true))}`);
});
