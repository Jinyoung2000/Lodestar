import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { ANALYSIS_BUDGET_MAX_USD, ANALYSIS_BUDGET_MIN_USD } from "../shared/analysisBudget";
import { sanitizeEditorOptions } from "../shared/editorOptions";
import { sanitizeKeymapOverrides } from "../shared/keymapOverrides";
import { SLACK_LINK_TARGETS } from "../shared/slackLink";
import { NOTION_LINK_TARGETS } from "../shared/notionLink";
import { parseReviewTime, REVIEW_DEFAULT_TIME } from "../shared/morningReview"; // MORNINGREVIEW
import { parseAccelerator, QUICK_ENTRY_DEFAULT_SHORTCUT } from "../shared/quickEntry"; // QUICKENTRY
import { DEFAULT_NOTION_BYPASS_WRITES, NOTION_BYPASS_WRITES } from "../shared/notionApproval"; // NOTION3
import { realDir } from "./paths";
import { perfNote } from "./perfStats";
import { removeFolder, restoreFolder, type RemovedFolder } from "./removedFolders";
import { settleStale } from "./subagents";
import { parseOrderIds, parseOrderScope, parentOfKidsScope, pruneSessionOrders, type SessionOrders } from "../shared/sessionOrder"; // SESSIONORDER
import type { DiffFeedback } from "../shared/protocol";
import { BROWSER_PAGE_ZOOMS, BROWSER_SEARCH_ENGINES, BROWSER_STORAGES, BROWSER_TITLE_BAR, DIFF_VIEWS, EDITOR_FONT_DEFAULTS, EFFORT_LEVELS, KEYMAP_PRESETS, THEME_STYLES, UI_TYPE_DEFAULTS, UI_TYPE_RANGES, type Agent, type FileChange, type Settings, type TimelineItem, type Workspace } from "../shared/protocol";

export const HOME = process.env.AGENT_NAV_HOME ?? join(homedir(), ".agent-nav");
const STATE_FILE = join(HOME, "state.json");
const SETTINGS_FILE = join(HOME, "settings.json");
const TIMELINE_DIR = join(HOME, "timelines");
const CHANGES_DIR = join(HOME, "changes");
// DIFFFB: 세션별로 쌓은 diff 피드백
const DIFF_FEEDBACK_DIR = join(HOME, "diff-feedback");

// PERFDAEMON: state.json 은 세션 상태가 바뀔 때마다 통째로(223KB, 들여쓰기 포함) 다시 썼다. 한 턴에 7~8번. 이 시간 안의 변경은 한 번에 쓴다. 0 이면 바로 쓴다(시험).
// 종료와 재시작은 flush() 가 남은 것을 쓴다. 비정상 종료로 잃을 수 있는 것은 마지막 이 시간의 상태 변화뿐이다(세션 기록은 Claude 의 jsonl 에 따로 있다).
// 메모리에 둘 타임라인 수의 상한(살아 있는 세션과 저장이 밀린 것은 이 수를 넘어도 둔다)
const TIMELINE_CACHE_LIMIT = Number(process.env.AGENT_NAV_TIMELINE_CACHE ?? 24);
const STATE_SAVE_DELAY_MS = Number(process.env.AGENT_NAV_SAVE_DELAY_MS ?? 300);
// 타임라인을 쓰지 못했을 때(디스크 가득 등) 다시 써 보는 간격
const TIMELINE_RETRY_MS = 5000;
// 지난번 시작 때 읽힌 state.json 의 사본. state.json 을 읽을 수 없을 때만 쓴다.
const STATE_BACKUP = `${STATE_FILE}.bak`;

// 임시 파일에 쓴 뒤 rename 으로 바꾼다(server/board.ts 와 같은 방식). 쓰는 도중 데몬이 죽거나 디스크가 차도 원래 파일이 비거나 반쪽으로 남지 않는다.
// 대화와 파일 내용이 든 파일이라 이 사용자만 읽게 만든다.
function writeFileAtomic(file: string, text: string) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, text, { mode: 0o600 });
    renameSync(tmp, file);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

// 읽을 수 없는 파일은 덮어쓰지 않고 옆으로 치운다(server/board.ts 와 같다). 그대로 두면 다음 저장이 사용자의 기록을 빈 값으로 덮거나, 읽을 때마다 던져서 세션을 열 수 없다.
function setAside(file: string, error: unknown) {
  const aside = `${file}.corrupt-${Date.now()}`;
  try {
    renameSync(file, aside);
  } catch {
    // 치우지 못해도 빈 값으로 계속한다
  }
  console.error(`[store] ${file} could not be read (${(error as Error).message}). It was kept as ${aside}`);
}

// 세션 id 로 그 세션의 파일 경로를 만든다. id 는 화면이 보낸 값이 확인 없이 들어오기도 해서(agents.timeline, changes.list, changes.set) 경로 조각이 섞인 값은 거절한다.
// 받아 주면 "../../x" 같은 id 가 이 폴더 밖의 .json 을 읽고, 쓰고, 읽을 수 없는 파일로 보고 옆으로 치우게 된다.
function sessionFile(dir: string, agentId: string) {
  if (typeof agentId !== "string" || !agentId || agentId === "." || agentId === ".." || basename(agentId) !== agentId) throw new Error(`Unknown agent: ${String(agentId)}`);
  return join(dir, `${agentId}.json`);
}

// 세션별 목록 파일(타임라인, 수정 전 내용, diff 피드백). 없으면 빈 목록이다.
function readList<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  try {
    const list: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray(list)) throw new Error("not a list");
    return list as T[];
  } catch (error) {
    setAside(file, error);
    return [];
  }
}

// removed 는 목록에서 뺀 폴더가 맡겨 둔 세션들(server/removedFolders.ts)
// sessionOrders 는 사이드바에서 손으로 정한 세션 순서(shared/sessionOrder.ts)
type State = { workspaces: Workspace[]; agents: Agent[]; removed?: RemovedFolder[]; sessionOrders?: SessionOrders };

// state.json 을 읽는다. 읽을 수 없으면(빈 파일, 반쪽 파일, 모양이 다름) 덮어쓰지 않고 옆으로 치운 뒤 지난번 시작 때 읽힌 사본으로 시작한다. 사본도 없으면 빈 상태다.
// 예전에는 여기서 던져서 데몬이 뜨지 못했고, 파일을 손으로 고치기 전에는 앱을 열 수 없었다.
function loadState(): State {
  const read = (file: string) => {
    const state = JSON.parse(readFileSync(file, "utf8")) as State | null;
    if (!state || !Array.isArray(state.workspaces) || !Array.isArray(state.agents)) throw new Error("not a state file");
    return state;
  };
  if (!existsSync(STATE_FILE)) return { workspaces: [], agents: [] };
  try {
    const state = read(STATE_FILE);
    try {
      copyFileSync(STATE_FILE, STATE_BACKUP);
      chmodSync(STATE_BACKUP, 0o600);
    } catch {
      // 사본을 못 남겨도 시작은 한다
    }
    return state;
  } catch (error) {
    setAside(STATE_FILE, error);
    try {
      const state = read(STATE_BACKUP);
      console.error(`[store] started from ${STATE_BACKUP}`);
      return state;
    } catch {
      return { workspaces: [], agents: [] };
    }
  }
}

// 이 버전부터 기본값 4종(권한, 모델, effort, diff 자동 전환)은 사용자가 고른 값만 담고, 고르지 않았으면 null 이다.
export const SETTINGS_VERSION = 2;
const PERMISSION_MODES = ["default", "acceptEdits", "plan", "auto", "bypassPermissions"];

const DEFAULT_SETTINGS: Settings = {
  settingsVersion: SETTINGS_VERSION,
  theme: "dark",
  themeStyle: "lodestar",
  defaultPermissionMode: null,
  defaultModel: null,
  defaultEffort: null,
  diffInlineWhenNarrow: null,
  requestQueuing: null,
  previewEditors: null,
  revealIfOpen: true,
  quickOpenIncludeExcluded: false,
  editorOptions: {},
  quickModel: "haiku",
  quickEntryEnabled: true,
  quickEntryShortcut: QUICK_ENTRY_DEFAULT_SHORTCUT,
  miniChatHideOnBlur: false,
  showSlack: false,
  showBoard: false,
  boardAutoMove: true,
  morningReviewEnabled: true,
  morningReviewTime: REVIEW_DEFAULT_TIME,
  notifyOnResponse: true,
  notifyOnApproval: true,
  // RELEASE: 켜야만 GitHub 에 묻는다(server/releaseCheck.ts)
  notifyNewVersion: false,
  useProviderEnv: false,
  inboxIntervalMinutes: 0,
  keepIdleSessionsWarmMinutes: 10,
  maxWarmSessions: 4,
  feedbackAutoTidy: false,
  // 켜야만 돈다: 소스 폴더(AGENT_NAV_SRC, 없으면 ~/Repository/agent-nav 로 짐작)에서 빌드를 돌리고 /Applications 의 앱을 갈아 끼우는 일이라, 사용자가 고르지 않았는데 하지 않는다(server/idleUpdate.ts).
  autoUpdateWhenIdle: false,
  autoAddRequests: false,
  mentionAnalysisModel: "sonnet",
  mentionAnalysisBudgetUsd: null,
  slackTeamId: "",
  slackLinkTarget: "app",
  notionLinkTarget: "lodestar",
  notionBypassWrites: DEFAULT_NOTION_BYPASS_WRITES,
  focusGuard: true,
  diffView: "inline",
  keymapPreset: "vscode",
  browserSearchEngine: "bing",
  browserMaxHistory: 200,
  browserChatTools: true,
  browserPageZoom: null,
  browserAttachElementImage: true,
  browserOpenLocalhostLinks: true,
  browserDataStorage: "default",
  browserAutoReload: true,
  browserShowInTitleBar: "whenOpen",
  browserUserTools: false,
  formatOnSave: null,
  formatters: {},
  defaultLayout: null,
  rememberLastLayout: false,
  rememberLayoutPerSession: true,
  expandSteps: false,
  pinnedPanelSide: null,
  chatInEditorLayout: null,
  mobileAccess: false,
  ...EDITOR_FONT_DEFAULTS,
  ...UI_TYPE_DEFAULTS,
};

// 버전이 없는 옛 설정 파일은 옛 내장 기본값(default, null, null)이 "고른 값"처럼 기록돼 있다. 그 값과 같으면 고른 게 아니라 기본값이 적힌 것으로 보고 null 로 옮긴다.
// 옛 기본값과 다른 값은 사용자가 고른 것이라 그대로 둔다. 옛 파일에는 diffInlineWhenNarrow 가 없다.
export function migrateSettings(raw: Partial<Settings>): { settings: Partial<Settings>; migrated: boolean } {
  if ((raw.settingsVersion ?? 0) >= SETTINGS_VERSION) return { settings: raw, migrated: false };
  const next: Partial<Settings> = { ...raw, settingsVersion: SETTINGS_VERSION };
  if (next.defaultPermissionMode === "default" || next.defaultPermissionMode === undefined) next.defaultPermissionMode = null;
  if (next.defaultModel === "default" || next.defaultModel === undefined) next.defaultModel = null;
  if (next.defaultEffort === undefined) next.defaultEffort = null;
  return { settings: next, migrated: true };
}

// 글꼴 크기와 줄 높이는 화면이 깨지지 않는 범위로만 받는다. 빈 글꼴 이름은 기본값으로 되돌린다.
function sanitizeSettings(patch: Partial<Settings>): Partial<Settings> {
  const next = { ...patch };
  const finite = (v: unknown, min: number, max: number) => typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
  if ("editorFontSize" in next && !finite(next.editorFontSize, 8, 32)) delete next.editorFontSize;
  if ("editorLineHeight" in next && !finite(next.editorLineHeight, 10, 64)) delete next.editorLineHeight;
  if ("editorFontFamily" in next && (typeof next.editorFontFamily !== "string" || !next.editorFontFamily.trim())) next.editorFontFamily = EDITOR_FONT_DEFAULTS.editorFontFamily;
  // UI 글자: 범위 밖 값은 거절(기존 값 유지), 자간은 0.01 단위로 반올림, 빈 글꼴 이름은 기본값으로.
  for (const key of ["uiLetterSpacing", "chatFontSize", "chatLineHeight"] as const) {
    if (key in next && !finite(next[key], UI_TYPE_RANGES[key].min, UI_TYPE_RANGES[key].max)) delete next[key];
  }
  if (typeof next.uiLetterSpacing === "number") next.uiLetterSpacing = Math.round(next.uiLetterSpacing * 100) / 100;
  if ("uiFontFamily" in next && (typeof next.uiFontFamily !== "string" || !next.uiFontFamily.trim())) next.uiFontFamily = UI_TYPE_DEFAULTS.uiFontFamily;
  if ("editorLigatures" in next && typeof next.editorLigatures !== "boolean") delete next.editorLigatures;
  if ("boardAutoMove" in next && typeof next.boardAutoMove !== "boolean") delete next.boardAutoMove;
  for (const key of ["showSlack", "showBoard"] as const) if (key in next && typeof next[key] !== "boolean") delete next[key];
  if ("quickEntryEnabled" in next && typeof next.quickEntryEnabled !== "boolean") delete next.quickEntryEnabled;
  if ("miniChatHideOnBlur" in next && typeof next.miniChatHideOnBlur !== "boolean") delete next.miniChatHideOnBlur;
  if ("quickEntryShortcut" in next) {
    const accelerator = parseAccelerator(next.quickEntryShortcut);
    if (accelerator) next.quickEntryShortcut = accelerator;
    else delete next.quickEntryShortcut;
  }
  if ("morningReviewEnabled" in next && typeof next.morningReviewEnabled !== "boolean") delete next.morningReviewEnabled;
  if ("morningReviewTime" in next) {
    const time = parseReviewTime(next.morningReviewTime);
    if (time) next.morningReviewTime = `${String(time.hour).padStart(2, "0")}:${String(time.minute).padStart(2, "0")}`;
    else delete next.morningReviewTime;
  }
  if ("notifyOnResponse" in next && typeof next.notifyOnResponse !== "boolean") delete next.notifyOnResponse;
  if ("notifyOnApproval" in next && typeof next.notifyOnApproval !== "boolean") delete next.notifyOnApproval;
  if ("notifyNewVersion" in next && typeof next.notifyNewVersion !== "boolean") delete next.notifyNewVersion;
  if ("useProviderEnv" in next && typeof next.useProviderEnv !== "boolean") delete next.useProviderEnv;
  if ("inboxIntervalMinutes" in next && !(Number.isInteger(next.inboxIntervalMinutes) && finite(next.inboxIntervalMinutes, 0, 120))) delete next.inboxIntervalMinutes;
  if ("keepIdleSessionsWarmMinutes" in next && !(Number.isInteger(next.keepIdleSessionsWarmMinutes) && finite(next.keepIdleSessionsWarmMinutes, 0, 1440))) delete next.keepIdleSessionsWarmMinutes;
  if ("feedbackAutoTidy" in next && typeof next.feedbackAutoTidy !== "boolean") delete next.feedbackAutoTidy;
  if ("autoUpdateWhenIdle" in next && typeof next.autoUpdateWhenIdle !== "boolean") delete next.autoUpdateWhenIdle;
  if ("maxWarmSessions" in next && !(Number.isInteger(next.maxWarmSessions) && finite(next.maxWarmSessions, 0, 50))) delete next.maxWarmSessions;
  if ("autoAddRequests" in next && typeof next.autoAddRequests !== "boolean") delete next.autoAddRequests;
  if ("mentionAnalysisModel" in next && !(typeof next.mentionAnalysisModel === "string" && ["sonnet", "haiku", "opus"].includes(next.mentionAnalysisModel))) delete next.mentionAnalysisModel;
  if ("mentionAnalysisBudgetUsd" in next && next.mentionAnalysisBudgetUsd !== null && !finite(next.mentionAnalysisBudgetUsd, ANALYSIS_BUDGET_MIN_USD, ANALYSIS_BUDGET_MAX_USD)) delete next.mentionAnalysisBudgetUsd;
  // 비워서 지우거나 T 로 시작하는 워크스페이스 ID 만 받는다.
  if ("slackTeamId" in next && !(typeof next.slackTeamId === "string" && /^(|T[0-9A-Z]{6,20})$/.test(next.slackTeamId.trim()))) delete next.slackTeamId;
  else if (typeof next.slackTeamId === "string") next.slackTeamId = next.slackTeamId.trim();
  if ("editorFontTerminal" in next && typeof next.editorFontTerminal !== "boolean") delete next.editorFontTerminal;
  // 기본값 4종: null 은 "고르지 않음". 모델 "default" 는 CLI 의 기본이라 고르지 않음과 같다.
  if ("defaultPermissionMode" in next && next.defaultPermissionMode !== null && !PERMISSION_MODES.includes(next.defaultPermissionMode as string)) delete next.defaultPermissionMode;
  if ("defaultModel" in next) {
    if (next.defaultModel === "default" || next.defaultModel === "") next.defaultModel = null;
    else if (next.defaultModel !== null && typeof next.defaultModel !== "string") delete next.defaultModel;
  }
  if ("defaultEffort" in next && next.defaultEffort !== null && !EFFORT_LEVELS.includes(next.defaultEffort as never)) delete next.defaultEffort;
  if ("diffInlineWhenNarrow" in next && next.diffInlineWhenNarrow !== null && typeof next.diffInlineWhenNarrow !== "boolean") delete next.diffInlineWhenNarrow;
  if ("requestQueuing" in next && next.requestQueuing !== null && next.requestQueuing !== "queue" && next.requestQueuing !== "steer") delete next.requestQueuing;
  if ("previewEditors" in next && next.previewEditors !== null && typeof next.previewEditors !== "boolean") delete next.previewEditors;
  if ("revealIfOpen" in next && typeof next.revealIfOpen !== "boolean") delete next.revealIfOpen;
  if ("quickOpenIncludeExcluded" in next && typeof next.quickOpenIncludeExcluded !== "boolean") delete next.quickOpenIncludeExcluded;
  // EDPARITY: 에디터 동작 설정은 알려진 키와 허용 값만 남긴다(통째로 바꾼다).
  if ("editorOptions" in next) next.editorOptions = sanitizeEditorOptions(next.editorOptions);
  // G7: Browser 탭 설정
  if ("browserSearchEngine" in next && !BROWSER_SEARCH_ENGINES.includes(next.browserSearchEngine as never)) delete next.browserSearchEngine;
  if ("browserMaxHistory" in next && !(Number.isInteger(next.browserMaxHistory) && finite(next.browserMaxHistory, 0, 10000))) delete next.browserMaxHistory;
  for (const key of ["browserChatTools", "browserAttachElementImage", "browserOpenLocalhostLinks", "browserAutoReload", "browserUserTools"] as const) if (key in next && typeof next[key] !== "boolean") delete next[key];
  if ("browserDataStorage" in next && !BROWSER_STORAGES.includes(next.browserDataStorage as never)) delete next.browserDataStorage;
  if ("browserShowInTitleBar" in next && !BROWSER_TITLE_BAR.includes(next.browserShowInTitleBar as never)) delete next.browserShowInTitleBar;
  if ("browserPageZoom" in next && next.browserPageZoom !== null && !BROWSER_PAGE_ZOOMS.includes(next.browserPageZoom as never)) delete next.browserPageZoom;
  if ("formatOnSave" in next && next.formatOnSave !== null && typeof next.formatOnSave !== "boolean") delete next.formatOnSave;
  // FMT: 언어별 포맷터는 알려진 포맷터 이름만 받는다
  if ("formatters" in next) {
    const given = next.formatters && typeof next.formatters === "object" && !Array.isArray(next.formatters) ? Object.entries(next.formatters) : [];
    next.formatters = Object.fromEntries(given.filter(([, id]) => id === "eslint" || id === "prettier" || id === "oxc" || id === "tsserver")) as Settings["formatters"];
  }
  // FLOAT: 배치. 알려진 두 값과 null 만 받는다.
  if ("defaultLayout" in next && next.defaultLayout !== null && next.defaultLayout !== "chat" && next.defaultLayout !== "editor") delete next.defaultLayout;
  if ("rememberLastLayout" in next && typeof next.rememberLastLayout !== "boolean") delete next.rememberLastLayout;
  if ("rememberLayoutPerSession" in next && typeof next.rememberLayoutPerSession !== "boolean") delete next.rememberLayoutPerSession;
  if ("expandSteps" in next && typeof next.expandSteps !== "boolean") delete next.expandSteps;
  if ("pinnedPanelSide" in next && next.pinnedPanelSide !== null && next.pinnedPanelSide !== "left" && next.pinnedPanelSide !== "right") delete next.pinnedPanelSide;
  if ("mobileAccess" in next && typeof next.mobileAccess !== "boolean") delete next.mobileAccess;
  if ("chatInEditorLayout" in next && next.chatInEditorLayout !== null && next.chatInEditorLayout !== "docked" && next.chatInEditorLayout !== "floating") delete next.chatInEditorLayout;
  // 버전은 데몬만 쓴다
  delete next.settingsVersion;
  // diff 기본 보기는 정해진 두 값만 받는다.
  if ("diffView" in next && !DIFF_VIEWS.includes(next.diffView as never)) delete next.diffView;
  if ("keymapPreset" in next && !KEYMAP_PRESETS.includes(next.keymapPreset as never)) delete next.keymapPreset;
  if ("keymapOverrides" in next) next.keymapOverrides = sanitizeKeymapOverrides(next.keymapOverrides);
  if ("themeStyle" in next && !THEME_STYLES.includes(next.themeStyle as never)) delete next.themeStyle;
  if ("slackLinkTarget" in next && !SLACK_LINK_TARGETS.includes(next.slackLinkTarget as never)) delete next.slackLinkTarget;
  if ("notionLinkTarget" in next && !NOTION_LINK_TARGETS.includes(next.notionLinkTarget as never)) delete next.notionLinkTarget;
  if ("focusGuard" in next && typeof next.focusGuard !== "boolean") delete next.focusGuard;
  if ("notionBypassWrites" in next && !NOTION_BYPASS_WRITES.includes(next.notionBypassWrites as never)) delete next.notionBypassWrites;
  return next;
}

export class Store {
  private state: State;
  private settingsValue: Settings;
  private timelines = new Map<string, TimelineItem[]>();
  private changesCache = new Map<string, FileChange[]>();
  private diffFeedbackCache = new Map<string, DiffFeedback[]>();
  private saveTimers = new Map<string, NodeJS.Timeout>();
  private stateTimer: NodeJS.Timeout | null = null;
  // 마지막 state.json 쓰기가 실패했다. 다음 변경이 없어도 flush() 가 다시 쓴다.
  private stateUnsaved = false;
  // 이 데몬이 뜰 때 응답 중(running, waiting)으로 기록돼 있던 세션: 이전 데몬이 죽거나 꺼지면서 응답이 끊겼다. server/index.ts 가 표시한다.
  readonly cutOffOnStart: string[] = [];
  // 폴더를 다시 추가해 숨겼던 세션이 돌아올 때 화면들에 알리는 곳(server/index.ts 가 건다)
  onRestored: ((agents: Agent[]) => void) | null = null;

  constructor() {
    mkdirSync(TIMELINE_DIR, { recursive: true });
    mkdirSync(CHANGES_DIR, { recursive: true });
    mkdirSync(DIFF_FEEDBACK_DIR, { recursive: true });
    // 대화, 파일 내용, 토큰이 든 폴더라 이 사용자만 들어오게 한다(기본 권한은 같은 맥의 다른 계정이 읽을 수 있다). 다른 모듈이 여기에 쓰는 파일도 함께 가려진다.
    try {
      chmodSync(HOME, 0o700);
    } catch {
      // 권한을 못 바꿔도 시작은 한다
    }
    this.state = loadState();
    for (const workspace of [...this.state.workspaces, ...(this.state.removed ?? []).flatMap((r) => r.workspaces)]) workspace.parentId ??= null;
    for (const agent of [...this.state.agents, ...(this.state.removed ?? []).flatMap((r) => r.agents)]) this.fill(agent);
    if (this.normalizePaths()) this.save();
    const stored = existsSync(SETTINGS_FILE) ? migrateSettings(this.readSettings()) : { settings: {}, migrated: false };
    this.settingsValue = { ...DEFAULT_SETTINGS, ...stored.settings };
    if (stored.migrated) writeFileAtomic(SETTINGS_FILE, JSON.stringify(this.settingsValue, null, 2));
    // 손으로 고친 settings.json 에 이상한 값이 있어도 기본값으로 되돌린다.
    if (!DIFF_VIEWS.includes(this.settingsValue.diffView)) this.settingsValue.diffView = DEFAULT_SETTINGS.diffView;
    if (!KEYMAP_PRESETS.includes(this.settingsValue.keymapPreset)) this.settingsValue.keymapPreset = DEFAULT_SETTINGS.keymapPreset;
    if (this.settingsValue.keymapOverrides !== undefined) this.settingsValue.keymapOverrides = sanitizeKeymapOverrides(this.settingsValue.keymapOverrides);
    if (!THEME_STYLES.includes(this.settingsValue.themeStyle)) this.settingsValue.themeStyle = DEFAULT_SETTINGS.themeStyle;
  }

  // 손으로 고치다 문법이 틀린 settings.json 은 옆으로 치우고 기본값으로 시작한다(예전에는 데몬이 뜨지 못했다). 치워 두므로 다음 설정 저장이 그 파일을 덮지 않는다.
  private readSettings(): Partial<Settings> {
    try {
      const raw: unknown = JSON.parse(readFileSync(SETTINGS_FILE, "utf8"));
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("not a settings object");
      return raw as Partial<Settings>;
    } catch (error) {
      setAside(SETTINGS_FILE, error);
      return { settingsVersion: SETTINGS_VERSION };
    }
  }

  // 옛 기록에 없는 필드를 채우고, 데몬이 재시작되며 사라진 실행 상태를 되돌린다.
  private fill(agent: Agent) {
    // 데몬이 재시작되면 실행 중이던 턴은 사라진다.
    if (agent.status === "running" || agent.status === "waiting") this.cutOffOnStart.push(agent.id);
    if (agent.status !== "idle") agent.status = "idle";
    // v1 에서 만든 레코드에는 없는 필드를 채운다.
    agent.model ??= null;
    agent.effort ??= null;
    agent.activeModel ??= null;
    agent.activeEffort ??= null;
    agent.backgroundTasks = 0;
    // 데몬이 죽으면 모델이 받지 못한 끼어들기 메시지는 사라진 프로세스 입력에만 있었다. 글이 사라지지 않게 큐 앞으로 돌려보낸다.
    if (agent.steering?.length) {
      agent.queue = [...agent.steering.map(({ sent: _sent, ...s }) => ({ ...s, id: randomUUID() })), ...(agent.queue ?? [])];
      delete agent.steering;
    }
    agent.cwd ??= this.state.workspaces.find((w) => w.id === agent.workspaceId)?.dir ?? "";
    agent.worktree ??= null;
    agent.forkedFrom ??= null;
    agent.resumeFrom ??= null;
    agent.startCommit ??= null;
    agent.feedbackId ??= null;
  }

  // 저장된 폴더 경로를 심볼릭 링크를 푼 실제 경로로 맞춘다(옛 데이터의 /tmp/x 는 git 이 주는 /private/tmp/x 와 달라 경로 검사가 거절했다).
  // 맞추고 나서 같은 폴더가 둘이 되면 하나로 합치고 세션과 부모 참조를 앞의 것으로 옮긴다. 바뀐 게 있으면 true.
  private normalizePaths() {
    let changed = false;
    const keep: Workspace[] = [];
    const renamed = new Map<string, string>();
    for (const workspace of this.state.workspaces) {
      const dir = realDir(workspace.dir);
      if (dir !== workspace.dir) {
        workspace.dir = dir;
        changed = true;
      }
      const same = keep.find((w) => w.dir === workspace.dir && w.parentId === workspace.parentId && !!w.feedback === !!workspace.feedback);
      if (same) {
        renamed.set(workspace.id, same.id);
        changed = true;
      } else keep.push(workspace);
    }
    if (renamed.size) {
      this.state.workspaces = keep;
      for (const workspace of keep) if (workspace.parentId && renamed.has(workspace.parentId)) workspace.parentId = renamed.get(workspace.parentId)!;
      for (const agent of this.state.agents) if (agent.workspaceId && renamed.has(agent.workspaceId)) agent.workspaceId = renamed.get(agent.workspaceId)!;
    }
    for (const agent of this.state.agents) {
      if (agent.workspaceId !== null && agent.cwd) {
        const cwd = realDir(agent.cwd);
        if (cwd !== agent.cwd) {
          agent.cwd = cwd;
          changed = true;
        }
      }
      if (agent.worktree) {
        const root = realDir(agent.worktree.root);
        if (root !== agent.worktree.root) {
          agent.worktree = { ...agent.worktree, root };
          changed = true;
        }
      }
    }
    return changed;
  }

  // 목록: 치워진(archived) 피드백 워크스페이스는 뺀다. id 로 찾는 workspace() 는 치워진 것도 찾는다.
  get workspaces() {
    return this.state.workspaces.some((w) => w.archived) ? this.state.workspaces.filter((w) => !w.archived) : this.state.workspaces;
  }

  // PERFDAEMON: 끝난 피드백의 worktree 를 치운 뒤 그 워크스페이스를 목록에서 뺀다. 이 워크스페이스에 아직 다른 세션이 있으면 그대로 둔다.
  archiveWorkspace(id: string) {
    const workspace = this.state.workspaces.find((w) => w.id === id);
    if (!workspace?.feedback || workspace.archived) return false;
    if (this.state.agents.some((a) => a.workspaceId === id && !a.feedbackId)) return false;
    workspace.archived = true;
    this.save();
    return true;
  }

  get agents() {
    return this.state.agents;
  }

  get sessionOrders(): SessionOrders {
    return this.state.sessionOrders ?? {};
  }

  // SESSIONORDER: scope 하나의 순서를 통째로 바꾼다. 없는 세션 id 는 빼고, 비게 되면 그 scope 의 순서를 지운다(기본 정렬로 돌아간다).
  // 알 수 없는 워크스페이스, 부모 세션의 scope 와 모양이 틀린 입력은 던진다.
  setSessionOrder(scope: unknown, ids: unknown): SessionOrders {
    const parsed = parseOrderScope(scope);
    if (!parsed) throw new Error("Invalid session order scope");
    if (parsed.kind === "workspace" && !this.allWorkspaceIds.has(parsed.scope)) throw new Error(`Unknown workspace: ${parsed.scope}`);
    if (parsed.kind === "kids" && !this.allAgentIds.has(parentOfKidsScope(parsed.scope))) throw new Error(`Unknown session: ${parentOfKidsScope(parsed.scope)}`);
    // FOLDERS_SCOPE 는 세션이 아니라 워크스페이스 id 를 담는다(최상위 폴더 묶음 순서)
    const known = parsed.kind === "folders" ? this.allWorkspaceIds : this.allAgentIds;
    const live = parseOrderIds(ids).filter((id) => known.has(id));
    return this.writeSessionOrders({ ...this.sessionOrders, [parsed.scope]: live });
  }

  // 여러 scope 의 순서를 지운다. 모양이 틀린 scope 가 하나라도 있으면 아무것도 지우지 않고 던진다.
  resetSessionOrders(scopes: unknown): SessionOrders {
    if (!Array.isArray(scopes) || scopes.length > 1000) throw new Error("scopes must be an array of session order scopes");
    const parsed = scopes.map((scope) => parseOrderScope(scope)?.scope ?? null);
    if (parsed.includes(null)) throw new Error("Invalid session order scope");
    const next = { ...this.sessionOrders };
    for (const scope of parsed) delete next[scope as string];
    return this.writeSessionOrders(next);
  }

  private writeSessionOrders(orders: SessionOrders): SessionOrders {
    this.state.sessionOrders = pruneSessionOrders(orders, { agents: this.allAgentIds, workspaces: this.allWorkspaceIds });
    this.save();
    return this.state.sessionOrders;
  }

  get settings() {
    return this.settingsValue;
  }

  updateSettings(patch: Partial<Settings>) {
    this.settingsValue = { ...this.settingsValue, ...sanitizeSettings(patch) };
    writeFileAtomic(SETTINGS_FILE, JSON.stringify(this.settingsValue, null, 2));
    return this.settingsValue;
  }

  workspace(id: string) {
    const workspace = this.state.workspaces.find((w) => w.id === id);
    if (!workspace) throw new Error(`Unknown workspace: ${id}`);
    return workspace;
  }

  agent(id: string) {
    const agent = this.state.agents.find((a) => a.id === id);
    if (!agent) throw new Error(`Unknown agent: ${id}`);
    return agent;
  }

  // 저장하는 폴더는 git 이 주는 경로와 같은 글자여야 해서 실제 경로로 맞춘다(/tmp/x 로 등록해도 /private/tmp/x 가 저장된다). 이름은 입력한 경로에서 만든다.
  addWorkspace(input: string, parentId: string | null = null, name = basename(input), feedback = false) {
    const dir = realDir(input);
    const existing = this.state.workspaces.find((w) => w.dir === dir);
    if (existing) return existing;
    // 목록에서 뺐던 폴더를 다시 추가하면 맡겨 둔 세션이 함께 돌아온다
    const restored = parentId === null && !feedback ? restoreFolder(this.state, dir) : null;
    if (restored) {
      this.save();
      this.onRestored?.(restored.agents);
      return restored.workspace;
    }
    const workspace: Workspace = { id: randomUUID(), name, dir, parentId, ...(feedback ? { feedback: true } : {}) };
    this.state.workspaces.push(workspace);
    this.save();
    return workspace;
  }

  // fix5-3: 폴더가 디스크에서 옮겨졌거나 지워졌다 다시 생겼을 때 같은 워크스페이스를 새 경로에 잇는다. 폴더 안 세션(worktree 가 아닌 것)의 작업 폴더는 옛 경로 접두만 새 경로로 바꾼다.
  // 이미 그 폴더를 가리키는 다른 워크스페이스가 있으면 던진다(둘로 갈라진 같은 폴더를 만들지 않는다).
  relocateWorkspace(id: string, input: string) {
    const workspace = this.workspace(id);
    const dir = realDir(input);
    if (this.state.workspaces.some((w) => w.id !== id && w.dir === dir && w.parentId === workspace.parentId && !!w.feedback === !!workspace.feedback)) throw new Error(`Another workspace already uses ${dir}`);
    const old = workspace.dir;
    workspace.dir = dir;
    const moved: Agent[] = [];
    for (const agent of this.state.agents) {
      if (agent.workspaceId !== id || agent.worktree) continue;
      if (agent.cwd === old) agent.cwd = dir;
      else if (agent.cwd.startsWith(`${old}/`)) agent.cwd = `${dir}${agent.cwd.slice(old.length)}`;
      else continue;
      moved.push(agent);
    }
    this.save();
    return { workspace, moved };
  }

  // 같은 폴더를 쓰는 다른 세션이 없으면 worktree 용 워크스페이스를 정리한다.
  removeWorkspaceIfUnused(id: string) {
    const workspace = this.state.workspaces.find((w) => w.id === id);
    if (!workspace || (!workspace.parentId && !workspace.feedback)) return;
    if (this.state.agents.some((a) => a.workspaceId === id)) return;
    this.state.workspaces = this.state.workspaces.filter((w) => w.id !== id);
    this.save();
  }

  // 목록에서 폴더를 뺀다. 세션은 지우지 않고 숨겨 두며(server/removedFolders.ts), 도는 세션이 있으면 던진다. 디스크의 파일과 git worktree 는 건드리지 않는다.
  removeFolderFromList(id: string) {
    const result = removeFolder(this.state, id);
    this.save();
    return result;
  }

  // 숨겨 둔 세션까지 포함한 id. 보드 카드가 숨긴 세션과의 연결을 잃지 않게 prune 에 쓴다.
  get allAgentIds() {
    return new Set([...this.state.agents, ...(this.state.removed ?? []).flatMap((r) => r.agents)].map((a) => a.id));
  }

  get allWorkspaceIds() {
    return new Set([...this.state.workspaces, ...(this.state.removed ?? []).flatMap((r) => r.workspaces)].map((w) => w.id));
  }

  addAgent(agent: Agent, items: TimelineItem[] = []) {
    this.state.agents.push(agent);
    this.timelines.set(agent.id, items);
    if (items.length) this.scheduleTimelineSave(agent.id);
    this.save();
  }

  updateAgent(id: string, patch: Partial<Agent>) {
    const agent = this.agent(id);
    Object.assign(agent, patch, { updatedAt: new Date().toISOString() });
    this.save();
    return agent;
  }

  // B1: 읽음, 고정, 완료, 이름처럼 세션의 활동이 아닌 변경. updatedAt 을 올리지 않는다.
  patchAgent(id: string, patch: Partial<Agent>) {
    const agent = this.agent(id);
    Object.assign(agent, patch);
    this.save();
    return agent;
  }

  removeAgent(id: string) {
    this.state.agents = this.state.agents.filter((a) => a.id !== id);
    this.timelines.delete(id);
    this.changesCache.delete(id);
    rmSync(sessionFile(TIMELINE_DIR, id), { force: true });
    rmSync(sessionFile(CHANGES_DIR, id), { force: true });
    this.diffFeedbackCache.delete(id);
    rmSync(sessionFile(DIFF_FEEDBACK_DIR, id), { force: true });
    this.save();
  }

  timeline(agentId: string) {
    let items = this.timelines.get(agentId);
    if (!items) {
      const file = sessionFile(TIMELINE_DIR, agentId);
      items = settleStale(readList<TimelineItem>(file));
      this.timelines.set(agentId, items);
      this.trimTimelines(agentId);
    } else {
      // 쓴 순서대로 Map 맨 뒤로 보낸다(맨 앞이 가장 오래전에 쓴 것)
      this.timelines.delete(agentId);
      this.timelines.set(agentId, items);
    }
    return items;
  }

  // PERFDAEMON: 읽은 타임라인은 데몬이 끝날 때까지 메모리에 남았다(세션 195개를 다 읽으면 힙 +29MB, RSS +56MB). 많이 쌓이면 가장 오래전에 쓴 것부터 내린다. 파일에 이미 저장돼 있어 다시 쓸 때 읽는다.
  // 내리지 않는 것: 저장이 밀려 있는 것(메모리가 최신), 지금 살아 있는 세션(isLive: 프로세스가 있거나 응답 중이거나 칸에 열림).
  isLive: (agentId: string) => boolean = () => false;

  private trimTimelines(justLoaded: string) {
    if (this.timelines.size <= TIMELINE_CACHE_LIMIT) return;
    for (const agentId of [...this.timelines.keys()]) {
      if (this.timelines.size <= TIMELINE_CACHE_LIMIT) return;
      if (agentId === justLoaded || this.saveTimers.has(agentId) || this.isLive(agentId) || !existsSync(sessionFile(TIMELINE_DIR, agentId))) continue;
      this.timelines.delete(agentId);
    }
  }

  cachedTimelineCount() {
    return this.timelines.size;
  }

  upsertItem(agentId: string, item: TimelineItem) {
    const items = this.timeline(agentId);
    const index = items.findIndex((i) => i.id === item.id);
    if (index === -1) items.push(item);
    else items[index] = item;
    // 스트리밍 초안은 파일에 저장하지 않는다(아래 저장이 걸러낸다). 초안 갱신마다 타임라인 전체를 직렬화하지 않게 저장을 걸지 않는다.
    if (item.kind === "assistant" && item.streaming) return;
    this.scheduleTimelineSave(agentId);
  }

  removeItem(agentId: string, itemId: string) {
    const items = this.timeline(agentId);
    const index = items.findIndex((i) => i.id === itemId);
    if (index !== -1) items.splice(index, 1);
    this.scheduleTimelineSave(agentId);
  }

  // --- 에이전트가 고친 파일의 수정 전 내용 ---

  changes(agentId: string) {
    let list = this.changesCache.get(agentId);
    if (!list) {
      const file = sessionFile(CHANGES_DIR, agentId);
      list = readList<FileChange>(file);
      this.changesCache.set(agentId, list);
    }
    return list;
  }

  change(agentId: string, path: string) {
    return this.changes(agentId).find((c) => c.path === path) ?? null;
  }

  setChange(agentId: string, path: string, original: string | null) {
    const list = this.changes(agentId);
    const entry: FileChange = { path, original, updatedAt: new Date().toISOString() };
    const index = list.findIndex((c) => c.path === path);
    if (index === -1) list.push(entry);
    else list[index] = entry;
    this.saveChanges(agentId);
    return list;
  }

  clearChanges(agentId: string, path: string | null) {
    const list = path ? this.changes(agentId).filter((c) => c.path !== path) : [];
    this.changesCache.set(agentId, list);
    this.saveChanges(agentId);
    return list;
  }

  private saveChanges(agentId: string) {
    writeFileAtomic(sessionFile(CHANGES_DIR, agentId), JSON.stringify(this.changes(agentId)));
  }

  // --- DIFFFB: diff 줄에 쌓은 피드백 ---

  diffFeedback(agentId: string) {
    let list = this.diffFeedbackCache.get(agentId);
    if (!list) {
      list = readList<DiffFeedback>(sessionFile(DIFF_FEEDBACK_DIR, agentId));
      this.diffFeedbackCache.set(agentId, list);
    }
    return list;
  }

  setDiffFeedback(agentId: string, list: DiffFeedback[]) {
    this.diffFeedbackCache.set(agentId, list);
    writeFileAtomic(sessionFile(DIFF_FEEDBACK_DIR, agentId), JSON.stringify(list));
    return list;
  }

  // 재시작 직전: 미뤄 둔 상태와 타임라인 저장을 지금 쓴다.
  // 파일 하나를 쓰지 못해도 나머지는 쓴다(예전에는 첫 실패에서 던져서 뒤의 타임라인들이 저장되지 않았다).
  flush() {
    if (this.stateTimer || this.stateUnsaved) {
      if (this.stateTimer) clearTimeout(this.stateTimer);
      this.stateTimer = null;
      try {
        this.writeState();
      } catch (error) {
        console.error("[store] state.json not written", (error as Error).message);
      }
    }
    for (const [agentId, timer] of this.saveTimers) {
      clearTimeout(timer);
      const items = this.timelines.get(agentId);
      if (!items) continue;
      try {
        writeFileAtomic(sessionFile(TIMELINE_DIR, agentId), JSON.stringify(items.filter((i) => !(i.kind === "assistant" && i.streaming))));
      } catch (error) {
        console.error("[store] timeline not written", agentId, (error as Error).message);
      }
    }
    this.saveTimers.clear();
  }

  private scheduleTimelineSave(agentId: string, delay = 500) {
    if (this.saveTimers.has(agentId)) return;
    this.saveTimers.set(
      agentId,
      setTimeout(() => {
        this.saveTimers.delete(agentId);
        const items = this.timelines.get(agentId);
        if (!items) return;
        // 스트리밍 중인 초안은 저장하지 않는다.
        const durable = items.filter((i) => !(i.kind === "assistant" && i.streaming));
        const start = performance.now();
        const text = JSON.stringify(durable);
        // 타이머 안에서 던지면 데몬이 죽는다. 쓰지 못하면(디스크 가득 등) 기록하고 잠시 뒤 다시 쓴다. 저장이 밀린 타임라인은 메모리에서 내려가지 않는다(trimTimelines).
        try {
          writeFileAtomic(sessionFile(TIMELINE_DIR, agentId), text);
        } catch (error) {
          console.error("[store] timeline not written", agentId, (error as Error).message);
          this.scheduleTimelineSave(agentId, TIMELINE_RETRY_MS);
          // 다시 쓰기를 기다리는 타이머가 프로세스를 붙잡지 않게 한다(끝날 때는 flush 가 쓴다)
          this.saveTimers.get(agentId)?.unref();
          return;
        }
        perfNote("save", "timeline", text.length, performance.now() - start);
      }, delay),
    );
  }

  private save() {
    if (STATE_SAVE_DELAY_MS <= 0) {
      this.writeState();
      return;
    }
    this.stateTimer ??= setTimeout(() => {
      this.stateTimer = null;
      // 타이머 안에서 던지면 데몬이 죽는다. 쓰기에 실패하면(폴더가 사라짐, 디스크 가득) 기록만 하고 다음 변경 때 다시 쓴다.
      try {
        this.writeState();
      } catch (error) {
        console.error("[store] state.json not written", (error as Error).message);
      }
    }, STATE_SAVE_DELAY_MS);
  }

  private writeState() {
    const start = performance.now();
    const text = JSON.stringify(this.state, null, 2);
    this.stateUnsaved = true;
    writeFileAtomic(STATE_FILE, text);
    this.stateUnsaved = false;
    perfNote("save", "state", text.length, performance.now() - start);
  }
}

export function loadToken() {
  const file = join(HOME, "token");
  mkdirSync(HOME, { recursive: true });
  // 빈 토큰 파일(첫 쓰기가 디스크 가득 등으로 끊긴 흔적)을 그대로 읽으면 토큰이 빈 문자열이 되어 `?token=` 만 붙인 요청이 통과한다. 비어 있으면 새로 만든다.
  const existing = existsSync(file) ? readFileSync(file, "utf8").trim() : "";
  if (existing) return existing;
  const token = randomBytes(24).toString("hex");
  writeFileAtomic(file, token);
  return token;
}
