import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { query, type McpServerConfig, type Options, type PermissionResult, type Query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type {
  Agent,
  ContextUsage,
  EffortLevel,
  PermissionDecision,
  PermissionMode,
  PermissionOutcome,
  QueuedMessage,
  ServerEvent,
  TimelineItem,
  UserAttachment,
  DiffFeedback,
  ImageRef,
  FileRef,
  Worktree,
  RestoreSkip,
} from "../shared/protocol";
import { HARNESS_VALUES, PERMISSION_MODE_VALUES, claudeEffort, harnessOf, isEffortLevel, type ClaudeEffortLevel, type Harness } from "../shared/protocol";
import { carryAfterCut, carryTranscript, checkpointLocked, HARNESS_NAMES, lastSwitchDividerId, remapSeen, switchBlock, switchedState } from "../shared/harnessSwitch";
import { CODEX_FALLBACK_MODE, codexSupportsMode } from "../shared/codexPermission";
import { CodexRunner, type CodexHost } from "./codex/runner";
import { AntigravityRunner } from "./antigravity/runner";
import { CursorRunner } from "./cursor/runner";
import { providerEnv, type CustomProviders } from "./customProviders";
import { checkpointMode, checkpointSession, commitRedo, dropRedo, keptEntryBefore, loadRedo, probeCheckpointModes, readRaw, resolveMessageId, saveRedo, sessionChain, splitTimeline, stageRedo, withRewindQuery } from "./checkpoints";
import { applyRestore, hashesOf, redoFiles } from "./restoreGuard";
import type { BrowserBridge } from "./browserBridge";
import { BROWSER_SERVER_NAME, browserMcpServer, browserToolNeedsApproval, isBrowserToolName } from "./browserTools";
import { claudeBin, claudeEnv, claudeErrorText, isAuthError } from "./claude";
import { selectWarmEvictions } from "./warmCap";
import { groupedSpawner } from "./processGroups";
import { defaultsReader } from "./defaults";
import * as gitOps from "./git";
import { captureForkBase } from "./forkBase";
import { sessionAllowRules } from "./permissionRules";
import { isInteractiveTool, planResult, PLAN_TOOL, QUESTION_TOOL, questionResult } from "./interactiveTools";
import { imageBlocks } from "./images";
import { resolveFiles } from "./fileAttach";
import { endTurn as endTouchTurn, noteBash, planRestore, recordAfterEdit, recordBeforeEdit, syncAfterRestore, touchedLastTurn } from "./sessionTouch";
import { snapshotBeforeEdit } from "./snapshots";
import { isDirectory, watchDirectory } from "./cwdWatch";
import { consumedUuids, isControlEcho, ownsTurn, PushQueue, splitSteering, turnEnd, userMessage } from "./turnInput";
import { forkedFrom } from "./forkAgent";
import { createFeedback, markSubmitted, pendingFeedback, queuedExtras, restageFeedback, shownOf, trimFeedback, type NewFeedback } from "./diffFeedback";
import { feedbackChip, formatFeedbackPrompt } from "../shared/diffFeedback";
import { saveBrowserShot } from "./browserShot";
import { HOME, type Store } from "./store";
import { T } from "./strings";
import { contextAfterCompact, contextFromApi, estimateContext, sameContext, type FrameUsage } from "../shared/contextUsage";
import { showsTaskNotice } from "./taskNotice";
import { finishTask, isAgentTask, isAgentTool, newTask, progressTask, reconcileTasks, resultTask, settleStale, slimInput, slimOutput, startTask, stopTask, updateTask } from "./subagents";
import { validHandoffId } from "./handoff";
import { shortTitle } from "../shared/sessionTitle";
import { sessionContextBlock } from "../shared/sessionRef";
import { chatGuidance, sessionEnv } from "./sessionEnv";
import { BLOCKED_NOTION_WRITE_MESSAGE, classifyTool, isBlockedNotionWrite, isNotionProposeTool, notionDisallowedTools } from "../shared/notionMcp";
import type { NotionWritePreview } from "../shared/notionWrite";
import { notionOverridden, notionServerConfig } from "./notionSession";
import { notionWriteGuard } from "./notionGuard";
import { guardBashCommand } from "./focusGuard";
import { saveAsideShots } from "./asideImages";
import { isAsideTool } from "../shared/asideTool";
import { notionWriteGate, type NotionWriteGate } from "../shared/notionApproval";
import { notionToolServer, type NotionToolHost } from "./notionTools";
import { NOTION_SERVER, OWN_SERVER } from "../shared/notionMcp";
import { isPreviewTool, PREVIEW_SERVER, PREVIEW_TOOL } from "../shared/previewCard";
import { previewToolServer } from "./previewTool";
import type { McpLaunch } from "./mateMcp";

const MAX_TOOL_OUTPUT = 20_000;
const SESSION_PROMPT_APPEND = [
  "When you write a Slack message or draft for the user to send, put the message body alone in a fenced code block with the language `slack`, written in Slack mrkdwn: *bold*, _italic_, ~strike~, `code`, <https://example.com|link text>, <@U123> mentions, > quotes, and lines starting with • or - for bullets.",
  "Lodestar shows that block as a Slack preview with a button that copies it with Slack formatting. Keep explanations outside the block.",
  `When you change or propose a screen, show it in the chat with ${PREVIEW_TOOL} (As-is and To-be frames) instead of pointing to an image path or describing it in words.`,
  "When the user should choose between screen options, call AskUserQuestion and put each option's self-contained HTML in its preview field; Lodestar renders it inline at phone width.",
  "When a structure, flow or exchange is clearer as a picture, draw it in a fenced code block with the language `mermaid`, using `flowchart` (with `subgraph` for grouped parts, `-.-x` for a broken link) or `sequenceDiagram`; Lodestar draws it as a diagram in the chat on desktop and phone. Keep node labels short and use `<br>` for a second line.",
  "When you explain how code flows or lay out a change across several places in the code, also put the stops in a fenced code block with the language `walkthrough`, in the order to read them: one step per line as `path:line | what happens here` (a range is `path:start-end`, the path relative to the working directory), and for a planned change follow the step with the current lines prefixed `- ` and the new lines prefixed `+ `. Lodestar shows the block as cards with the real surrounding code that the user steps through on desktop and phone, and can move the editor along with each step. Keep each note to one sentence.",
].join(" ");
const BACKGROUND_NOTICE_MAX = 120;
const CLAUDE_SCRATCH_ROOTS = typeof process.getuid === "function" ? [`/tmp/claude-${process.getuid()}`, `/private/tmp/claude-${process.getuid()}`] : [];
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
function writtenDirs(items: TimelineItem[]): string[] {
  const dirs = new Set<string>();
  for (const item of items) {
    if (item.kind !== "tool" || !WRITE_TOOLS.has(item.name)) continue;
    const path = (item.input as { file_path?: unknown; notebook_path?: unknown } | null)?.file_path ?? (item.input as { notebook_path?: unknown } | null)?.notebook_path;
    if (typeof path === "string" && path.startsWith("/")) dirs.add(dirname(path));
  }
  return [...dirs];
}
const SIDE_ADOPTED_NOTE = "<system-reminder>이 대화는 곁다리 질문 창에서 정식 세션으로 옮겨졌다. 앞부분의 '읽기 도구만 쓰고 파일을 고치거나 명령을 실행하지 않는다' 제한은 이제 없다. 앞에서 '이 창에서는 실행할 수 없다' 고 답한 것은 그 제한 때문이었고, 지금은 메인 세션과 같은 도구(Bash 포함)와 권한으로 작업한다.</system-reminder>";

const CHATS_DIR = join(HOME, "chats");
const chatDir = (agentId: string) => join(CHATS_DIR, agentId);
function removeEmptyDir(dir: string) {
  if (!dir.startsWith(CHATS_DIR)) return;
  try {
    rmdirSync(dir);
  } catch {
  }
}
const TRACE = process.env.AGENT_NAV_TRACE === "1";
const THINKING_DISPLAY = process.env.AGENT_NAV_THINKING_DISPLAY === "summarized" || process.env.AGENT_NAV_THINKING_DISPLAY === "omitted" ? process.env.AGENT_NAV_THINKING_DISPLAY : undefined;
const AUTH_API_ERRORS = new Set(["authentication_failed", "oauth_org_not_allowed"]);

type PendingPermission = {
  toolName: string;
  input: Record<string, unknown>;
  resolve: (decision: PermissionDecision) => void;
  settle: (result: PermissionResult, outcome?: PermissionOutcome, auto?: boolean) => void;
};

type Run = {
  query: Query;
  input: PushQueue;
  draftId: string | null;
  active: boolean;
  interrupted: boolean;
  turnMessageId: string | null;
  steers: Set<string>;
  model: string | null;
  effort: ClaudeEffortLevel | null;
  permissionMode: PermissionMode;
  permissionSetAt: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  idleSince: number;
  lastUsed: number;
  closed: boolean;
  apiError: boolean;
  approvalWaitMs: number;
  stopWatch: (() => void) | null;
  ctxSeq: number;
  stderrTail: () => string;
  cwd: string;
  folders: string;
  providerKey: string | null;
};

const MODE_SETTLE_MS = 2000;
const isPermissionMode = (value: string): value is PermissionMode => (PERMISSION_MODE_VALUES as readonly string[]).includes(value);

const IDLE_CLOSE_ENV_MS = Number(process.env.AGENT_NAV_IDLE_CLOSE_MS) || 0;
const IDLE_RECHECK_MS = 60_000;
const STEER_PRIORITY = process.env.AGENT_NAV_STEER_PRIORITY === "now" ? "now" : "next";
const INTERRUPT_GRACE_MS = 10_000;
const STEER_INTERRUPT_GRACE_MS = 1_500;

export type FeedbackHooks = {
  options: (agent: Agent) => Partial<Options> | null;
  afterTurn: (agentId: string) => void;
  turnStarted: (agentId: string) => void;
  beforeTurn: (agentId: string, prompt: string) => Promise<string>;
  removeWorktree: (agent: Agent) => Promise<void>;
};

export type AssistantAsk = (toolName: string, input: Record<string, unknown>, signal: AbortSignal, toolUseId?: string) => Promise<PermissionResult>;

export type AssistantHooks = {
  options: (agent: Agent, ask: AssistantAsk) => Partial<Options> | null;
  silentTurn: (agentId: string) => boolean;
  foreignSetup: (agent: Agent) => McpLaunch | null;
};

export type BoardHooks = {
  link: (agentId: string, cardId: string) => void;
  turnStarted: (agentId: string) => void;
  turnEnded: (agentId: string) => void;
  removed: (agentId: string) => void;
};


export type NotionHooks = {
  host: (agentId: string, ask: NotionToolHost["ask"]) => NotionToolHost;
  attach: (agentId: string, page: { url: string; title: string }) => void;
};

export type CreateParams = {
  workspaceId: string | null;
  prompt: string;
  permissionMode: PermissionMode;
  model: string | null;
  effort: EffortLevel | null;
  worktree: { branch: string; base: string } | null;
  boardCardId?: string;
  handoffFrom?: string;
  handoffId?: string;
  images?: ImageRef[];
  files?: FileRef[];
  shown?: string;
  notionContext?: { text: string; label: string; url: string; title: string };
  harness?: Harness;
  providerId?: string | null;
  extraWorkspaceIds?: string[];
};

export class AgentRunner {
  private runs = new Map<string, Run>();
  private pending = new Map<string, PendingPermission>();
  private feedbackHooks: FeedbackHooks | null = null;
  private assistantHooks: AssistantHooks | null = null;
  private boardHooks: BoardHooks | null = null;
  private preparing = new Set<string>();
  private cancellingSteers = new Set<string>();
  private browserBridge: BrowserBridge | null = null;
  private notionHooks: NotionHooks | null = null;
  private restoring = new Set<string>();
  private restoreCancelled = new Set<string>();
  private turnDivider = new Map<string, string | null>();

  private codex: CodexRunner;
  private antigravity: AntigravityRunner;
  private providers: CustomProviders | null = null;
  private cursor: CursorRunner;

  constructor(
    private store: Store,
    private emit: (event: ServerEvent) => void,
  ) {
    const host: CodexHost = {
      store,
      emit,
      upsert: (agentId, item) => this.upsert(agentId, item),
      setStatus: (agentId, status) => this.setStatus(agentId, status),
      turnStarted: (agentId) => this.boardHooks?.turnStarted(agentId),
      turnEnded: (agentId) => {
        this.clearCarry(agentId);
        this.boardHooks?.turnEnded(agentId);
      },
      turnChanges: (agentId) => this.turnChanges(agentId),
      finishTouch: async (agentId) => {
        await endTouchTurn(this.store.agent(agentId), this.store);
        this.emit({ type: "changes", agentId, changes: this.store.changes(agentId) });
      },
      noteBash: (agentId) => noteBash(agentId),
      recordBeforeEdit: (agentId, toolName, input) => recordBeforeEdit(this.store.agent(agentId), this.store, toolName, input),
      recordAfterEdit: (agentId, toolName, input) => recordAfterEdit(this.store.agent(agentId), this.store, toolName, input),
      sendQueued: (agentId, next) => {
        this.takeQueued(agentId, next.id);
        void this.send(agentId, next.text, shownOf(next)).catch((error) => console.error("[agent] queued send failed", error));
      },
      idleLimitMs: () => this.idleLimitMs(),
      mateMcp: (agent) => (agent.assistant ? (this.assistantHooks?.foreignSetup(agent) ?? null) : null),
    };
    this.codex = new CodexRunner(host);
    this.antigravity = new AntigravityRunner(host);
    this.cursor = new CursorRunner(host);
  }

  private otherRunners() {
    return [this.codex, this.antigravity, this.cursor];
  }

  private runnerOf(agentId: string): CodexRunner | AntigravityRunner | CursorRunner | null {
    const harness = harnessOf(this.store.agent(agentId));
    return harness === "codex" ? this.codex : harness === "antigravity" ? this.antigravity : harness === "cursor" ? this.cursor : null;
  }

  private notClaude(agentId: string) {
    return this.runnerOf(agentId) !== null;
  }

  setProviders(providers: CustomProviders) {
    this.providers = providers;
  }

  private providerOf(providerId: string | null | undefined) {
    return this.providers?.get(providerId) ?? null;
  }

  antigravityMeta(refresh = false) {
    return this.antigravity.meta(refresh);
  }

  cursorMeta(refresh = false) {
    return this.cursor.meta(refresh);
  }

  codexMeta(refresh = false) {
    return this.codex.meta(refresh);
  }

  assertClaude(agentId: string, what: string) {
    const harness = harnessOf(this.store.agent(agentId));
    if (harness !== "claude") throw new Error(T.harnessUnsupported(HARNESS_NAMES[harness], what));
  }

  async create(params: CreateParams) {
    const id = randomUUID();
    const attached = await resolveFiles(params.files);
    if (params.harness && params.harness !== "claude" && params.notionContext) throw new Error(T.harnessUnsupported(HARNESS_NAMES[params.harness], "Notion page chat"));
    const workspace = params.workspaceId === null ? null : this.store.workspace(params.workspaceId);
    if (!workspace && params.worktree) throw new Error(T.errChatNoWorktree);
    let cwd = workspace ? workspace.dir : chatDir(id);
    if (!workspace) mkdirSync(cwd, { recursive: true });
    let worktree: Worktree | null = null;
    let workspaceId = workspace?.id ?? null;
    if (workspace && params.worktree) {
      const root = await gitOps.repoRoot(workspace.dir);
      if (!root) throw new Error(T.errNotGitRepoForWorktree);
      const path = await gitOps.addWorktree(root, params.worktree.branch, params.worktree.base);
      cwd = join(path, relative(root, workspace.dir));
      worktree = { root: path, branch: params.worktree.branch, base: params.worktree.base };
      workspaceId = this.store.addWorkspace(cwd, workspace.id, `${workspace.name} (${params.worktree.branch})`).id;
      this.emit({ type: "workspaces", workspaces: this.store.workspaces });
    }
    const extraWorkspaceIds = this.validExtraFolders(params.extraWorkspaceIds ?? [], workspaceId, cwd);
    const now = new Date().toISOString();
    const handoff = params.handoffFrom ? this.store.agent(params.handoffFrom) : null;
    if (params.handoffId !== undefined && !validHandoffId(params.handoffId)) throw new Error(T.errHandoffUnknown);
    const agent: Agent = {
      id,
      workspaceId,
      cwd,
      ...(extraWorkspaceIds.length ? { extraWorkspaceIds } : {}),
      worktree,
      forkedFrom: null,
      resumeFrom: null,
      startCommit: worktree || !workspace ? null : await gitOps.headCommit(cwd),
      feedbackId: null,
      title: handoff ? (params.shown?.trim() ? titleFrom(params.shown) : T.handoffTitle(handoff.title).slice(0, TITLE_MAX)) : titleFrom(params.prompt.trim() || (params.images?.length ? T.imageTitle : (attached.files[0]?.name ?? ""))),
      sessionId: null,
      status: "idle",
      permissionMode: params.harness === "codex" && !codexSupportsMode(params.permissionMode) ? CODEX_FALLBACK_MODE : params.permissionMode,
      model: params.model,
      effort: params.effort,
      activeModel: null,
      activeEffort: null,
      backgroundTasks: 0,
      createdAt: now,
      updatedAt: now,
      ...(handoff ? { handoffFrom: handoff.id } : {}),
      ...(params.harness === "codex" ? { harness: "codex" as const, codexThreadId: null } : {}),
      ...(params.harness === "antigravity" ? { harness: "antigravity" as const, antigravitySessionId: null } : {}),
      ...(params.harness === "cursor" ? { harness: "cursor" as const, cursorSessionId: null } : {}),
      ...((params.harness ?? "claude") === "claude" && this.providerOf(params.providerId) ? { providerId: params.providerId } : {}),
    };
    this.store.addAgent(agent);
    if (agent.startCommit) await captureForkBase(agent, this.store, agent.id).catch(() => false);
    this.emit({ type: "agent", agent });
    if (handoff) this.upsert(handoff.id, { id: randomUUID(), kind: "notice", text: T.handedOffTo(agent.title), openAgentId: agent.id });
    if (params.boardCardId) this.boardHooks?.link(agent.id, params.boardCardId);
    if (params.notionContext) this.notionHooks?.attach(agent.id, { url: params.notionContext.url, title: params.notionContext.title });
    const imageChips: UserAttachment[] = [...(params.images ?? []).map((image) => ({ kind: "image" as const, ...image })), ...attached.chips];
    const first: { display?: string; attachments?: UserAttachment[] } = params.notionContext
      ? { display: params.prompt, attachments: [{ kind: "notion" as const, label: params.notionContext.label, url: params.notionContext.url }, ...imageChips] }
      : handoff
      ? { display: params.shown ?? "", attachments: [...(params.handoffId ? [{ kind: "handoff" as const, label: T.handoffLabel(handoff.title), id: params.handoffId }] : []), ...imageChips] }
      : imageChips.length
        ? { display: params.prompt, attachments: imageChips }
        : {};
    const sent = attached.model(params.notionContext ? `${params.notionContext.text}\n\n${params.prompt}` : params.prompt);
    void this.send(agent.id, sent, first).catch((error) => console.error("[agent] first turn failed", error));
    return agent;
  }

  private foldersKey(agent: Pick<Agent, "cwd" | "extraWorkspaceIds">) {
    return this.store.agentRoots(agent).join("\n");
  }

  private validExtraFolders(ids: readonly unknown[], primary: string | null, cwd: string): string[] {
    if (!Array.isArray(ids)) throw new Error(T.errFolderListInvalid);
    const out: string[] = [];
    for (const id of ids) {
      if (typeof id !== "string") throw new Error(T.errFolderListInvalid);
      const workspace = this.store.workspace(id);
      if (workspace.feedback || workspace.archived) throw new Error(T.errFolderNotAddable(workspace.name));
      if (id === primary || workspace.dir === cwd || out.includes(id)) continue;
      out.push(id);
    }
    return out;
  }

  addFolder(agentId: string, workspaceId: string) {
    const agent = this.store.agent(agentId);
    if (agent.feedbackId) throw new Error(T.errFolderFeedbackSession);
    const before = agent.extraWorkspaceIds ?? [];
    const extra = this.validExtraFolders([...before, workspaceId], agent.workspaceId, agent.cwd);
    if (extra.length === before.length) return agent;
    const next = this.store.patchAgent(agentId, { extraWorkspaceIds: extra });
    this.notice(agentId, T.addedFolder(this.store.workspace(workspaceId).name));
    this.emit({ type: "agent", agent: next });
    return next;
  }

  removeFolder(agentId: string, workspaceId: string) {
    const agent = this.store.agent(agentId);
    if (!agent.extraWorkspaceIds?.includes(workspaceId)) return agent;
    const extra = agent.extraWorkspaceIds.filter((id) => id !== workspaceId);
    const next = this.store.patchAgent(agentId, { extraWorkspaceIds: extra.length ? extra : undefined });
    if (!next.extraWorkspaceIds) delete next.extraWorkspaceIds;
    this.notice(agentId, T.removedFolder(this.store.workspaces.find((w) => w.id === workspaceId)?.name ?? T.unknownFolder));
    this.emit({ type: "agent", agent: next });
    return next;
  }

  async moveToFolder(agentId: string, workspaceId: string) {
    const agent = this.store.agent(agentId);
    if (agent.workspaceId !== null) throw new Error(T.errMoveHasFolder);
    if (agent.feedbackId) throw new Error(T.errMoveUnsupported);
    const workspace = this.store.workspace(workspaceId);
    if (workspace.feedback || workspace.archived) throw new Error(T.errFolderNotAddable(workspace.name));
    const from = agent.cwd;
    const harness = harnessOf(agent);
    const divider: TimelineItem = { id: randomUUID(), kind: "notice", text: T.movedToFolder(workspace.name), divider: true, switched: harness, switchedFrom: harness, movedFrom: from };
    this.upsert(agentId, divider);
    const startCommit = await gitOps.headCommit(workspace.dir);
    const current = this.store.agent(agentId);
    const extra = (current.extraWorkspaceIds ?? []).filter((id) => id !== workspace.id);
    const moved = this.store.updateAgent(agentId, {
      workspaceId: workspace.id,
      cwd: workspace.dir,
      extraWorkspaceIds: extra.length ? extra : undefined,
      startCommit,
      forkBased: undefined,
      sessionId: null,
      resumeFrom: null,
      resumeAt: null,
      codexThreadId: harness === "codex" ? null : current.codexThreadId,
      antigravitySessionId: harness === "antigravity" ? null : current.antigravitySessionId,
      cursorSessionId: harness === "cursor" ? null : current.cursorSessionId,
      activeModel: null,
      activeEffort: null,
      contextUsage: null,
      ...switchedState(current, divider.id),
    });
    if (!moved.extraWorkspaceIds) delete moved.extraWorkspaceIds;
    if (startCommit) await captureForkBase(moved, this.store, moved.id).catch(() => false);
    void this.clearRedo(agentId).catch((error) => console.error("[agent] redo record not cleared", error));
    this.emit({ type: "agent", agent: this.store.agent(agentId) });
    this.emit({ type: "workspaces", workspaces: this.store.workspaces });
    return this.store.agent(agentId);
  }

  setFeedbackHooks(hooks: FeedbackHooks) {
    this.feedbackHooks = hooks;
  }

  setAssistantHooks(hooks: AssistantHooks) {
    this.assistantHooks = hooks;
  }

  setNotionHooks(hooks: NotionHooks) {
    this.notionHooks = hooks;
  }

  setBrowserBridge(bridge: BrowserBridge) {
    this.browserBridge = bridge;
  }

  setBoardHooks(hooks: BoardHooks) {
    this.boardHooks = hooks;
  }

  activeCount() {
    return [...this.runs.entries()].filter(([agentId, run]) => run.active || this.backgroundTaskCount(agentId) > 0).length + this.pending.size + this.codex.activeCount() + this.antigravity.activeCount() + this.cursor.activeCount();
  }

  private backgroundTaskCount(agentId: string) {
    return this.store.agents.find((a) => a.id === agentId)?.backgroundTasks ?? 0;
  }

  liveQueries(): Query[] {
    return [...this.runs.values()].map((run) => run.query);
  }

  closeIdle(agentId: string) {
    this.closeRun(agentId);
  }

  closeAll() {
    for (const agentId of [...this.runs.keys()]) this.closeRun(agentId);
    this.codex.closeAll();
    this.antigravity.closeAll();
    this.cursor.closeAll();
  }

  notice(agentId: string, text: string, detail?: string, fold?: { label: string; text: string }, id: string = randomUUID()) {
    this.upsert(agentId, { id, kind: "notice", text, ...(detail ? { detail } : {}), ...(fold ? { fold } : {}) });
    return id;
  }

  adopt(agent: Agent, items: TimelineItem[]) {
    this.store.addAgent(agent, items);
    this.emit({ type: "agent", agent });
    for (const item of items) this.emit({ type: "timelineUpsert", agentId: agent.id, item });
  }

  async fork(agentId: string) {
    this.assertClaude(agentId, "Fork");
    const source = this.store.agent(agentId);
    if (!source.sessionId) throw new Error(T.errNoSessionToFork);
    const now = new Date().toISOString();
    const forkedId = randomUUID();
    const forked: Agent = {
      ...forkedFrom(source),
      id: forkedId,
      seenThrough: remapSeen(source.seenThrough, (id) => `${forkedId.slice(0, 8)}:${id}`),
      title: `Forked: ${source.title}`,
      sessionId: null,
      resumeFrom: source.sessionId,
      forkedFrom: source.id,
      feedbackId: null,
      status: "idle",
      backgroundTasks: 0,
      createdAt: now,
      updatedAt: now,
      unread: false,
      pinned: false,
      done: false,
    };
    const agent = await this.withForkBase(source, forked);
    this.adopt(agent, copyItems(this.store.timeline(agentId), agent.id));
    return agent;
  }

  private async withForkBase(source: Agent, agent: Agent): Promise<Agent> {
    if (source.workspaceId === null) return agent;
    const startCommit = source.worktree ? source.startCommit : await gitOps.headCommit(source.cwd);
    const based = await captureForkBase(agent, this.store, source.id);
    return { ...agent, startCommit, forkBased: based || undefined };
  }

  async forkBefore(agentId: string, beforeItemId: string) {
    this.assertClaude(agentId, "Fork");
    const source = this.store.agent(agentId);
    if (!source.sessionId) throw new Error(T.errNoSessionToFork);
    const items = this.store.timeline(agentId);
    const split = splitTimeline(items, beforeItemId);
    const target = items.find((i) => i.id === beforeItemId);
    if (!split || target?.kind !== "user" || target.source === "system") throw new Error(T.errNoCheckpoint);
    if (target.preCompact) throw new Error(T.errPreCompact);
    if (checkpointLocked(items, harnessOf(source)).has(beforeItemId)) throw new Error(T.errCheckpointBeforeSwitch);
    if (!split.kept.some((i) => i.kind === "user" && i.source !== "system")) throw new Error(T.errNothingToFork);
    const messageId = await resolveMessageId(source, items, beforeItemId);
    if (!messageId) throw new Error(T.errCheckpointGone);
    const kept = keptEntryBefore(await sessionChain(source), messageId);
    if (!kept) throw new Error(T.errCheckpointGone);
    const title = T.forkedTitle(source.title);
    const now = new Date().toISOString();
    const nextId = randomUUID();
    const mapId = (id: string) => `${nextId.slice(0, 8)}:${id}`;
    const next: Agent = {
      ...forkedFrom(source),
      id: nextId,
      seenThrough: remapSeen(source.seenThrough, mapId),
      title,
      sessionId: null,
      resumeFrom: source.sessionId,
      resumeAt: kept,
      forkedFrom: source.id,
      feedbackId: null,
      status: "idle",
      backgroundTasks: 0,
      createdAt: now,
      updatedAt: now,
      unread: false,
      pinned: false,
      done: false,
    };
    const copied = copyItems(split.kept, nextId);
    const agent = await this.withForkBase(source, { ...next, ...carryAfterCut(copied, next.seenThrough) });
    this.adopt(agent, copied);
    return agent;
  }

  async send(agentId: string, prompt: string, options: { steer?: boolean; display?: string; system?: boolean; attachments?: UserAttachment[]; feedback?: DiffFeedback[] } = {}): Promise<{ queued: boolean }> {
    this.store.agent(agentId);
    if (this.restoring.has(agentId)) throw new Error(T.errAgentRunning);
    const other = this.runnerOf(agentId);
    if (other) {
      if (other.isActive(agentId) && options.steer && await other.steer(agentId, prompt, options)) {
        return { queued: false };
      }
      if (other.isActive(agentId)) {
        this.enqueue(agentId, prompt, options);
        return { queued: true };
      }
      const carried = this.withCarry(agentId, prompt, options);
      await other.startTurn(agentId, carried.prompt, carried.options);
      return { queued: false };
    }
    const run = this.runs.get(agentId);
    if (this.preparing.has(agentId)) {
      this.enqueue(agentId, prompt, options);
      return { queued: true };
    }
    if (run?.active) {
      if (options.steer) {
        this.steer(agentId, run, prompt, options);
        return { queued: false };
      }
      this.enqueue(agentId, prompt, options);
      return { queued: true };
    }
    const carried = this.withCarry(agentId, prompt, options);
    await this.startTurn(agentId, carried.prompt, carried.options);
    return { queued: false };
  }

  private withCarry<O extends { display?: string }>(agentId: string, prompt: string, options: O): { prompt: string; options: O } {
    const agent = this.store.agent(agentId);
    this.turnDivider.set(agentId, lastSwitchDividerId(this.store.timeline(agentId)));
    if (!agent.carryPending) return { prompt, options };
    const block = carryTranscript(this.store.timeline(agentId), agent, this.providerOf(agent.providerId)?.name);
    if (!block) {
      this.clearCarry(agentId);
      return { prompt, options };
    }
    return { prompt: `${block}\n\n${prompt}`, options: { ...options, display: options.display ?? prompt } };
  }

  private clearCarry(agentId: string) {
    const agent = this.store.agents.find((a) => a.id === agentId);
    if (!agent?.carryPending || agent.status === "error") return;
    const divider = this.turnDivider.get(agentId);
    if (divider !== undefined && divider !== lastSwitchDividerId(this.store.timeline(agentId))) return;
    this.emit({ type: "agent", agent: this.store.patchAgent(agentId, { carryPending: false }) });
  }

  async switchHarness(agentId: string, target: Harness, model: string | null, effort: EffortLevel | null, providerId: string | null = null) {
    const agent = this.store.agent(agentId);
    if (!HARNESS_VALUES.includes(target)) throw new Error(`Unknown tool: ${String(target)}`);
    const from = harnessOf(agent);
    const provider = target === "claude" ? this.providerOf(providerId) : null;
    if (providerId && !provider) throw new Error(T.providerGone);
    const fromProvider = from === "claude" ? (agent.providerId ?? null) : null;
    const nextModel = typeof model === "string" && model.trim() ? model.trim() : null;
    const nextEffort = provider ? null : target === "claude" ? claudeEffort(effort) : isEffortLevel(effort) ? effort : null;
    if (from === target && fromProvider === (provider?.id ?? null)) {
      this.emit({ type: "agent", agent: this.store.updateAgent(agentId, { model: nextModel, effort: nextEffort }) });
      return;
    }
    const items = this.store.timeline(agentId);
    const live = this.runs.get(agentId)?.active || this.preparing.has(agentId) || this.restoring.has(agentId) || this.otherRunners().some((r) => r.isActive(agentId));
    const pending = [...this.pending.keys()].some((key) => key.startsWith(`${agentId}:`)) || this.otherRunners().some((r) => r.pendingApprovalIds(agentId).length > 0);
    const blocked = switchBlock(agent, items) ?? (pending ? "waiting" : live ? "running" : null);
    if (blocked) throw new Error(T.switchBlocked[blocked]);
    if (from === "claude") this.closeRun(agentId);
    else await this.runnerOf(agentId)?.remove(agentId);
    const shownModel = provider && nextModel ? (provider.models.find((m) => m.id === nextModel)?.name ?? nextModel) : nextModel;
    const divider: TimelineItem = { id: randomUUID(), kind: "notice", text: T.switchedTo(provider?.name ?? HARNESS_NAMES[target], shownModel), divider: true, switched: target, switchedFrom: from, ...(provider ? { switchedName: provider.name } : {}) };
    const claudeIdentityChanged = from === "claude" && target === "claude";
    this.upsert(agentId, divider);
    const current = this.store.agent(agentId);
    this.emit({
      type: "agent",
      agent: this.store.updateAgent(agentId, {
        harness: target,
        model: nextModel,
        effort: nextEffort,
        permissionMode: target === "codex" && !codexSupportsMode(current.permissionMode) ? CODEX_FALLBACK_MODE : current.permissionMode,
        activeModel: null,
        activeEffort: null,
        contextUsage: null,
        ...switchedState(current, divider.id),
        ...(target === "codex" ? { codexThreadId: null } : {}),
        ...(target === "antigravity" ? { antigravitySessionId: null } : {}),
        ...(target === "cursor" ? { cursorSessionId: null } : {}),
        ...(target === "claude" ? { providerId: provider?.id ?? null } : {}),
        ...(target === "claude" && (claudeIdentityChanged || provider || fromProvider) ? { sessionId: null, resumeFrom: null, resumeAt: null } : {}),
      }),
    });
  }

  setDiffFeedback(agentId: string, items: DiffFeedback[]) {
    this.store.agent(agentId);
    const next = this.store.setDiffFeedback(agentId, trimFeedback(items));
    this.emit({ type: "diffFeedback", agentId, items: next });
    return next;
  }

  addDiffFeedback(agentId: string, input: NewFeedback) {
    const item = createFeedback(input);
    this.setDiffFeedback(agentId, [...this.store.diffFeedback(agentId), item]);
    return item;
  }

  updateDiffFeedback(agentId: string, id: string, text: string) {
    const value = text.trim();
    if (!value) throw new Error("Feedback text is empty");
    this.setDiffFeedback(agentId, this.store.diffFeedback(agentId).map((f) => (f.id === id && f.state === "accepted" ? { ...f, text: value.slice(0, 20_000) } : f)));
  }

  removeDiffFeedback(agentId: string, id: string) {
    this.setDiffFeedback(agentId, this.store.diffFeedback(agentId).filter((f) => f.id !== id));
  }

  clearDiffFeedback(agentId: string) {
    this.setDiffFeedback(agentId, this.store.diffFeedback(agentId).filter((f) => f.state === "submitted"));
  }

  async sendDiffFeedback(agentId: string, options: { text?: string; steer?: boolean; ids?: string[] }) {
    this.store.agent(agentId);
    const pending = pendingFeedback(this.store.diffFeedback(agentId), options.ids);
    const userText = (options.text ?? "").trim();
    if (pending.length === 0) throw new Error(T.errNoDiffFeedback);
    const steer = options.steer === true;
    this.setDiffFeedback(agentId, markSubmitted(this.store.diffFeedback(agentId), pending));
    try {
      return await this.send(agentId, formatFeedbackPrompt(userText, pending), { steer, display: userText, attachments: pending.map(feedbackChip), feedback: pending });
    } catch (error) {
      this.setDiffFeedback(agentId, restageFeedback(this.store.diffFeedback(agentId), pending));
      throw error;
    }
  }

  private takeQueued(agentId: string, queueId: string): QueuedMessage | null {
    const queue = this.store.agent(agentId).queue ?? [];
    const item = queue.find((q) => q.id === queueId);
    if (!item) return null;
    this.emit({ type: "agent", agent: this.store.patchAgent(agentId, { queue: queue.filter((q) => q.id !== queueId) }) });
    return item;
  }

  dequeue(agentId: string, queueId: string): { text: string } | null {
    const item = this.takeQueued(agentId, queueId);
    if (!item) return null;
    if (item.feedback?.length) this.setDiffFeedback(agentId, restageFeedback(this.store.diffFeedback(agentId), item.feedback));
    return { text: item.shown ?? item.text };
  }

  async sendQueuedNow(agentId: string, queueId: string) {
    const item = this.takeQueued(agentId, queueId);
    if (!item) return;
    try {
      await this.send(agentId, item.text, { steer: true, ...shownOf(item) });
    } catch (error) {
      this.emit({ type: "agent", agent: this.store.patchAgent(agentId, { queue: [item, ...(this.store.agent(agentId).queue ?? [])] }) });
      throw error;
    }
  }

  private enqueue(agentId: string, text: string, shown: { display?: string; attachments?: UserAttachment[]; feedback?: DiffFeedback[] } = {}) {
    const queue = [...(this.store.agent(agentId).queue ?? []), { id: randomUUID(), text, ...queuedExtras(shown) }];
    this.emit({ type: "agent", agent: this.store.patchAgent(agentId, { queue }) });
  }

  private steer(agentId: string, run: Run, prompt: string, shown: { display?: string; attachments?: UserAttachment[]; feedback?: DiffFeedback[] } = {}) {
    const messageId = randomUUID();
    run.steers.add(messageId);
    this.setSteering(agentId, [...(this.store.agent(agentId).steering ?? []), { id: messageId, text: prompt, ...queuedExtras(shown) }]);
    run.input.push(userMessage(prompt, messageId, STEER_PRIORITY, imageBlocks(shown.attachments)));
  }

  private setSteering(agentId: string, steering: QueuedMessage[]) {
    this.emit({ type: "agent", agent: this.store.patchAgent(agentId, { steering: steering.length ? steering : undefined }) });
  }

  private foldSteers(agentId: string, uuids: string[] | undefined) {
    const { taken, rest } = splitSteering(this.store.agent(agentId).steering, uuids);
    if (!taken.length) return;
    for (const s of taken) this.upsert(agentId, { id: randomUUID(), kind: "user", text: s.text, source: "user", at: new Date().toISOString(), messageId: s.id, ...(s.shown !== undefined ? { shown: s.shown } : {}), ...(s.attachments?.length ? { attachments: s.attachments } : {}) });
    this.setSteering(agentId, rest);
  }

  private requeueSteering(agentId: string) {
    const steering = this.store.agent(agentId).steering;
    if (!steering?.length) return;
    const queue = [...steering.map(({ sent: _sent, ...s }) => ({ ...s, id: randomUUID() })), ...(this.store.agent(agentId).queue ?? [])];
    this.emit({ type: "agent", agent: this.store.patchAgent(agentId, { queue, steering: undefined }) });
  }

  async cancelSteering(agentId: string, steeringId: string): Promise<{ cancelled: true; text: string } | { cancelled: false } | null> {
    const find = () => this.store.agent(agentId).steering?.find((s) => s.id === steeringId);
    const item = find();
    if (!item || this.cancellingSteers.has(steeringId)) return null;
    const run = this.runs.get(agentId);
    let cancelled = true;
    if (run && !run.closed && !run.input.remove(steeringId)) {
      this.cancellingSteers.add(steeringId);
      try {
        cancelled = await cancelAsyncMessage(run.query, steeringId);
      } finally {
        this.cancellingSteers.delete(steeringId);
      }
    }
    const current = find();
    if (!current) return null;
    if (!cancelled) {
      this.setSteering(agentId, (this.store.agent(agentId).steering ?? []).map((s) => (s.id === steeringId ? { ...s, sent: true } : s)));
      return { cancelled: false };
    }
    run?.steers.delete(steeringId);
    this.setSteering(agentId, (this.store.agent(agentId).steering ?? []).filter((s) => s.id !== steeringId));
    if (current.feedback?.length) this.setDiffFeedback(agentId, restageFeedback(this.store.diffFeedback(agentId), current.feedback));
    return { cancelled: true, text: current.shown ?? current.text };
  }

  private async startTurn(agentId: string, prompt: string, shown: { display?: string; system?: boolean; attachments?: UserAttachment[] } = {}) {
    const shownFields = { ...(shown.display !== undefined ? { shown: shown.display } : {}), ...(shown.attachments?.length ? { attachments: shown.attachments } : {}) };
    const agent = this.store.agent(agentId);
    const defaults = defaultsReader.resolve(this.store.settings);
    const provider = agent.providerId ? this.providerOf(agent.providerId) : null;
    const turnModel = provider ? (provider.models.some((m) => m.id === agent.model) ? agent.model : provider.defaultModel) : (agent.model ?? defaults.model.value);
    const turnEffort = provider ? null : (claudeEffort(agent.effort) ?? claudeEffort(defaults.effort.value));
    let customEnv: Record<string, string> | null = null;
    if (agent.providerId) {
      const failure = await this.providerFailure(agent.providerId);
      if (typeof failure === "string") {
        this.upsert(agentId, { id: randomUUID(), kind: "user", text: prompt, source: "user", at: new Date().toISOString(), ...shownFields });
        this.upsert(agentId, { id: randomUUID(), kind: "error", text: failure, auth: true });
        this.store.patchAgent(agentId, { unread: true });
        this.setStatus(agentId, "error");
        return;
      }
      customEnv = providerEnv(failure.provider, failure.key, turnModel ?? failure.provider.models[0].id);
    }
    const providerKey = agent.providerId ? `${agent.providerId}:${turnModel}` : null;
    const stale = this.runs.get(agentId);
    if (stale && !stale.active && stale.providerKey !== providerKey) this.closeRun(agentId);
    if (stale && !stale.active && stale.folders !== this.foldersKey(agent) && (stale.cwd !== agent.cwd || this.backgroundTaskCount(agentId) === 0)) this.closeRun(agentId);
    if (!this.runs.has(agentId) && !(await isDirectory(agent.cwd))) {
      this.upsert(agentId, { id: randomUUID(), kind: "user", text: prompt, source: "user", at: new Date().toISOString(), ...shownFields });
      this.upsert(agentId, { id: randomUUID(), kind: "error", text: T.errWorkingDirectoryGone(agent.cwd), auth: false });
      this.store.patchAgent(agentId, { unread: true });
      this.setStatus(agentId, "error");
      return;
    }
    let modelPrompt = prompt;
    if (agent.feedbackId && this.feedbackHooks) {
      this.preparing.add(agentId);
      try {
        modelPrompt = await this.feedbackHooks.beforeTurn(agentId, prompt);
      } catch (error) {
        console.error("[feedback] sync before send failed", error);
      } finally {
        this.preparing.delete(agentId);
      }
    }
    if (!agent.feedbackId) {
      const context = sessionContextBlock(prompt, agentId, this.store.agents, (id) => this.store.timeline(id));
      if (context) modelPrompt = `${modelPrompt}\n\n${context}`;
    }
    if (agent.sideAdopted) {
      modelPrompt = `${SIDE_ADOPTED_NOTE}\n\n${modelPrompt}`;
      this.store.patchAgent(agentId, { sideAdopted: false });
    }
    console.log(`[agent] turn ${agentId.slice(0, 8)} model=${turnModel ?? "(cli default)"}${agent.model ? "" : `[${defaults.model.source}]`} effort=${turnEffort ?? "(cli default)"}${agent.effort ? "" : `[${defaults.effort.source}]`} permission=${agent.permissionMode}`);

    const messageId = randomUUID();
    let run = this.runs.get(agentId);
    let reuse = false;
    if (run) {
      reuse = true;
      this.beginRun(run);
    } else {
      run = this.openRun(agent, turnModel, turnEffort, customEnv);
    }
    run.turnMessageId = messageId;
    void this.clearRedo(agentId).catch((error) => console.error("[agent] redo record not cleared", error));
    this.upsert(agentId, shown.system ? { id: randomUUID(), kind: "user", text: prompt, source: "system", at: new Date().toISOString(), messageId } : { id: randomUUID(), kind: "user", text: prompt, source: "user", at: new Date().toISOString(), messageId, ...shownFields });
    if (agent.unread || agent.done) this.store.patchAgent(agentId, { unread: false, done: false });
    this.setStatus(agentId, "running");
    this.boardHooks?.turnStarted(agentId);
    if (agent.feedbackId) this.feedbackHooks?.turnStarted(agentId);

    if (reuse && (run.model !== turnModel || run.effort !== turnEffort || run.permissionMode !== agent.permissionMode)) run = await this.syncSettings(agentId, run, turnModel, turnEffort);
    run.input.push(userMessage(modelPrompt, messageId, undefined, imageBlocks(shown.attachments)));
  }

  private async syncSettings(agentId: string, run: Run, model: string | null, effort: ClaudeEffortLevel | null): Promise<Run> {
    try {
      if (run.model !== model) await run.query.setModel(model ?? undefined);
      if (run.effort !== effort) await run.query.applyFlagSettings({ effortLevel: effort });
      const mode = this.store.agent(agentId).permissionMode;
      if (run.permissionMode !== mode) {
        await run.query.setPermissionMode(mode);
        run.permissionMode = mode;
        run.permissionSetAt = Date.now();
      }
      run.model = model;
      run.effort = effort;
      return run;
    } catch (error) {
      console.error("[agent] live model/effort/permission change failed, restarting the process", error);
      const turnMessageId = run.turnMessageId;
      this.closeRun(agentId);
      const next = this.openRun(this.store.agent(agentId), model, effort, run.providerKey ? this.liveProviderEnv.get(agentId) ?? null : null);
      next.turnMessageId = turnMessageId;
      return next;
    }
  }

  private liveProviderEnv = new Map<string, Record<string, string>>();

  private async providerFailure(providerId: string): Promise<string | { provider: NonNullable<ReturnType<CustomProviders["get"]>>; key: string }> {
    const provider = this.providerOf(providerId);
    if (!provider) return T.providerGone;
    try {
      const key = await this.providers!.keyFor(providerId);
      return key ? { provider, key } : T.providerNoKey(provider.name);
    } catch {
      return T.providerKeyUnreadable(provider.name);
    }
  }

  private openRun(agent: Agent, turnModel: string | null, turnEffort: ClaudeEffortLevel | null, customEnv: Record<string, string> | null = null): Run {
    const agentId = agent.id;
    if (customEnv) this.liveProviderEnv.set(agentId, customEnv);
    else this.liveProviderEnv.delete(agentId);
    const baseEnv = { ...claudeEnv(), ...sessionEnv(agentId) };
    if (customEnv) delete baseEnv.ANTHROPIC_API_KEY;
    const feedbackOptions = agent.feedbackId ? this.feedbackHooks?.options(agent) : null;
    const assistantOptions = agent.assistant ? this.assistantHooks?.options(agent, (toolName, toolInput, signal, toolUseId) => this.askPermission(agentId, toolName, toolInput, signal, toolUseId)) : null;
    const input = new PushQueue();
    const spawner = groupedSpawner();
    const notionServer = this.notionHooks && !agent.feedbackId && notionServerConfig() ? notionToolServer(this.notionHooks.host(agentId, (toolName, toolInput, preview, signal) => this.askNotionWrite(agentId, toolName, toolInput, preview, signal))) : null;
    const overriddenNotion = notionOverridden() ? notionServerConfig() : null;
    const extraDirs = this.store.extraDirs(agent);
    const guidance = chatGuidance(agent, this.store.workspaces, { explicitId: false });
    const mcpServers: Record<string, McpServerConfig> = {};
    if (this.browserBridge && !agent.feedbackId) mcpServers[BROWSER_SERVER_NAME] = browserMcpServer(this.browserBridge, () => this.store.settings.browserChatTools, agentId, () => [...this.store.agentRoots(this.store.agent(agentId)), join(HOME, "browser-shots"), ...CLAUDE_SCRATCH_ROOTS, ...writtenDirs(this.store.timeline(agentId))]);
    if (notionServer) mcpServers[OWN_SERVER] = notionServer;
    if (!agent.feedbackId) mcpServers[PREVIEW_SERVER] = previewToolServer();
    if (overriddenNotion) mcpServers[NOTION_SERVER] = overriddenNotion as McpServerConfig;
    const q = query({
      prompt: input,
      options: {
        cwd: agent.cwd,
        env: { ...baseEnv, ...(customEnv ?? {}) },
        ...(extraDirs.length ? { additionalDirectories: extraDirs } : {}),
        resume: agent.sessionId ?? agent.resumeFrom ?? undefined,
        resumeSessionAt: agent.resumeAt ?? undefined,
        enableFileCheckpointing: true,
        forkSession: !agent.sessionId && agent.resumeFrom ? true : undefined,
        permissionMode: agent.permissionMode,
        allowDangerouslySkipPermissions: true,
        model: turnModel ?? undefined,
        effort: turnEffort ?? undefined,
        ...(THINKING_DISPLAY ? { thinking: { type: "adaptive" as const, display: THINKING_DISPLAY } } : {}),
        includePartialMessages: true,
        pathToClaudeCodeExecutable: claudeBin(),
        spawnClaudeCodeProcess: spawner.spawn,
        systemPrompt: { type: "preset", preset: "claude_code", append: guidance ? `${SESSION_PROMPT_APPEND}\n\n${guidance}` : SESSION_PROMPT_APPEND },
        settingSources: ["user", "project", "local"],
        canUseTool: (toolName, input, { signal, toolUseID }) =>
          isBlockedNotionWrite(toolName) && this.notionGate(agentId) !== "apply"
            ? Promise.resolve({ behavior: "deny" as const, message: BLOCKED_NOTION_WRITE_MESSAGE })
            : classifyTool(toolName) === "own" || isPreviewTool(toolName)
              ? Promise.resolve({ behavior: "allow" as const, updatedInput: input })
              : !isInteractiveTool(toolName) && ((isBrowserToolName(toolName) && !browserToolNeedsApproval(toolName, input)) || this.store.agent(agentId).permissionMode === "bypassPermissions")
                ? Promise.resolve({ behavior: "allow" as const, updatedInput: input })
                : this.askPermission(agentId, toolName, input, signal, toolUseID),
        ...(Object.keys(mcpServers).length ? { mcpServers } : {}),
        disallowedTools: this.store.settings.notionBypassWrites === "apply" ? [] : notionDisallowedTools(),
        ...(overriddenNotion ? { strictMcpConfig: true } : {}),
        hooks: {
          PreToolUse: [
            {
              matcher: "mcp__.*",
              hooks: [
                async (input) => this.guardNotionWrite(agentId, input),
              ],
            },
            {
              hooks: [
                async (input) => {
                  const level = input.effort?.level as EffortLevel | undefined;
                  if (level && this.store.agent(agentId).activeEffort !== level) {
                    this.emit({ type: "agent", agent: this.store.updateAgent(agentId, { activeEffort: level }) });
                  }
                  const live = (input as { permission_mode?: string }).permission_mode;
                  const run = this.runs.get(agentId);
                  if (run && live && live !== run.permissionMode && isPermissionMode(live) && Date.now() - run.permissionSetAt > MODE_SETTLE_MS) {
                    run.permissionMode = live;
                    this.emit({ type: "agent", agent: this.store.patchAgent(agentId, { permissionMode: live }) });
                  }
                  return {};
                },
              ],
            },
            {
              matcher: "Edit|Write|MultiEdit|NotebookEdit",
              hooks: [
                async (input) => {
                  if (input.hook_event_name !== "PreToolUse") return {};
                  const agent = this.store.agent(agentId);
                  const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
                  try {
                    if (await snapshotBeforeEdit(agent, this.store, input.tool_name, toolInput)) {
                      this.emit({ type: "changes", agentId, changes: this.store.changes(agentId) });
                    }
                  } catch (error) {
                    console.error("[snapshot] failed", error);
                  }
                  await recordBeforeEdit(agent, this.store, input.tool_name, toolInput).catch((error) => console.error("[touched] before failed", error));
                  return {};
                },
              ],
            },
            {
              matcher: "Bash",
              hooks: [async (input) => this.guardFocus(agentId, input)],
            },
            {
              matcher: "Bash",
              hooks: [
                async () => {
                  noteBash(agentId);
                  return {};
                },
              ],
            },
          ],
          PostToolUse: [
            {
              matcher: "Edit|Write|MultiEdit|NotebookEdit",
              hooks: [
                async (input) => {
                  if (input.hook_event_name !== "PostToolUse") return {};
                  await recordAfterEdit(this.store.agent(agentId), this.store, input.tool_name, (input.tool_input ?? {}) as Record<string, unknown>).catch((error) => console.error("[touched] after failed", error));
                  return {};
                },
              ],
            },
          ],
        },
        ...feedbackOptions,
        ...assistantOptions,
      },
    });
    const run: Run = { query: q, input, draftId: null, active: true, interrupted: false, turnMessageId: null, steers: new Set(), model: turnModel, effort: turnEffort, permissionMode: agent.permissionMode, permissionSetAt: 0, idleTimer: null, idleSince: Date.now(), lastUsed: Date.now(), closed: false, apiError: false, approvalWaitMs: 0, stopWatch: null, ctxSeq: 0, stderrTail: spawner.stderrTail, cwd: agent.cwd, folders: this.foldersKey(agent), providerKey: customEnv ? `${agent.providerId}:${turnModel}` : null };
    run.stopWatch = watchDirectory(agent.cwd, () => this.workingDirectoryGone(agentId, run));
    this.runs.set(agentId, run);
    void this.consume(agentId, run).catch((error) => console.error("[agent] session cleanup failed", error));
    return run;
  }

  private async consume(agentId: string, run: Run) {
    try {
      for await (const message of run.query) await this.handleMessage(agentId, run, message);
    } catch (error) {
      if (!run.closed) {
        if (run.interrupted) {
        } else {
          const tail = run.stderrTail();
          const text = claudeErrorText(tail ? `${String(error)}. stderr: ${tail}` : String(error));
          this.upsert(agentId, { id: randomUUID(), kind: "error", text, auth: isAuthError(text) });
          this.store.updateAgent(agentId, { status: "error" });
          this.emit({ type: "agent", agent: this.store.agent(agentId) });
        }
      }
    } finally {
      if (!run.closed && this.runs.get(agentId) === run) {
        const wasActive = run.active;
        this.closeRun(agentId);
        this.clearDraft(agentId, run);
        this.settleRunningTools(agentId, run.interrupted);
        if (wasActive) this.endTouch(agentId);
        if (wasActive && this.store.agent(agentId).status !== "error" && !run.interrupted) {
          this.upsert(agentId, { id: randomUUID(), kind: "error", text: T.processEnded, auth: false });
          this.store.updateAgent(agentId, { status: "error" });
        }
        if (this.store.agent(agentId).status !== "error") this.store.updateAgent(agentId, { status: "idle" });
        this.store.updateAgent(agentId, { backgroundTasks: 0, unread: true });
        this.emit({ type: "agent", agent: this.store.agent(agentId) });
        if (wasActive && this.store.agent(agentId).feedbackId) this.feedbackHooks?.afterTurn(agentId);
      }
    }
  }

  private workingDirectoryGone(agentId: string, run: Run) {
    if (run.closed || this.runs.get(agentId) !== run) return;
    for (const [itemId, pending] of this.pending) {
      if (itemId.startsWith(`${agentId}:`)) pending.resolve("deny");
    }
    this.closeRun(agentId);
    run.active = false;
    run.interrupted = false;
    run.turnMessageId = null;
    run.approvalWaitMs = 0;
    this.clearDraft(agentId, run);
    this.settleRunningTools(agentId, true);
    this.endTouch(agentId);
    this.upsert(agentId, { id: randomUUID(), kind: "error", text: T.errWorkingDirectoryGone(this.store.agent(agentId).cwd), auth: false });
    this.store.updateAgent(agentId, { status: "error", backgroundTasks: 0, unread: true });
    this.emit({ type: "agent", agent: this.store.agent(agentId) });
  }

  markCutOff(agentId: string) {
    const agent = this.store.agents.find((a) => a.id === agentId);
    if (!agent || agent.feedbackId) return;
    this.settleRunningTools(agentId, true);
    for (const item of this.store.timeline(agentId)) {
      if (item.kind === "permission" && item.status === "pending") this.upsert(agentId, { ...item, status: "denied" });
    }
    this.upsert(agentId, { id: randomUUID(), kind: "error", text: harnessOf(agent) === "codex" ? this.codex.cutOffText() : harnessOf(agent) === "antigravity" ? this.antigravity.cutOffText() : harnessOf(agent) === "cursor" ? this.cursor.cutOffText() : T.daemonStoppedMidReply, auth: false });
    this.store.updateAgent(agentId, { status: "error", unread: true });
  }

  private closeRun(agentId: string) {
    const run = this.runs.get(agentId);
    if (!run) return;
    run.closed = true;
    run.stopWatch?.();
    if (run.idleTimer) clearTimeout(run.idleTimer);
    this.runs.delete(agentId);
    run.input.close();
    run.query.close();
    if (!this.store.agents.some((a) => a.id === agentId)) return;
    this.requeueSteering(agentId);
    this.stopTasks(agentId);
  }

  private endTouch(agentId: string) {
    void endTouchTurn(this.store.agent(agentId), this.store).then(() => this.emit({ type: "changes", agentId, changes: this.store.changes(agentId) }), (error) => console.error("[touched] end turn failed", error));
  }

  private stopTasks(agentId: string) {
    const now = new Date().toISOString();
    for (const item of this.store.timeline(agentId)) {
      if (item.kind === "tool" && item.task?.status === "running") this.upsert(agentId, stopTask(item, now));
    }
  }

  private armIdleClose(agentId: string, run: Run) {
    if (run.idleTimer) clearTimeout(run.idleTimer);
    run.idleSince = Date.now();
    run.lastUsed = run.idleSince;
    this.scheduleIdleCheck(agentId, run);
    this.enforceWarmCap();
  }

  enforceWarmCap() {
    const limit = this.store.settings.maxWarmSessions;
    const candidates = [...this.runs.entries()]
      .filter(([, run]) => !run.closed)
      .map(([agentId, run]) => ({
        agentId,
        lastUsed: run.lastUsed,
        busy: run.active || this.backgroundTaskCount(agentId) > 0 || this.preparing.has(agentId) || (this.store.agents.find((a) => a.id === agentId)?.queue?.length ?? 0) > 0,
      }));
    for (const agentId of selectWarmEvictions(candidates, limit)) {
      console.log(`[agent] warm cap close ${agentId.slice(0, 8)} (limit ${limit})`);
      this.closeRun(agentId);
    }
  }

  private scheduleIdleCheck(agentId: string, run: Run) {
    const limit = this.idleLimitMs();
    if (limit === 0) return;
    const wait = Math.max(1, Math.min(limit - (Date.now() - run.idleSince), IDLE_RECHECK_MS));
    run.idleTimer = setTimeout(() => {
      if (run.closed) return;
      const busy = run.active || this.backgroundTaskCount(agentId) > 0 || this.isOpen(agentId);
      if (busy) run.idleSince = Date.now();
      else if (Date.now() - run.idleSince >= this.idleLimitMs()) return this.closeIdleRun(agentId, run);
      this.scheduleIdleCheck(agentId, run);
    }, wait);
    run.idleTimer.unref();
  }

  private closeIdleRun(agentId: string, run: Run) {
    console.log(`[agent] idle close ${agentId.slice(0, 8)} after ${Math.round((Date.now() - run.idleSince) / 1000)}s`);
    this.closeRun(agentId);
  }

  private idleLimitMs() {
    return IDLE_CLOSE_ENV_MS || this.store.settings.keepIdleSessionsWarmMinutes * 60_000;
  }

  private openByClient = new Map<unknown, Set<string>>();

  setOpenAgents(client: unknown, agentIds: string[]) {
    this.openByClient.set(client, new Set(agentIds));
  }

  dropOpenAgents(client: unknown) {
    this.openByClient.delete(client);
  }

  isLive(agentId: string) {
    const status = this.store.agents.find((a) => a.id === agentId)?.status;
    return this.runs.has(agentId) || this.otherRunners().some((r) => r.isLive(agentId)) || status === "running" || status === "waiting" || this.isOpen(agentId);
  }

  private isOpen(agentId: string) {
    for (const ids of this.openByClient.values()) if (ids.has(agentId)) return true;
    return false;
  }

  rearmIdleCloses() {
    for (const [agentId, run] of this.runs) {
      if (run.active || run.closed) continue;
      if (run.idleTimer) clearTimeout(run.idleTimer);
      this.scheduleIdleCheck(agentId, run);
    }
  }

  private beginRun(run: Run) {
    run.lastUsed = Date.now();
    run.active = true;
    run.interrupted = false;
    run.apiError = false;
    if (run.idleTimer) clearTimeout(run.idleTimer);
    run.idleTimer = null;
  }

  private finishTurn(agentId: string, run: Run, outcome: "ok" | "error" | "interrupted") {
    run.active = false;
    run.interrupted = false;
    run.turnMessageId = null;
    void endTouchTurn(this.store.agent(agentId), this.store).then(() => this.emit({ type: "changes", agentId, changes: this.store.changes(agentId) }), (error) => console.error("[touched] end turn failed", error));
    run.approvalWaitMs = 0;
    if (outcome === "ok") this.foldSteers(agentId, [...run.steers]);
    else this.requeueSteering(agentId);
    run.steers.clear();
    this.clearDraft(agentId, run);
    this.settleRunningTools(agentId, outcome === "interrupted");
    if (outcome === "interrupted") this.upsert(agentId, { id: randomUUID(), kind: "notice", text: T.stopped });
    this.setStatus(agentId, run.apiError && outcome !== "interrupted" ? "error" : "idle");
    const silent = this.store.agent(agentId).assistant === true && this.assistantHooks?.silentTurn(agentId) === true;
    this.store.updateAgent(agentId, silent ? {} : { unread: true });
    this.emit({ type: "agent", agent: this.store.agent(agentId) });
    const agent = this.store.agent(agentId);
    if (agent.feedbackId) this.feedbackHooks?.afterTurn(agentId);
    if (agent.status !== "error") {
      this.clearCarry(agentId);
      this.boardHooks?.turnEnded(agentId);
    }
    this.armIdleClose(agentId, run);
    const next = outcome === "ok" ? agent.queue?.[0] : undefined;
    if (next) {
      this.takeQueued(agentId, next.id);
      void this.send(agentId, next.text, shownOf(next)).catch((error) => console.error("[agent] queued send failed", error));
    }
  }

  async interrupt(agentId: string) {
    for (const [itemId, pending] of this.pending) {
      if (itemId.startsWith(`${agentId}:`)) pending.resolve("deny");
    }
    const other = this.runnerOf(agentId);
    if (other) return other.interrupt(agentId);
    const run = this.runs.get(agentId);
    if (!run?.active) return;
    const steered = run.steers.size > 0;
    run.interrupted = true;
    setTimeout(() => {
      if (run.closed || !run.active || !run.interrupted) return;
      this.closeRun(agentId);
      this.clearDraft(agentId, run);
      this.settleRunningTools(agentId, true);
      this.endTouch(agentId);
      this.upsert(agentId, { id: randomUUID(), kind: "notice", text: T.stopped });
      this.store.patchAgent(agentId, { backgroundTasks: 0 });
      this.setStatus(agentId, "idle");
    }, steered ? STEER_INTERRUPT_GRACE_MS : INTERRUPT_GRACE_MS).unref();
    await stopEverything(run.query).catch((error) => console.error("[agent] interrupt request failed", error));
  }

  async setPermissionMode(agentId: string, mode: PermissionMode) {
    const harness = harnessOf(this.store.agent(agentId));
    if (harness === "antigravity" || harness === "cursor") {
      this.emit({ type: "agent", agent: this.store.updateAgent(agentId, { permissionMode: mode }) });
      return;
    }
    if (this.notClaude(agentId)) {
      if (!codexSupportsMode(mode)) throw new Error(T.codexPlanUnavailable);
      this.emit({ type: "agent", agent: this.store.updateAgent(agentId, { permissionMode: mode }) });
      return;
    }
    const run = this.runs.get(agentId);
    if (run && !run.closed) {
      try {
        await this.withModeTimeout(run.query.setPermissionMode(mode));
        run.permissionMode = mode;
        run.permissionSetAt = Date.now();
      } catch (error) {
        if (run.active) throw error;
        console.error("[agent] live permission mode change failed, the next turn restarts the process", error);
        this.closeRun(agentId);
      }
    }
    this.emit({ type: "agent", agent: this.store.updateAgent(agentId, { permissionMode: mode }) });
    this.releaseNotionCards(agentId);
  }

  private modeApplyTimeoutMs = 8000;
  private withModeTimeout(applying: Promise<void>): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(T.permissionModeTimeout)), this.modeApplyTimeoutMs);
      applying.then(
        () => (clearTimeout(timer), resolve()),
        (error) => (clearTimeout(timer), reject(error)),
      );
    });
  }

  setModel(agentId: string, model: string | null) {
    this.emit({ type: "agent", agent: this.store.updateAgent(agentId, { model }) });
  }

  setEffort(agentId: string, effort: EffortLevel | null) {
    this.emit({ type: "agent", agent: this.store.updateAgent(agentId, { effort }) });
  }

  setRead(agentId: string, read: boolean) {
    this.emit({ type: "agent", agent: this.store.patchAgent(agentId, { unread: !read }) });
  }

  setPinned(agentId: string, pinned: boolean) {
    this.emit({ type: "agent", agent: this.store.patchAgent(agentId, { pinned }) });
  }

  setDone(agentId: string, done: boolean) {
    this.emit({ type: "agent", agent: this.store.patchAgent(agentId, done ? { done } : { done, reopenedAt: new Date().toISOString() }) });
  }

  autoDone(now = Date.now(), held: (agentId: string) => boolean = () => false) {
    const stale = this.store.agents.filter((agent) => isAutoDoneDue(agent, now) && !held(agent.id));
    for (const agent of stale) this.emit({ type: "agent", agent: this.store.patchAgent(agent.id, { done: true }) });
    return stale.length;
  }

  rename(agentId: string, title: string) {
    const next = typeof title === "string" ? title.replace(/\s+/g, " ").trim() : "";
    if (!next) throw new Error(T.errEmptyTitle);
    this.emit({ type: "agent", agent: this.store.patchAgent(agentId, { title: next.slice(0, 200) }) });
  }

  async askTool(agentId: string, toolName: string, input: Record<string, unknown>, signal: AbortSignal): Promise<boolean> {
    const result = await this.askPermission(agentId, toolName, input, signal);
    const other = this.runnerOf(agentId);
    if (other && this.store.agents.find((a) => a.id === agentId)?.status === "waiting" && ![...this.pending.keys()].some((key) => key.startsWith(`${agentId}:`)) && other.pendingApprovalIds(agentId).length === 0) {
      this.setStatus(agentId, other.isActive(agentId) ? "running" : "idle");
    }
    return result.behavior === "allow";
  }

  respondPermission(agentId: string, itemId: string, decision: PermissionDecision) {
    if (this.codex.hasApproval(agentId, itemId)) return this.codex.respond(agentId, itemId, decision);
    if (this.antigravity.hasApproval(agentId, itemId)) return this.antigravity.respond(agentId, itemId, decision);
    if (this.cursor.hasApproval(agentId, itemId)) return this.cursor.respond(agentId, itemId, decision);
    const pending = this.pending.get(`${agentId}:${itemId}`);
    if (!pending) throw new Error(T.errPermissionHandled);
    if ((isInteractiveTool(pending.toolName) || isNotionProposeTool(pending.toolName)) && decision !== "deny") throw new Error(T.errNeedsAnswer);
    pending.resolve(decision);
  }

  private notionGate(agentId: string): NotionWriteGate {
    const agent = this.store.agent(agentId);
    return agent.feedbackId ? "ask" : notionWriteGate(agent.permissionMode, this.store.settings.notionBypassWrites);
  }

  private guardNotionWrite(agentId: string, input: Parameters<typeof notionWriteGuard>[0] & { tool_input?: unknown; permission_mode?: unknown }) {
    let allowDirect = false;
    try {
      allowDirect = this.notionGate(agentId) === "apply" && (input.permission_mode === undefined || input.permission_mode === "bypassPermissions");
    } catch {
    }
    const output = notionWriteGuard(input, { allowDirect });
    const name = typeof input.tool_name === "string" ? input.tool_name : "";
    if (allowDirect && input.hook_event_name === "PreToolUse" && isBlockedNotionWrite(name)) {
      const shown = name.replace(/^mcp__/, "").replace("__", " / ");
      const detail = (() => {
        try {
          return JSON.stringify(input.tool_input ?? {}, null, 2).slice(0, 4000);
        } catch {
          return "";
        }
      })();
      this.upsert(agentId, { id: randomUUID(), kind: "notice", text: `Notion write allowed by Bypass Permissions: ${shown}`, ...(detail ? { fold: { label: "Input", text: detail } } : {}) });
    }
    return output;
  }

  private guardFocus(agentId: string, input: { hook_event_name?: string; tool_input?: unknown }) {
    try {
      if (input.hook_event_name !== "PreToolUse" || this.store.settings.focusGuard === false) return {};
      const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
      const command = typeof toolInput.command === "string" ? toolInput.command : "";
      if (!command) return {};
      const cwd = this.store.agents.find((a) => a.id === agentId)?.cwd ?? "";
      const verdict = guardBashCommand(command, {
        readScript: (path) => {
          try {
            const file = path.startsWith("/") ? path : join(cwd, path);
            return statSync(file).size <= 65536 ? readFileSync(file, "utf8") : null;
          } catch {
            return null;
          }
        },
      });
      if (verdict.action === "pass") return {};
      if (verdict.action === "deny") {
        this.note(agentId, T.focusGuardBlocked, "Command", command);
        return { hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "deny" as const, permissionDecisionReason: verdict.reason } };
      }
      this.note(agentId, T.focusGuardRewrote(verdict.opens.length), "Ran instead", verdict.command);
      return { hookSpecificOutput: { hookEventName: "PreToolUse" as const, updatedInput: { ...toolInput, command: verdict.command } } };
    } catch (error) {
      console.error("[focusguard] failed", error);
      return {};
    }
  }

  private note(agentId: string, text: string, label: string, body: string) {
    try {
      this.upsert(agentId, { id: randomUUID(), kind: "notice", text, fold: { label, text: body.slice(0, 4000) } });
    } catch (error) {
      console.error("[focusguard] notice failed", error);
    }
  }

  releaseNotionCards(agentId?: string) {
    for (const [key, pending] of [...this.pending]) {
      if (!isNotionProposeTool(pending.toolName)) continue;
      const owner = key.slice(0, key.indexOf(":"));
      if (agentId && owner !== agentId) continue;
      try {
        if (this.notionGate(owner) !== "apply") continue;
      } catch {
        continue;
      }
      pending.settle({ behavior: "allow", updatedInput: pending.input }, undefined, true);
    }
  }

  respondNotionWrite(agentId: string, itemId: string, apply: boolean, feedback?: string) {
    const pending = this.pending.get(`${agentId}:${itemId}`);
    if (!pending) throw new Error(T.errPermissionHandled);
    if (!isNotionProposeTool(pending.toolName)) throw new Error(T.errNeedsAnswer);
    if (apply) pending.settle({ behavior: "allow", updatedInput: pending.input });
    else pending.settle({ behavior: "deny", message: feedback?.trim() ?? "" });
  }

  private async askNotionWrite(agentId: string, toolName: string, input: Record<string, unknown>, preview: NotionWritePreview, signal?: AbortSignal) {
    const items = this.store.timeline(agentId);
    const call = [...items].reverse().find((i) => i.kind === "tool" && i.name === toolName && i.status === "running" && !items.some((p) => p.kind === "permission" && p.toolUseId === i.id));
    if (this.notionGate(agentId) === "apply") {
      this.upsert(agentId, { id: randomUUID(), kind: "permission", toolUseId: call?.id, toolName, input, status: "allowed", notion: preview, auto: true });
      return { allowed: true as const };
    }
    const result = await this.askPermission(agentId, toolName, input, signal ?? new AbortController().signal, call?.id, preview);
    if (result.behavior === "allow") return { allowed: true as const };
    return { allowed: false as const, feedback: result.message === T.permissionDeniedByUser ? undefined : result.message };
  }

  answerQuestion(agentId: string, itemId: string, answers: Record<string, string> | null) {
    if (this.codex.hasApproval(agentId, itemId)) return this.codex.answerQuestion(agentId, itemId, answers);
    const pending = this.pending.get(`${agentId}:${itemId}`);
    if (!pending) throw new Error(T.errPermissionHandled);
    if (pending.toolName !== QUESTION_TOOL) throw new Error(T.errNeedsAnswer);
    const { result, answers: clean } = questionResult(pending.input, answers);
    pending.settle(result, { answers: clean });
  }

  respondPlan(agentId: string, itemId: string, decision: { approve: true; mode: "acceptEdits" | "default" } | { approve: false; feedback?: string }) {
    const pending = this.pending.get(`${agentId}:${itemId}`);
    if (!pending) throw new Error(T.errPermissionHandled);
    if (pending.toolName !== PLAN_TOOL) throw new Error(T.errNeedsAnswer);
    if (decision.approve) {
      const run = this.runs.get(agentId);
      if (run) {
        run.permissionMode = decision.mode;
        run.permissionSetAt = Date.now();
      }
      this.emit({ type: "agent", agent: this.store.patchAgent(agentId, { permissionMode: decision.mode }) });
      pending.settle(planResult(pending.input, decision), { plan: { decision: "approved", mode: decision.mode } });
      return;
    }
    const feedback = decision.feedback?.trim();
    pending.settle(planResult(pending.input, decision), { plan: { decision: "kept", ...(feedback ? { feedback } : {}) } });
  }

  async remove(agentId: string, removeWorktree: boolean) {
    const agent = this.store.agent(agentId);
    const run = this.runs.get(agentId);
    await this.interrupt(agentId);
    this.closeRun(agentId);
    await this.codex.remove(agentId);
    await this.antigravity.remove(agentId);
    await this.cursor.remove(agentId);
    try {
      if (agent.worktree && removeWorktree) {
        const others = this.store.agents.filter((a) => a.id !== agentId && a.worktree?.root === agent.worktree?.root);
        if (others.length) throw new Error(T.errWorktreeShared);
        const status = await gitOps.worktreeStatus(agent.worktree.root);
        if (status.dirty) throw new Error(T.errWorktreeDirty(status.summary));
        const parentId = this.store.workspace(agent.workspaceId!).parentId ?? agent.workspaceId!;
        const root = await gitOps.repoRoot(this.store.workspace(parentId).dir);
        if (!root) throw new Error(T.errRepoNotFound);
        await gitOps.removeWorktree(root, agent.worktree.root, agent.worktree.branch);
      }
      if (agent.feedbackId) await this.feedbackHooks?.removeWorktree(agent);
    } catch (error) {
      if (run) this.clearDraft(agentId, run);
      this.settleRunningTools(agentId, true);
      this.endTouch(agentId);
      if (agent.status === "running" || agent.status === "waiting") this.setStatus(agentId, "idle");
      throw error;
    }
    const workspaceId = agent.workspaceId;
    this.turnDivider.delete(agentId);
    this.store.removeAgent(agentId);
    void dropRedo(agentId).catch((error) => console.error("[agent] redo record not removed", error));
    this.emit({ type: "agentRemoved", agentId });
    this.boardHooks?.removed(agentId);
    if (workspaceId) this.store.removeWorkspaceIfUnused(workspaceId);
    else removeEmptyDir(agent.cwd);
    removeEmptyDir(chatDir(agentId));
    this.emit({ type: "workspaces", workspaces: this.store.workspaces });
  }

  async restoreCheckpoint(agentId: string, itemId: string) {
    this.assertClaude(agentId, "Restore checkpoint");
    const agent = this.store.agent(agentId);
    if (this.runs.get(agentId)?.active || agent.status === "waiting" || this.restoring.has(agentId)) throw new Error(T.errAgentRunning);
    const items = this.store.timeline(agentId);
    const item = items.find((i) => i.id === itemId);
    if (item?.kind !== "user" || item.source === "system" || !checkpointSession(agent)) throw new Error(T.errNoCheckpoint);
    if (item.preCompact) throw new Error(T.errPreCompact);
    if (checkpointLocked(items, harnessOf(agent)).has(itemId)) throw new Error(T.errCheckpointBeforeSwitch);
    const split = splitTimeline(items, itemId);
    if (!split) throw new Error(T.errNoCheckpoint);
    const chain = await sessionChain(agent);
    const messageId = await resolveMessageId(agent, items, itemId, chain);
    if (!messageId) throw new Error(T.errCheckpointUnmatched);
    const kept = keptEntryBefore(chain, messageId);
    if (kept === undefined) throw new Error(T.errCheckpointGone);
    const tip = chain.at(-1)?.uuid ?? null;
    const redoBase = { items: split.removed, prevSessionId: agent.sessionId, prevResumeFrom: agent.resumeFrom, prevResumeAt: agent.resumeAt ?? null, tip };

    this.restoring.add(agentId);
    this.restoreCancelled.delete(agentId);
    try {
      this.closeRun(agentId);
      const files = await withRewindQuery(agent, async (rewind) => {
        const preview = await rewind(messageId, true);
        const plan = checkpointMode(messageId, preview);
        if (plan.mode === "none") throw new Error(T.errCannotRewind(plan.reason ?? "unknown"));
        if (plan.mode === "chat") return { count: 0, before: {}, chatOnly: true, restoredHash: {}, trashed: 0, reverted: 0, skipped: [] as RestoreSkip[] };
        const changed = preview.filesChanged ?? [];
        if (this.restoreCancelled.has(agentId)) throw new Error(T.errRestoreCancelled);
        const filePlan = await planRestore(agent, this.store, changed, split.kept);
        const touched = [...filePlan.revert, ...filePlan.remove].map((f) => f.path);
        const before = await readRaw(agent, touched);
        await stageRedo(agentId, { ...redoBase, files: before });
        const { trashed } = await applyRestore(filePlan, async () => {
          if (touched.length === 0) return;
          const result = await rewind(messageId, false);
          if (!result.canRewind) throw new Error(T.errCannotRewind(result.error ?? "unknown"));
        });
        await commitRedo(agentId);
        await syncAfterRestore(agent, this.store, touched);
        return { count: touched.length, before, chatOnly: false, restoredHash: await hashesOf(Object.keys(before)), trashed: trashed.length, reverted: filePlan.revert.length, skipped: filePlan.skip };
      });
      const redoSaved = saveRedo(agentId, { ...redoBase, files: files.before, restoredHash: files.restoredHash, chatOnly: files.chatOnly });
      await (files.chatOnly ? redoSaved : redoSaved.catch((error) => console.error("[agent] redo record not updated", error)));
      for (const removed of split.removed) {
        this.store.removeItem(agentId, removed.id);
        this.emit({ type: "timelineRemove", agentId, itemId: removed.id });
      }
      this.upsert(agentId, { id: randomUUID(), kind: "restored", redoable: true, chatOnly: files.chatOnly || undefined });
      const carry = carryAfterCut(split.kept, this.store.agent(agentId).seenThrough);
      this.emit({ type: "agent", agent: this.store.updateAgent(agentId, { ...(kept === null ? { sessionId: null, resumeFrom: null, resumeAt: null } : { resumeAt: kept }), ...carry }) });
      this.emit({ type: "changes", agentId, changes: this.store.changes(agentId) });
      return { text: item.shown ?? item.text, files: files.count, chatOnly: files.chatOnly, reverted: files.reverted, removed: files.trashed, skipped: files.skipped };
    } finally {
      this.restoring.delete(agentId);
      this.restoreCancelled.delete(agentId);
    }
  }

  async previewCheckpoint(agentId: string, itemId: string) {
    this.assertClaude(agentId, "Restore checkpoint");
    const agent = this.store.agent(agentId);
    if (this.runs.get(agentId)?.active || agent.status === "waiting" || this.restoring.has(agentId)) throw new Error(T.errAgentRunning);
    const items = this.store.timeline(agentId);
    const split = splitTimeline(items, itemId);
    if (!checkpointSession(agent) || !split) throw new Error(T.errNoCheckpoint);
    if (checkpointLocked(items, harnessOf(agent)).has(itemId)) throw new Error(T.errCheckpointBeforeSwitch);
    const messageId = await resolveMessageId(agent, items, itemId, await sessionChain(agent));
    if (!messageId) throw new Error(T.errCheckpointUnmatched);
    const result = await withRewindQuery(agent, async (rewind) => {
      const preview = await rewind(messageId, true);
      if (checkpointMode(messageId, preview).mode !== "files") return { files: 0 };
      const plan = await planRestore(agent, this.store, preview.filesChanged ?? [], split.kept);
      return { files: plan.revert.length + plan.remove.length, plan };
    });
    return result;
  }

  async checkpointModes(agentId: string) {
    if (this.notClaude(agentId)) return {};
    const agent = this.store.agent(agentId);
    if (this.runs.get(agentId)?.active || agent.status === "waiting" || this.restoring.has(agentId)) throw new Error(T.errAgentRunning);
    const modes = await probeCheckpointModes(agent, this.store.timeline(agentId));
    return modes;
  }

  cancelRestore(agentId: string) {
    if (this.restoring.has(agentId)) this.restoreCancelled.add(agentId);
  }

  async redoCheckpoint(agentId: string) {
    this.assertClaude(agentId, "Restore checkpoint");
    const agent = this.store.agent(agentId);
    if (this.runs.get(agentId)?.active || agent.status === "waiting" || this.restoring.has(agentId)) throw new Error(T.errAgentRunning);
    this.restoring.add(agentId);
    try {
      const redo = await loadRedo(agentId);
      if (!redo) throw new Error(T.errNothingToRedo);
      this.closeRun(agentId);
      const { written, skipped } = await redoFiles(agent, redo.files, redo.restoredHash);
      await syncAfterRestore(agent, this.store, written);
      this.removeRestoredMarker(agentId);
      for (const item of redo.items) this.upsert(agentId, item);
      const carry = carryAfterCut(this.store.timeline(agentId), this.store.agent(agentId).seenThrough);
      this.emit({ type: "agent", agent: this.store.updateAgent(agentId, { ...carry, sessionId: redo.prevSessionId, ...(redo.prevResumeFrom !== undefined ? { resumeFrom: redo.prevResumeFrom } : {}), resumeAt: redo.prevResumeAt ?? redo.tip }) });
      this.emit({ type: "changes", agentId, changes: this.store.changes(agentId) });
      await dropRedo(agentId);
      return { files: written.length, chatOnly: redo.chatOnly === true, skipped };
    } finally {
      this.restoring.delete(agentId);
    }
  }

  private removeRestoredMarker(agentId: string) {
    for (const item of this.store.timeline(agentId).filter((i) => i.kind === "restored")) {
      this.store.removeItem(agentId, item.id);
      this.emit({ type: "timelineRemove", agentId, itemId: item.id });
    }
  }

  private async clearRedo(agentId: string) {
    this.removeRestoredMarker(agentId);
    await dropRedo(agentId);
  }

  private settleRunningTools(agentId: string, cancelled: boolean) {
    for (const item of this.store.timeline(agentId)) {
      if (item.kind !== "tool" || item.status !== "running") continue;
      this.upsert(agentId, { ...item, status: "error", cancelled: cancelled || undefined });
    }
  }

  private async turnChanges(agentId: string) {
    try {
      const agent = this.store.agent(agentId);
      await endTouchTurn(agent, this.store);
      const { files } = await touchedLastTurn(agent, this.store);
      if (!files.length) return undefined;
      return {
        files: files.length,
        additions: files.reduce((n, f) => n + f.additions, 0),
        deletions: files.reduce((n, f) => n + f.deletions, 0),
        list: files.map((f) => ({ path: f.path, additions: f.additions, deletions: f.deletions })),
      };
    } catch (error) {
      console.error("[agent] turn changes failed", error);
      return undefined;
    }
  }

  private browserCallPage(agentId: string, input: Record<string, unknown>): { page?: { title: string; url: string } } {
    const bridge = this.browserBridge;
    if (!bridge) return {};
    const pages = bridge.pagesFor(agentId).map((m) => m.page);
    const page = typeof input.pageId === "string" ? pages.find((p) => p.pageId === input.pageId) : pages.length === 1 ? pages[0] : undefined;
    return page ? { page: { title: page.title || page.url, url: page.url } } : {};
  }

  private async browserResultExtras(agentId: string, toolName: string, content: unknown): Promise<{ shots?: string[]; page?: { title: string; url: string } }> {
    const out: { shots?: string[]; page?: { title: string; url: string } } = {};
    const parts = Array.isArray(content) ? (content as { type?: string; source?: { data?: string } }[]) : [];
    const shots: string[] = [];
    for (const part of parts) {
      if (part?.type !== "image" || typeof part.source?.data !== "string") continue;
      try {
        shots.push((await saveBrowserShot(part.source.data, join(HOME, "tool-shots"), 200)).path);
      } catch {
      }
    }
    if (shots.length) out.shots = shots;
    if (toolName.endsWith("open_browser_page")) {
      const id = /^Page ID: (\S+)/m.exec(toolResultText(content))?.[1];
      const page = id ? this.browserBridge?.pagesFor(agentId).find((m) => m.page.pageId === id)?.page : undefined;
      if (page) out.page = { title: page.title || page.url, url: page.url };
    }
    return out;
  }

  private async asideResultExtras(content: unknown): Promise<{ shots?: string[] }> {
    const shots = await saveAsideShots(content);
    return shots.length ? { shots } : {};
  }

  private askPermission(
    agentId: string,
    toolName: string,
    input: Record<string, unknown>,
    signal: AbortSignal,
    toolUseId?: string,
    notion?: NotionWritePreview,
  ): Promise<PermissionResult> {
    const itemId = randomUUID();
    const key = `${agentId}:${itemId}`;
    const askedAt = Date.now();
    this.upsert(agentId, { id: itemId, kind: "permission", toolUseId, toolName, input, status: "pending", ...(notion ? { notion } : {}) });
    this.setStatus(agentId, "waiting");

    return new Promise<PermissionResult>((resolve) => {
      const settle = (result: PermissionResult, outcome?: PermissionOutcome, auto?: boolean) => {
        this.pending.delete(key);
        signal.removeEventListener("abort", onAbort);
        const run = this.runs.get(agentId);
        if (run) run.approvalWaitMs += Date.now() - askedAt;
        this.upsert(agentId, {
          id: itemId,
          kind: "permission",
          toolUseId,
          toolName,
          input,
          status: result.behavior === "allow" ? "allowed" : "denied",
          ...(outcome ? { outcome } : {}),
          ...(notion ? { notion } : {}),
          ...(auto ? { auto: true } : {}),
        });
        if (![...this.pending.keys()].some((other) => other.startsWith(`${agentId}:`))) {
          if (run?.active) this.setStatus(agentId, "running");
          else if (run && this.store.agents.find((a) => a.id === agentId)?.status === "waiting") this.setStatus(agentId, "idle");
        }
        resolve(result);
      };
      const finish = (decision: PermissionDecision) => {
        if (toolName === QUESTION_TOOL && decision === "deny") {
          const dismissed = questionResult(input, null);
          settle(dismissed.result, { answers: dismissed.answers });
          return;
        }
        if (toolName === PLAN_TOOL && decision === "deny") {
          settle(planResult(input, { approve: false }), { plan: { decision: "kept" } });
          return;
        }
        if (decision === "deny") {
          settle({ behavior: "deny", message: T.permissionDeniedByUser });
          return;
        }
        settle({
          behavior: "allow",
          updatedInput: input,
          updatedPermissions:
            decision === "allowAlways"
              ? [{ type: "addRules", rules: sessionAllowRules(toolName), behavior: "allow", destination: "session" }]
              : undefined,
        });
      };
      const onAbort = () => finish("deny");
      signal.addEventListener("abort", onAbort);
      this.pending.set(key, { toolName, input, resolve: finish, settle });
    });
  }

  private async handleMessage(agentId: string, run: Run, message: SDKMessage) {
    if (TRACE) {
      const subtype = "subtype" in message ? (message as { subtype?: string }).subtype : "";
      const detail =
        message.type === "result"
          ? ` queued=${message.queued_turn_count} uuids=${JSON.stringify(message.user_message_uuids)} turns=${message.num_turns}`
          : message.type === "assistant" || message.type === "stream_event"
            ? ` frameUuids=${JSON.stringify(consumedUuids(message))}`
            : (message.type as string) === "command_lifecycle"
              ? ` ${JSON.stringify(message).slice(0, 300)}`
              : "";
      console.log(`[trace ${agentId.slice(0, 8)} ${new Date().toISOString().slice(14, 23)}] ${message.type}${subtype ? "/" + subtype : ""}${detail}`);
    }
    if ((message.type as string) === "command_lifecycle") {
      const frame = message as unknown as { command_uuid?: string; state?: string };
      if (frame.state === "started" && frame.command_uuid) this.foldSteers(agentId, [frame.command_uuid]);
      if (frame.state === "cancelled" && frame.command_uuid && !this.store.agent(agentId).steering?.some((s) => s.id === frame.command_uuid)) run.steers.delete(frame.command_uuid);
      return;
    }
    if (!run.active && !run.closed && (message.type === "stream_event" || message.type === "assistant" || message.type === "user") && !message.parent_tool_use_id && !isControlEcho(message)) {
      this.beginRun(run);
      this.setStatus(agentId, "running");
    }
    switch (message.type) {
      case "system": {
        this.handleSystem(agentId, run, message);
        return;
      }
      case "stream_event": {
        if (message.parent_tool_use_id) return;
        this.foldSteers(agentId, consumedUuids(message));
        const event = message.event;
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          run.draftId ??= randomUUID();
          const items = this.store.timeline(agentId);
          const draft = items.find((i) => i.id === run.draftId);
          const text = (draft?.kind === "assistant" ? draft.text : "") + event.delta.text;
          this.upsert(agentId, { id: run.draftId, kind: "assistant", text, streaming: true });
        }
        return;
      }
      case "assistant": {
        if (message.parent_tool_use_id) {
          this.subagentToolCalls(agentId, message.parent_tool_use_id, message.message.content);
          return;
        }
        this.foldSteers(agentId, consumedUuids(message));
        this.noteUsage(agentId, run, message);
        for (const [index, block] of message.message.content.entries()) {
          const id = `${message.uuid}:${index}`;
          if (block.type === "text" && message.error) {
            this.clearDraft(agentId, run);
            run.apiError = true;
            this.upsert(agentId, { id, kind: "error", text: block.text, auth: AUTH_API_ERRORS.has(message.error) });
          } else if (block.type === "text") {
            const streamedId = run.draftId;
            run.draftId = null;
            this.upsert(agentId, { id: streamedId ?? id, kind: "assistant", text: block.text, streaming: false, at: new Date().toISOString(), model: message.message.model });
            this.dropRepeatedAnswer(agentId, streamedId ?? id, block.text);
          } else if (block.type === "thinking" && block.thinking.trim()) {
            this.upsert(agentId, { id, kind: "thinking", text: block.thinking });
          } else if (block.type === "tool_use") {
            this.clearDraft(agentId, run);
            const input = (block.input ?? {}) as Record<string, unknown>;
            this.upsert(agentId, {
              id: block.id,
              kind: "tool",
              name: block.name,
              input,
              status: "running",
              output: null,
              ...(isBrowserToolName(block.name) ? this.browserCallPage(agentId, input) : {}),
              ...(isAgentTool(block.name) ? { task: newTask(input, new Date().toISOString()) } : {}),
            });
          }
        }
        return;
      }
      case "user": {
        if (message.parent_tool_use_id) {
          this.subagentToolResults(agentId, run, message.message.content);
          return;
        }
        if (isControlEcho(message)) return;
        const content = message.message.content;
        if (typeof content === "string") {
          this.upsert(agentId, { id: message.uuid ?? randomUUID(), kind: "user", text: content, source: "system" });
          return;
        }
        for (const block of content) {
          if (block.type === "text" && block.text.trim()) {
            this.upsert(agentId, { id: `${message.uuid ?? randomUUID()}:text`, kind: "user", text: block.text, source: "system" });
            continue;
          }
          if (block.type !== "tool_result") continue;
          const tool = this.store.timeline(agentId).find((i) => i.id === block.tool_use_id);
          if (tool?.kind !== "tool") continue;
          const browser = isBrowserToolName(tool.name) ? await this.browserResultExtras(agentId, tool.name, block.content) : isAsideTool(tool.name) ? await this.asideResultExtras(block.content) : {};
          const output = toolResultText(block.content);
          const done: typeof tool = {
            ...tool,
            ...browser,
            status: block.is_error ? "error" : "done",
            output,
            ...(block.is_error && run.interrupted ? { cancelled: true } : {}),
          };
          this.upsert(agentId, isAgentTool(tool.name) ? resultTask(done, output, block.is_error === true, new Date().toISOString()) : done);
        }
        return;
      }
      case "result": {
        void this.refreshContext(agentId, run);
        this.clearDraft(agentId, run);
        this.foldSteers(agentId, message.user_message_uuids);
        const consumedSteers = (message.user_message_uuids ?? []).filter((id) => run.steers.delete(id)).length;
        const end = turnEnd({ interrupted: run.interrupted, queuedTurnCount: message.queued_turn_count, isError: message.is_error, pendingSteers: run.steers.size, uuidsKnown: message.user_message_uuids !== undefined });
        if (run.interrupted) {
          this.settleRunningTools(agentId, true);
          run.interrupted = false;
          if (end !== "continue") this.finishTurn(agentId, run, "interrupted");
          return;
        }
        if (end === "steered" && message.is_error) {
          this.settleRunningTools(agentId, true);
          return;
        }
        if (message.num_turns !== 0) {
          const ownTurn = run.turnMessageId !== null && (consumedSteers > 0 || ownsTurn(run.turnMessageId, message.user_message_uuids));
          const changes = ownTurn ? await this.turnChanges(agentId) : undefined;
          if (run.closed) return;
          if (ownTurn) run.turnMessageId = null;
          const waited = run.approvalWaitMs;
          run.approvalWaitMs = 0;
          this.upsert(agentId, {
            id: message.uuid,
            kind: "result",
            isError: message.is_error,
            durationMs: Math.max(0, message.duration_ms - waited),
            costUsd: message.total_cost_usd ?? null,
            ...(changes ? { changes } : {}),
          });
        }
        if (end !== "continue" && end !== "steered") this.finishTurn(agentId, run, end);
        return;
      }
      default:
        return;
    }
  }

  private dropRepeatedAnswer(agentId: string, keptId: string, text: string) {
    const answer = text.trim();
    if (!answer) return;
    const items = this.store.timeline(agentId);
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (item.kind === "user" && item.source !== "system") return;
      if (item.kind !== "assistant" || item.id === keptId || item.streaming || item.text.trim() !== answer) continue;
      this.store.removeItem(agentId, item.id);
      this.emit({ type: "timelineRemove", agentId, itemId: item.id });
      return;
    }
  }

  private handleSystem(agentId: string, run: Run, message: Extract<SDKMessage, { type: "system" }>) {
    switch (message.subtype) {
      case "init": {
        if (run.cwd !== this.store.agent(agentId).cwd) return;
        const agent = this.store.updateAgent(agentId, {
          sessionId: message.session_id,
          resumeFrom: null,
          resumeAt: null,
          activeModel: message.model,
          activeEffort: (message.effort as EffortLevel | null | undefined) ?? null,
        });
        this.emit({ type: "agent", agent });
        return;
      }
      case "background_tasks_changed": {
        const live = message.tasks.filter((t) => !t.ambient).length;
        this.emit({ type: "agent", agent: this.store.updateAgent(agentId, { backgroundTasks: live }) });
        for (const item of reconcileTasks(this.store.timeline(agentId), new Set(message.tasks.map((t) => t.task_id)), new Date().toISOString())) this.upsert(agentId, item);
        return;
      }
      case "task_started": {
        if (!isAgentTask(message)) return;
        this.updateTask(agentId, message.tool_use_id, null, (item) => startTask(item, message, new Date().toISOString()));
        return;
      }
      case "task_progress": {
        this.updateTask(agentId, message.tool_use_id, message.task_id, (item) => progressTask(item, message));
        return;
      }
      case "task_updated": {
        this.updateTask(agentId, undefined, message.task_id, (item) => updateTask(item, message, new Date().toISOString()));
        return;
      }
      case "task_notification": {
        this.updateTask(agentId, message.tool_use_id, message.task_id, (item) => finishTask(item, message, new Date().toISOString()));
        if (message.status === "stopped") return;
        const called = message.tool_use_id ? this.store.timeline(agentId).find((i) => i.id === message.tool_use_id) : undefined;
        if (!showsTaskNotice(message.status === "failed" ? "failed" : "completed", called)) return;
        const summary = message.summary.trim();
        const head = summary.split("\n").find((l) => l.trim())?.trim() ?? "";
        const short = head.length > BACKGROUND_NOTICE_MAX ? `${head.slice(0, BACKGROUND_NOTICE_MAX).trimEnd()}…` : head;
        this.upsert(agentId, {
          id: message.uuid,
          kind: "notice",
          text: T.backgroundTask(message.status === "completed" ? "completed" : message.status === "failed" ? "failed" : "stopped", short),
          ...(short !== summary ? { fold: { label: T.backgroundTaskDetails, text: summary } } : {}),
        });
        return;
      }
      case "compact_boundary": {
        this.upsert(agentId, { id: message.uuid, kind: "notice", text: T.compacted });
        const run = this.runs.get(agentId);
        const agent = this.store.agent(agentId);
        const dropped = contextAfterCompact(agent.contextUsage, message.compact_metadata.post_tokens, agent.activeModel, new Date().toISOString());
        if (dropped) {
          if (run) run.ctxSeq++;
          this.setContext(agentId, dropped);
        }
        if (run) void this.refreshContext(agentId, run);
        return;
      }
      default:
        return;
    }
  }

  private knownContextLimit(model: string | null | undefined) {
    if (!model) return null;
    return this.store.agents.find((a) => a.activeModel === model && a.contextUsage?.source === "api")?.contextUsage?.limit ?? null;
  }

  private noteUsage(agentId: string, run: Run, message: Extract<SDKMessage, { type: "assistant" }>) {
    if (message.error) return;
    const next = estimateContext(this.store.agent(agentId).contextUsage, message.message.usage as FrameUsage, message.message.model, new Date().toISOString(), this.knownContextLimit(message.message.model));
    if (!next) return;
    run.ctxSeq++;
    this.setContext(agentId, next);
  }

  private setContext(agentId: string, next: ContextUsage) {
    if (sameContext(this.store.agent(agentId).contextUsage, next)) return;
    this.emit({ type: "agent", agent: this.store.patchAgent(agentId, { contextUsage: next }) });
  }

  private async refreshContext(agentId: string, run: Run) {
    const seq = ++run.ctxSeq;
    try {
      const res = await run.query.getContextUsage({ detail: "summary" });
      if (run.closed || run.ctxSeq !== seq) return;
      const next = contextFromApi(res, new Date().toISOString());
      if (next) this.setContext(agentId, next);
    } catch {
    }
  }

  private subagentToolCalls(agentId: string, parentId: string, content: unknown) {
    if (!Array.isArray(content)) return;
    for (const block of content as { type: string; id?: string; name?: string; input?: unknown }[]) {
      if (block.type !== "tool_use" || !block.id || !block.name) continue;
      if (this.store.timeline(agentId).some((i) => i.id === block.id)) continue;
      this.upsert(agentId, { id: block.id, kind: "tool", name: block.name, input: slimInput((block.input ?? {}) as Record<string, unknown>), status: "running", output: null, parentToolUseId: parentId });
    }
  }

  private subagentToolResults(agentId: string, run: Run, content: unknown) {
    if (!Array.isArray(content)) return;
    for (const block of content as { type: string; tool_use_id?: string; content?: unknown; is_error?: boolean }[]) {
      if (block.type !== "tool_result" || !block.tool_use_id) continue;
      const tool = this.store.timeline(agentId).find((i) => i.id === block.tool_use_id);
      if (tool?.kind !== "tool" || !tool.parentToolUseId) continue;
      this.upsert(agentId, { ...tool, status: block.is_error ? "error" : "done", output: slimOutput(toolResultText(block.content)), ...(block.is_error && run.interrupted ? { cancelled: true } : {}) });
    }
  }

  private updateTask(agentId: string, toolUseId: string | undefined, taskId: string | null, change: (item: Extract<TimelineItem, { kind: "tool" }>) => Extract<TimelineItem, { kind: "tool" }>) {
    const item = this.store.timeline(agentId).find((i): i is Extract<TimelineItem, { kind: "tool" }> => i.kind === "tool" && isAgentTool(i.name) && ((toolUseId !== undefined && i.id === toolUseId) || (taskId !== null && i.task?.taskId === taskId)));
    if (item) this.upsert(agentId, change(item));
  }

  private clearDraft(agentId: string, run: Run) {
    if (!run.draftId) return;
    this.store.removeItem(agentId, run.draftId);
    this.emit({ type: "timelineRemove", agentId, itemId: run.draftId });
    run.draftId = null;
  }

  private upsert(agentId: string, item: TimelineItem) {
    this.store.upsertItem(agentId, item);
    this.emit({ type: "timelineUpsert", agentId, item });
  }

  private setStatus(agentId: string, status: Agent["status"]) {
    const agent = this.store.updateAgent(agentId, { status });
    this.emit({ type: "agent", agent });
  }
}

export const AUTO_DONE_MS = 3 * 24 * 3_600_000;
export function isAutoDoneDue(agent: Agent, now: number) {
  if (agent.pinned || agent.done || agent.feedbackId || agent.assistant || agent.unread) return false;
  if (agent.status === "running" || agent.status === "waiting") return false;
  if (agent.queue?.length || agent.steering?.length || agent.backgroundTasks > 0) return false;
  const last = Math.max(Date.parse(agent.updatedAt) || 0, agent.reopenedAt ? Date.parse(agent.reopenedAt) || 0 : 0);
  return last > 0 && weekdayMsBetween(last, now) >= AUTO_DONE_MS;
}

export function weekdayMsBetween(from: number, to: number) {
  let total = 0;
  let cursor = from;
  while (cursor < to) {
    const day = new Date(cursor);
    const next = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime();
    const end = Math.min(next, to);
    const weekday = day.getDay();
    if (weekday !== 0 && weekday !== 6) total += end - cursor;
    cursor = end;
  }
  return total;
}

export async function cancelAsyncMessage(q: Query, uuid: string): Promise<boolean> {
  const cancel = (q as unknown as { cancelAsyncMessage?: (uuid: string) => Promise<boolean | undefined> }).cancelAsyncMessage;
  if (typeof cancel !== "function") throw new Error(T.errCancelUnsupported);
  return (await cancel.call(q, uuid)) === true;
}

function stopEverything(q: Query) {
  const interrupt = q.interrupt as (options?: { cancelQueued?: boolean }) => Promise<unknown>;
  return interrupt.call(q, { cancelQueued: true });
}

export function copyItems(items: TimelineItem[], agentId: string): TimelineItem[] {
  return settleStale(items
    .filter((i) => !(i.kind === "assistant" && i.streaming) && i.kind !== "restored")
    .map((i) => {
      const prefix = agentId.slice(0, 8);
      const copy = { ...i, id: `${prefix}:${i.id}` };
      if (copy.kind === "user") delete copy.messageId;
      if (copy.kind === "permission" && copy.toolUseId) copy.toolUseId = `${prefix}:${copy.toolUseId}`;
      if (copy.kind === "tool" && copy.parentToolUseId) copy.parentToolUseId = `${prefix}:${copy.parentToolUseId}`;
      return copy;
    }));
}

const TITLE_MAX = 200;
export function titleFrom(prompt: string) {
  return shortTitle(prompt) || T.newSessionTitle;
}

export function toolResultText(content: unknown): string {
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((part) => (part && typeof part === "object" && "text" in part ? String(part.text) : ""))
            .join("\n")
        : "";
  return text.length > MAX_TOOL_OUTPUT ? `${text.slice(0, MAX_TOOL_OUTPUT)}\n${T.truncated}` : text;
}
