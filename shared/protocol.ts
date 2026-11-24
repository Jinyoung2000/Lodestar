import type { ActivityBarPrefs } from "./activityBar";
import type { EditorOptions, ResolvedEditorOptions } from "./editorOptions";
import type { SearchSettings } from "./searchSettings";
import type { PrRpcMethods } from "./prTypes";
import type { SimulatorRpcMethods } from "./simulator";
import type { SkillsRpcMethods } from "./skills";
import type { AutomationsRpcMethods, AutomationsState } from "./automations";
import type { ScmCommit, ScmCommitFile, ScmCommitOptions, ScmCommitResult, ScmDiffSection, ScmDiscardResult, ScmFileDiff, ScmFileDiffSection, ScmOperationResult, ScmPullMode, ScmRepoWorktrees, ScmStatus, ScmSyncResult, ScmTarget } from "./scm";
import type { SlackLinkTarget } from "./slackLink";
import type { NotionLinkTarget } from "./notionLink";
import type { NotionPin, NotionPinInput, NotionPinPatch } from "./notionPins";
import type { ReviewState } from "./morningReview";
import type { FollowUpsState, SnoozeChoice } from "./followups";
import type { ReleaseState } from "./release";
import type { NotionPageData } from "./notionFetch";
import type { NotionWritePreview } from "./notionWrite";
import type { NotionBypassWrites } from "./notionApproval";
import type { ReplaceFileRequest, ReplaceFileResult } from "./searchReplace";
import type { TermAskContext } from "./termAsk";
import type { MobileStatus, PairingOffer, TimelinePage } from "./mobile";
import type { SessionOrders } from "./sessionOrder";
import type { RetentionPolicy, TidyPlan, TidyResult } from "./feedbackRetention";
export type Workspace = {
  id: string;
  name: string;
  dir: string;
  parentId: string | null;
  feedback?: boolean;
  archived?: boolean;
};

export type AgentStatus = "idle" | "running" | "waiting" | "error";

export type PermissionMode = "default" | "acceptEdits" | "plan" | "auto" | "bypassPermissions";
export const PERMISSION_MODE_VALUES: readonly PermissionMode[] = ["default", "acceptEdits", "plan", "auto", "bypassPermissions"];

export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

export const EFFORT_LEVELS: EffortLevel[] = ["low", "medium", "high", "xhigh", "max", "ultra"];
export type ClaudeEffortLevel = Exclude<EffortLevel, "ultra">;
export const CLAUDE_EFFORT_LEVELS: ClaudeEffortLevel[] = ["low", "medium", "high", "xhigh", "max"];
export const isEffortLevel = (value: unknown): value is EffortLevel => typeof value === "string" && (EFFORT_LEVELS as string[]).includes(value);
export const claudeEffort = (value: unknown): ClaudeEffortLevel | null => (typeof value === "string" && (CLAUDE_EFFORT_LEVELS as string[]).includes(value) ? (value as ClaudeEffortLevel) : null);

export type Worktree = { root: string; branch: string; base: string };

export type Harness = "claude" | "codex" | "antigravity";
export const HARNESS_VALUES: readonly Harness[] = ["claude", "codex", "antigravity"];
export const harnessOf = (agent: { harness?: Harness }): Harness => agent.harness ?? "claude";
export type HarnessSeen = Partial<Record<Harness, string>>;

export type Agent = {
  id: string;
  workspaceId: string | null;
  cwd: string;
  extraWorkspaceIds?: string[];
  worktree: Worktree | null;
  forkedFrom: string | null;
  sideAdopted?: boolean;
  resumeFrom: string | null;
  startCommit: string | null;
  forkBased?: boolean;
  feedbackId: string | null;
  title: string;
  sessionId: string | null;
  status: AgentStatus;
  permissionMode: PermissionMode;
  model: string | null;
  effort: EffortLevel | null;
  activeModel: string | null;
  activeEffort: EffortLevel | null;
  backgroundTasks: number;
  createdAt: string;
  updatedAt: string;
  unread?: boolean;
  pinned?: boolean;
  done?: boolean;
  reopenedAt?: string;
  resumeAt?: string | null;
  queue?: QueuedMessage[];
  steering?: QueuedMessage[];
  imported?: ImportedFrom;
  contextUsage?: ContextUsage | null;
  handoffFrom?: string | null;
  harness?: Harness;
  codexThreadId?: string | null;
  antigravitySessionId?: string | null;
  seenThrough?: HarnessSeen;
  carryPending?: boolean;
  automationId?: string;
};

export type ContextUsage = { used: number; limit: number; source: "api" | "estimate"; at: string };

export type QueuedMessage = { id: string; text: string; shown?: string; attachments?: UserAttachment[]; feedback?: DiffFeedback[]; sent?: boolean };

export type CheckpointMode = "files" | "chat" | "none";

export type UserAttachment =
  | { kind: "element"; label: string; path: string | null; line: number | null }
  | { kind: "screenshot"; label: string; thumb: string }
  | { kind: "diffFeedback"; label: string; path: string; line: number; endLine: number; id: string; text: string }
  | { kind: "handoff"; label: string; id: string }
  | { kind: "image"; label: string; id: string; thumb: string }
  | { kind: "file"; label: string; path: string; bytes: number }
  | { kind: "notion"; label: string; url: string };

export type SubagentStatus = "running" | "completed" | "failed" | "stopped";
export type SubagentTask = {
  taskId: string | null;
  status: SubagentStatus;
  backgrounded: boolean;
  subagentType: string | null;
  description: string;
  activity: string | null;
  tokens: number;
  toolUses: number;
  durationMs: number;
  lastTool: string | null;
  summary: string | null;
  startedAt: string;
  endedAt?: string;
};

export type DiffFeedback = {
  id: string;
  path: string;
  rel: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  text: string;
  codeSelection?: string;
  diffHunks?: string;
  state: "accepted" | "submitted";
  createdAt: string;
};

export type MediaInfo = { raw: string; kind: "image" | "video"; mime: string; size: number; name: string; url: string };

export type TimelineItem =
  | { id: string; kind: "user"; text: string; source?: "user" | "system"; at?: string; messageId?: string; shown?: string; attachments?: UserAttachment[]; preCompact?: boolean }
  | { id: string; kind: "assistant"; text: string; streaming: boolean; at?: string; model?: string }
  | { id: string; kind: "thinking"; text: string }
  | {
      id: string;
      kind: "tool";
      name: string;
      input: Record<string, unknown>;
      status: "running" | "done" | "error";
      output: string | null;
      cancelled?: boolean;
      page?: { title: string; url: string };
      shots?: string[];
      shotCount?: number;
      task?: SubagentTask;
      parentToolUseId?: string;
    }
  | {
      id: string;
      kind: "permission";
      toolUseId?: string;
      toolName: string;
      input: Record<string, unknown>;
      status: "pending" | "allowed" | "denied";
      outcome?: PermissionOutcome;
      notion?: NotionWritePreview;
      auto?: boolean;
    }
  | { id: string; kind: "result"; isError: boolean; durationMs: number; costUsd: number | null; changes?: TurnChanges; tokens?: number }
  | { id: string; kind: "restored"; redoable: boolean; chatOnly?: boolean }
  | { id: string; kind: "notice"; text: string; detail?: string; fold?: { label: string; text: string }; divider?: boolean; openAgentId?: string; switched?: Harness; switchedFrom?: Harness; movedFrom?: string }
  | { id: string; kind: "error"; text: string; auth: boolean };

export type TurnChangedFile = { path: string; additions: number; deletions: number };
export type TurnChanges = { files: number; additions: number; deletions: number; list?: TurnChangedFile[] };

export type PermissionDecision = "allow" | "allowAlways" | "deny";

export type PermissionOutcome = {
  answers?: Record<string, string>;
  plan?: { decision: "approved"; mode: PermissionMode } | { decision: "kept"; feedback?: string };
};

export type ImageRef = { id: string; label: string; thumb: string };

export type FileRef = { path: string; name: string; bytes: number; mediaType: string };

export type ModelInfo = {
  value: string;
  resolvedModel: string | null;
  displayName: string;
  supportedEffortLevels: EffortLevel[];
};

export type CodexModelInfo = { value: string; displayName: string; description: string; isDefault: boolean; supportedEffortLevels: EffortLevel[]; defaultEffort: EffortLevel | null };

export type CodexMeta = {
  installed: boolean;
  version: string | null;
  loggedIn: boolean;
  account: { type: "chatgpt" | "apiKey" | "other"; plan: string | null } | null;
  models: CodexModelInfo[];
  defaultModel: string | null;
  defaultEffort: EffortLevel | null;
  error: string | null;
  fetchedAt: string;
};

export type AntigravityMeta = CodexMeta;

export type McpStatus = { name: string; status: string; source: string | null; error: string | null; toolCount: number | null; tools?: { name: string; description: string | null }[] };

export type McpSessionResult = { reconnected: number; failed: number; skipped: number };
export type McpActionResult = { ok: boolean; error: string | null; sessions: McpSessionResult; meta: Meta };

export type CommandInfo = { name: string; description: string };

export type Meta = {
  claudeVersion: string | null;
  account: { email: string; subscriptionType: string } | null;
  models: ModelInfo[];
  mcp: McpStatus[];
  commandCount: number;
  commands?: CommandInfo[];
  fetchedAt: string | null;
  error: string | null;
  claudeMissing?: boolean;
};

export type RuntimeInfo = { kind: "repo" | "bundle"; root: string; note: string | null; operator: boolean };

export const OPERATOR_MARK = ".lodestar-operator";

export type Theme = "dark" | "light" | "system" | "black";

export const THEME_STYLES = ["lodestar", "webstorm"] as const;
export type ThemeStyle = (typeof THEME_STYLES)[number];

export const DIFF_VIEWS = ["inline", "split", "auto"] as const;
export type DiffView = (typeof DIFF_VIEWS)[number];

export const KEYMAP_PRESETS = ["vscode", "webstorm"] as const;
export type KeymapPreset = (typeof KEYMAP_PRESETS)[number];
export type CommandKeys = Record<string, string[]>;
export type KeymapOverrides = Partial<Record<KeymapPreset, CommandKeys>>;

export const BROWSER_SEARCH_ENGINES = ["bing", "google", "duckduckgo", "yahoo", "none"] as const;
export type BrowserSearchEngine = (typeof BROWSER_SEARCH_ENGINES)[number];
export const BROWSER_PAGE_ZOOMS = [50, 75, 100, 125, 150, 200] as const;
export const BROWSER_STORAGES = ["default", "global", "workspace", "ephemeral", "agent"] as const;
export type BrowserStorage = (typeof BROWSER_STORAGES)[number];
export const BROWSER_TITLE_BAR = [true, false, "whenOpen"] as const;
export type BrowserTitleBar = (typeof BROWSER_TITLE_BAR)[number];

export type Settings = {
  settingsVersion: number;
  theme: Theme;
  themeStyle: ThemeStyle;
  defaultPermissionMode: PermissionMode | null;
  defaultModel: string | null;
  defaultEffort: EffortLevel | null;
  diffInlineWhenNarrow: boolean | null;
  requestQueuing: RequestQueuing | null;
  previewEditors: boolean | null;
  revealIfOpen: boolean;
  quickOpenIncludeExcluded: boolean;
  editorOptions: Partial<EditorOptions>;
  quickModel: string;
  quickEntryEnabled: boolean;
  quickEntryShortcut: string;
  miniChatHideOnBlur: boolean;
  editorFontFamily: string;
  editorFontSize: number;
  editorLineHeight: number;
  editorLigatures: boolean;
  editorFontTerminal: boolean;
  uiLetterSpacing: number;
  uiFontFamily: string;
  chatFontSize: number;
  chatLineHeight: number;
  showSlack: boolean;
  showBoard: boolean;
  boardAutoMove: boolean;
  morningReviewEnabled: boolean;
  morningReviewTime: string;
  automationConcurrency: number;
  followUpsEnabled: boolean;
  followUpsReminders: boolean;
  followUpsModel: string;
  notifyOnResponse: boolean;
  notifyOnApproval: boolean;
  notifyNewVersion?: boolean;
  useProviderEnv?: boolean;
  inboxIntervalMinutes: number;
  keepIdleSessionsWarmMinutes: number;
  maxWarmSessions: number;
  feedbackAutoTidy: boolean;
  autoUpdateWhenIdle: boolean;
  autoAddRequests: boolean;
  mentionAnalysisModel: string;
  mentionAnalysisBudgetUsd: number | null;
  slackTeamId: string;
  slackLinkTarget: SlackLinkTarget;
  notionLinkTarget: NotionLinkTarget;
  notionBypassWrites: NotionBypassWrites;
  focusGuard: boolean;
  diffView: DiffView;
  keymapPreset: KeymapPreset;
  keymapOverrides?: KeymapOverrides;
  activityBar?: ActivityBarPrefs;
  browserSearchEngine: BrowserSearchEngine;
  browserMaxHistory: number;
  browserChatTools: boolean;
  browserPageZoom: number | null;
  browserAttachElementImage: boolean;
  browserOpenLocalhostLinks: boolean;
  browserDataStorage: BrowserStorage;
  browserAutoReload: boolean;
  browserShowInTitleBar: BrowserTitleBar;
  browserUserTools: boolean;
  formatOnSave: boolean | null;
  formatters: Record<string, FormatterId>;
  defaultLayout: "chat" | "editor" | null;
  rememberLastLayout: boolean;
  rememberLayoutPerSession: boolean;
  expandSteps: boolean;
  pinnedPanelSide: "left" | "right" | null;
  chatInEditorLayout: "docked" | "floating" | null;
  mobileAccess: boolean;
  mobileRelay: boolean;
};

export type DefaultSource = "agent-nav" | "vscode" | "claude" | "builtin";
export type Resolved<T> = { value: T; source: DefaultSource };
export type SessionSort = "created" | "updated";

export type ResolvedDefaults = {
  model: Resolved<string | null>;
  effort: Resolved<EffortLevel | null>;
  permissionMode: Resolved<PermissionMode>;
  diffInlineWhenNarrow: Resolved<boolean>;
  sessionSort: Resolved<SessionSort>;
  requestQueuing: Resolved<RequestQueuing>;
  previewEditors: Resolved<boolean>;
  editorOptions?: ResolvedEditorOptions;
};

export type RequestQueuing = "queue" | "steer";

export const EDITOR_FONT_DEFAULTS = {
  editorFontFamily: '"D2Coding ligature", "D2Coding", "Geist Mono", monospace',
  editorFontSize: 12.5,
  editorLineHeight: 20,
  editorLigatures: true,
  editorFontTerminal: true,
} satisfies Pick<Settings, "editorFontFamily" | "editorFontSize" | "editorLineHeight" | "editorLigatures" | "editorFontTerminal">;

export const UI_TYPE_DEFAULTS = {
  uiLetterSpacing: -0.02,
  uiFontFamily: '-apple-system, "system-ui", sans-serif',
  chatFontSize: 13,
  chatLineHeight: 19.5,
} satisfies Pick<Settings, "uiLetterSpacing" | "uiFontFamily" | "chatFontSize" | "chatLineHeight">;
export const UI_TYPE_RANGES = {
  uiLetterSpacing: { min: -0.05, max: 0.05 },
  chatFontSize: { min: 10, max: 24 },
  chatLineHeight: { min: 14, max: 40 },
} as const;

export type InboxKind = "mention" | "dm" | "thread";

export type InboxItem = {
  id: string;
  kind: InboxKind;
  channelId: string;
  channelName: string;
  ts: string;
  threadTs: string | null;
  from: { id: string; name: string };
  text: string;
  permalink: string;
  time: string;
  read: boolean;
  archived: boolean;
  fetchedAt: string;
  judgment?: MentionJudgment;
  judgeFailures?: number;
  cardId?: string | null;
  analysis?: MentionAnalysis;
  verdict?: "not-request";
  thread?: { fetchedAt: string; messages: InboxThreadMessage[] };
  legacy?: true;
};

export type MentionJudgment = {
  at: string;
  skipped?: "legacy" | "off" | "failed";
  isRequest: boolean;
  confidence: number;
  title: string;
  summary: string;
};

export type MentionAnalysisStatus = "queued" | "running" | "done" | "failed";

export type MentionAnalysis = {
  status: MentionAnalysisStatus;
  at: string;
  manual?: boolean;
  model?: string;
  costUsd?: number | null;
  turns?: number | null;
  tools?: string[];
  error?: string | null;
  stats?: { steps: number; files: number; questions: number; links: number };
};

export type InboxThreadMessage = { ts: string; from: { id: string; name: string }; text: string };

export type InboxFetchInfo = {
  at: string;
  counts: Record<InboxKind, number>;
  added: number;
  partial: boolean;
  error: string | null;
  tools: string[];
  costUsd: number | null;
  turns: number | null;
  judge?: JudgeInfo;
};

export type JudgeInfo = {
  judged: number;
  requests: number;
  notRequests: number;
  queued: number;
  error: string | null;
  costUsd: number | null;
  turns: number | null;
};

export type InboxState = {
  selfUserId: string | null;
  lastFetchedAt: string | null;
  items: InboxItem[];
  lastFetch: InboxFetchInfo | null;
  fetching: boolean;
  unread: number;
};

export type BoardRole = "backlog" | "todo" | "inProgress" | "review" | "done";

export type BoardColumn = { id: string; name: string; role: BoardRole | null };

export type BoardPriority = 0 | 1 | 2 | 3 | 4;

export type BoardSort = "manual" | "priority" | "updated";

export type CardLink = { url: string; title: string | null };

export type CardSource = { agentId: string; itemId: string; part: string | null };

export type BoardCard = {
  id: string;
  columnId: string;
  title: string;
  body: string;
  labels: string[];
  priority: BoardPriority;
  number: number;
  workspaceId: string | null;
  agentIds: string[];
  links: CardLink[];
  source?: CardSource | null;
  createdAt: string;
  updatedAt: string;
};

export type Board = { columns: BoardColumn[]; cards: BoardCard[]; nextNumber: number; labelColors: Record<string, number> };

export type NewCard = {
  title: string;
  body?: string;
  labels?: string[];
  links?: CardLink[];
  workspaceId?: string | null;
  agentIds?: string[];
  source?: CardSource | null;
  priority?: BoardPriority;
  columnId?: string;
};

export type CardPatch = {
  title?: string;
  body?: string;
  labels?: string[];
  links?: CardLink[];
  workspaceId?: string | null;
  priority?: BoardPriority;
};

export type UndoSkip = { path: string; reason: "modified" | "mixed" | "unknown"; rel?: string };
export type UndoCheck = { allowed: string[]; skipped: UndoSkip[] };

export type RestoreFile = { path: string; rel: string };
export type RestoreSkip = UndoSkip & { rel: string };
export type RestorePlan = { revert: RestoreFile[]; remove: RestoreFile[]; skip: RestoreSkip[] };
export type ShellNote = { turns: { at: string; title: string }[] };

export type FileChange = { path: string; original: string | null; updatedAt: string };

export type QuickContext = { path: string; startLine: number; endLine: number; text: string };

export type QuickRun = {
  id: string;
  workspaceId: string;
  model: string;
  question: string;
  context: QuickContext;
  answer: string;
  status: "running" | "done" | "error";
  sessionId: string | null;
};

export type TermAskRun = { id: string; model: string; question: string; answer: string; status: "running" | "done" | "error" };

export type SideMessage = { role: "user" | "assistant"; text: string };
export type SideRun = {
  id: string;
  agentId: string;
  model: string;
  effort?: EffortLevel | null;
  updatedAt?: string;
  sessionId: string | null;
  messages: SideMessage[];
  status: "running" | "idle" | "error";
};

export type BlameCommit = { hash: string; author: string; email: string; time: number; summary: string; message: string; you: boolean; uncommitted: boolean };
export type FileBlame = { commits: BlameCommit[]; lines: number[] };

export type ChangedFile = {
  path: string;
  rel: string;
  status: "A" | "M" | "D" | "R";
  additions: number;
  deletions: number;
  from?: string;
  outside?: true;
  modifiedSince?: true;
};

export type GitInfo = {
  repoRoot: string | null;
  hasHead: boolean;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  base: string | null;
  baseLabel: string | null;
  baseBranch?: string | null;
  headShort?: string | null;
  hasRemote?: boolean;
};

export const CHANGE_SCOPES = ["branch", "uncommitted", "session", "lastTurn"] as const;
export type ChangeScope = (typeof CHANGE_SCOPES)[number];
export const defaultChangeScope = (agent: { worktree: unknown; forkBased?: boolean }): ChangeScope => (agent.forkBased ? "session" : "branch");

export type WorktreeMergeInfo = { branch: string; target: string; unmerged: number; blocker: string | null };
export type WorktreePrResult = { kind: "created" | "existing" | "pushed"; url: string | null; message: string };

export type PullRequest = {
  number: number;
  title: string;
  url: string;
  state: string;
  checks: { passing: number; failing: number; pending: number };
};

export type ElementInfo = {
  kind?: "region";
  component: string | null;
  sources: string[];
  tag: string;
  domPath: string;
  width: number;
  height: number;
  text: string;
  styles: Record<string, string>;
};

export type ScreenContext = {
  view: string;
  overlay: string | null;
  activePane: string;
  paneCount: number;
  layout: string;
  sidebar: boolean;
  rightPanel: string | null;
  bottomPanel: string | null;
  theme: string;
  width: number;
  height: number;
};

export type FeedbackStatus = "running" | "checking" | "fixing" | "awaitingRestart" | "applied" | "failed" | "reverted" | "noChanges" | "needsInput" | "resolved" | "dismissed" | "blocked";

export type FeedbackBlock = { reason: "environment" | "auth"; stage: "checks" | "session"; nextRetryAt: string | null };

export type FeedbackCheck = { name: string; ok: boolean; output: string; ignored?: number; baseline?: string };

export type Feedback = {
  id: string;
  agentId: string;
  text: string;
  element: ElementInfo | null;
  screen?: ScreenContext | null;
  windowScreenshot?: boolean;
  screenshot: boolean;
  screenshotNote: string | null;
  status: FeedbackStatus;
  summary: string | null;
  question?: string | null;
  changedFiles: string[];
  needsRestart: boolean;
  restartRequested: boolean;
  restartPending: boolean;
  checks: FeedbackCheck[];
  retrying?: boolean;
  fixAttempts?: number;
  interrupted?: boolean;
  conflict?: boolean;
  resumeCount?: number;
  reapplyTries?: number;
  reapplying?: boolean;
  failureNotice?: { head: string; itemId: string | null } | null;
  blocked?: FeedbackBlock | null;
  blockTries?: number;
  sessionFailed?: boolean;
  failure: string | null;
  worktree: string;
  seen: boolean;
  createdAt: string;
  updatedAt: string;
};

export type BrowserSharedPage = { pageId: string; agentId: string; url: string; title: string; visible?: "active" | "hidden" };

export type BrowserToolOutput = { text?: string; image?: string };

export type BrowserToolName = "read_page" | "screenshot_page" | "click_element" | "drag_element" | "handle_dialog" | "hover_element" | "type_in_page" | "navigate_page" | "run_playwright_code" | "read_console_logs";

export type FormatterId = "eslint" | "prettier" | "oxc" | "tsserver";

export type FormatProblem =
  | { kind: "cannotFormat"; extension: string; detail: string | null }
  | { kind: "selectionUnsupported"; extension: string }
  | { kind: "unavailable"; extensionId: string }
  | { kind: "unsupported"; extension: string }
  | { kind: "ambiguous" }
  | { kind: "none" };
export type FormatChoice = { formatter: FormatterId; label: string };
export type FormatResult = {
  text: string | null;
  formatter: FormatterId | null;
  language: string;
  problem?: FormatProblem;
  alternatives?: FormatChoice[];
};
export type FormatLanguage = {
  id: string;
  name: string;
  chosen: FormatterId | null;
  vscode: { raw: string | null; formatter: FormatterId | null; scope: "workspace" | "user" | null; label: string | null; supported: boolean };
  options: FormatChoice[];
};

export type ImportedFrom = {
  source: "vscode";
  vsSessionId: string;
  chatId: string;
  origin: "user" | "sideChat" | null;
  importedAt: string;
  syncedMtimeMs: number;
  syncedUntil: string | null;
  cwdMissing?: boolean;
  vsRunning?: boolean;
};

export type VscodeCandidate = {
  key: string;
  claudeSessionId: string | null;
  vsSessionId: string;
  chatId: string;
  kind: "main" | "peer";
  parentKey: string | null;
  origin: "user" | "sideChat" | null;
  title: string;
  cwd: string | null;
  cwdExists: boolean;
  createdAt: string | null;
  updatedAt: string | null;
  chats: number;
  subagentChats: number;
  hasJsonl: boolean;
  archived: boolean;
  unread: boolean;
  running: boolean;
  from: "cache" | "session" | "both";
  importedAgentId: string | null;
  problem: "noSessionId" | "noTranscript" | null;
};

export type VscodeImportList = {
  available: boolean;
  reason: string | null;
  stateFile: string;
  candidates: VscodeCandidate[];
  stats: { cached: number; cachedExternal: number; sessionDb: number; importable: number; alreadyImported: number };
};

export type VscodeImportResult = {
  key: string;
  agentId: string | null;
  outcome: "created" | "updated" | "unchanged" | "skipped" | "failed";
  items: number;
  added: number;
  note: string | null;
};

export type BranchesResult = { repoRoot: string | null; current: string | null; defaultBase: string | null; branches: string[]; locals: string[]; remotes: string[]; uncommitted: number };

export type RpcMethods = PrRpcMethods & SimulatorRpcMethods & SkillsRpcMethods & AutomationsRpcMethods & {
  "workspaces.list": { params: Record<string, never>; result: Workspace[] };
  "sessionOrder.list": { params: Record<string, never>; result: SessionOrders };
  "sessionOrder.set": { params: { scope: string; ids: string[] }; result: SessionOrders };
  "sessionOrder.reset": { params: { scopes: string[] }; result: SessionOrders };
  "workspaces.add": { params: { dir: string }; result: Workspace };
  "workspaces.create": { params: { parent: string; name: string; git: boolean }; result: Workspace };
  "workspaces.open": { params: { dir: string }; result: Workspace };
  "workspaces.remove": { params: { id: string }; result: { hidden: number } };
  "workspaces.relocate": { params: { id: string; dir: string }; result: Workspace };
  "workspaces.reveal": { params: { workspaceId: string }; result: null };
  "files.list": { params: { workspaceId: string }; result: string[] };
  "files.ignored": { params: { workspaceId: string }; result: string[] };
  "browser.probe": { params: { url: string }; result: { ok: boolean; status: number | null; reason: string | null } };
  "files.search": {
    params: { workspaceId: string; query: string; matchCase: boolean; wholeWord: boolean; regex: boolean; context: number; include?: string; exclude?: string; ignore?: boolean; ranges?: boolean };
    result: { files: { path: string; rows: { line: number; text: string; match: boolean; ranges?: { start: number; end: number }[]; offset?: number }[] }[]; matches: number; truncated: boolean; engine: "rg" | "git" };
  };
  "search.settings": { params: Record<string, never>; result: SearchSettings };
  "browser.saveShot": { params: { png: string }; result: { path: string } };
  "browser.setShares": { params: { pages: BrowserSharedPage[]; open?: number }; result: null };
  "browser.readShot": { params: { path: string }; result: { png: string | null } };
  "aside.readImage": { params: { paths: string[] }; result: { mime: string; data: string } | null };
  "media.resolve": { params: { agentId: string; paths: string[] }; result: (MediaInfo | null)[] };
  "browser.toolResult": { params: { id: string; result?: BrowserToolOutput; error?: string }; result: null };
  "files.read": { params: { workspaceId: string; path: string }; result: { text: string | null; mtimeMs?: number | null; binary?: boolean; size?: number; readOnly?: boolean } };
  "files.readBinary": { params: { workspaceId: string; path: string }; result: { base64: string | null; mime: string | null; size: number } };
  "files.readOfAgent": { params: { agentId: string; path: string }; result: { text: string | null } };
  "files.stat": { params: { workspaceId: string; path: string }; result: { mtimeMs: number | null } };
  "repos.mirrorDir": { params: { repo: string; request?: boolean }; result: { dir: string | null } };
  "files.headText": { params: { workspaceId: string; path: string }; result: { repo: boolean; text: string | null } };
  "files.save": {
    params: { workspaceId: string; path: string; text: string; baseMtimeMs: number | null; force?: boolean };
    result: { saved: true; mtimeMs: number } | { saved: false; conflict: "changed" | "exists" | "readonly"; mtimeMs: number | null };
  };
  "files.create": { params: { workspaceId: string; path: string; kind: "file" | "folder"; text?: string }; result: { mtimeMs: number } };
  "files.rename": { params: { workspaceId: string; from: string; to: string }; result: null };
  "files.trash": { params: { workspaceId: string; path: string }; result: { trashed: string } };
  "files.reveal": { params: { workspaceId: string; path: string }; result: null };
  "files.dirs": { params: { workspaceId: string }; result: string[] };
  "format.run": {
    params: { workspaceId: string; path: string; text: string; range?: { from: number; to: number }; formatter?: FormatterId };
    result: FormatResult;
  };
  "format.config": { params: { workspaceId?: string }; result: { formatOnSave: boolean; source: DefaultSource; languages: FormatLanguage[] } };
  "files.write": { params: { agentId: string; path: string; text: string | null }; result: null };
  "files.openInVSCode": {
    params: { workspaceId: string; path: string; line: number; column: number };
    result: null;
  };
  "workspaces.openInVSCode": { params: { agentId?: string; workspaceId?: string }; result: null };
  "commands.local": { params: { workspaceId: string }; result: CommandInfo[] };
  "meta.get": { params: Record<string, never>; result: Meta };
  "codex.meta": { params: { refresh?: boolean }; result: CodexMeta };
  "antigravity.meta": { params: { refresh?: boolean }; result: AntigravityMeta };
  "meta.refresh": { params: Record<string, never>; result: Meta };
  "mcp.reconnect": { params: { name: string }; result: McpActionResult };
  "mcp.toggle": { params: { name: string; enabled: boolean }; result: McpActionResult };
  "runtime.info": { params: Record<string, never>; result: RuntimeInfo };
  "models.pins": { params: Record<string, never>; result: string[] };
  "models.setPin": { params: { harness: Harness; model: string; pinned: boolean }; result: string[] };
  "models.importPins": { params: { pins: string[] }; result: string[] };
  "settings.get": { params: Record<string, never>; result: Settings };
  "defaults.get": { params: Record<string, never>; result: ResolvedDefaults };
  "settings.set": { params: Partial<Settings>; result: Settings };
  "logs.tail": { params: { lines: number }; result: string[] };
  "agents.list": { params: Record<string, never>; result: Agent[] };
  "agents.create": {
    params: {
      workspaceId: string | null;
      prompt: string;
      permissionMode: PermissionMode;
      model: string | null;
      effort: EffortLevel | null;
      worktree: { branch: string; base: string } | null;
      boardCardId?: string;
      handoffFrom?: string;
      handoffId?: string;
      shown?: string;
      images?: ImageRef[];
      files?: FileRef[];
      harness?: Harness;
      extraWorkspaceIds?: string[];
    };
    result: Agent;
  };
  "agents.addFolder": { params: { agentId: string; workspaceId: string }; result: Agent };
  "agents.removeFolder": { params: { agentId: string; workspaceId: string }; result: Agent };
  "agents.moveToFolder": { params: { agentId: string; dir: string; create?: boolean }; result: Agent };
  "agents.respondNotionWrite": { params: { agentId: string; itemId: string; apply: boolean; feedback?: string }; result: null };
  "handoff.create": { params: { agentId: string }; result: { id: string; title: string; text: string; path: string } };
  "handoff.read": { params: { id: string }; result: { id: string; text: string; path: string } };
  "handoff.save": { params: { id: string; text: string }; result: null };
  "agents.send": { params: { agentId: string; prompt: string; steer?: boolean; images?: ImageRef[]; files?: FileRef[] }; result: { queued: boolean } };
  "images.upload": { params: { mediaType: string; data: string; name: string }; result: { id: string } };
  "attachments.discard": { params: { id: string }; result: null };
  "agents.dequeue": { params: { agentId: string; queueId: string }; result: { text: string } | null };
  "diffFeedback.list": { params: { agentId: string }; result: DiffFeedback[] };
  "diffFeedback.add": { params: { agentId: string; item: Omit<DiffFeedback, "id" | "state" | "createdAt"> }; result: DiffFeedback };
  "diffFeedback.update": { params: { agentId: string; id: string; text: string }; result: null };
  "diffFeedback.remove": { params: { agentId: string; id: string }; result: null };
  "diffFeedback.clear": { params: { agentId: string }; result: null };
  "diffFeedback.send": { params: { agentId: string; text?: string; steer?: boolean; ids?: string[] }; result: { queued: boolean } };
  "agents.cancelSteering": { params: { agentId: string; steeringId: string }; result: { cancelled: true; text: string } | { cancelled: false } | null };
  "agents.sendQueuedNow": { params: { agentId: string; queueId: string }; result: null };
  "agents.interrupt": { params: { agentId: string }; result: null };
  "agents.timeline": { params: { agentId: string }; result: TimelineItem[] };
  "agents.setPermissionMode": { params: { agentId: string; mode: PermissionMode }; result: null };
  "agents.setModel": { params: { agentId: string; model: string | null }; result: null };
  "agents.setEffort": { params: { agentId: string; effort: EffortLevel | null }; result: null };
  "agents.switchHarness": { params: { agentId: string; harness: Harness; model: string | null; effort: EffortLevel | null }; result: null };
  "agents.respondPermission": {
    params: { agentId: string; itemId: string; decision: PermissionDecision };
    result: null;
  };
  "agents.answerQuestion": {
    params: { agentId: string; itemId: string; answers: Record<string, string> | null };
    result: null;
  };
  "agents.respondPlan": {
    params: { agentId: string; itemId: string; approve: true; mode: "acceptEdits" | "default" } | { agentId: string; itemId: string; approve: false; feedback?: string };
    result: null;
  };
  "agents.remove": { params: { agentId: string; removeWorktree: boolean }; result: null };
  "agents.worktreeStatus": { params: { agentId: string }; result: { dirty: boolean; summary: string; unmerged: number | null; branch: string; base: string } | null };
  "worktree.mergeInfo": { params: { agentId: string }; result: WorktreeMergeInfo | null };
  "worktree.merge": { params: { agentId: string; confirmed: true }; result: { target: string; fastForward: boolean; commits: number; affectedAgentIds: string[] } };
  "worktree.createPr": { params: { agentId: string; confirmed: true }; result: WorktreePrResult };
  "agents.fork": { params: { agentId: string; beforeItemId?: string }; result: Agent };
  "agents.restoreCheckpoint": { params: { agentId: string; itemId: string }; result: { text: string; files: number; chatOnly: boolean; reverted?: number; removed?: number; skipped?: RestoreSkip[] } };
  "agents.previewCheckpoint": { params: { agentId: string; itemId: string }; result: { files: number; plan?: RestorePlan } };
  "agents.cancelRestore": { params: { agentId: string }; result: null };
  "agents.redoCheckpoint": { params: { agentId: string }; result: { files: number; chatOnly: boolean; skipped?: RestoreSkip[] } };
  "agents.checkpointModes": { params: { agentId: string }; result: Record<string, CheckpointMode> };
  "agents.markRead": { params: { agentId: string; read: boolean }; result: null };
  "agents.setOpen": { params: { agentIds: string[] }; result: null };
  "workspaces.watch": { params: { workspaceIds: string[] }; result: null };
  "feedback.tidyPlan": { params: { policy?: Partial<RetentionPolicy> }; result: TidyPlan };
  "feedback.tidyRun": { params: { policy?: Partial<RetentionPolicy> }; result: TidyResult };
  "perf.stats": { params: { reset?: boolean }; result: { since: number; now: number; buckets: Record<string, { count: number; bytes: number; ms: number }>; process: { rssMb: number; heapMb: number; cpuUserMs: number; cpuSystemMs: number }; watch: { events: number; ignored: number; emits: number; watched: number } } };
  "app.showAgent": { params: { agentId: string }; result: null };
  "agents.setPinned": { params: { agentId: string; pinned: boolean }; result: null };
  "agents.setDone": { params: { agentId: string; done: boolean }; result: null };
  "agents.rename": { params: { agentId: string; title: string }; result: null };
  "agents.openChatFile": { params: { agentId: string; path: string }; result: null };
  "changes.list": { params: { agentId: string }; result: FileChange[] };
  "changes.setOriginal": { params: { agentId: string; path: string; original: string | null }; result: null };
  "changes.clear": { params: { agentId: string; path: string | null }; result: null };
  "changes.checkUndo": { params: { agentId: string; paths: string[] }; result: UndoCheck };
  "changes.undo": { params: { agentId: string; items: { path: string; text: string | null }[] }; result: UndoCheck & { reverted: string[] } };
  "git.info": { params: { agentId: string } | { workspaceId: string }; result: GitInfo };
  "git.fetch": { params: { agentId: string }; result: GitInfo };
  "git.push": { params: { agentId: string }; result: { output: string } };
  "git.pull": { params: { agentId: string }; result: { output: string } };
  "git.changes": { params: { agentId: string; scope?: ChangeScope; includeOutside?: boolean }; result: { base: string | null; files: ChangedFile[]; outsideCount: number; shellNote?: ShellNote } };
  "git.workspaceChanges": { params: { workspaceId: string }; result: { files: ChangedFile[] } };
  "git.original": { params: { agentId: string; path: string; scope?: ChangeScope; from?: string }; result: { text: string | null } };
  "git.blame": { params: { workspaceId: string; path: string; text?: string }; result: { blame: FileBlame | null } };
  "git.branches": {
    params: { workspaceId: string };
    result: BranchesResult;
  };
  "git.checkBranchName": { params: { workspaceId: string; branch: string }; result: { problem: string | null } };
  "git.switchBranch": { params: { workspaceId: string; branch: string; allowBusy?: boolean }; result: { switched: boolean; busy: string[]; affectedAgentIds: string[]; info: BranchesResult } };
  "git.prs": { params: { agentId: string }; result: { available: boolean; reason: string | null; prs: PullRequest[] } };
  "scm.status": { params: ScmTarget; result: ScmStatus };
  "scm.stage": { params: ScmTarget & { paths: string[] }; result: null };
  "scm.unstage": { params: ScmTarget & { paths: string[] }; result: null };
  "scm.discard": { params: ScmTarget & { paths: string[] }; result: ScmDiscardResult };
  "scm.commit": { params: ScmTarget & { options: ScmCommitOptions }; result: ScmCommitResult };
  "scm.undoCommit": { params: ScmTarget; result: { message: string } };
  "scm.generateMessage": { params: ScmTarget & { model: string }; result: { message: string } };
  "scm.graph": { params: ScmTarget & { limit?: number }; result: ScmCommit[] };
  "scm.commitFiles": { params: ScmTarget & { hash: string }; result: ScmCommitFile[] };
  "scm.commitDiff": { params: ScmTarget & { hash: string; rel: string; from?: string }; result: { text: string; truncated: boolean } };
  "scm.worktrees": { params: Record<string, never>; result: ScmRepoWorktrees[] };
  "scm.openWorktree": { params: { path: string }; result: { workspaceId: string } };
  "scm.pull": { params: ScmTarget & { mode?: ScmPullMode }; result: ScmSyncResult };
  "scm.push": { params: ScmTarget; result: ScmSyncResult };
  "scm.fetch": { params: ScmTarget; result: ScmSyncResult };
  "scm.continue": { params: ScmTarget & { message?: string }; result: ScmOperationResult };
  "scm.abort": { params: ScmTarget; result: null };
  "scm.fileDiff": { params: ScmTarget & { rel: string; section: ScmFileDiffSection }; result: ScmFileDiff };
  "scm.stageHunk": { params: ScmTarget & { rel: string; section: ScmDiffSection; index: number; hash: string }; result: null };
  "scm.discardHunk": { params: ScmTarget & { rel: string; index: number; hash: string }; result: null };
  "quick.ask": {
    params: { id: string; workspaceId: string; model: string; question: string; context: QuickContext };
    result: null;
  };
  "quick.cancel": { params: { id: string }; result: null };
  "quick.adopt": { params: { id: string }; result: Agent };
  "termask.ask": { params: { id: string; model: string; question: string; context: TermAskContext }; result: null };
  "termask.cancel": { params: { id: string }; result: null };
  "pty.info": { params: { ptyId: string }; result: { cwd: string; shell: string; os: string } };
  "side.ask": { params: { id: string; agentId: string; model: string; effort?: EffortLevel | null; question: string }; result: null };
  "side.list": { params: { agentId: string }; result: SideRun[] };
  "side.cancel": { params: { id: string }; result: null };
  "side.adopt": { params: { id: string }; result: Agent };
  "feedback.create": {
    params: { text: string; element: ElementInfo | null; screenshot: string | null; screenshotNote: string | null; screen?: ScreenContext | null; windowScreenshot?: string | null; thumb?: string | null };
    result: Feedback;
  };
  "feedback.sourceReady": { params: Record<string, never>; result: { ready: boolean } };
  "feedback.list": { params: Record<string, never>; result: Feedback[] };
  "feedback.revert": { params: { id: string }; result: Feedback };
  "feedback.restart": { params: { id: string }; result: Feedback };
  "feedback.retryChecks": { params: { id: string }; result: Feedback };
  "feedback.runAgain": { params: { id: string }; result: Feedback };
  "feedback.markSeen": { params: { id: string }; result: null };
  "daemon.restartIfIdle": { params: Record<string, never>; result: { restarted: boolean; busy: number; deferred?: boolean; inMs?: number } };
  "feedback.resolve": { params: { id: string }; result: Feedback };
  "feedback.dismiss": { params: { id: string }; result: Feedback };
  "inbox.get": { params: Record<string, never>; result: InboxState };
  "inbox.refresh": { params: Record<string, never>; result: InboxState };
  "inbox.markRead": { params: { ids: string[]; read: boolean }; result: InboxState };
  "inbox.archive": { params: { ids: string[]; archived: boolean }; result: InboxState };
  "inbox.thread": { params: { id: string }; result: InboxItem };
  "inbox.addToBoard": { params: { id: string; workspaceId?: string | null }; result: { item: InboxItem; card: BoardCard } };
  "inbox.reanalyze": { params: { id: string }; result: InboxState };
  "inbox.notRequest": { params: { id: string }; result: InboxState };
  "board.get": { params: Record<string, never>; result: Board };
  "board.createCard": { params: NewCard; result: BoardCard };
  "board.updateCard": { params: { id: string; patch: CardPatch }; result: BoardCard };
  "board.deleteCard": { params: { id: string }; result: null };
  "board.moveCard": { params: { id: string; columnId: string; index: number }; result: BoardCard };
  "board.linkAgent": { params: { cardId: string; agentId: string }; result: BoardCard };
  "board.unlinkAgent": { params: { cardId: string; agentId: string }; result: BoardCard };
  "board.addColumn": { params: { name: string }; result: BoardColumn };
  "board.renameColumn": { params: { id: string; name: string }; result: BoardColumn };
  "board.deleteColumn": { params: { id: string }; result: null };
  "board.moveColumn": { params: { id: string; index: number }; result: null };
  "board.setLabelColor": { params: { label: string; color: number | null }; result: null };
  "review.get": { params: Record<string, never>; result: ReviewState };
  "release.get": { params: Record<string, never>; result: ReleaseState };
  "release.dismiss": { params: { version: string }; result: ReleaseState };
  "review.run": { params: Record<string, never>; result: ReviewState };
  "review.apply": { params: { date: string; cardIds: string[] | null }; result: { review: ReviewState; applied: number; skipped: number } };
  "review.markSeen": { params: { date: string }; result: ReviewState };
  "followUps.get": { params: Record<string, never>; result: FollowUpsState };
  "followUps.check": { params: Record<string, never>; result: FollowUpsState };
  "followUps.snooze": { params: { id: string; choice: SnoozeChoice }; result: FollowUpsState };
  "followUps.wake": { params: { id: string }; result: FollowUpsState };
  "followUps.dismiss": { params: { id: string }; result: FollowUpsState };
  "followUps.keepOpen": { params: { agentId: string }; result: FollowUpsState };
  "notion.pins.list": { params: Record<string, never>; result: NotionPin[] };
  "notion.pins.add": { params: NotionPinInput; result: { pin: NotionPin; added: boolean } };
  "notion.pins.update": { params: { id: string; patch: NotionPinPatch }; result: NotionPin };
  "notion.pins.remove": { params: { id: string }; result: null };
  "notion.pins.move": { params: { id: string; index: number }; result: NotionPin[] };
  "notion.page.cached": { params: { url: string }; result: NotionPageView | null };
  "notion.page.read": { params: { url: string }; result: NotionPageView };
  "notion.chats.list": { params: Record<string, never>; result: Record<string, string> };
  "notion.chat.start": { params: { url: string; prompt: string; permissionMode: PermissionMode; model: string | null; effort: EffortLevel | null; images?: ImageRef[]; files?: FileRef[] }; result: Agent };
  "notion.chat.reset": { params: { url: string }; result: null };
  "agents.timelinePage": { params: { agentId: string; limit: number; beforeId?: string }; result: TimelinePage };
  "mobile.ping": { params: Record<string, never>; result: { now: number } };
  "mobile.status": { params: Record<string, never>; result: MobileStatus };
  "mobile.pairingCode": { params: Record<string, never>; result: PairingOffer };
  "mobile.revokeDevice": { params: { id: string }; result: MobileStatus };
  "import.vscodeList": { params: Record<string, never>; result: VscodeImportList };
  "import.vscodeRun": { params: { keys: string[] }; result: VscodeImportResult[] };
  "import.activity": { params: { agentId: string }; result: { active: boolean; lastWriteAt: string | null } };
  "search.replace": { params: { workspaceId: string; files: ReplaceFileRequest[] }; result: { results: ReplaceFileResult[] } };
};

export type NotionPageView = { page: Omit<NotionPageData, "enhanced">; fetchedAt: string; costUsd: number | null };

export type RpcMethod = keyof RpcMethods;

export type RpcRequest = { id: number; method: RpcMethod; params: unknown };

export type ServerEvent =
  | { type: "workspaces"; workspaces: Workspace[] }
  | { type: "modelPins"; pins: string[] }
  | { type: "sessionOrders"; orders: SessionOrders }
  | { type: "agent"; agent: Agent }
  | { type: "agentRemoved"; agentId: string }
  | { type: "showAgent"; agentId: string }
  | { type: "timelineUpsert"; agentId: string; item: TimelineItem }
  | { type: "timelineRemove"; agentId: string; itemId: string }
  | { type: "meta"; meta: Meta }
  | { type: "settings"; settings: Settings; defaults?: ResolvedDefaults }
  | { type: "changes"; agentId: string; changes: FileChange[] }
  | { type: "workspaceChanged"; workspaceIds: string[] }
  | { type: "diffFeedback"; agentId: string; items: DiffFeedback[] }
  | { type: "quick"; run: QuickRun }
  | { type: "side"; run: SideRun }
  | { type: "termask"; run: TermAskRun }
  | { type: "feedback"; feedback: Feedback }
  | { type: "board"; board: Board }
  | { type: "review"; review: ReviewState }
  | { type: "automations"; state: AutomationsState }
  | { type: "followUps"; state: FollowUpsState }
  | { type: "release"; release: ReleaseState }
  | { type: "notionPins"; pins: NotionPin[] }
  | { type: "notionChanged"; key: string }
  | { type: "notionChats"; chats: Record<string, string> }
  | { type: "notionStartSession"; agentId: string; prompt: string }
  | { type: "inbox"; inbox: InboxState }
  | { type: "reload"; restarting: boolean; immediate?: boolean }
  | { type: "browserTool"; id: string; agentId: string; pageId: string; tool: BrowserToolName; args: Record<string, unknown> }
  | { type: "browserOpen"; id: string; agentId: string; url: string | null; forceNew: boolean };

export type ServerMessage =
  | { id: number; result: unknown }
  | { id: number; error: string }
  | { event: ServerEvent };
