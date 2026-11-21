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
  RestoreSkip, // FIX5-0
} from "../shared/protocol";
import { HARNESS_VALUES, PERMISSION_MODE_VALUES, claudeEffort, harnessOf, isEffortLevel, type ClaudeEffortLevel, type Harness } from "../shared/protocol";
import { carryAfterCut, carryTranscript, checkpointLocked, HARNESS_NAMES, remapSeen, switchBlock, switchedState } from "../shared/harnessSwitch";
import { CODEX_FALLBACK_MODE, codexSupportsMode } from "../shared/codexPermission"; // CODEX
import { CodexRunner } from "./codex/runner"; // CODEX
import { checkpointMode, checkpointSession, commitRedo, dropRedo, keptEntryBefore, loadRedo, probeCheckpointModes, readRaw, resolveMessageId, saveRedo, sessionChain, splitTimeline, stageRedo, withRewindQuery } from "./checkpoints";
import { applyRestore, hashesOf, redoFiles } from "./restoreGuard"; // FIX5-0
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
import { resolveFiles } from "./fileAttach"; // FILEATTACH
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
import { sessionContextBlock, sessionRef } from "../shared/sessionRef";
import { BLOCKED_NOTION_WRITE_MESSAGE, classifyTool, isBlockedNotionWrite, isNotionProposeTool, notionDisallowedTools } from "../shared/notionMcp"; // NOTION2
import type { NotionWritePreview } from "../shared/notionWrite"; // NOTION2
import { notionOverridden, notionServerConfig } from "./notionSession"; // NOTION2
import { notionWriteGuard } from "./notionGuard"; // NOTION2
import { guardBashCommand } from "./focusGuard"; // ASIDEVIEW
import { saveAsideShots } from "./asideImages"; // ASIDEVIEW
import { isAsideTool } from "../shared/asideTool"; // ASIDEVIEW
import { notionWriteGate, type NotionWriteGate } from "../shared/notionApproval"; // NOTION3
import { notionToolServer, type NotionToolHost } from "./notionTools"; // NOTION2
import { NOTION_SERVER, OWN_SERVER } from "../shared/notionMcp"; // NOTION2

const MAX_TOOL_OUTPUT = 20_000;
// 세션 시스템 프롬프트 뒤에 붙인다. Slack 초안을 ```slack 블록에 쓰면 화면이 Slack 모양 미리보기와 서식 복사 버튼으로 보인다(web/slackPreview.ts).
const SESSION_PROMPT_APPEND = [
  "When you write a Slack message or draft for the user to send, put the message body alone in a fenced code block with the language `slack`, written in Slack mrkdwn: *bold*, _italic_, ~strike~, `code`, <https://example.com|link text>, <@U123> mentions, > quotes, and lines starting with • or - for bullets.",
  "Lodestar shows that block as a Slack preview with a button that copies it with Slack formatting. Keep explanations outside the block.",
].join(" ");
// 백그라운드 작업 알림 한 줄에 보이는 글자 수. 넘는 내용은 접어 둔다.
const BACKGROUND_NOTICE_MAX = 120;
// 브라우저 도구가 file: 로 열 수 있는 곳(작업 폴더 말고). 에이전트 scratchpad 와 이 세션이 Write, Edit 로 만든 파일의 폴더.
// 세션이 ~/.agents/... 에 만든 대시보드 HTML 을 확인하려다 작업 폴더 밖이라 막혔다(사용자 10-29). 직접 만든 파일만 넓히고 임의 경로는 그대로 막는다.
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
// 곁다리 질문 창에서 옮겨 온 세션의 첫 턴에 모델에게만 붙이는 안내(server/side.ts 의 읽기 전용 제한이 풀렸다는 것)
const SIDE_ADOPTED_NOTE = "<system-reminder>이 대화는 곁다리 질문 창에서 정식 세션으로 옮겨졌다. 앞부분의 '읽기 도구만 쓰고 파일을 고치거나 명령을 실행하지 않는다' 제한은 이제 없다. 앞에서 '이 창에서는 실행할 수 없다' 고 답한 것은 그 제한 때문이었고, 지금은 메인 세션과 같은 도구(Bash 포함)와 권한으로 작업한다.</system-reminder>";

// B6: 폴더 없는 세션(퀵 챗)의 작업 폴더
const CHATS_DIR = join(HOME, "chats");
const chatDir = (agentId: string) => join(CHATS_DIR, agentId);
function removeEmptyDir(dir: string) {
  if (!dir.startsWith(CHATS_DIR)) return;
  try {
    rmdirSync(dir);
  } catch {
    // 비어 있지 않거나 이미 없으면 그대로 둔다
  }
}
const TRACE = process.env.AGENT_NAV_TRACE === "1";
const THINKING_DISPLAY = process.env.AGENT_NAV_THINKING_DISPLAY === "summarized" || process.env.AGENT_NAV_THINKING_DISPLAY === "omitted" ? process.env.AGENT_NAV_THINKING_DISPLAY : undefined;
const AUTH_API_ERRORS = new Set(["authentication_failed", "oauth_org_not_allowed"]);

type PendingPermission = {
  toolName: string;
  input: Record<string, unknown>;
  resolve: (decision: PermissionDecision) => void;
  // fixB: 질문과 계획 승인은 허용 또는 거절이 아니라 사용자가 고른 결과를 SDK 에 돌려준다.
  // NOTION3: auto 는 사용자가 누르지 않고 Bypass Permissions 가 승인한 Notion 쓰기
  settle: (result: PermissionResult, outcome?: PermissionOutcome, auto?: boolean) => void;
};

// B3: 세션 하나가 쓰는 CLI 프로세스. 세션 동안 유지하고(MCP 서버를 매 턴 다시 띄우지 않는다), 메시지는 input 으로 밀어 넣는다.
type Run = {
  query: Query;
  input: PushQueue;
  draftId: string | null;
  // 턴이 진행 중인가. 보낸 메시지의 result 가 오기 전까지, 또는 CLI 가 스스로 연 턴이 끝나기 전까지 true. 프로세스는 false 인 동안에도 살아 있다.
  active: boolean;
  interrupted: boolean;
  // B2: 이 턴을 시작한 사용자 메시지의 uuid. 그 메시지가 담긴 첫 result 에서 턴의 변경 요약을 만들고 비운다(CLI 가 스스로 여는 뒷 턴에는 요약이 없다).
  turnMessageId: string | null;
  // 끼어들기(priority now)로 보냈고 아직 result 에 담기지 않은 메시지 uuid
  steers: Set<string>;
  // 이 프로세스에 적용돼 있는 모델과 effort. 다음 턴 앞에서 바뀌었으면 라이브로 맞춘다.
  model: string | null;
  effort: ClaudeEffortLevel | null;
  // permbug: 이 프로세스가 실제로 쓰는 권한 모드와 마지막으로 바꾼 시각. CLI 가 스스로 모드를 바꾸는 경우(계획 승인 뒤 등)를 도구 호출 훅에서 알아챌 때, 방금 사용자가 바꾼 값과 헷갈리지 않게 시각을 같이 둔다.
  permissionMode: PermissionMode;
  permissionSetAt: number;
  // 유휴가 길어지면 프로세스를 닫는 타이머와, 유휴가 시작된(또는 마지막으로 쓰이거나 보인) 시각
  idleTimer: ReturnType<typeof setTimeout> | null;
  idleSince: number;
  // PERFDAEMON: 마지막으로 메시지를 받았거나 턴이 끝난 시각. 칸에 열려 있어도 밀리지 않는 순서라서 데워 두는 개수 한도(maxWarmSessions)가 이 순서로 닫는다.
  lastUsed: number;
  closed: boolean;
  // 이 턴에서 모델이 API 오류(잘못된 모델, 한도 초과 등)로 답을 못 했다. 턴이 끝날 때 세션을 error 로 표시한다.
  apiError: boolean;
  approvalWaitMs: number;
  // 작업 폴더가 사라지는지 보는 감시를 멈춘다. 프로세스가 사는 동안만 감시한다.
  stopWatch: (() => void) | null;
  // CTX: 컨텍스트 사용량 갱신 순번. SDK 에 물은 사이에 더 새 값이 들어오면 늦게 온 답을 버린다.
  ctxSeq: number;
  // FIX6A: CLI 가 비정상 종료했을 때 오류 문구에 붙일 stderr 끝부분(사용자 지정 spawn 은 SDK 가 붙여 주지 않는다)
  stderrTail: () => string;
};

// permbug: 사용자가 모드를 바꾼 직후, 아직 날아오는 옛 모드의 훅 입력을 CLI 가 바꾼 것으로 오해하지 않는 시간
const MODE_SETTLE_MS = 2000;
const isPermissionMode = (value: string): value is PermissionMode => (PERMISSION_MODE_VALUES as readonly string[]).includes(value);

// B3: 유휴 프로세스를 닫기까지의 시간은 설정(keepIdleSessionsWarmMinutes, 기본 10분, 0 이면 닫지 않음)을 따른다. 닫아도 다음 메시지가 resume 으로 이어 간다(그때 MCP 서버가 다시 뜬다).
// 시험에서는 AGENT_NAV_IDLE_CLOSE_MS 가 설정을 대신한다.
const IDLE_CLOSE_ENV_MS = Number(process.env.AGENT_NAV_IDLE_CLOSE_MS) || 0;
// 닫지 못하게 막는 조건(진행 중, 칸에 열림)이 있는 동안 얼마 간격으로 다시 확인할지. 조건이 풀린 뒤 한도의 두 배가 넘게 남지 않게 한다.
const IDLE_RECHECK_MS = 60_000;
// 중단을 눌렀는데 result 가 오지 않을 때 프로세스를 강제로 닫기까지의 시간
const STEER_PRIORITY = process.env.AGENT_NAV_STEER_PRIORITY === "now" ? "now" : "next";
const INTERRUPT_GRACE_MS = 10_000;
// 끼어들기로 보낸 메시지가 아직 result 에 담기지 않은 채로 중단하면, CLI 가 중단을 받고도 도구를 끊지 않고 result 도 내지 않는 경우가 있다(끼어든 메시지가 도구 실행 직전에 도착한 틈).
// 정상 중단은 수십 ms 안에 result 가 오므로 이때는 짧게만 기다리고 프로세스를 닫는다.
const STEER_INTERRUPT_GRACE_MS = 1_500;

// 피드백 개선 세션(server/feedback.ts)이 꽂는 훅. options 는 세션의 query() 옵션을 덮어쓰고, afterTurn 은 턴이 끝난 뒤 검사와 반영을 시작한다.
export type FeedbackHooks = {
  options: (agent: Agent) => Partial<Options> | null;
  afterTurn: (agentId: string) => void;
  // 후속 턴이 시작됐다(답을 기다리던 피드백이 다시 도는 중이 된다)
  turnStarted: (agentId: string) => void;
  // FBREBASE: 사용자가 이어서 보내는 턴이 모델에 가기 전에 작업 폴더를 본 작업 폴더의 현재 상태에 맞춘다. 돌려주는 글이 모델에게 갈 메시지다(바꿨으면 안내가 앞에 붙는다).
  beforeTurn: (agentId: string, prompt: string) => Promise<string>;
  removeWorktree: (agent: Agent) => Promise<void>;
};

// 칸반 보드(server/board.ts)가 꽂는 훅. 보드가 세션의 시작과 끝, 삭제를 알아야 카드를 자동으로 옮기고 연결을 정리할 수 있다.
export type BoardHooks = {
  link: (agentId: string, cardId: string) => void;
  turnStarted: (agentId: string) => void;
  turnEnded: (agentId: string) => void;
  removed: (agentId: string) => void;
};

export type ImportHooks = {
  beforeTurn: (agentId: string) => Promise<boolean>;
  turnEnded: (agentId: string) => void;
};

// NOTION2: Notion 연동이 꽂는 훅. 에이전트 세션에 Notion 제안 도구(쓰기는 승인 카드를 거친다)를 붙이는 데 필요한 것들을 데몬이 채운다.
export type NotionHooks = {
  // 세션에 붙일 NotionToolHost 를 만든다. 페이지 전용 대화면 page, addCards, startSession 이 채워진다.
  host: (agentId: string, ask: NotionToolHost["ask"]) => NotionToolHost;
  // 페이지 전용 대화로 만든 세션을 페이지에 묶는다. 첫 턴이 시작되기 전에 불려서, 그 세션의 도구가 처음부터 페이지를 안다.
  attach: (agentId: string, page: { url: string; title: string }) => void;
};

export type CreateParams = {
  // B6: null 이면 폴더 없는 세션. worktree 는 쓸 수 없다.
  workspaceId: string | null;
  prompt: string;
  permissionMode: PermissionMode;
  model: string | null;
  effort: EffortLevel | null;
  worktree: { branch: string; base: string } | null;
  // 보드 카드에서 시작한 세션이면 그 카드. 첫 턴이 시작되기 전에 연결한다.
  boardCardId?: string;
  // HANDOFF: 핸드오프로 시작하는 세션. shown 은 첫 말풍선에 보일 글(prompt 에는 인계 문서가 들어 있다).
  handoffFrom?: string;
  handoffId?: string;
  // fixB: 첫 메시지에 붙은 이미지
  images?: ImageRef[];
  // FILEATTACH: 첫 메시지에 붙은 파일(경로만 모델에 가고, 말풍선에는 파일 칩이 보인다)
  files?: FileRef[];
  shown?: string;
  // NOTION2: 페이지 전용 대화. text(페이지 내용과 사용 안내)가 첫 메시지 앞에 붙어 모델에 가고, 말풍선에는 사용자가 쓴 글과 페이지 칩만 보인다.
  notionContext?: { text: string; label: string; url: string; title: string };
  // CODEX: 세션을 돌릴 도구. 없으면 claude.
  harness?: Harness;
};

export class AgentRunner {
  // B3: 세션 id -> 살아 있는 CLI 프로세스(유휴 포함). 턴이 도는 중인지는 Run.active.
  private runs = new Map<string, Run>();
  private pending = new Map<string, PendingPermission>();
  private feedbackHooks: FeedbackHooks | null = null;
  private boardHooks: BoardHooks | null = null;
  // IMPORT: 가져온 세션의 동기화 훅과, 보내기 전 동기화를 하는 동안 들어오는 메시지를 큐로 보내기 위한 표시
  private importHooks: ImportHooks | null = null;
  private preparing = new Set<string>();
  // QUEUECANCEL: CLI 에 취소를 물어 보는 중인 끼어들기 메시지. 더블클릭이 두 번째 물음에서 false 를 받아 "이미 보냄" 표지를 잘못 달지 않게 한다.
  private cancellingSteers = new Set<string>();
  // G7: 공유된 Browser 탭을 에이전트에게 주는 길. 없으면 Browser 도구를 붙이지 않는다.
  private browserBridge: BrowserBridge | null = null;
  // NOTION2
  private notionHooks: NotionHooks | null = null;
  // B2: 체크포인트 복원이 도는 세션과, 그 복원을 취소하겠다고 한 세션
  private restoring = new Set<string>();
  private restoreCancelled = new Set<string>();

  // CODEX: harness 가 codex 인 세션을 돌리는 실행기. 공개 진입점(send, interrupt, 승인 응답 등)에서 harness 로 나눠 보낸다. Claude 경로는 그대로다.
  private codex: CodexRunner;

  constructor(
    private store: Store,
    private emit: (event: ServerEvent) => void,
  ) {
    this.codex = new CodexRunner({
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
        void this.send(agentId, next.text, shownOf(next)).catch((error) => console.error("[codex] queued send failed", error));
      },
      idleLimitMs: () => this.idleLimitMs(),
    });
  }

  private isCodex(agentId: string) {
    return harnessOf(this.store.agent(agentId)) === "codex";
  }

  // CODEX: Codex 앱 서버에서 읽은 모델 목록과 로그인 상태(RPC codex.meta)
  codexMeta(refresh = false) {
    return this.codex.meta(refresh);
  }

  // CODEX: Claude 기록(세션 id)에 기대는 기능은 Codex 세션에서 쓸 수 없다. 화면은 같은 이유로 단추를 막고, 서버도 직접 호출을 거절한다.
  assertClaude(agentId: string, what: string) {
    if (this.isCodex(agentId)) throw new Error(T.codexUnsupported(what));
  }

  async create(params: CreateParams) {
    const id = randomUUID();
    // FILEATTACH: 파일이 사라졌으면 세션을 만들기 전에 던진다(화면이 입력을 그대로 두고 이유를 알린다).
    const attached = await resolveFiles(params.files);
    // B6: 폴더 없는 세션은 세션마다 새 빈 폴더(git 없음)에서 돈다. 모델 호출 환경은 폴더 세션과 같다(claudeEnv).
    // CODEX: Notion 연동은 Claude 세션의 MCP 도구라 Codex 세션에는 붙지 않는다
    if (params.harness === "codex" && params.notionContext) throw new Error(T.codexUnsupported("Notion page chat"));
    const workspace = params.workspaceId === null ? null : this.store.workspace(params.workspaceId);
    if (!workspace && params.worktree) throw new Error(T.errChatNoWorktree);
    let cwd = workspace ? workspace.dir : chatDir(id);
    if (!workspace) mkdirSync(cwd, { recursive: true });
    let worktree: Worktree | null = null;
    let workspaceId = workspace?.id ?? null;
    if (workspace && params.worktree) {
      // worktree 는 레포 옆 <repo>.worktrees/<branch>. 모노레포 하위 폴더면 worktree 안의 같은 하위 경로가 cwd.
      const root = await gitOps.repoRoot(workspace.dir);
      if (!root) throw new Error(T.errNotGitRepoForWorktree);
      const path = await gitOps.addWorktree(root, params.worktree.branch, params.worktree.base);
      cwd = join(path, relative(root, workspace.dir));
      worktree = { root: path, branch: params.worktree.branch, base: params.worktree.base };
      workspaceId = this.store.addWorkspace(cwd, workspace.id, `${workspace.name} (${params.worktree.branch})`).id;
      this.emit({ type: "workspaces", workspaces: this.store.workspaces });
    }
    const now = new Date().toISOString();
    const handoff = params.handoffFrom ? this.store.agent(params.handoffFrom) : null;
    if (params.handoffId !== undefined && !validHandoffId(params.handoffId)) throw new Error(T.errHandoffUnknown);
    const agent: Agent = {
      id,
      workspaceId,
      cwd,
      worktree,
      forkedFrom: null,
      resumeFrom: null,
      startCommit: worktree || !workspace ? null : await gitOps.headCommit(cwd),
      feedbackId: null,
      // HANDOFF: 핸드오프 세션의 제목은 사용자가 쓴 글에서, 글이 없으면 원 세션 제목에서 만든다.
      title: handoff ? (params.shown?.trim() ? titleFrom(params.shown) : T.handoffTitle(handoff.title).slice(0, TITLE_MAX)) : titleFrom(params.prompt.trim() || (params.images?.length ? T.imageTitle : (attached.files[0]?.name ?? ""))),
      sessionId: null,
      status: "idle",
      // CODEX: Codex 에 없는 권한 모드(plan)는 가장 가까운 default 로 시작한다
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
    };
    this.store.addAgent(agent);
    // 같은 폴더의 다른 세션이나 사람이 만든 커밋 안 된 변경이 이 세션의 Session 범위(칩과 사이드바 숫자)에 섞이지 않게, 시작 시점의 작업 폴더 상태를 기준으로 남긴다. 실패해도 세션 생성은 막지 않는다.
    if (agent.startCommit) await captureForkBase(agent, this.store, agent.id).catch(() => false);
    this.emit({ type: "agent", agent });
    // HANDOFF: 원 세션 대화 끝에 어디로 넘겼는지 남긴다. 원 세션의 Claude 기록(jsonl)에는 쓰지 않고 이 앱의 타임라인에만 남는다.
    if (handoff) this.upsert(handoff.id, { id: randomUUID(), kind: "notice", text: T.handedOffTo(agent.title), openAgentId: agent.id });
    // send 는 첫 await 전에 running 으로 바꾸므로, 카드 연결은 그 전에 해야 "첫 실행" 규칙이 이 카드를 본다.
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

  setFeedbackHooks(hooks: FeedbackHooks) {
    this.feedbackHooks = hooks;
  }

  // NOTION2
  setNotionHooks(hooks: NotionHooks) {
    this.notionHooks = hooks;
  }

  setBrowserBridge(bridge: BrowserBridge) {
    this.browserBridge = bridge;
  }

  setBoardHooks(hooks: BoardHooks) {
    this.boardHooks = hooks;
  }

  setImportHooks(hooks: ImportHooks) {
    this.importHooks = hooks;
  }

  // IMPORT: 가져온 세션을 등록한다. 타임라인은 화면이 세션을 열 때 읽으므로 항목마다 이벤트를 보내지 않는다.
  adoptImported(agent: Agent, items: TimelineItem[]) {
    this.store.addAgent(agent, items);
    this.emit({ type: "agent", agent });
  }

  private markOwnWrite(agentId: string) {
    if (!this.store.agents.some((a) => a.id === agentId && a.imported)) return;
    // CLI 는 닫은 뒤에도 기록을 마저 쓰므로 표지를 몇 번 더 올린다
    for (const delay of [0, 2500, 8000]) setTimeout(() => this.importHooks?.turnEnded(agentId), delay).unref();
  }

  // IMPORT: 이미 가져온 세션에 새 항목(또는 결과가 늦게 생긴 도구 호출)을 더한다. 열려 있는 화면은 이벤트로 받는다.
  applyImported(agentId: string, items: TimelineItem[]) {
    for (const item of items) this.upsert(agentId, item);
  }

  // 진행 중인 턴, 백그라운드 작업(서브에이전트, 백그라운드 Bash)이 도는 세션, 응답을 기다리는 권한 요청의 수. 데몬을 재시작해도 되는지 판단할 때 쓴다(유휴 프로세스는 세지 않는다).
  // 턴이 끝나도 백그라운드 작업은 같은 CLI 프로세스 안에서 돌기 때문에, 재시작이 프로세스를 끄면 작업이 결과 없이 사라진다.
  activeCount() {
    return [...this.runs.entries()].filter(([agentId, run]) => run.active || this.backgroundTaskCount(agentId) > 0).length + this.pending.size + this.codex.activeCount();
  }

  private backgroundTaskCount(agentId: string) {
    return this.store.agents.find((a) => a.id === agentId)?.backgroundTasks ?? 0;
  }

  // 살아 있는 세션들의 CLI 프로세스(유휴 포함). MCP 재연결을 거는 데 쓴다 (프로세스가 없는 세션은 다음 턴에 새로 읽는다).
  liveQueries(): Query[] {
    return [...this.runs.values()].map((run) => run.query);
  }

  // WSMENU: 숨기는 세션의 쉬는 프로세스를 닫는다. 이후 이벤트가 사라진 세션을 찾지 않게 한다.
  closeIdle(agentId: string) {
    this.closeRun(agentId);
  }

  // 데몬이 끝날 때 모든 세션 프로세스를 닫는다.
  closeAll() {
    for (const agentId of [...this.runs.keys()]) this.closeRun(agentId);
    this.codex.closeAll();
  }

  // 타임라인에 알림 한 줄을 남긴다.
  // id 를 주면 그 항목을 같은 자리에서 갱신한다(FBREBASE: 같은 사유의 실패 알림이 턴마다 쌓이지 않게). 항목 id 를 돌려준다.
  notice(agentId: string, text: string, detail?: string, fold?: { label: string; text: string }, id: string = randomUUID()) {
    this.upsert(agentId, { id, kind: "notice", text, ...(detail ? { detail } : {}), ...(fold ? { fold } : {}) });
    return id;
  }

  // 빠른 질문이나 사이드 챗처럼 다른 곳에서 만든 세션을 에이전트로 등록한다.
  adopt(agent: Agent, items: TimelineItem[]) {
    this.store.addAgent(agent, items);
    this.emit({ type: "agent", agent });
    for (const item of items) this.emit({ type: "timelineUpsert", agentId: agent.id, item });
  }

  // 정식 갈래: 기록을 복사하고, 첫 턴에서 forkSession 으로 새 세션 id 를 받는다.
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
      // B1: 갈래는 원 세션의 고정, 완료, 안 읽음을 물려받지 않는다.
      unread: false,
      pinned: false,
      done: false,
    };
    const agent = await this.withForkBase(source, forked);
    this.adopt(agent, copyItems(this.store.timeline(agentId), agent.id));
    return agent;
  }

  // 갈래의 변경은 갈래를 만든 시점의 작업 폴더 상태에서 센다. 그 시점의 HEAD 와, 그때 이미 바뀌어 있던 파일의 내용을 남긴다.
  // 원 세션이 만든 커밋 안 된 변경이 갈래의 변경으로 보이지 않게 하는 것이다. worktree 세션은 같은 worktree 를 쓰므로 startCommit 은 그대로다.
  private async withForkBase(source: Agent, agent: Agent): Promise<Agent> {
    if (source.workspaceId === null) return agent;
    const startCommit = source.worktree ? source.startCommit : await gitOps.headCommit(source.cwd);
    const based = await captureForkBase(agent, this.store, source.id);
    return { ...agent, startCommit, forkBased: based || undefined };
  }

  // B2: 메시지 단위 갈래. beforeItemId 사용자 메시지 바로 앞까지의 대화로 시작하는 새 세션.
  // 정식 갈래처럼 첫 턴에서 CLI 가 원 세션을 그 지점(resumeAt)까지 갈라 새 세션 id 를 만든다. SDK 의 forkSession 함수로 미리 만들면 파일 체크포인트가 안 따라오고
  // 메시지 uuid 도 새로 매겨져서(시험으로 확인), 갈래에서 Start Over 나 Restore Checkpoint 가 파일을 못 되돌린다. CLI 가 갈라 만든 세션은 지점까지의 스냅샷과 백업 파일을 함께 옮기고 uuid 도 그대로다.
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

  // --- B3: 메시지 보내기, 큐, 끼어들기 ---

  // 응답 중이면 steer 가 아닌 한 큐에 넣는다(클라이언트가 유휴로 알고 보냈는데 서버는 응답 중인 경주도 여기서 큐로 간다).
  // display 와 attachments 는 타임라인에 보일 사용자 글과 첨부 칩이다(모델에는 prompt 가 그대로 간다). 큐와 끼어들기 경로에는 실리지 않는다.
  // DIFFFB: feedback 은 이 메시지에 묶인 diff 피드백이다. 큐에 들어가면 함께 보관돼서 큐에서 뺄 때 다시 쌓인 상태로 돌아간다.
  async send(agentId: string, prompt: string, options: { steer?: boolean; display?: string; attachments?: UserAttachment[]; feedback?: DiffFeedback[] } = {}): Promise<{ queued: boolean }> {
    this.store.agent(agentId);
    if (this.restoring.has(agentId)) throw new Error(T.errAgentRunning);
    // CODEX: Codex 세션은 끼어들기(steer)를 아직 지원하지 않아 도는 중이면 모두 큐에 쌓는다
    if (this.isCodex(agentId)) {
      if (this.codex.isActive(agentId)) {
        this.enqueue(agentId, prompt, options);
        return { queued: true };
      }
      const carried = this.withCarry(agentId, prompt, options);
      await this.codex.startTurn(agentId, carried.prompt, carried.options);
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
    if (!agent.carryPending) return { prompt, options };
    const block = carryTranscript(this.store.timeline(agentId), agent);
    if (!block) {
      this.clearCarry(agentId);
      return { prompt, options };
    }
    return { prompt: `${block}\n\n${prompt}`, options: { ...options, display: options.display ?? prompt } };
  }

  private clearCarry(agentId: string) {
    const agent = this.store.agents.find((a) => a.id === agentId);
    if (!agent?.carryPending || agent.status === "error") return;
    this.emit({ type: "agent", agent: this.store.patchAgent(agentId, { carryPending: false }) });
  }

  async switchHarness(agentId: string, target: Harness, model: string | null, effort: EffortLevel | null) {
    const agent = this.store.agent(agentId);
    if (!HARNESS_VALUES.includes(target)) throw new Error(`Unknown tool: ${String(target)}`);
    const from = harnessOf(agent);
    const nextModel = typeof model === "string" && model.trim() ? model.trim() : null;
    const nextEffort = target === "claude" ? claudeEffort(effort) : isEffortLevel(effort) ? effort : null;
    if (from === target) {
      this.emit({ type: "agent", agent: this.store.updateAgent(agentId, { model: nextModel, effort: nextEffort }) });
      return;
    }
    const items = this.store.timeline(agentId);
    const live = this.runs.get(agentId)?.active || this.preparing.has(agentId) || this.restoring.has(agentId) || this.codex.isActive(agentId);
    const pending = [...this.pending.keys()].some((key) => key.startsWith(`${agentId}:`)) || this.codex.pendingApprovalIds(agentId).length > 0;
    const blocked = switchBlock(agent, items) ?? (pending ? "waiting" : live ? "running" : null);
    if (blocked) throw new Error(T.switchBlocked[blocked]);
    if (from === "claude") this.closeRun(agentId);
    else await this.codex.remove(agentId);
    const divider: TimelineItem = { id: randomUUID(), kind: "notice", text: T.switchedTo(HARNESS_NAMES[target], nextModel), divider: true, switched: target };
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
      }),
    });
  }

  // --- DIFFFB: diff 줄에 쌓은 피드백 ---

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

  // 쌓인 것(안 보낸 것)만 지운다. 보낸 것은 대화의 칩이 가리키는 기록이라 남는다.
  clearDiffFeedback(agentId: string) {
    this.setDiffFeedback(agentId, this.store.diffFeedback(agentId).filter((f) => f.state === "submitted"));
  }

  // 쌓인 피드백을 한 메시지로 보낸다. 모델에는 경로, 줄 범위, 선택한 코드, diff 조각이 든 프롬프트가 가고, 말풍선에는 입력창 글과 칩만 보인다.
  // 보낸 것은 바로 submitted 로 바꾸고(응답 중이어서 큐에 들어가도 같다), 전송이 실패하면 다시 쌓인 상태로 돌린다.
  sendDiffFeedback(agentId: string, options: { text?: string; steer?: boolean; ids?: string[] }) {
    this.store.agent(agentId);
    const pending = pendingFeedback(this.store.diffFeedback(agentId), options.ids);
    const userText = (options.text ?? "").trim();
    if (pending.length === 0) throw new Error(T.errNoDiffFeedback);
    const steer = options.steer === true;
    const queued = this.willQueue(agentId, steer);
    this.setDiffFeedback(agentId, markSubmitted(this.store.diffFeedback(agentId), pending));
    void this.send(agentId, formatFeedbackPrompt(userText, pending), { steer, display: userText, attachments: pending.map(feedbackChip), feedback: pending }).catch((error) => {
      console.error("[agent] diff feedback send failed", error);
      this.setDiffFeedback(agentId, restageFeedback(this.store.diffFeedback(agentId), pending));
    });
    return { queued };
  }

  // send 가 이 호출에서 큐에 넣게 되는지(응답 중이고 끼어들기가 아닐 때)
  willQueue(agentId: string, steer: boolean) {
    if (this.isCodex(agentId)) return this.codex.willQueue(agentId);
    return !steer && (this.runs.get(agentId)?.active === true || this.preparing.has(agentId));
  }

  // 큐에서 빼서 돌려준다. 묶인 diff 피드백은 건드리지 않는다.
  private takeQueued(agentId: string, queueId: string): QueuedMessage | null {
    const queue = this.store.agent(agentId).queue ?? [];
    const item = queue.find((q) => q.id === queueId);
    if (!item) return null;
    this.emit({ type: "agent", agent: this.store.patchAgent(agentId, { queue: queue.filter((q) => q.id !== queueId) }) });
    return item;
  }

  // Edit 과 Remove from Queue. 묶인 diff 피드백은 다시 쌓인 상태로 돌아가고, 돌려주는 글은 입력창에 쓴 글이다.
  dequeue(agentId: string, queueId: string): { text: string } | null {
    const item = this.takeQueued(agentId, queueId);
    if (!item) return null;
    if (item.feedback?.length) this.setDiffFeedback(agentId, restageFeedback(this.store.diffFeedback(agentId), item.feedback));
    return { text: item.shown ?? item.text };
  }

  // 큐의 한 항목을 지금 보낸다. 응답 중이면 끼어들기, 아니면 보통 전송.
  async sendQueuedNow(agentId: string, queueId: string) {
    const item = this.takeQueued(agentId, queueId);
    if (!item) return;
    // QUEUECANCEL: 보내기가 실패해도 글이 사라지지 않게 큐 앞으로 돌려놓는다.
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

  // 모델이 받은 끼어들기 메시지(uuids)를 Steering 표시에서 빼고 대화에 사용자 말풍선으로 넣는다. 말풍선을 먼저 넣고 표시를 지워, 글이 화면에서 사라지는 순간이 없다.
  private foldSteers(agentId: string, uuids: string[] | undefined) {
    const { taken, rest } = splitSteering(this.store.agent(agentId).steering, uuids);
    if (!taken.length) return;
    for (const s of taken) this.upsert(agentId, { id: randomUUID(), kind: "user", text: s.text, source: "user", at: new Date().toISOString(), messageId: s.id, ...(s.shown !== undefined ? { shown: s.shown } : {}), ...(s.attachments?.length ? { attachments: s.attachments } : {}) });
    this.setSteering(agentId, rest);
  }

  // 모델이 받지 못한 채 프로세스가 닫히거나 턴이 중단돼 CLI 쪽에서 취소된 끼어들기 메시지는 큐 앞으로 돌려 글을 보존한다.
  private requeueSteering(agentId: string) {
    const steering = this.store.agent(agentId).steering;
    if (!steering?.length) return;
    const queue = [...steering.map(({ sent: _sent, ...s }) => ({ ...s, id: randomUUID() })), ...(this.store.agent(agentId).queue ?? [])];
    this.emit({ type: "agent", agent: this.store.patchAgent(agentId, { queue, steering: undefined }) });
  }

  // QUEUECANCEL: 끼어들기 대기 메시지를 거둔다. 취소할 수 있는 건 CLI 가 그 메시지를 꺼내 가기 전까지다.
  //   1) 우리 입력 큐(PushQueue)에 아직 있으면 CLI 는 존재도 모르니 그냥 뺀다.
  //   2) CLI 의 명령 큐에 있으면 cancel_async_message 가 true 를 준다(SDK sdk.d.ts: "Drops a pending async user message from the command queue by uuid. No-op if already dequeued for execution").
  //   3) 이미 꺼내 갔으면 false 라서 지울 수 없다. 그 항목에 sent 표지를 달아 화면이 "Already sent to Claude" 를 보이게 하고, 곧 오는 command_lifecycle started 가 말풍선으로 옮긴다.
  // 취소되면 run.steers 에서도 빼야 한다. 남겨 두면 다음 result 가 "아직 끼어들기가 남은 턴"(steered)으로 읽혀 세션이 idle 로 돌아오지 않는다.
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
    // 기다리는 사이 모델이 받아서 이미 말풍선으로 옮겨졌을 수 있다.
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

  // 유휴 세션에 새 턴을 시작한다. 프로세스가 있으면 거기에 밀어 넣고(필요하면 모델과 effort 를 라이브로 맞춘다), 없으면 resume 으로 새로 띄운다.
  private async startTurn(agentId: string, prompt: string, shown: { display?: string; attachments?: UserAttachment[] } = {}) {
    const shownFields = { ...(shown.display !== undefined ? { shown: shown.display } : {}), ...(shown.attachments?.length ? { attachments: shown.attachments } : {}) };
    const agent = this.store.agent(agentId);
    const defaults = defaultsReader.resolve(this.store.settings);
    const turnModel = agent.model ?? defaults.model.value;
    const turnEffort = claudeEffort(agent.effort) ?? claudeEffort(defaults.effort.value);
    // 작업 폴더가 사라진 세션(지운 worktree 등)은 프로세스를 띄우기 전에 원인을 알린다. 안 그러면 CLI 가 엉뚱한 실행 오류를 낸다.
    if (!this.runs.has(agentId) && !(await isDirectory(agent.cwd))) {
      this.upsert(agentId, { id: randomUUID(), kind: "user", text: prompt, source: "user", at: new Date().toISOString(), ...shownFields });
      this.upsert(agentId, { id: randomUUID(), kind: "error", text: T.errWorkingDirectoryGone(agent.cwd), auth: false });
      this.store.patchAgent(agentId, { unread: true });
      this.setStatus(agentId, "error");
      return;
    }
    if (agent.imported && this.importHooks) {
      this.preparing.add(agentId);
      try {
        if (await this.importHooks.beforeTurn(agentId)) this.closeRun(agentId);
      } catch (error) {
        console.error("[import] sync before send failed", error);
      } finally {
        this.preparing.delete(agentId);
      }
    }
    // FBREBASE: 피드백 개선 세션에 사용자가 이어서 보내는 턴은 모델이 파일을 읽기 전에 작업 폴더를 본 작업 폴더의 현재 상태에 맞춘다. 모델에게만 가는 안내가 붙으면 modelPrompt 가 달라진다(타임라인에는 사용자가 쓴 글 그대로).
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
    // 메시지에 다른 세션 참조(lodestar://session/...)가 있으면 그 세션의 최근 대화를 모델에게만 덧붙인다(타임라인의 말풍선은 사용자가 쓴 글 그대로).
    if (!agent.feedbackId) {
      const context = sessionContextBlock(prompt, agentId, this.store.agents, (id) => this.store.timeline(id));
      if (context) modelPrompt = `${modelPrompt}\n\n${context}`;
    }
    // 곁다리 창의 답("이 창에서는 쿼리를 돌릴 수 없어요")이 기록에 남아 있어, 옮긴 뒤에도 모델이 그 제한을 따라 했다(사용자 10-27). 첫 턴에 풀렸다고 알린다.
    if (agent.sideAdopted) {
      modelPrompt = `${SIDE_ADOPTED_NOTE}\n\n${modelPrompt}`;
      this.store.patchAgent(agentId, { sideAdopted: false });
    }
    console.log(`[agent] turn ${agentId.slice(0, 8)} model=${turnModel ?? "(cli default)"}${agent.model ? "" : `[${defaults.model.source}]`} effort=${turnEffort ?? "(cli default)"}${agent.effort ? "" : `[${defaults.effort.source}]`} permission=${agent.permissionMode}`);

    // B2: 이 턴의 사용자 메시지 uuid 를 우리가 정해서 SDK 에 보낸다. 세션 기록과 파일 체크포인트가 이 uuid 를 쓰므로, 타임라인 항목이 그대로 복원과 갈래의 열쇠가 된다.
    const messageId = randomUUID();
    // 아래 await 전에 active 를 올려서, 그 사이에 오는 send 가 큐로 가게 한다.
    let run = this.runs.get(agentId);
    let reuse = false;
    if (run) {
      reuse = true;
      this.beginRun(run);
    } else {
      run = this.openRun(agent, turnModel, turnEffort);
    }
    run.turnMessageId = messageId;
    // 새 턴을 보내면 직전 복원의 Redo 는 더 이상 쓸 수 없다.
    void this.clearRedo(agentId).catch((error) => console.error("[agent] redo record not cleared", error));
    this.upsert(agentId, { id: randomUUID(), kind: "user", text: prompt, source: "user", at: new Date().toISOString(), messageId, ...shownFields });
    // B1: 새 턴을 보내면 그 세션을 보고 있다는 뜻이라 안 읽음이 풀리고, 완료 묶음에 있던 세션이면 다시 목록으로 돌아온다.
    if (agent.unread || agent.done) this.store.patchAgent(agentId, { unread: false, done: false });
    this.setStatus(agentId, "running");
    this.boardHooks?.turnStarted(agentId);
    if (agent.feedbackId) this.feedbackHooks?.turnStarted(agentId);

    if (reuse && (run.model !== turnModel || run.effort !== turnEffort || run.permissionMode !== agent.permissionMode)) run = await this.syncSettings(agentId, run, turnModel, turnEffort);
    run.input.push(userMessage(modelPrompt, messageId, undefined, imageBlocks(shown.attachments)));
  }

  // 살아 있는 프로세스의 모델과 effort 를 맞춘다. 실패하면 프로세스를 닫고 같은 세션을 resume 하는 새 프로세스로 바꾼다.
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
      const next = this.openRun(this.store.agent(agentId), model, effort);
      next.turnMessageId = turnMessageId;
      return next;
    }
  }

  // CLI 프로세스를 띄운다. 프롬프트는 닫히지 않는 입력 큐라 세션 동안 같은 프로세스가 메시지를 계속 받는다.
  private openRun(agent: Agent, turnModel: string | null, turnEffort: ClaudeEffortLevel | null): Run {
    const agentId = agent.id;
    // 피드백 개선 세션이면 도구, 권한, 시스템 프롬프트가 그 쪽 옵션으로 바뀐다. 다른 세션은 그대로다.
    const feedbackOptions = agent.feedbackId ? this.feedbackHooks?.options(agent) : null;
    const input = new PushQueue();
    const spawner = groupedSpawner();
    // NOTION2: Notion 쓰기는 이 서버의 제안 도구(승인 카드)만 거친다. 실제 Notion 쓰기 도구는 세션에서 막는다.
    const notionServer = this.notionHooks && !agent.feedbackId && notionServerConfig() ? notionToolServer(this.notionHooks.host(agentId, (toolName, toolInput, preview, signal) => this.askNotionWrite(agentId, toolName, toolInput, preview, signal))) : null;
    const overriddenNotion = notionOverridden() ? notionServerConfig() : null;
    const mcpServers: Record<string, McpServerConfig> = {};
    if (this.browserBridge && !agent.feedbackId) mcpServers[BROWSER_SERVER_NAME] = browserMcpServer(this.browserBridge, () => this.store.settings.browserChatTools, agentId, () => [agent.cwd, join(HOME, "browser-shots"), ...CLAUDE_SCRATCH_ROOTS, ...writtenDirs(this.store.timeline(agentId))]);
    if (notionServer) mcpServers[OWN_SERVER] = notionServer;
    if (overriddenNotion) mcpServers[NOTION_SERVER] = overriddenNotion as McpServerConfig;
    // 프롬프트는 그대로 보낸다. 브라우저 상태 같은 문구를 앞뒤에 붙이지 않는다.
    const q = query({
      prompt: input,
      options: {
        cwd: agent.cwd,
        // 세션 안의 Bash 가 자기 id 를 알고 lodestar CLI 로 다른 세션과 말하게 한다.
        env: { ...claudeEnv(), LODESTAR_SESSION_ID: agentId, LODESTAR_SESSION_REF: sessionRef(agentId) },
        resume: agent.sessionId ?? agent.resumeFrom ?? undefined,
        // B2: 체크포인트를 복원한 세션은 그 지점까지만 이어서, 같은 세션 id 의 새 가지로 진행한다.
        resumeSessionAt: agent.resumeAt ?? undefined,
        enableFileCheckpointing: true,
        // 갈래 세션의 첫 턴: 원 세션을 resume 하되 새 session id 로 갈라진다.
        forkSession: !agent.sessionId && agent.resumeFrom ? true : undefined,
        permissionMode: agent.permissionMode,
        // permbug: 이 플래그가 없으면 Ask Before Edits 로 뜬 프로세스는 나중에 Bypass Permissions 로 바꿀 수 없다(setPermissionMode 가 거절된다). 모드를 켜는 것이 아니라 바꿀 수 있게만 한다.
        allowDangerouslySkipPermissions: true,
        model: turnModel ?? undefined,
        effort: turnEffort ?? undefined,
        // 기본은 CLI 가 정한다(sonnet 5.5 는 생각 텍스트를 비워 보낸다). 시험용으로 summarized 를 강제하면 생각 블록에 텍스트가 온다.
        ...(THINKING_DISPLAY ? { thinking: { type: "adaptive" as const, display: THINKING_DISPLAY } } : {}),
        includePartialMessages: true,
        pathToClaudeCodeExecutable: claudeBin(),
        // FIX6A: CLI 를 자기 프로세스 그룹으로 띄워 종료 때 MCP 서버와 도구 자식까지 한꺼번에 정리한다(server/processGroups.ts).
        spawnClaudeCodeProcess: spawner.spawn,
        systemPrompt: { type: "preset", preset: "claude_code", append: SESSION_PROMPT_APPEND },
        settingSources: ["user", "project", "local"],
        // G7: Browser 도구는 사용자가 탭을 공유하며 이미 허락했으므로 따로 묻지 않는다(공유되지 않은 탭은 BrowserBridge 가 거절한다).
        // Bypass Permissions 를 고른 세션도 CLI 가 자체 안전 검사(복잡한 셸 따옴표, 민감한 경로 등)에 걸린 호출은 여기로 묻는다.
        // 사용자가 모든 호출을 허용하겠다고 고른 모드라 다시 묻지 않고 통과시킨다(사용자 요청). deny 규칙과 훅의 deny 는 CLI 가 먼저 막는다.
        // fixB: 질문과 계획 승인은 Bypass Permissions 에서도 사용자가 답해야 하므로 그 검사보다 먼저 묻는다.
        // NOTION2: Notion 쓰기 도구는 모드와 상관없이 막고(제안 도구로 안내), 제안 도구는 핸들러가 승인 카드를 띄우므로 여기서 한 번 더 묻지 않는다.
        canUseTool: (toolName, input, { signal, toolUseID }) =>
          isBlockedNotionWrite(toolName) && this.notionGate(agentId) !== "apply"
            ? Promise.resolve({ behavior: "deny" as const, message: BLOCKED_NOTION_WRITE_MESSAGE })
            : classifyTool(toolName) === "own"
              ? Promise.resolve({ behavior: "allow" as const, updatedInput: input })
              : !isInteractiveTool(toolName) && ((isBrowserToolName(toolName) && !browserToolNeedsApproval(toolName, input)) || this.store.agent(agentId).permissionMode === "bypassPermissions")
                ? Promise.resolve({ behavior: "allow" as const, updatedInput: input })
                : this.askPermission(agentId, toolName, input, signal, toolUseID),
        ...(Object.keys(mcpServers).length ? { mcpServers } : {}),
        // NOTION2: 알려진 Notion 쓰기 도구를 도구 목록에서 뺀다. 목록에 없는 이름은 아래 PreToolUse 훅이 막는다. 시험 인스턴스(AGENT_NAV_NOTION_MCP)는 가짜 서버 하나만 연결한다.
        // NOTION3: 설정이 "apply" 면 Bypass Permissions 에서 직접 쓰기 도구도 열려야 하는데 이 목록은 프로세스가 사는 동안 바뀌지 않는다. 그래서 "apply" 일 때는 목록에서 빼지 않고 아래 훅이 지금 모드로 판정한다.
        disallowedTools: this.store.settings.notionBypassWrites === "apply" ? [] : notionDisallowedTools(),
        ...(overriddenNotion ? { strictMcpConfig: true } : {}),
        hooks: {
          PreToolUse: [
            {
              // NOTION2: 어떤 서버 이름으로 붙었든 Notion 쓰기 도구(읽기 목록에 없는 Notion 도구)는 모드와 상관없이 거절한다. 오류가 나도 거절이다.
              matcher: "mcp__.*",
              hooks: [
                async (input) => this.guardNotionWrite(agentId, input),
              ],
            },
            {
              // SDK 호스트의 init 메시지에는 effort 가 없다. 도구 호출 훅 입력에는 실제 적용된 effort 가 오므로 여기서 받는다.
              hooks: [
                async (input) => {
                  const level = input.effort?.level as EffortLevel | undefined;
                  if (level && this.store.agent(agentId).activeEffort !== level) {
                    this.emit({ type: "agent", agent: this.store.updateAgent(agentId, { activeEffort: level }) });
                  }
                  // permbug: CLI 가 스스로 바꾼 모드(계획 승인 뒤 등)면 칩이 실제 값을 따라가게 저장값을 맞춘다. 방금 우리가 바꾼 값과 겹치지 않게 바꾼 직후 2초는 건너뛴다.
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
              // 기준 커밋이 없는 폴더에서는 수정 직전 내용이 변경 패널의 기준이다. 편집 도구가 파일을 쓰기 전에 남긴다.
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
                  // FIX4A: 이 세션의 에이전트가 만진 파일 장부(Session 범위와 Undo 의 근거)에 수정 직전 내용을 남긴다.
                  await recordBeforeEdit(agent, this.store, input.tool_name, toolInput).catch((error) => console.error("[touched] before failed", error));
                  return {};
                },
              ],
            },
            {
              // ASIDEVIEW: Bash 가 사용자의 포커스와 입력을 뺏지 않게 한다. open 에는 -g 를 붙이고, 앱 활성화와 입력 주입은 막는다. 권한 모드와 상관없이 훅으로 건다(Bypass 에서는 canUseTool 이 안 불린다).
              matcher: "Bash",
              hooks: [async (input) => this.guardFocus(agentId, input)],
            },
            {
              // FIX4A: Bash 로 바뀐 파일은 턴 끝에 귀속한다. 이 턴에서 Bash 를 불렀다는 표시만 남긴다.
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
      },
    });
    const run: Run = { query: q, input, draftId: null, active: true, interrupted: false, turnMessageId: null, steers: new Set(), model: turnModel, effort: turnEffort, permissionMode: agent.permissionMode, permissionSetAt: 0, idleTimer: null, idleSince: Date.now(), lastUsed: Date.now(), closed: false, apiError: false, approvalWaitMs: 0, stopWatch: null, ctxSeq: 0, stderrTail: spawner.stderrTail };
    run.stopWatch = watchDirectory(agent.cwd, () => this.workingDirectoryGone(agentId, run));
    this.runs.set(agentId, run);
    // 정리 도중의 예외(저장 실패 등)가 잡히지 않은 거절로 올라가면 데몬이 통째로 죽어 다른 세션의 턴까지 끊긴다
    void this.consume(agentId, run).catch((error) => console.error("[agent] session cleanup failed", error));
    return run;
  }

  // 프로세스가 내보내는 메시지를 끝까지 읽는다. 턴 경계는 result 가 알려 준다(handleMessage). 반복문이 끝나는 것은 프로세스가 닫혔다는 뜻이다.
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
      // 우리가 닫은 프로세스(closeRun)는 이미 정리됐다.
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

  // 데몬이 뜰 때 응답 중으로 남아 있던 세션을 끊긴 것으로 표시한다. 피드백 개선 세션은 자기 복구(server/feedback.ts)가 있어 건드리지 않는다.
  markCutOff(agentId: string) {
    const agent = this.store.agents.find((a) => a.id === agentId);
    if (!agent || agent.feedbackId) return;
    // 끊긴 턴이 남긴 실행 중 도구와 답을 기다리던 승인은 받을 프로세스가 없다. 그대로 두면 다시 뜬 화면이 도는 표시와 승인 카드를 계속 띄우고, 카드를 누르면 오류가 난다.
    this.settleRunningTools(agentId, true);
    for (const item of this.store.timeline(agentId)) {
      if (item.kind === "permission" && item.status === "pending") this.upsert(agentId, { ...item, status: "denied" });
    }
    this.upsert(agentId, { id: randomUUID(), kind: "error", text: harnessOf(agent) === "codex" ? this.codex.cutOffText() : T.daemonStoppedMidReply, auth: false });
    this.store.updateAgent(agentId, { status: "error", unread: true });
  }

  // 프로세스를 닫는다. 진행 중인 턴이 있으면 그 상태 정리는 부르는 쪽이 한다.
  private closeRun(agentId: string) {
    const run = this.runs.get(agentId);
    if (!run) return;
    run.closed = true;
    run.stopWatch?.();
    if (run.idleTimer) clearTimeout(run.idleTimer);
    this.runs.delete(agentId);
    run.input.close();
    run.query.close();
    // 폴더를 목록에서 뺄 때(workspaces.remove)는 세션이 이미 목록에서 빠진 뒤에 프로세스를 닫는다. 목록에 없는 세션은 되돌릴 큐도 갱신할 항목도 없다(던지면 폴더 빼기가 반쯤 끝난 채 오류로 보인다).
    if (!this.store.agents.some((a) => a.id === agentId)) return;
    this.requeueSteering(agentId);
    // SUB: 프로세스와 함께 그 안에서 돌던 서브에이전트도 끝났다
    this.stopTasks(agentId);
  }

  // FIX4A: result 없이 끝난 턴(프로세스 종료, 강제 중단, 작업 폴더 사라짐)도 변경 장부의 턴을 닫는다. 열린 채로 두면 같은 저장소의 다른 세션이 계속 "겹친 턴" 으로 판정돼 Bash 로 바꾼 파일을 자기 변경으로 세지 못한다.
  private endTouch(agentId: string) {
    void endTouchTurn(this.store.agent(agentId), this.store).then(() => this.emit({ type: "changes", agentId, changes: this.store.changes(agentId) }), (error) => console.error("[touched] end turn failed", error));
  }

  // SUB: 도는 것으로 남은 서브에이전트를 멈춘 것으로 바꾼다(프로세스가 닫혔는데 task_notification 을 못 받은 경우).
  private stopTasks(agentId: string) {
    const now = new Date().toISOString();
    for (const item of this.store.timeline(agentId)) {
      if (item.kind === "tool" && item.task?.status === "running") this.upsert(agentId, stopTask(item, now));
    }
  }

  // 유휴 프로세스를 오래 들고 있지 않는다(세션 11개에 CLI 11개 3.2GB 였다). 한도는 keepIdleSessionsWarmMinutes.
  // 진행 중인 턴, 백그라운드 작업, 칸에 열려 있는 세션은 유휴로 세지 않는다: 그 동안 idleSince 를 계속 지금으로 밀어서, 닫히는 건 마지막으로 쓰이거나 보인 뒤 한도가 지났을 때다.
  private armIdleClose(agentId: string, run: Run) {
    if (run.idleTimer) clearTimeout(run.idleTimer);
    run.idleSince = Date.now();
    run.lastUsed = run.idleSince;
    this.scheduleIdleCheck(agentId, run);
    this.enforceWarmCap();
  }

  // PERFDAEMON: 쉬는 프로세스가 한도(maxWarmSessions)를 넘으면 가장 오래전에 쓴 것부터 닫는다. 턴이 끝나 쉬는 세션이 하나 늘 때, 설정이 바뀔 때 부른다.
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

  // 0 은 닫지 않음. 설정을 바꾸면 이미 걸려 있는 타이머가 다음 확인 때 새 한도를 읽는다.
  private idleLimitMs() {
    return IDLE_CLOSE_ENV_MS || this.store.settings.keepIdleSessionsWarmMinutes * 60_000;
  }

  // 창(웹소켓 연결)마다 칸에 열려 있는 세션. 열린 세션은 유휴로 닫지 않는다.
  private openByClient = new Map<unknown, Set<string>>();

  setOpenAgents(client: unknown, agentIds: string[]) {
    this.openByClient.set(client, new Set(agentIds));
  }

  dropOpenAgents(client: unknown) {
    this.openByClient.delete(client);
  }

  // PERFDAEMON: 이 세션의 타임라인을 메모리에서 내리면 안 되는가: 프로세스가 있거나, 응답 중이거나, 칸에 열려 있다
  isLive(agentId: string) {
    const status = this.store.agents.find((a) => a.id === agentId)?.status;
    return this.runs.has(agentId) || this.codex.isLive(agentId) || status === "running" || status === "waiting" || this.isOpen(agentId);
  }

  private isOpen(agentId: string) {
    for (const ids of this.openByClient.values()) if (ids.has(agentId)) return true;
    return false;
  }

  // 설정이 켜지거나 한도가 바뀌면 유휴로 쉬고 있는 프로세스의 타이머를 새 한도로 다시 건다.
  rearmIdleCloses() {
    for (const [agentId, run] of this.runs) {
      if (run.active || run.closed) continue;
      if (run.idleTimer) clearTimeout(run.idleTimer);
      this.scheduleIdleCheck(agentId, run);
    }
  }

  // 유휴였던 프로세스가 턴을 시작한다(사용자 메시지, 또는 백그라운드 작업이 끝난 뒤 CLI 가 스스로 연 턴).
  private beginRun(run: Run) {
    run.lastUsed = Date.now();
    run.active = true;
    run.interrupted = false;
    run.apiError = false;
    if (run.idleTimer) clearTimeout(run.idleTimer);
    run.idleTimer = null;
  }

  // 턴 하나가 끝났다(result 에 더 이어질 턴이 없을 때). 정상 종료면 큐의 맨 앞 메시지를 이어서 보낸다. 중단과 오류는 큐를 그대로 둔다.
  private finishTurn(agentId: string, run: Run, outcome: "ok" | "error" | "interrupted") {
    run.active = false;
    run.interrupted = false;
    run.turnMessageId = null;
    // FIX4A: 중단과 오류로 끝난 턴도 장부를 마무리한다(요약 카드를 만든 턴은 이미 끝나 있어 아무 일도 안 한다)
    void endTouchTurn(this.store.agent(agentId), this.store).then(() => this.emit({ type: "changes", agentId, changes: this.store.changes(agentId) }), (error) => console.error("[touched] end turn failed", error));
    // 중단되거나 오류로 끝난 턴이 쌓은 승인 대기 시간이 다음 턴의 경과 시간에서 빠지지 않게 비운다
    run.approvalWaitMs = 0;
    // 턴이 정상으로 끝났다면 남은 끼어들기 메시지는 이미 모델이 받은 것(result 가 uuid 를 안 주는 옛 CLI)이라 대화에 넣고, 중단이나 오류면 취소된 것이라 큐로 돌려보낸다.
    if (outcome === "ok") this.foldSteers(agentId, [...run.steers]);
    else this.requeueSteering(agentId);
    run.steers.clear();
    this.clearDraft(agentId, run);
    // B2: 끝나지 못한 도구 호출이 running 으로 남지 않게 한다.
    this.settleRunningTools(agentId, outcome === "interrupted");
    // 문장이 중간에서 끊긴 채 끝나므로, 중단했다는 흐린 한 줄을 턴 끝에 남긴다.
    if (outcome === "interrupted") this.upsert(agentId, { id: randomUUID(), kind: "notice", text: T.stopped });
    this.setStatus(agentId, run.apiError && outcome !== "interrupted" ? "error" : "idle");
    // B1: 턴이 끝났다(정상, 중단, 오류 모두). 웹이 그 세션을 보고 있지 않으면 사이드바에 안 읽음 점이 남는다.
    this.store.updateAgent(agentId, { unread: true });
    this.emit({ type: "agent", agent: this.store.agent(agentId) });
    const agent = this.store.agent(agentId);
    if (agent.feedbackId) this.feedbackHooks?.afterTurn(agentId);
    // 오류로 끝난 턴은 검토할 결과가 아니라서 Review 로 보내지 않는다.
    if (agent.status !== "error") {
      this.clearCarry(agentId);
      this.boardHooks?.turnEnded(agentId);
    }
    this.armIdleClose(agentId, run);
    if (agent.imported) this.importHooks?.turnEnded(agentId);
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
    if (this.isCodex(agentId)) return this.codex.interrupt(agentId);
    const run = this.runs.get(agentId);
    if (!run?.active) return;
    const steered = run.steers.size > 0;
    run.interrupted = true;
    // 중단된 턴의 result 가 오지 않으면 프로세스를 닫아서라도 멈춘 상태로 남기지 않는다.
    // 중단 요청을 보내기 전에 건다: 제어 채널이 막힌 프로세스는 요청에 답하지 않아서, 답을 기다린 뒤에 걸면 타이머가 영영 안 걸리고 세션이 응답 중으로 남는다.
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
    // 요청이 거절되는 경우(프로세스가 이미 끝남, 위 타이머가 닫음)는 consume 과 타이머가 턴을 정리한다.
    await stopEverything(run.query).catch((error) => console.error("[agent] interrupt request failed", error));
  }

  // permbug: 살아 있는 프로세스에 먼저 적용하고, 됐을 때만 저장하고 알린다(예전에는 저장부터 해서 프로세스가 거절하면 저장값과 실제 모드가 어긋났다).
  // 응답 중에 거절되면 그 이유를 그대로 올려 화면이 보여 준다. 유휴 프로세스가 거절하면 프로세스를 닫아서, 다음 턴이 저장한 모드로 새로 뜨게 한다.
  async setPermissionMode(agentId: string, mode: PermissionMode) {
    // CODEX: 모드는 다음 턴의 approvalPolicy, sandbox 로 옮겨 간다(shared/codexPermission.ts). Codex 에 없는 모드는 고를 수 없다.
    if (this.isCodex(agentId)) {
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

  // 제어 채널이 막힌 프로세스는 응답을 안 준다. 그대로 기다리면 칩이 아무 표시 없이 안 바뀌므로, 정해진 시간 안에 못 받으면 실패로 보고 위의 거절 경로로 보낸다.
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

  // 모델과 effort 는 다음 턴의 query() 옵션으로 들어간다. 실행 중인 턴은 바꾸지 않는다.
  setModel(agentId: string, model: string | null) {
    this.emit({ type: "agent", agent: this.store.updateAgent(agentId, { model }) });
  }

  setEffort(agentId: string, effort: EffortLevel | null) {
    this.emit({ type: "agent", agent: this.store.updateAgent(agentId, { effort }) });
  }

  // B1: 사이드바 행 동작. updatedAt 을 올리지 않는다(정렬과 "2 mins ago" 가 마지막 활동 기준으로 남도록).
  setRead(agentId: string, read: boolean) {
    this.emit({ type: "agent", agent: this.store.patchAgent(agentId, { unread: !read }) });
  }

  setPinned(agentId: string, pinned: boolean) {
    this.emit({ type: "agent", agent: this.store.patchAgent(agentId, { pinned }) });
  }

  setDone(agentId: string, done: boolean) {
    this.emit({ type: "agent", agent: this.store.patchAgent(agentId, done ? { done } : { done, reopenedAt: new Date().toISOString() }) });
  }

  // AUTODONE: 마지막 활동에서 3일이 지난 세션을 Done 으로 넘긴다. 넘긴 세션 수를 돌려준다.
  autoDone(now = Date.now()) {
    const stale = this.store.agents.filter((agent) => isAutoDoneDue(agent, now));
    for (const agent of stale) this.emit({ type: "agent", agent: this.store.patchAgent(agent.id, { done: true }) });
    return stale.length;
  }

  // 제목은 첫 프롬프트로 만든 값이 기본이고, 이름을 바꾸면 그 값으로 덮인다. 빈 이름은 받지 않는다.
  rename(agentId: string, title: string) {
    const next = typeof title === "string" ? title.replace(/\s+/g, " ").trim() : "";
    if (!next) throw new Error(T.errEmptyTitle);
    this.emit({ type: "agent", agent: this.store.patchAgent(agentId, { title: next.slice(0, 200) }) });
  }

  respondPermission(agentId: string, itemId: string, decision: PermissionDecision) {
    if (this.codex.hasApproval(agentId, itemId)) return this.codex.respond(agentId, itemId, decision);
    const pending = this.pending.get(`${agentId}:${itemId}`);
    if (!pending) throw new Error(T.errPermissionHandled);
    // fixB: 질문과 계획 승인에는 한 번 허용이 없다. 알림이나 사이드바의 허용으로는 답할 수 없고, 넘기기(deny)만 받는다.
    if ((isInteractiveTool(pending.toolName) || isNotionProposeTool(pending.toolName)) && decision !== "deny") throw new Error(T.errNeedsAnswer);
    pending.resolve(decision);
  }

  // NOTION3: 이 세션의 Notion 쓰기를 지금 카드 없이 반영할지. 저장된 권한 모드를 그때그때 읽으므로, 세션 도중 모드를 바꾸면 다음 쓰기부터 따른다. 피드백 개선 세션은 늘 "ask" 다.
  private notionGate(agentId: string): NotionWriteGate {
    const agent = this.store.agent(agentId);
    return agent.feedbackId ? "ask" : notionWriteGate(agent.permissionMode, this.store.settings.notionBypassWrites);
  }

  // NOTION3: 에이전트 세션의 PreToolUse 훅. Notion 직접 쓰기 도구는 Bypass Permissions 이고 설정이 "apply" 일 때만 통과하고, 통과시킨 호출은 대화에 기록 줄을 남긴다.
  // CLI 가 훅 입력에 싣는 permission_mode 도 Bypass 여야 한다(저장값이 바뀌기 직전에 CLI 가 먼저 모드를 바꾼 틈을 막는다).
  private guardNotionWrite(agentId: string, input: Parameters<typeof notionWriteGuard>[0] & { tool_input?: unknown; permission_mode?: unknown }) {
    let allowDirect = false;
    try {
      allowDirect = this.notionGate(agentId) === "apply" && (input.permission_mode === undefined || input.permission_mode === "bypassPermissions");
    } catch {
      // 판정이 실패하면 막는다
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

  // ASIDEVIEW: Bash 명령의 포커스 가드(server/focusGuard.ts). 고치면 updatedInput 으로 바뀐 명령을 돌려주고(허용 여부는 CLI 의 다음 판정에 맡긴다), 막으면 이유를 모델에 돌려준다. 어떤 예외가 나도 명령은 그대로 통과한다.
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

  // 알림 줄을 남기지 못해도(세션이 이미 없는 경우 등) 가드의 판정은 그대로 나간다.
  private note(agentId: string, text: string, label: string, body: string) {
    try {
      this.upsert(agentId, { id: randomUUID(), kind: "notice", text, fold: { label, text: body.slice(0, 4000) } });
    } catch (error) {
      console.error("[focusguard] notice failed", error);
    }
  }

  // NOTION3: 카드가 떠 있는 동안 권한 모드나 설정이 바뀌어 이제 카드 없이 반영해도 되면 그 카드를 승인한 것으로 닫는다. agentId 가 없으면 모든 세션이 대상이다.
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

  // NOTION2: Notion 쓰기 제안 카드의 결정. 승인하면 제안 도구 핸들러가 그 내용 그대로 데몬의 쓰기 세션을 한 번 부르고, 아니면 아무것도 보내지 않는다.
  respondNotionWrite(agentId: string, itemId: string, apply: boolean, feedback?: string) {
    const pending = this.pending.get(`${agentId}:${itemId}`);
    if (!pending) throw new Error(T.errPermissionHandled);
    if (!isNotionProposeTool(pending.toolName)) throw new Error(T.errNeedsAnswer);
    if (apply) pending.settle({ behavior: "allow", updatedInput: pending.input });
    else pending.settle({ behavior: "deny", message: feedback?.trim() ?? "" });
  }

  // NOTION2: 제안 도구 핸들러가 부른다. 승인 카드를 띄우고 사용자의 결정을 기다린다. 중단하거나 세션이 닫히면 거절이다.
  private async askNotionWrite(agentId: string, toolName: string, input: Record<string, unknown>, preview: NotionWritePreview, signal?: AbortSignal) {
    // 같은 도구 호출의 진행 줄과 승인 항목이 대화에서 한 줄로 합쳐지게, 아직 승인 항목이 없는 실행 중 호출의 id 를 잇는다.
    const items = this.store.timeline(agentId);
    const call = [...items].reverse().find((i) => i.kind === "tool" && i.name === toolName && i.status === "running" && !items.some((p) => p.kind === "permission" && p.toolUseId === i.id));
    // NOTION3: Bypass Permissions 이고 설정이 "apply" 면 카드를 기다리지 않는다. 처리된 승인 항목을 바로 만들어, 대화에 같은 diff 가 든 "Applied to Notion" 줄로 남긴다.
    if (this.notionGate(agentId) === "apply") {
      this.upsert(agentId, { id: randomUUID(), kind: "permission", toolUseId: call?.id, toolName, input, status: "allowed", notion: preview, auto: true });
      return { allowed: true as const };
    }
    const result = await this.askPermission(agentId, toolName, input, signal ?? new AbortController().signal, call?.id, preview);
    if (result.behavior === "allow") return { allowed: true as const };
    return { allowed: false as const, feedback: result.message === T.permissionDeniedByUser ? undefined : result.message };
  }

  // fixB: AskUserQuestion 카드의 답. answers 가 null 이면 답 없이 넘긴다.
  answerQuestion(agentId: string, itemId: string, answers: Record<string, string> | null) {
    const pending = this.pending.get(`${agentId}:${itemId}`);
    if (!pending) throw new Error(T.errPermissionHandled);
    if (pending.toolName !== QUESTION_TOOL) throw new Error(T.errNeedsAnswer);
    const { result, answers: clean } = questionResult(pending.input, answers);
    pending.settle(result, { answers: clean });
  }

  // fixB: ExitPlanMode 카드의 결정. 진행이면 권한 모드를 바꾸고(실행 중인 프로세스와 세션 기록의 모드를 같은 순간에 맞춘다), 아니면 글과 함께 계속 계획하게 한다.
  respondPlan(agentId: string, itemId: string, decision: { approve: true; mode: "acceptEdits" | "default" } | { approve: false; feedback?: string }) {
    const pending = this.pending.get(`${agentId}:${itemId}`);
    if (!pending) throw new Error(T.errPermissionHandled);
    if (pending.toolName !== PLAN_TOOL) throw new Error(T.errNeedsAnswer);
    if (decision.approve) {
      const run = this.runs.get(agentId);
      // 실행 중인 프로세스가 기억하는 모드를 먼저 맞춘다. 안 그러면 다음 메시지에서 "저장된 모드와 다르다" 고 보고 plan 으로 되돌려 보낸다.
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

  // worktree 는 사용자가 고른 경우에만, 변경이 남아 있지 않을 때만 지운다 (--force 없음).
  async remove(agentId: string, removeWorktree: boolean) {
    const agent = this.store.agent(agentId);
    const run = this.runs.get(agentId);
    await this.interrupt(agentId);
    this.closeRun(agentId);
    await this.codex.remove(agentId);
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
      // worktree 를 지우지 못해 세션이 남는다(변경이 남은 worktree 등). 프로세스는 위에서 이미 닫았으니 응답 중으로 남기지 않는다.
      if (run) this.clearDraft(agentId, run);
      this.settleRunningTools(agentId, true);
      this.endTouch(agentId);
      if (agent.status === "running" || agent.status === "waiting") this.setStatus(agentId, "idle");
      throw error;
    }
    const workspaceId = agent.workspaceId;
    this.store.removeAgent(agentId);
    void dropRedo(agentId).catch((error) => console.error("[agent] redo record not removed", error));
    this.emit({ type: "agentRemoved", agentId });
    this.boardHooks?.removed(agentId);
    if (workspaceId) this.store.removeWorkspaceIfUnused(workspaceId);
    // B6: 폴더 없는 세션의 임시 폴더는 비어 있을 때만 치운다(에이전트가 만든 파일이 있으면 남긴다).
    else removeEmptyDir(agent.cwd);
    this.emit({ type: "workspaces", workspaces: this.store.workspaces });
  }

  // --- B2: 체크포인트 ---

  // 그 사용자 메시지를 보내기 직전으로 파일과 대화를 되돌린다. 입력창에 다시 채울 그 메시지의 글과 되돌린 파일 수를 돌려준다.
  // 순서: 메시지 uuid 확인(없으면 글로 짝짓기) -> dryRun 으로 바뀔 파일 확인 -> 그 파일들의 지금 내용을 Redo 용으로 저장 -> 실제 되돌리기 -> 타임라인과 세션 위치 조정.
  // 파일 스냅샷이 없는 메시지(체크포인트 이전에 보낸 것)는 dryRun 이 스냅샷 없음으로 답하고, 그때는 파일을 건드리지 않고 대화만 그 지점으로 자른다.
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
      // B3: 세션 프로세스가 같은 기록을 열고 있으면 되돌리는 쿼리와 겹치고, 복원 뒤 위치(resumeAt)는 프로세스를 새로 띄울 때만 먹는다.
      this.closeRun(agentId);
      const files = await withRewindQuery(agent, async (rewind) => {
        const preview = await rewind(messageId, true);
        const plan = checkpointMode(messageId, preview);
        if (plan.mode === "none") throw new Error(T.errCannotRewind(plan.reason ?? "unknown"));
        if (plan.mode === "chat") return { count: 0, before: {}, chatOnly: true, restoredHash: {}, trashed: 0, reverted: 0, skipped: [] as RestoreSkip[] };
        const changed = preview.filesChanged ?? [];
        if (this.restoreCancelled.has(agentId)) throw new Error(T.errRestoreCancelled);
        // FIX5-0: 에이전트의 마지막 쓰기 뒤 바뀐 파일은 건드리지 않고, 에이전트가 새로 만든 파일은 휴지통으로 보낸다. 서버가 직접 가르므로 화면을 거치지 않는 호출도 같다.
        const filePlan = await planRestore(agent, this.store, changed, split.kept);
        const touched = [...filePlan.revert, ...filePlan.remove].map((f) => f.path);
        // 복원이 디스크를 덮어쓰기 전의 내용. Redo 가 이 내용을 다시 쓴다.
        const before = await readRaw(agent, touched);
        // Redo 기록은 파일을 되돌리기 전에 먼저 디스크에 쓴다. 되돌린 뒤에 쓰다 실패하면(디스크 가득 등) 복원 전 내용이 메모리에서 사라지고, 파일은 되돌려졌는데 대화는 그대로인 상태가 남는다.
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
      // 파일을 되돌린 복원은 위에서 이미 기록을 남겼다. 해시를 더해 다시 쓰지 못해도 복원은 끝까지 간다(해시 없는 기록은 Redo 가 검사 없이 쓴다).
      const redoSaved = saveRedo(agentId, { ...redoBase, files: files.before, restoredHash: files.restoredHash, chatOnly: files.chatOnly });
      await (files.chatOnly ? redoSaved : redoSaved.catch((error) => console.error("[agent] redo record not updated", error)));
      for (const removed of split.removed) {
        this.store.removeItem(agentId, removed.id);
        this.emit({ type: "timelineRemove", agentId, itemId: removed.id });
      }
      this.upsert(agentId, { id: randomUUID(), kind: "restored", redoable: true, chatOnly: files.chatOnly || undefined });
      // 첫 메시지(Start Over)는 남길 앞부분이 없으니 새 세션으로 시작한다. 옛 세션 기록은 Redo 를 위해 그대로 둔다.
      const carry = carryAfterCut(split.kept, this.store.agent(agentId).seenThrough);
      this.emit({ type: "agent", agent: this.store.updateAgent(agentId, { ...(kept === null ? { sessionId: null, resumeFrom: null, resumeAt: null } : { resumeAt: kept }), ...carry }) });
      this.emit({ type: "changes", agentId, changes: this.store.changes(agentId) });
      return { text: item.shown ?? item.text, files: files.count, chatOnly: files.chatOnly, reverted: files.reverted, removed: files.trashed, skipped: files.skipped };
    } finally {
      this.restoring.delete(agentId);
      this.restoreCancelled.delete(agentId);
      this.markOwnWrite(agentId);
    }
  }

  // 복원이 되돌릴 파일 수. 파일을 건드리지 않는 dryRun 이고 응답 중에는 checkpointModes 와 같은 이유로 거절한다.
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
      // FIX5-0: 확인 창이 파일 이름을 세 갈래(되돌림, 휴지통, 건너뜀)로 보이도록 복원과 같은 계획을 돌려준다
      const plan = await planRestore(agent, this.store, preview.filesChanged ?? [], split.kept);
      return { files: plan.revert.length + plan.remove.length, plan };
    });
    this.markOwnWrite(agentId);
    return result;
  }

  // messageId 없는 사용자 항목별 복원 범위(화면이 버튼 문구를 정하는 데 쓴다). 응답 중에는 기록을 여는 쿼리가 실제 프로세스와 겹치므로 거절한다.
  async checkpointModes(agentId: string) {
    // CODEX: 체크포인트가 없는 세션이라 복원 범위를 묻지 않는다(화면도 Codex 세션에서는 묻지 않는다)
    if (this.isCodex(agentId)) return {};
    const agent = this.store.agent(agentId);
    if (this.runs.get(agentId)?.active || agent.status === "waiting" || this.restoring.has(agentId)) throw new Error(T.errAgentRunning);
    const modes = await probeCheckpointModes(agent, this.store.timeline(agentId));
    this.markOwnWrite(agentId);
    return modes;
  }

  // 실제 되돌리기 전에만 멈출 수 있다. 시작한 되돌리기는 끝까지 간다.
  cancelRestore(agentId: string) {
    if (this.restoring.has(agentId)) this.restoreCancelled.add(agentId);
  }

  async redoCheckpoint(agentId: string) {
    this.assertClaude(agentId, "Restore checkpoint");
    const agent = this.store.agent(agentId);
    if (this.runs.get(agentId)?.active || agent.status === "waiting" || this.restoring.has(agentId)) throw new Error(T.errAgentRunning);
    // 파일을 다시 쓰고 세션 위치를 옮기는 동안 들어오는 전송은 복원과 같이 거절한다(send). 막지 않으면 그 사이에 보낸 메시지가 옛 위치에서 프로세스를 띄우고, 이어서 여기서 바꾸는 세션 위치와 어긋난다.
    this.restoring.add(agentId);
    try {
      const redo = await loadRedo(agentId);
      if (!redo) throw new Error(T.errNothingToRedo);
      this.closeRun(agentId);
      // FIX5-0: 복원 뒤 바뀐 파일은 덮어쓰지 않는다
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

  // 턴이 끝났는데 running 으로 남은 도구 호출(중단된 호출)을 끝난 상태로 바꾼다.
  private settleRunningTools(agentId: string, cancelled: boolean) {
    for (const item of this.store.timeline(agentId)) {
      if (item.kind !== "tool" || item.status !== "running") continue;
      this.upsert(agentId, { ...item, status: "error", cancelled: cancelled || undefined });
    }
  }

  // 마지막 턴이 바꾼 파일 요약. 변경이 없거나 읽지 못하면 undefined.
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

  // Browser 도구 호출이 가리키는 페이지의 호출 시점 제목과 주소. 타임라인 줄의 페이지 칩이 이 값을 쓴다(나중에 탭 제목이 바뀌어도 그대로다).
  private browserCallPage(agentId: string, input: Record<string, unknown>): { page?: { title: string; url: string } } {
    const bridge = this.browserBridge;
    if (!bridge) return {};
    const pages = bridge.pagesFor(agentId).map((m) => m.page);
    const page = typeof input.pageId === "string" ? pages.find((p) => p.pageId === input.pageId) : pages.length === 1 ? pages[0] : undefined;
    return page ? { page: { title: page.title || page.url, url: page.url } } : {};
  }

  // Browser 도구 결과의 스크린샷은 파일로 남겨 타임라인 썸네일로 쓰고, open_browser_page 가 연 페이지는 결과의 Page ID 로 칩 제목을 정한다.
  private async browserResultExtras(agentId: string, toolName: string, content: unknown): Promise<{ shots?: string[]; page?: { title: string; url: string } }> {
    const out: { shots?: string[]; page?: { title: string; url: string } } = {};
    const parts = Array.isArray(content) ? (content as { type?: string; source?: { data?: string } }[]) : [];
    const shots: string[] = [];
    for (const part of parts) {
      if (part?.type !== "image" || typeof part.source?.data !== "string") continue;
      try {
        shots.push((await saveBrowserShot(part.source.data, join(HOME, "tool-shots"), 200)).path);
      } catch {
        // 저장하지 못해도 도구 결과는 그대로 둔다
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

  // ASIDEVIEW: Aside 도구 결과의 이미지는 파일로 남겨 타임라인 썸네일로 쓴다(결과 글에는 경로만 있다).
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
      // 사용자가 정한 결과를 SDK 에 돌려주고 타임라인의 승인 항목을 닫는다. outcome 은 질문의 답이나 계획 승인의 선택이다(대화에 남는다).
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
        // 같은 세션의 다른 승인이 아직 떠 있으면 계속 기다리는 상태다(먼저 답한 하나가 "응답 중" 으로 바꾸면 남은 카드가 사이드바에서 가려진다).
        // 턴이 끝난 뒤 백그라운드 작업이 물은 승인이면 돌아갈 턴이 없으니 유휴로 되돌린다(그대로 두면 다음 메시지를 보낼 때까지 승인 대기로 남는다).
        // 프로세스가 닫히면서 정리되는 승인(run 이 없다)은 닫는 쪽이 상태를 정한다. 데몬이 끝날 때는 승인 대기로 남아야 다음 시작이 끊긴 세션으로 표시한다.
        if (![...this.pending.keys()].some((other) => other.startsWith(`${agentId}:`))) {
          if (run?.active) this.setStatus(agentId, "running");
          else if (run && this.store.agents.find((a) => a.id === agentId)?.status === "waiting") this.setStatus(agentId, "idle");
        }
        resolve(result);
      };
      const finish = (decision: PermissionDecision) => {
        // 질문을 넘기면 "답하지 않았다" 는 결과로, 계획 승인을 넘기면 계속 계획하게 한다. 그 밖의 도구는 허용 또는 거절이다.
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
          // 항상 허용은 이 세션 안에서 같은 도구 호출을 다시 묻지 않게 한다. 파일 편집 도구는 넷이 한 묶음이다(server/permissionRules.ts).
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
    // 끼어들기 메시지는 CLI 가 그 명령을 시작했다고 알리는 순간(command_lifecycle started) 모델이 받은 것이다. 이때 Steering 표시를 대화의 말풍선으로 옮긴다.
    // 이 프레임은 SDK 타입 선언에 없어서 모양을 직접 읽는다: { command_uuid, state: "queued" | "started" | "completed" | "cancelled" }.
    if ((message.type as string) === "command_lifecycle") {
      const frame = message as unknown as { command_uuid?: string; state?: string };
      if (frame.state === "started" && frame.command_uuid) this.foldSteers(agentId, [frame.command_uuid]);
      // QUEUECANCEL: 우리가 거둔 끼어들기가 CLI 에서도 취소됐다는 알림. 이미 run.steers 에서 뺐으니 할 일이 없다. 중단으로 CLI 가 취소한 것은 Steering 표시에 남아 있고 finishTurn 이 큐로 돌려보낸다.
      if (frame.state === "cancelled" && frame.command_uuid && !this.store.agent(agentId).steering?.some((s) => s.id === frame.command_uuid)) run.steers.delete(frame.command_uuid);
      return;
    }
    // B3: 유휴인데 모델 쪽 메시지가 오면 CLI 가 스스로 연 턴이다(백그라운드 작업 완료 알림 뒤의 이어가기). 사용자가 보내지 않은 턴도 진행 상태로 보여 준다(버그 12).
    if (!run.active && !run.closed && (message.type === "stream_event" || message.type === "assistant" || message.type === "user") && !message.parent_tool_use_id && !isControlEcho(message)) {
      this.beginRun(run);
      this.setStatus(agentId, "running");
    }
    switch (message.type) {
      case "system": {
        this.handleSystem(agentId, message);
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
            // API 오류(model_not_found 등)는 CLI 가 어시스턴트 글처럼 보내므로 오류 항목으로 바꿔 올린다.
            this.clearDraft(agentId, run);
            run.apiError = true;
            this.upsert(agentId, { id, kind: "error", text: block.text, auth: AUTH_API_ERRORS.has(message.error) });
          } else if (block.type === "text") {
            this.clearDraft(agentId, run);
            this.upsert(agentId, { id, kind: "assistant", text: block.text, streaming: false, at: new Date().toISOString(), model: message.message.model });
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
              // SUB: Agent 호출은 task_started 가 오기 전부터 서브에이전트 현황을 갖는다
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
        // 중단과 모델 바꾸기 같은 제어 동작의 안내 프레임은 보이지 않는다.
        if (isControlEcho(message)) return;
        const content = message.message.content;
        if (typeof content === "string") {
          // CLI 가 스스로 넣는 사용자 메시지(백그라운드 작업 알림, 자동 이어가기)는 보낸 사람을 구분해 보여 준다.
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
            // B2: 사용자가 중단해서 오류로 끝난 호출은 실패가 아니라 취소로 보인다.
            ...(block.is_error && run.interrupted ? { cancelled: true } : {}),
          };
          // SUB: Agent 호출의 결과는 서브에이전트가 끝났다는 뜻이거나(앞에서 기다린 경우) 백그라운드로 띄웠다는 안내다
          this.upsert(agentId, isAgentTool(tool.name) ? resultTask(done, output, block.is_error === true, new Date().toISOString()) : done);
        }
        return;
      }
      case "result": {
        // CTX: 턴이 끝나면 SDK 가 아는 값으로 맞춘다(응답 도중에는 프레임의 usage 로 어림한 값이었다)
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
        // 끼어든 메시지가 진행 중이던 턴을 끊었다. 끊긴 턴의 오류 result 는 보여 주지 않고, 끼어든 메시지의 턴이 이어서 진행된다.
        if (end === "steered" && message.is_error) {
          this.settleRunningTools(agentId, true);
          return;
        }
        // 백그라운드 작업 뒤에 오는 마지막 result 는 모델 왕복이 0번이라 보여 줄 게 없다.
        if (message.num_turns !== 0) {
          // 이 턴을 시작한 메시지가 담긴 result 에서만 변경 요약을 만든다(끼어들기로 생긴 두 번째 result 에는 없다).
          // 끼어든 메시지가 이어 간 턴도 원래 턴의 연장이라 같은 요약을 만든다.
          const ownTurn = run.turnMessageId !== null && (consumedSteers > 0 || ownsTurn(run.turnMessageId, message.user_message_uuids));
          const changes = ownTurn ? await this.turnChanges(agentId) : undefined;
          // 요약을 만드는 사이 프로세스가 닫혔으면(세션 삭제 등) 정리는 닫은 쪽이 했다. 이어 가면 지워진 세션의 타임라인 파일이 다시 생긴다.
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

  private handleSystem(agentId: string, message: Extract<SDKMessage, { type: "system" }>) {
    switch (message.subtype) {
      case "init": {
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
        // SUB: 이 목록은 살아 있는 백그라운드 작업 전체다. task_notification 을 놓친 서브에이전트가 도는 것으로 남지 않게 여기서 빠진 것을 끝낸다.
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
        // 요약이 길어도 타임라인에는 한 줄만 보이고, 전체는 접어 둔다(백그라운드 작업이라 눈에 덜 띄어야 한다)
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
        // CTX: 압축 뒤 토큰 수로 게이지를 바로 내리고, SDK 값으로 다시 맞춘다
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

  // --- CTX: 컨텍스트 사용량 ---

  // 같은 모델의 다른 세션에서 SDK 가 알려 준 창 크기. 아직 SDK 값을 못 받은 세션의 어림에 쓴다.
  private knownContextLimit(model: string | null | undefined) {
    if (!model) return null;
    return this.store.agents.find((a) => a.activeModel === model && a.contextUsage?.source === "api")?.contextUsage?.limit ?? null;
  }

  // 최상위 응답 프레임의 usage 로 어림한다. 서브에이전트의 프레임은 자기 컨텍스트라 여기 오지 않는다.
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

  // SDK 의 getContextUsage(summary): 마지막 응답의 usage 와 로컬 추정으로 답해서 모델을 부르지 않는다. 프로세스가 닫혔거나 답이 늦으면 버린다.
  private async refreshContext(agentId: string, run: Run) {
    const seq = ++run.ctxSeq;
    try {
      const res = await run.query.getContextUsage({ detail: "summary" });
      if (run.closed || run.ctxSeq !== seq) return;
      const next = contextFromApi(res, new Date().toISOString());
      if (next) this.setContext(agentId, next);
    } catch {
      // 프로세스가 닫히는 중이면 어림한 값을 그대로 둔다
    }
  }

  // --- SUB: 서브에이전트 ---

  // 서브에이전트가 부른 도구는 그 Agent 호출 행 안에 보이는 단계다. 대화의 단계 목록에는 나오지 않는다(parentToolUseId).
  private subagentToolCalls(agentId: string, parentId: string, content: unknown) {
    if (!Array.isArray(content)) return;
    for (const block of content as { type: string; id?: string; name?: string; input?: unknown }[]) {
      if (block.type !== "tool_use" || !block.id || !block.name) continue;
      // 같은 호출이 다시 오더라도 이미 끝난 단계를 도는 것으로 되돌리지 않는다
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

  // task_* 시스템 메시지를 Agent 호출 항목에 반영한다. 항목은 tool_use_id 로, 없으면 taskId 로 찾는다. 서브에이전트가 아닌 작업(백그라운드 명령 등)의 메시지는 짝이 없어 무시된다.
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

// AUTODONE: 마지막 활동은 updatedAt(턴 시작과 끝, 설정 변경에 올라간다)과 Done 을 직접 푼 시각 중 늦은 쪽이다.
// 고정한 세션, 이미 Done 인 세션, 아직 안 읽은 세션, 응답 중이거나 승인을 기다리는 세션, 줄 선 메시지나 백그라운드 작업이 남은 세션, 피드백 개선 세션은 넘기지 않는다.
// 3일은 평일 시간만 센다(로컬 시각 토요일과 일요일은 빼서, 금요일에 두고 간 세션이 월요일 아침에 사라지지 않게).
export const AUTO_DONE_MS = 3 * 24 * 3_600_000;
export function isAutoDoneDue(agent: Agent, now: number) {
  if (agent.pinned || agent.done || agent.feedbackId || agent.unread) return false;
  if (agent.status === "running" || agent.status === "waiting") return false;
  if (agent.queue?.length || agent.steering?.length || agent.backgroundTasks > 0) return false;
  const last = Math.max(Date.parse(agent.updatedAt) || 0, agent.reopenedAt ? Date.parse(agent.reopenedAt) || 0 : 0);
  return last > 0 && weekdayMsBetween(last, now) >= AUTO_DONE_MS;
}

// AUTODONE: from 과 to 사이에서 평일(월요일부터 금요일, 로컬 시각)에 해당하는 시간만 더한다.
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

// 갈래로 복사하는 항목. 갈래 세션의 기록은 uuid 가 새로 매겨지고 체크포인트도 복사되지 않으므로 messageId 를 떼고, 복원 자리표시도 가져가지 않는다.
// 중단. 끼어들기로 보낸 메시지처럼 CLI 큐에 이미 들어간 메시지도 같이 취소한다(cancelQueued). 그러지 않으면 중단된 턴 뒤에 그 메시지의 새 턴이 시작되거나,
// 끼어들기 직후의 중단은 결과 없이 멈춰 INTERRUPT_GRACE_MS 뒤에야 풀린다. SDK 0.3.296 의 interrupt 는 이 옵션을 받지만 타입 선언에는 없다.
// QUEUECANCEL: CLI 명령 큐에서 아직 시작 안 한 사용자 메시지를 uuid 로 뺀다. SDK 0.3.296 의 Query 클래스에는 있지만 타입 선언에 없다. 이미 꺼내 간 메시지면 false.
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
  // 도는 서브에이전트는 갈래로 따라오지 못한다(프로세스가 새로 뜬다). 멈춘 것으로 복사한다.
  return settleStale(items
    .filter((i) => !(i.kind === "assistant" && i.streaming) && i.kind !== "restored")
    .map((i) => {
      const prefix = agentId.slice(0, 8);
      const copy = { ...i, id: `${prefix}:${i.id}` };
      if (copy.kind === "user") delete copy.messageId;
      // 승인 항목이 가리키는 도구 호출도 같은 규칙으로 새 id 를 따라가야 대화가 두 항목을 한 줄로 합친다(안 그러면 갈래의 한 단계가 두 단계로 센다)
      if (copy.kind === "permission" && copy.toolUseId) copy.toolUseId = `${prefix}:${copy.toolUseId}`;
      // 서브에이전트가 부른 도구도 같은 규칙으로 부모 Agent 호출의 새 id 를 따라간다
      if (copy.kind === "tool" && copy.parentToolUseId) copy.parentToolUseId = `${prefix}:${copy.parentToolUseId}`;
      return copy;
    }));
}

// 제목은 첫 요청의 첫 줄만 마크다운 없이 짧게 둔다(shared/sessionTitle.ts). 알림 제목과 사이드바 행이 첫 요청 전체를 끌고 다니지 않게 한다(dogfood 5회차 20).
// 핸드오프 제목의 상한은 그대로 둔다.
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
