import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { ANALYSIS_BUDGET_MAX_USD, ANALYSIS_BUDGET_MIN_USD } from "../shared/analysisBudget";
import { sanitizeEditorOptions } from "../shared/editorOptions";
import { sanitizeKeymapOverrides } from "../shared/keymapOverrides";
import { sanitizeActivityBar } from "../shared/activityBar";
import { SLACK_LINK_TARGETS } from "../shared/slackLink";
import { NOTION_LINK_TARGETS } from "../shared/notionLink";
import { parseReviewTime, REVIEW_DEFAULT_TIME } from "../shared/morningReview";
import { parseAccelerator, QUICK_ENTRY_DEFAULT_SHORTCUT } from "../shared/quickEntry";
import { DEFAULT_NOTION_BYPASS_WRITES, NOTION_BYPASS_WRITES } from "../shared/notionApproval";
import { realDir } from "./paths";
import { perfNote } from "./perfStats";
import { removeFolder, restoreFolder, type RemovedFolder } from "./removedFolders";
import { settleStale } from "./subagents";
import { parseOrderIds, parseOrderScope, parentOfKidsScope, pruneSessionOrders, type SessionOrders } from "../shared/sessionOrder";
import type { DiffFeedback } from "../shared/protocol";
import { BROWSER_PAGE_ZOOMS, BROWSER_SEARCH_ENGINES, BROWSER_STORAGES, BROWSER_TITLE_BAR, DIFF_VIEWS, EDITOR_FONT_DEFAULTS, EFFORT_LEVELS, HARNESS_VALUES, isEffortLevel, KEYMAP_PRESETS, THEME_STYLES, UI_TYPE_DEFAULTS, UI_TYPE_RANGES, type Agent, type FileChange, type HarnessSeen, type Settings, type TimelineItem, type Workspace } from "../shared/protocol";

export const HOME = process.env.AGENT_NAV_HOME ?? join(homedir(), ".agent-nav");
const STATE_FILE = join(HOME, "state.json");
const MODEL_PINS_FILE = join(HOME, "model-pins.json");
const SETTINGS_FILE = join(HOME, "settings.json");
const TIMELINE_DIR = join(HOME, "timelines");
const CHANGES_DIR = join(HOME, "changes");
const DIFF_FEEDBACK_DIR = join(HOME, "diff-feedback");

const TIMELINE_CACHE_LIMIT = Number(process.env.AGENT_NAV_TIMELINE_CACHE ?? 24);
const STATE_SAVE_DELAY_MS = Number(process.env.AGENT_NAV_SAVE_DELAY_MS ?? 300);
const TIMELINE_RETRY_MS = 5000;
const STATE_BACKUP = `${STATE_FILE}.bak`;

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

function setAside(file: string, error: unknown) {
  const aside = `${file}.corrupt-${Date.now()}`;
  try {
    renameSync(file, aside);
  } catch {
  }
  console.error(`[store] ${file} could not be read (${(error as Error).message}). It was kept as ${aside}`);
}

function sessionFile(dir: string, agentId: string) {
  if (typeof agentId !== "string" || !agentId || agentId === "." || agentId === ".." || basename(agentId) !== agentId) throw new Error(`Unknown agent: ${String(agentId)}`);
  return join(dir, `${agentId}.json`);
}

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

type State = { workspaces: Workspace[]; agents: Agent[]; removed?: RemovedFolder[]; sessionOrders?: SessionOrders };

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
  notifyNewVersion: false,
  useProviderEnv: false,
  inboxIntervalMinutes: 0,
  keepIdleSessionsWarmMinutes: 10,
  maxWarmSessions: 4,
  feedbackAutoTidy: false,
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

export function migrateSettings(raw: Partial<Settings>): { settings: Partial<Settings>; migrated: boolean } {
  if ((raw.settingsVersion ?? 0) >= SETTINGS_VERSION) return { settings: raw, migrated: false };
  const next: Partial<Settings> = { ...raw, settingsVersion: SETTINGS_VERSION };
  if (next.defaultPermissionMode === "default" || next.defaultPermissionMode === undefined) next.defaultPermissionMode = null;
  if (next.defaultModel === "default" || next.defaultModel === undefined) next.defaultModel = null;
  if (next.defaultEffort === undefined) next.defaultEffort = null;
  return { settings: next, migrated: true };
}

function sanitizeSettings(patch: Partial<Settings>): Partial<Settings> {
  const next = { ...patch };
  const finite = (v: unknown, min: number, max: number) => typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
  if ("editorFontSize" in next && !finite(next.editorFontSize, 8, 32)) delete next.editorFontSize;
  if ("editorLineHeight" in next && !finite(next.editorLineHeight, 10, 64)) delete next.editorLineHeight;
  if ("editorFontFamily" in next && (typeof next.editorFontFamily !== "string" || !next.editorFontFamily.trim())) next.editorFontFamily = EDITOR_FONT_DEFAULTS.editorFontFamily;
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
  if ("slackTeamId" in next && !(typeof next.slackTeamId === "string" && /^(|T[0-9A-Z]{6,20})$/.test(next.slackTeamId.trim()))) delete next.slackTeamId;
  else if (typeof next.slackTeamId === "string") next.slackTeamId = next.slackTeamId.trim();
  if ("editorFontTerminal" in next && typeof next.editorFontTerminal !== "boolean") delete next.editorFontTerminal;
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
  if ("editorOptions" in next) next.editorOptions = sanitizeEditorOptions(next.editorOptions);
  if ("browserSearchEngine" in next && !BROWSER_SEARCH_ENGINES.includes(next.browserSearchEngine as never)) delete next.browserSearchEngine;
  if ("browserMaxHistory" in next && !(Number.isInteger(next.browserMaxHistory) && finite(next.browserMaxHistory, 0, 10000))) delete next.browserMaxHistory;
  for (const key of ["browserChatTools", "browserAttachElementImage", "browserOpenLocalhostLinks", "browserAutoReload", "browserUserTools"] as const) if (key in next && typeof next[key] !== "boolean") delete next[key];
  if ("browserDataStorage" in next && !BROWSER_STORAGES.includes(next.browserDataStorage as never)) delete next.browserDataStorage;
  if ("browserShowInTitleBar" in next && !BROWSER_TITLE_BAR.includes(next.browserShowInTitleBar as never)) delete next.browserShowInTitleBar;
  if ("browserPageZoom" in next && next.browserPageZoom !== null && !BROWSER_PAGE_ZOOMS.includes(next.browserPageZoom as never)) delete next.browserPageZoom;
  if ("formatOnSave" in next && next.formatOnSave !== null && typeof next.formatOnSave !== "boolean") delete next.formatOnSave;
  if ("formatters" in next) {
    const given = next.formatters && typeof next.formatters === "object" && !Array.isArray(next.formatters) ? Object.entries(next.formatters) : [];
    next.formatters = Object.fromEntries(given.filter(([, id]) => id === "eslint" || id === "prettier" || id === "oxc" || id === "tsserver")) as Settings["formatters"];
  }
  if ("defaultLayout" in next && next.defaultLayout !== null && next.defaultLayout !== "chat" && next.defaultLayout !== "editor") delete next.defaultLayout;
  if ("rememberLastLayout" in next && typeof next.rememberLastLayout !== "boolean") delete next.rememberLastLayout;
  if ("rememberLayoutPerSession" in next && typeof next.rememberLayoutPerSession !== "boolean") delete next.rememberLayoutPerSession;
  if ("expandSteps" in next && typeof next.expandSteps !== "boolean") delete next.expandSteps;
  if ("pinnedPanelSide" in next && next.pinnedPanelSide !== null && next.pinnedPanelSide !== "left" && next.pinnedPanelSide !== "right") delete next.pinnedPanelSide;
  if ("mobileAccess" in next && typeof next.mobileAccess !== "boolean") delete next.mobileAccess;
  if ("chatInEditorLayout" in next && next.chatInEditorLayout !== null && next.chatInEditorLayout !== "docked" && next.chatInEditorLayout !== "floating") delete next.chatInEditorLayout;
  delete next.settingsVersion;
  if ("diffView" in next && !DIFF_VIEWS.includes(next.diffView as never)) delete next.diffView;
  if ("keymapPreset" in next && !KEYMAP_PRESETS.includes(next.keymapPreset as never)) delete next.keymapPreset;
  if ("keymapOverrides" in next) next.keymapOverrides = sanitizeKeymapOverrides(next.keymapOverrides);
  if ("activityBar" in next) next.activityBar = sanitizeActivityBar(next.activityBar);
  if ("themeStyle" in next && !THEME_STYLES.includes(next.themeStyle as never)) delete next.themeStyle;
  if ("slackLinkTarget" in next && !SLACK_LINK_TARGETS.includes(next.slackLinkTarget as never)) delete next.slackLinkTarget;
  if ("notionLinkTarget" in next && !NOTION_LINK_TARGETS.includes(next.notionLinkTarget as never)) delete next.notionLinkTarget;
  if ("focusGuard" in next && typeof next.focusGuard !== "boolean") delete next.focusGuard;
  if ("notionBypassWrites" in next && !NOTION_BYPASS_WRITES.includes(next.notionBypassWrites as never)) delete next.notionBypassWrites;
  return next;
}

function validSeen(value: unknown): HarnessSeen | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const seen: HarnessSeen = {};
  for (const harness of HARNESS_VALUES) {
    const id = (value as Record<string, unknown>)[harness];
    if (typeof id === "string" && id) seen[harness] = id;
  }
  return Object.keys(seen).length ? seen : undefined;
}

export class Store {
  private state: State;
  private modelPinsValue: string[] = [];
  private beforePinImport: string[] | null = [];
  private settingsValue: Settings;
  private timelines = new Map<string, TimelineItem[]>();
  private changesCache = new Map<string, FileChange[]>();
  private diffFeedbackCache = new Map<string, DiffFeedback[]>();
  private saveTimers = new Map<string, NodeJS.Timeout>();
  private stateTimer: NodeJS.Timeout | null = null;
  private stateUnsaved = false;
  readonly cutOffOnStart: string[] = [];
  onRestored: ((agents: Agent[]) => void) | null = null;

  constructor() {
    if (existsSync(MODEL_PINS_FILE)) {
      try {
        const saved = JSON.parse(readFileSync(MODEL_PINS_FILE, "utf8"));
        const pins: unknown = Array.isArray(saved) ? saved : saved.pins;
        const edits: unknown = Array.isArray(saved) ? null : saved.beforeImport;
        if (!Array.isArray(pins) || !pins.every((pin) => typeof pin === "string")
          || !(edits === null || (Array.isArray(edits) && edits.every((pin) => typeof pin === "string")))) throw new Error("invalid model pins");
        this.modelPinsValue = pins;
        this.beforePinImport = edits;
      } catch (error) {
        setAside(MODEL_PINS_FILE, error);
      }
    }
    mkdirSync(TIMELINE_DIR, { recursive: true });
    mkdirSync(CHANGES_DIR, { recursive: true });
    mkdirSync(DIFF_FEEDBACK_DIR, { recursive: true });
    try {
      chmodSync(HOME, 0o700);
    } catch {
    }
    this.state = loadState();
    for (const workspace of [...this.state.workspaces, ...(this.state.removed ?? []).flatMap((r) => r.workspaces)]) workspace.parentId ??= null;
    for (const agent of [...this.state.agents, ...(this.state.removed ?? []).flatMap((r) => r.agents)]) this.fill(agent);
    if (this.normalizePaths()) this.save();
    const stored = existsSync(SETTINGS_FILE) ? migrateSettings(this.readSettings()) : { settings: {}, migrated: false };
    this.settingsValue = { ...DEFAULT_SETTINGS, ...stored.settings };
    if (stored.migrated) writeFileAtomic(SETTINGS_FILE, JSON.stringify(this.settingsValue, null, 2));
    if (!DIFF_VIEWS.includes(this.settingsValue.diffView)) this.settingsValue.diffView = DEFAULT_SETTINGS.diffView;
    if (!KEYMAP_PRESETS.includes(this.settingsValue.keymapPreset)) this.settingsValue.keymapPreset = DEFAULT_SETTINGS.keymapPreset;
    if (this.settingsValue.keymapOverrides !== undefined) this.settingsValue.keymapOverrides = sanitizeKeymapOverrides(this.settingsValue.keymapOverrides);
    if (this.settingsValue.activityBar !== undefined) this.settingsValue.activityBar = sanitizeActivityBar(this.settingsValue.activityBar);
    if (!THEME_STYLES.includes(this.settingsValue.themeStyle)) this.settingsValue.themeStyle = DEFAULT_SETTINGS.themeStyle;
  }

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

  private fill(agent: Agent) {
    if (agent.status === "running" || agent.status === "waiting") this.cutOffOnStart.push(agent.id);
    if (agent.status !== "idle") agent.status = "idle";
    agent.model ??= null;
    agent.effort = isEffortLevel(agent.effort) ? agent.effort : null;
    agent.activeModel ??= null;
    agent.activeEffort = isEffortLevel(agent.activeEffort) ? agent.activeEffort : null;
    if (agent.harness !== undefined && !HARNESS_VALUES.includes(agent.harness)) delete agent.harness;
    agent.seenThrough = validSeen(agent.seenThrough);
    if (!agent.seenThrough) delete agent.seenThrough;
    if (typeof agent.carryPending !== "boolean") delete agent.carryPending;
    agent.backgroundTasks = 0;
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
    const extra = Array.isArray(agent.extraWorkspaceIds) ? [...new Set(agent.extraWorkspaceIds.filter((id) => typeof id === "string" && id !== agent.workspaceId))] : [];
    if (extra.length) agent.extraWorkspaceIds = extra;
    else delete agent.extraWorkspaceIds;
  }

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
      for (const agent of this.state.agents) {
        if (!agent.extraWorkspaceIds?.some((id) => renamed.has(id))) continue;
        const extra = [...new Set(agent.extraWorkspaceIds.map((id) => renamed.get(id) ?? id).filter((id) => id !== agent.workspaceId))];
        if (extra.length) agent.extraWorkspaceIds = extra;
        else delete agent.extraWorkspaceIds;
      }
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

  get workspaces() {
    return this.state.workspaces.some((w) => w.archived) ? this.state.workspaces.filter((w) => !w.archived) : this.state.workspaces;
  }

  archiveWorkspace(id: string) {
    const workspace = this.state.workspaces.find((w) => w.id === id);
    if (!workspace?.feedback || workspace.archived) return false;
    if (this.state.agents.some((a) => (a.workspaceId === id && !a.feedbackId) || a.extraWorkspaceIds?.includes(id))) return false;
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

  setSessionOrder(scope: unknown, ids: unknown): SessionOrders {
    const parsed = parseOrderScope(scope);
    if (!parsed) throw new Error("Invalid session order scope");
    if (parsed.kind === "workspace" && !this.allWorkspaceIds.has(parsed.scope)) throw new Error(`Unknown workspace: ${parsed.scope}`);
    if (parsed.kind === "kids" && !this.allAgentIds.has(parentOfKidsScope(parsed.scope))) throw new Error(`Unknown session: ${parentOfKidsScope(parsed.scope)}`);
    const known = parsed.kind === "folders" ? this.allWorkspaceIds : this.allAgentIds;
    const live = parseOrderIds(ids).filter((id) => known.has(id));
    return this.writeSessionOrders({ ...this.sessionOrders, [parsed.scope]: live });
  }

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

  get modelPins(): string[] {
    return this.modelPinsValue;
  }

  setModelPin(key: string, pinned: boolean) {
    const current = this.modelPinsValue;
    const beforeImport = this.beforePinImport;
    if (current.includes(key) === pinned && (!beforeImport || beforeImport.includes(key))) return current;
    const pins = pinned ? [...new Set([...current, key])] : current.filter((pin) => pin !== key);
    return this.writeModelPins(pins, beforeImport && [...new Set([...beforeImport, key])]);
  }

  importModelPins(legacy: string[]) {
    if (this.beforePinImport === null) return this.modelPinsValue;
    const removed = new Set(this.beforePinImport.filter((pin) => !this.modelPinsValue.includes(pin)));
    return this.writeModelPins([...new Set([...legacy.filter((pin) => !removed.has(pin)), ...this.modelPinsValue])], null);
  }

  private writeModelPins(pins: string[], beforeImport: string[] | null) {
    writeFileAtomic(MODEL_PINS_FILE, JSON.stringify({ pins, beforeImport }));
    this.modelPinsValue = pins;
    this.beforePinImport = beforeImport;
    return pins;
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

  extraFolders(agent: Pick<Agent, "cwd" | "extraWorkspaceIds">): Workspace[] {
    const folders: Workspace[] = [];
    for (const id of agent.extraWorkspaceIds ?? []) {
      const workspace = this.state.workspaces.find((w) => w.id === id && !w.archived);
      if (workspace && workspace.dir !== agent.cwd && !folders.some((f) => f.dir === workspace.dir)) folders.push(workspace);
    }
    return folders;
  }

  extraDirs(agent: Pick<Agent, "cwd" | "extraWorkspaceIds">): string[] {
    return this.extraFolders(agent).map((w) => w.dir);
  }

  agentRoots(agent: Pick<Agent, "cwd" | "extraWorkspaceIds">): string[] {
    return [agent.cwd, ...this.extraDirs(agent)];
  }

  agent(id: string) {
    const agent = this.state.agents.find((a) => a.id === id);
    if (!agent) throw new Error(`Unknown agent: ${id}`);
    return agent;
  }

  addWorkspace(input: string, parentId: string | null = null, name = basename(input), feedback = false) {
    const dir = realDir(input);
    const existing = this.state.workspaces.find((w) => w.dir === dir);
    if (existing) return existing;
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

  removeWorkspaceIfUnused(id: string) {
    const workspace = this.state.workspaces.find((w) => w.id === id);
    if (!workspace || (!workspace.parentId && !workspace.feedback)) return;
    if (this.state.agents.some((a) => a.workspaceId === id || a.extraWorkspaceIds?.includes(id))) return;
    this.state.workspaces = this.state.workspaces.filter((w) => w.id !== id);
    this.save();
  }

  removeFolderFromList(id: string) {
    const result = removeFolder(this.state, id);
    this.save();
    return result;
  }

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
      this.timelines.delete(agentId);
      this.timelines.set(agentId, items);
    }
    return items;
  }

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
    if (item.kind === "assistant" && item.streaming) return;
    this.scheduleTimelineSave(agentId);
  }

  removeItem(agentId: string, itemId: string) {
    const items = this.timeline(agentId);
    const index = items.findIndex((i) => i.id === itemId);
    if (index !== -1) items.splice(index, 1);
    this.scheduleTimelineSave(agentId);
  }

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
        const durable = items.filter((i) => !(i.kind === "assistant" && i.streaming));
        const start = performance.now();
        const text = JSON.stringify(durable);
        try {
          writeFileAtomic(sessionFile(TIMELINE_DIR, agentId), text);
        } catch (error) {
          console.error("[store] timeline not written", agentId, (error as Error).message);
          this.scheduleTimelineSave(agentId, TIMELINE_RETRY_MS);
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
  const existing = existsSync(file) ? readFileSync(file, "utf8").trim() : "";
  if (existing) return existing;
  const token = randomBytes(24).toString("hex");
  writeFileAtomic(file, token);
  return token;
}
