import { BROWSER_PAGE_ZOOMS, BROWSER_SEARCH_ENGINES, BROWSER_STORAGES, DIFF_VIEWS, EDITOR_FONT_DEFAULTS, EFFORT_LEVELS, KEYMAP_PRESETS, THEME_STYLES, UI_TYPE_DEFAULTS, UI_TYPE_RANGES, type DiffView, type EffortLevel, type KeymapPreset, type FormatLanguage, type ModelInfo, type PermissionMode, type RequestQueuing, type ResolvedDefaults, type Settings, type Theme, type ThemeStyle } from "../shared/protocol";
import { analysisBudgetUsd } from "../shared/analysisBudget";
import { parseReviewTime } from "../shared/morningReview";
import { QUICK_ENTRY_DEFAULT_SHORTCUT } from "../shared/quickEntry";
import { EDITOR_OPTION_DEFS, type EditorOptionDef, type EditorOptionKey } from "../shared/editorOptions";
import { currentEditorOptions, resetEditorOption, saveEditorOption } from "./editorOptions";
import { PERMISSION_MODES, effortName } from "./Composer";
import type { DraftDefaults } from "./defaults";
import type { LayoutMode } from "./floatLayout";
import { chatDockOf, type ChatDock } from "./focusLayout";
import type { PinnedSide } from "./pinnedLayout";
import { supportedLevels } from "./effortLevels";
import { rpc } from "./rpc";
import { forgetPick, getState, setLayoutMode } from "./store";
import { chatSizePatch } from "./uiType";
import { S } from "./strings";
import { N } from "./notionStrings";
import { isModified, type GroupId } from "./settingsSchema";

export type FormatConfig = { formatOnSave: boolean; source: import("../shared/protocol").DefaultSource; languages: FormatLanguage[] };

export type SettingsCtx = {
  settings: Settings;
  draft: DraftDefaults;
  defaults: ResolvedDefaults | null;
  diffView: DiffView;
  format: FormatConfig | null;
  models: ModelInfo[];
};

export type CustomKind = "formatLanguages" | "mcpServers" | "daemon" | "quickEntryShortcut" | "mobileAccess" | "desktopLinkIncoming" | "desktopLinkOutgoing";
export type Option = { value: string; label: string; title?: string };

type Common = {
  id: string;
  group: GroupId;
  title: string;
  description: string | ((c: SettingsCtx) => string);
  keywords?: string;
  source?: (c: SettingsCtx) => string | null;
  modified: (c: SettingsCtx) => boolean;
  reset?: (c: SettingsCtx) => void;
  wide?: boolean;
  extra?: "release";
  operatorOnly?: true;
};

export type SettingDef = Common &
  (
    | { kind: "switch"; value: (c: SettingsCtx) => boolean; set: (v: boolean) => void }
    | { kind: "enum"; value: (c: SettingsCtx) => string; set: (v: string, c: SettingsCtx) => void; options: (c: SettingsCtx) => Option[]; placeholder?: string }
    | { kind: "number"; value: (c: SettingsCtx) => number; set: (v: number) => void; min: number; max: number; step: number }
    | { kind: "text"; value: (c: SettingsCtx) => string; set: (v: string) => void; placeholder?: string; commit: "change" | "blur"; clearOnCommit?: boolean; checkFont?: boolean; validate?: (v: string) => string | null }
    | { kind: "custom"; component: CustomKind }
  );

const save = (patch: Partial<Settings>) => void rpc.call("settings.set", patch);

function plain<K extends keyof Settings>(key: K, def: NonNullable<Settings[K]>) {
  const current = (c: SettingsCtx) => c.settings[key] ?? def;
  return {
    current,
    modified: (c: SettingsCtx) => isModified(current(c), def),
    reset: () => {
      const patch: Partial<Settings> = {};
      patch[key] = def;
      save(patch);
    },
  };
}

function text(id: string) {
  const [title, description] = S.settingText[id];
  return { id, title, description };
}

const SOURCE_NOTE = (source: keyof typeof S.defaultSource | null) => (source ? S.defaultSource[source] : null);

const modelValue = (c: SettingsCtx) => {
  const models = c.models.filter((m) => m.value !== "default");
  return c.draft.model ? (models.find((m) => m.value === c.draft.model || m.resolvedModel === c.draft.model)?.value ?? c.draft.model) : "";
};

const FOLLOW_VSCODE = "vscode";

const BUDGET_CHOICES = [0.1, 0.25, 0.5, 1, 2];
const INBOX_INTERVALS = [0, 5, 10, 30];
const KEEP_WARM_MINUTES = [5, 10, 30, 60, 0];
const MAX_WARM_SESSIONS = [2, 3, 4, 6, 8, 0];

function editorOptionRow(def: EditorOptionDef): SettingDef {
  const key: EditorOptionKey = def.key;
  const common = {
    id: `editorOption.${key}`,
    group: "editor" as const,
    title: def.title,
    description: def.description,
    keywords: `${def.vscode} ${def.keywords ?? ""}`,
    source: (c: SettingsCtx) => SOURCE_NOTE(c.defaults?.editorOptions?.sources[key] ?? null),
    modified: (c: SettingsCtx) => c.settings.editorOptions?.[key] !== undefined,
    reset: () => resetEditorOption(key),
  };
  const current = () => currentEditorOptions()[key];
  if (def.kind === "boolean") return { ...common, kind: "switch", value: () => current() as boolean, set: (v) => saveEditorOption(key, v as never) };
  if (def.kind === "number") return { ...common, kind: "number", value: () => current() as number, set: (v) => saveEditorOption(key, v as never), min: def.min, max: def.max, step: def.step };
  return { ...common, kind: "enum", value: () => current() as string, set: (v) => saveEditorOption(key, v as never), options: () => def.options.map((o) => ({ value: o.value, label: o.label })) };
}

export const SETTING_DEFS: readonly SettingDef[] = [
  {
    ...text("theme"),
    group: "appearance",
    kind: "enum",
    ...plain("theme", "dark"),
    value: (c) => c.settings.theme ?? "dark",
    set: (v) => save({ theme: v as Theme }),
    options: () => [
      { value: "dark", label: S.themes.dark },
      { value: "light", label: S.themes.light },
      { value: "system", label: S.themes.system },
      { value: "black", label: S.themes.black },
    ],
  },
  {
    ...text("themeStyle"),
    group: "appearance",
    kind: "enum",
    ...plain("themeStyle", "lodestar"),
    value: (c) => c.settings.themeStyle ?? "lodestar",
    set: (v) => save({ themeStyle: v as ThemeStyle }),
    options: () => THEME_STYLES.map((v) => ({ value: v, label: S.themeStyles[v] })),
  },
  { ...text("uiLetterSpacing"), group: "appearance", kind: "number", ...plain("uiLetterSpacing", UI_TYPE_DEFAULTS.uiLetterSpacing), value: (c) => c.settings.uiLetterSpacing ?? UI_TYPE_DEFAULTS.uiLetterSpacing, set: (v) => save({ uiLetterSpacing: v }), ...UI_TYPE_RANGES.uiLetterSpacing, step: 0.01 },
  { ...text("uiFontFamily"), group: "appearance", kind: "text", wide: true, commit: "change", checkFont: true, placeholder: UI_TYPE_DEFAULTS.uiFontFamily, ...plain("uiFontFamily", UI_TYPE_DEFAULTS.uiFontFamily), value: (c) => c.settings.uiFontFamily ?? UI_TYPE_DEFAULTS.uiFontFamily, set: (v) => save({ uiFontFamily: v }) },
  { ...text("chatFontSize"), group: "appearance", kind: "number", ...plain("chatFontSize", UI_TYPE_DEFAULTS.chatFontSize), value: (c) => c.settings.chatFontSize ?? UI_TYPE_DEFAULTS.chatFontSize, set: (v) => save(chatSizePatch(getState().settings, v)), reset: () => save(chatSizePatch(getState().settings, UI_TYPE_DEFAULTS.chatFontSize)), ...UI_TYPE_RANGES.chatFontSize, step: 0.5 },
  { ...text("chatLineHeight"), group: "appearance", kind: "number", ...plain("chatLineHeight", UI_TYPE_DEFAULTS.chatLineHeight), value: (c) => c.settings.chatLineHeight ?? UI_TYPE_DEFAULTS.chatLineHeight, set: (v) => save({ chatLineHeight: v }), ...UI_TYPE_RANGES.chatLineHeight, step: 0.5 },

  {
    ...text("defaultLayout"),
    group: "layout",
    kind: "enum",
    ...plain("defaultLayout", "chat"),
    value: (c) => c.settings.defaultLayout ?? "chat",
    set: (v) => {
      save({ defaultLayout: v as LayoutMode });
      setLayoutMode(v as LayoutMode);
    },
    options: () => [
      { value: "chat", label: S.layoutChat },
      { value: "editor", label: S.layoutEditor },
    ],
  },
  { ...text("rememberLastLayout"), group: "layout", kind: "switch", ...plain("rememberLastLayout", false), value: (c) => c.settings.rememberLastLayout === true, set: (v) => save({ rememberLastLayout: v }) },
  { ...text("rememberLayoutPerSession"), group: "layout", kind: "switch", ...plain("rememberLayoutPerSession", true), value: (c) => c.settings.rememberLayoutPerSession !== false, set: (v) => save({ rememberLayoutPerSession: v }) },
  {
    ...text("chatInEditorLayout"),
    group: "layout",
    kind: "enum",
    ...plain("chatInEditorLayout", "docked"),
    value: (c) => chatDockOf(c.settings.chatInEditorLayout),
    set: (v) => save({ chatInEditorLayout: v as ChatDock }),
    options: () => [
      { value: "docked", label: S.chatDockDocked },
      { value: "floating", label: S.chatDockFloating },
    ],
  },
  {
    ...text("pinnedPanelSide"),
    group: "layout",
    kind: "enum",
    ...plain("pinnedPanelSide", "right"),
    value: (c) => c.settings.pinnedPanelSide ?? "right",
    set: (v) => save({ pinnedPanelSide: v as PinnedSide }),
    options: () => [
      { value: "right", label: S.pinnedSideRight },
      { value: "left", label: S.pinnedSideLeft },
    ],
  },

  { ...text("editorFontFamily"), group: "editor", kind: "text", wide: true, commit: "change", checkFont: true, ...plain("editorFontFamily", EDITOR_FONT_DEFAULTS.editorFontFamily), value: (c) => c.settings.editorFontFamily ?? EDITOR_FONT_DEFAULTS.editorFontFamily, set: (v) => save({ editorFontFamily: v }) },
  { ...text("editorFontSize"), group: "editor", kind: "number", ...plain("editorFontSize", EDITOR_FONT_DEFAULTS.editorFontSize), value: (c) => c.settings.editorFontSize ?? EDITOR_FONT_DEFAULTS.editorFontSize, set: (v) => save({ editorFontSize: v }), min: 8, max: 32, step: 0.5 },
  { ...text("editorLineHeight"), group: "editor", kind: "number", ...plain("editorLineHeight", EDITOR_FONT_DEFAULTS.editorLineHeight), value: (c) => c.settings.editorLineHeight ?? EDITOR_FONT_DEFAULTS.editorLineHeight, set: (v) => save({ editorLineHeight: v }), min: 10, max: 64, step: 1 },
  { ...text("editorLigatures"), group: "editor", kind: "switch", ...plain("editorLigatures", EDITOR_FONT_DEFAULTS.editorLigatures), value: (c) => c.settings.editorLigatures ?? EDITOR_FONT_DEFAULTS.editorLigatures, set: (v) => save({ editorLigatures: v }) },
  { ...text("editorFontTerminal"), group: "editor", kind: "switch", ...plain("editorFontTerminal", EDITOR_FONT_DEFAULTS.editorFontTerminal), value: (c) => c.settings.editorFontTerminal ?? EDITOR_FONT_DEFAULTS.editorFontTerminal, set: (v) => save({ editorFontTerminal: v }) },

  { ...text("revealIfOpen"), group: "editor", kind: "switch", ...plain("revealIfOpen", true), value: (c) => c.settings.revealIfOpen ?? true, set: (v) => save({ revealIfOpen: v }) },
  {
    ...text("previewEditors"),
    group: "editor",
    kind: "switch",
    value: (c) => c.defaults?.previewEditors?.value ?? c.settings.previewEditors ?? false,
    set: (v) => save({ previewEditors: v }),
    source: (c) => SOURCE_NOTE(c.defaults?.previewEditors?.source ?? null),
    modified: (c) => (c.defaults?.previewEditors?.source ?? (c.settings.previewEditors == null ? "builtin" : "agent-nav")) === "agent-nav",
    reset: () => save({ previewEditors: null }),
  },

  { ...text("quickOpenIncludeExcluded"), group: "editor", kind: "switch", ...plain("quickOpenIncludeExcluded", false), value: (c) => c.settings.quickOpenIncludeExcluded ?? false, set: (v) => save({ quickOpenIncludeExcluded: v }) },

  {
    ...text("keymapPreset"),
    group: "editor",
    kind: "enum",
    ...plain("keymapPreset", "vscode"),
    value: (c) => c.settings.keymapPreset ?? "vscode",
    set: (v) => save({ keymapPreset: v as KeymapPreset }),
    options: () => KEYMAP_PRESETS.map((v) => ({ value: v, label: S.keymapPresets[v] })),
  },

  ...EDITOR_OPTION_DEFS.map(editorOptionRow),

  {
    ...text("diffView"),
    group: "diff",
    kind: "enum",
    value: (c) => c.diffView,
    set: (v) => save({ diffView: v as DiffView }),
    modified: (c) => c.diffView !== "inline",
    reset: () => save({ diffView: "inline" }),
    options: () => DIFF_VIEWS.map((v) => ({ value: v, label: { inline: S.diffInline, split: S.diffSplit, auto: S.diffViewAutomatic }[v] })),
  },
  {
    ...text("diffInlineWhenNarrow"),
    group: "diff",
    kind: "switch",
    value: (c) => c.draft.diffInlineWhenNarrow,
    set: (v) => save({ diffInlineWhenNarrow: v }),
    source: (c) => SOURCE_NOTE(c.defaults?.diffInlineWhenNarrow.source ?? null),
    modified: (c) => (c.defaults?.diffInlineWhenNarrow.source ?? (c.settings.diffInlineWhenNarrow == null ? "builtin" : "agent-nav")) === "agent-nav",
    reset: () => save({ diffInlineWhenNarrow: null }),
  },

  {
    ...text("formatOnSave"),
    group: "formatting",
    kind: "switch",
    value: (c) => c.format?.formatOnSave ?? c.settings.formatOnSave ?? false,
    set: (v) => save({ formatOnSave: v }),
    source: (c) => (c.format ? S.formatSourceNote[c.format.source] : null),
    modified: (c) => c.settings.formatOnSave !== null && c.settings.formatOnSave !== undefined,
    reset: () => save({ formatOnSave: null }),
  },
  {
    ...text("formatLanguages"),
    group: "formatting",
    kind: "custom",
    component: "formatLanguages",
    wide: true,
    keywords: "formatter prettier eslint oxc tsserver language",
    modified: (c) => Object.keys(c.settings.formatters ?? {}).length > 0,
    reset: () => save({ formatters: {} }),
  },

  {
    ...text("browserDataStorage"),
    group: "browser",
    kind: "enum",
    ...plain("browserDataStorage", "default"),
    value: (c) => c.settings.browserDataStorage ?? "default",
    set: (v) => save({ browserDataStorage: v as Settings["browserDataStorage"] }),
    options: () => BROWSER_STORAGES.map((v) => ({ value: v, label: S.browserDataStorageChoices[v], title: S.browserDataStorageDetails[v] })),
  },
  { ...text("browserMaxHistory"), group: "browser", kind: "number", ...plain("browserMaxHistory", 200), value: (c) => c.settings.browserMaxHistory ?? 200, set: (v) => save({ browserMaxHistory: v }), min: 0, max: 10000, step: 1 },
  {
    ...text("browserSearchEngine"),
    group: "browser",
    kind: "enum",
    ...plain("browserSearchEngine", "bing"),
    value: (c) => c.settings.browserSearchEngine ?? "bing",
    set: (v) => save({ browserSearchEngine: v as Settings["browserSearchEngine"] }),
    options: () => BROWSER_SEARCH_ENGINES.map((v) => ({ value: v, label: S.browserSearchEngines[v] })),
  },
  { ...text("browserAutoReload"), group: "browser", kind: "switch", ...plain("browserAutoReload", true), value: (c) => c.settings.browserAutoReload ?? true, set: (v) => save({ browserAutoReload: v }) },
  { ...text("browserChatTools"), group: "browser", kind: "switch", ...plain("browserChatTools", true), value: (c) => c.settings.browserChatTools ?? true, set: (v) => save({ browserChatTools: v }) },
  {
    ...text("notionLinkTarget"),
    group: "browser",
    kind: "enum",
    ...plain("notionLinkTarget", "lodestar"),
    value: (c) => c.settings.notionLinkTarget ?? "lodestar",
    set: (v) => save({ notionLinkTarget: v as Settings["notionLinkTarget"] }),
    options: () => [
      { value: "lodestar", label: N.linkTargetLodestar },
      { value: "app", label: N.linkTargetApp },
      { value: "notion", label: N.linkTargetNotion },
      { value: "browser", label: N.linkTargetBrowser },
    ],
  },
  { ...text("browserOpenLocalhostLinks"), group: "browser", kind: "switch", ...plain("browserOpenLocalhostLinks", true), value: (c) => c.settings.browserOpenLocalhostLinks ?? true, set: (v) => save({ browserOpenLocalhostLinks: v }) },
  {
    ...text("browserPageZoom"),
    group: "browser",
    kind: "enum",
    value: (c) => (c.settings.browserPageZoom == null ? "match" : String(c.settings.browserPageZoom)),
    set: (v) => save({ browserPageZoom: v === "match" ? null : (Number(v) as Settings["browserPageZoom"]) }),
    modified: (c) => c.settings.browserPageZoom != null,
    reset: () => save({ browserPageZoom: null }),
    options: () => [{ value: "match", label: S.browserPageZoomMatch }, ...BROWSER_PAGE_ZOOMS.map((p) => ({ value: String(p), label: `${p}%` }))],
  },
  { ...text("browserAttachElementImage"), group: "browser", kind: "switch", ...plain("browserAttachElementImage", true), value: (c) => c.settings.browserAttachElementImage ?? true, set: (v) => save({ browserAttachElementImage: v }) },
  {
    ...text("browserShowInTitleBar"),
    group: "browser",
    kind: "enum",
    value: (c) => String(c.settings.browserShowInTitleBar ?? "whenOpen"),
    set: (v) => save({ browserShowInTitleBar: v === "true" ? true : v === "false" ? false : "whenOpen" }),
    modified: (c) => (c.settings.browserShowInTitleBar ?? "whenOpen") !== "whenOpen",
    reset: () => save({ browserShowInTitleBar: "whenOpen" }),
    options: () => (["true", "false", "whenOpen"] as const).map((v) => ({ value: v, label: S.browserShowInTitleBarChoices[v], title: S.browserShowInTitleBarDetails[v] })),
  },
  { ...text("browserUserTools"), group: "browser", kind: "switch", ...plain("browserUserTools", false), value: (c) => c.settings.browserUserTools ?? false, set: (v) => save({ browserUserTools: v }) },

  { ...text("showBoard"), group: "board", kind: "switch", ...plain("showBoard", false), value: (c) => c.settings.showBoard ?? false, set: (v) => save({ showBoard: v }) },
  { ...text("boardAutoMove"), group: "board", kind: "switch", ...plain("boardAutoMove", true), value: (c) => c.settings.boardAutoMove ?? true, set: (v) => save({ boardAutoMove: v }) },
  { ...text("morningReviewEnabled"), group: "board", kind: "switch", ...plain("morningReviewEnabled", true), value: (c) => c.settings.morningReviewEnabled ?? true, set: (v) => save({ morningReviewEnabled: v }) },
  {
    ...text("morningReviewTime"),
    group: "board",
    kind: "text",
    commit: "blur",
    placeholder: "09:30",
    ...plain("morningReviewTime", "09:30"),
    value: (c) => c.settings.morningReviewTime ?? "09:30",
    set: (v) => save({ morningReviewTime: v.trim() }),
    validate: (v) => (parseReviewTime(v) ? null : S.reviewTimeInvalid),
  },
  { ...text("assistantEnabled"), group: "followUps", kind: "switch", ...plain("assistantEnabled", false), value: (c) => c.settings.assistantEnabled ?? false, set: (v) => save({ assistantEnabled: v }), keywords: "mate assistant agent proactive check in dot duet muse" },
  { ...text("assistantMorningBrief"), group: "followUps", kind: "switch", ...plain("assistantMorningBrief", true), value: (c) => c.settings.assistantMorningBrief ?? true, set: (v) => save({ assistantMorningBrief: v }), keywords: "mate morning brief daily summary" },
  { ...text("followUpsEnabled"), group: "followUps", kind: "switch", ...plain("followUpsEnabled", true), value: (c) => c.settings.followUpsEnabled ?? true, set: (v) => save({ followUpsEnabled: v }), keywords: "follow up decisions waiting in progress tracking" },
  { ...text("followUpsReminders"), group: "followUps", kind: "switch", ...plain("followUpsReminders", true), value: (c) => c.settings.followUpsReminders ?? true, set: (v) => save({ followUpsReminders: v }), keywords: "remind notification nudge snooze" },
  {
    ...text("followUpsModel"),
    group: "followUps",
    kind: "enum",
    ...plain("followUpsModel", "haiku"),
    value: (c) => c.settings.followUpsModel ?? "haiku",
    set: (v) => save({ followUpsModel: v }),
    options: () => [
      { value: "haiku", label: "Haiku" },
      { value: "sonnet", label: "Sonnet" },
      { value: "opus", label: "Opus" },
    ],
  },
  { ...text("autoUpdateWhenIdle"), operatorOnly: true, group: "general", kind: "switch", ...plain("autoUpdateWhenIdle", false), value: (c) => c.settings.autoUpdateWhenIdle ?? false, set: (v) => save({ autoUpdateWhenIdle: v }), keywords: "update restart install build idle away automatic" },
  { ...text("notifyOnResponse"), group: "notifications", kind: "switch", ...plain("notifyOnResponse", true), value: (c) => c.settings.notifyOnResponse ?? true, set: (v) => save({ notifyOnResponse: v }) },
  { ...text("notifyOnApproval"), group: "notifications", kind: "switch", ...plain("notifyOnApproval", true), value: (c) => c.settings.notifyOnApproval ?? true, set: (v) => save({ notifyOnApproval: v }) },
  { ...text("notifyNewVersion"), group: "notifications", kind: "switch", ...plain("notifyNewVersion", false), value: (c) => c.settings.notifyNewVersion ?? false, set: (v) => save({ notifyNewVersion: v }), keywords: "update release version github", extra: "release" },

  { ...text("showSlack"), group: "mentions", kind: "switch", ...plain("showSlack", false), value: (c) => c.settings.showSlack ?? false, set: (v) => save({ showSlack: v }) },
  { ...text("autoAddRequests"), group: "mentions", kind: "switch", ...plain("autoAddRequests", false), value: (c) => c.settings.autoAddRequests ?? false, set: (v) => save({ autoAddRequests: v }) },
  {
    ...text("mentionAnalysisModel"),
    group: "mentions",
    kind: "enum",
    ...plain("mentionAnalysisModel", "sonnet"),
    value: (c) => c.settings.mentionAnalysisModel ?? "sonnet",
    set: (v) => save({ mentionAnalysisModel: v }),
    options: () => [
      { value: "sonnet", label: "Sonnet" },
      { value: "haiku", label: "Haiku" },
      { value: "opus", label: "Opus" },
    ],
  },
  {
    ...text("mentionAnalysisBudgetUsd"),
    group: "mentions",
    kind: "enum",
    value: (c) => (c.settings.mentionAnalysisBudgetUsd == null ? "default" : String(c.settings.mentionAnalysisBudgetUsd)),
    set: (v) => save({ mentionAnalysisBudgetUsd: v === "default" ? null : Number(v) }),
    modified: (c) => c.settings.mentionAnalysisBudgetUsd != null,
    reset: () => save({ mentionAnalysisBudgetUsd: null }),
    options: (c) => {
      const budget = c.settings.mentionAnalysisBudgetUsd ?? null;
      const choices = [...new Set([...BUDGET_CHOICES, ...(budget !== null ? [budget] : [])])].sort((a, b) => a - b);
      return [{ value: "default", label: S.analysisBudgetDefault(analysisBudgetUsd(c.settings.mentionAnalysisModel ?? "sonnet")) }, ...choices.map((usd) => ({ value: String(usd), label: `$${usd.toFixed(2)}` }))];
    },
  },
  {
    ...text("inboxIntervalMinutes"),
    group: "mentions",
    kind: "enum",
    ...plain("inboxIntervalMinutes", 0),
    value: (c) => String(c.settings.inboxIntervalMinutes ?? 0),
    set: (v) => save({ inboxIntervalMinutes: Number(v) }),
    options: (c) => {
      const minutes = c.settings.inboxIntervalMinutes ?? 0;
      const all = INBOX_INTERVALS.includes(minutes) ? INBOX_INTERVALS : [...INBOX_INTERVALS, minutes].sort((a, b) => a - b);
      return all.map((n) => ({ value: String(n), label: n === 0 ? S.inboxIntervalOff : S.inboxIntervalMinutes(n) }));
    },
  },
  {
    ...text("slackTeamId"),
    group: "mentions",
    kind: "text",
    commit: "blur",
    placeholder: S.inboxTeamIdPlaceholder,
    ...plain("slackTeamId", ""),
    value: (c) => c.settings.slackTeamId ?? "",
    set: (v) => save({ slackTeamId: v.trim() }),
    validate: (v) => (v.trim() && !/^T[0-9A-Z]{6,20}$/.test(v.trim()) ? S.inboxTeamIdInvalid : null),
  },
  {
    ...text("slackLinkTarget"),
    group: "mentions",
    kind: "enum",
    ...plain("slackLinkTarget", "app"),
    value: (c) => c.settings.slackLinkTarget ?? "app",
    set: (v) => save({ slackLinkTarget: v as Settings["slackLinkTarget"] }),
    options: () => [
      { value: "app", label: S.slackLinkTargetApp },
      { value: "browser", label: S.slackLinkTargetBrowser },
    ],
  },

  {
    ...text("defaultPermissionMode"),
    group: "sessions",
    kind: "enum",
    value: (c) => c.draft.permissionMode,
    set: (v) => save({ defaultPermissionMode: v as PermissionMode }),
    source: (c) => SOURCE_NOTE(c.draft.permissionSource),
    modified: (c) => c.draft.permissionSource === "agent-nav" || c.draft.permissionSource === "last",
    reset: (c) => (c.draft.permissionSource === "last" ? forgetPick("permissionMode") : save({ defaultPermissionMode: null })),
    options: () => PERMISSION_MODES.map((m) => ({ value: m.value, label: m.label })),
  },
  { ...text("expandSteps"), group: "sessions", kind: "switch", keywords: "steps tools collapse expand finished working", ...plain("expandSteps", false), value: (c) => c.settings.expandSteps === true, set: (v) => save({ expandSteps: v }) },
  { ...text("quickEntryEnabled"), group: "general", kind: "switch", keywords: "global shortcut hotkey option c quick entry launcher", ...plain("quickEntryEnabled", true), value: (c) => c.settings.quickEntryEnabled ?? true, set: (v) => save({ quickEntryEnabled: v }) },
  {
    ...text("quickEntryShortcut"),
    group: "general",
    kind: "custom",
    component: "quickEntryShortcut",
    wide: true,
    keywords: "global hotkey accelerator option c",
    ...plain("quickEntryShortcut", QUICK_ENTRY_DEFAULT_SHORTCUT),
  },
  { ...text("focusGuard"), group: "sessions", kind: "switch", ...plain("focusGuard", true), value: (c) => c.settings.focusGuard ?? true, set: (v) => save({ focusGuard: v }) },
  {
    ...text("notionBypassWrites"),
    group: "sessions",
    kind: "enum",
    ...plain("notionBypassWrites", "apply"),
    value: (c) => c.settings.notionBypassWrites ?? "apply",
    set: (v) => save({ notionBypassWrites: v as Settings["notionBypassWrites"] }),
    options: () => [
      { value: "apply", label: N.settingApply },
      { value: "ask", label: N.settingAsk },
    ],
  },
  {
    ...text("defaultModel"),
    group: "sessions",
    kind: "enum",
    placeholder: S.defaultModelNone,
    value: modelValue,
    set: (v) => save({ defaultModel: v }),
    source: (c) => SOURCE_NOTE(c.draft.modelSource),
    modified: (c) => c.draft.modelSource === "agent-nav" || c.draft.modelSource === "last",
    reset: (c) => (c.draft.modelSource === "last" ? forgetPick("model") : save({ defaultModel: "default" })),
    options: (c) => {
      const models = c.models.filter((m) => m.value !== "default");
      const current = modelValue(c);
      const list = models.map((m) => ({ value: m.value, label: m.displayName }));
      return current && !models.some((m) => m.value === current) ? [...list, { value: current, label: current }] : list;
    },
  },
  {
    ...text("defaultModelCustom"),
    group: "sessions",
    kind: "text",
    commit: "blur",
    clearOnCommit: true,
    placeholder: "claude-sonnet-5-5",
    value: () => "",
    set: (v) => save({ defaultModel: v.trim() }),
    validate: (v) => (v.trim() && !/^[\w.[\]:/-]+$/.test(v.trim()) ? S.customModelInvalid : null),
    modified: () => false,
    keywords: "model name",
  },
  {
    ...text("defaultEffort"),
    group: "sessions",
    kind: "enum",
    placeholder: S.defaultEffortNone,
    value: (c) => c.draft.effort ?? "",
    set: (v) => save({ defaultEffort: v as EffortLevel }),
    source: (c) => SOURCE_NOTE(c.draft.effortSource),
    modified: (c) => c.draft.effortSource === "agent-nav" || c.draft.effortSource === "last",
    reset: (c) => (c.draft.effortSource === "last" ? forgetPick("effort") : save({ defaultEffort: null })),
    options: (c) => {
      const levels = supportedLevels(c.draft.model);
      const list: EffortLevel[] = c.draft.effort && !levels.includes(c.draft.effort) ? EFFORT_LEVELS.filter((l) => levels.includes(l) || l === c.draft.effort) : levels;
      return list.map((l) => ({ value: l, label: effortName(l) }));
    },
  },

  {
    ...text("requestQueuing"),
    group: "sessions",
    kind: "enum",
    keywords: "enter queue steer message reply busy option",
    value: (c) => c.settings.requestQueuing ?? FOLLOW_VSCODE,
    set: (v) => save({ requestQueuing: v === FOLLOW_VSCODE ? null : (v as RequestQueuing) }),
    source: (c) => SOURCE_NOTE(c.defaults?.requestQueuing?.source ?? (c.settings.requestQueuing ? "agent-nav" : null)),
    modified: (c) => (c.defaults?.requestQueuing?.source ?? (c.settings.requestQueuing ? "agent-nav" : "builtin")) === "agent-nav",
    reset: () => save({ requestQueuing: null }),
    options: (c) => [
      { value: "queue", label: S.requestQueuingChoices.queue, title: S.requestQueuingDetails.queue },
      { value: "steer", label: S.requestQueuingChoices.steer, title: S.requestQueuingDetails.steer },
      { value: FOLLOW_VSCODE, label: S.requestQueuingFollow(S.requestQueuingChoices[c.defaults?.requestQueuing?.value ?? "queue"]) },
    ],
  },

  {
    ...text("keepIdleSessionsWarmMinutes"),
    group: "sessions",
    kind: "enum",
    keywords: "idle process memory resume close claude",
    ...plain("keepIdleSessionsWarmMinutes", 10),
    value: (c) => String(c.settings.keepIdleSessionsWarmMinutes ?? 10),
    set: (v) => save({ keepIdleSessionsWarmMinutes: Number(v) }),
    options: (c) => {
      const minutes = c.settings.keepIdleSessionsWarmMinutes ?? 10;
      const all = KEEP_WARM_MINUTES.includes(minutes) ? KEEP_WARM_MINUTES : [...KEEP_WARM_MINUTES, minutes].sort((a, b) => a - b);
      return all.map((n) => ({ value: String(n), label: n === 0 ? S.keepWarmNever : S.inboxIntervalMinutes(n) }));
    },
  },

  {
    ...text("maxWarmSessions"),
    group: "sessions",
    kind: "enum",
    keywords: "idle process memory resume close claude limit warm",
    ...plain("maxWarmSessions", 4),
    value: (c) => String(c.settings.maxWarmSessions ?? 4),
    set: (v) => save({ maxWarmSessions: Number(v) }),
    options: (c) => {
      const count = c.settings.maxWarmSessions ?? 4;
      const all = MAX_WARM_SESSIONS.includes(count) ? MAX_WARM_SESSIONS : [...MAX_WARM_SESSIONS, count].sort((a, b) => (a === 0 ? 1 : b === 0 ? -1 : a - b));
      return all.map((n) => ({ value: String(n), label: n === 0 ? S.maxWarmUnlimited : S.maxWarmCount(n) }));
    },
  },

  { ...text("feedbackAutoTidy"), operatorOnly: true, group: "general", kind: "switch", ...plain("feedbackAutoTidy", false), value: (c) => c.settings.feedbackAutoTidy ?? false, set: (v) => save({ feedbackAutoTidy: v }), keywords: "improvements feedback worktree backup disk cleanup" },
  { ...text("useProviderEnv"), group: "general", kind: "switch", ...plain("useProviderEnv", false), value: (c) => c.settings.useProviderEnv ?? false, set: (v) => save({ useProviderEnv: v }), keywords: "api key anthropic bedrock vertex foundry billing environment" },

  { ...text("mobileAccess"), group: "mobile", kind: "switch", ...plain("mobileAccess", false), value: (c) => c.settings.mobileAccess ?? false, set: (v) => save({ mobileAccess: v }), keywords: "iphone phone ios lan qr pairing" },
  { ...text("mobileRelay"), group: "mobile", kind: "switch", ...plain("mobileRelay", false), value: (c) => c.settings.mobileRelay ?? false, set: (v) => save({ mobileRelay: v }), keywords: "relay remote anywhere cloudflare tunnel encrypted outside" },
  { ...text("mobilePairing"), group: "mobile", kind: "custom", component: "mobileAccess", wide: true, keywords: "iphone phone ios qr pairing device code", modified: () => false },
  { ...text("desktopLink"), group: "desktopLink", kind: "switch", ...plain("desktopLink", false), value: (c) => c.settings.desktopLink ?? false, set: (v) => save({ desktopLink: v }), keywords: "remote mac desktop link pair encrypted another computer host" },
  { ...text("desktopLinkIncoming"), group: "desktopLink", kind: "custom", component: "desktopLinkIncoming", wide: true, keywords: "remote mac desktop link pairing text fingerprint", modified: () => false },
  { ...text("desktopLinkOutgoing"), group: "desktopLink", kind: "custom", component: "desktopLinkOutgoing", wide: true, keywords: "remote mac desktop link open window add host", modified: () => false },


  { ...text("mcpServers"), group: "mcp", kind: "custom", component: "mcpServers", wide: true, keywords: "server connector reconnect", modified: () => false },
  { ...text("daemon"), group: "status", kind: "custom", component: "daemon", wide: true, keywords: "account version connection", modified: () => false },
];
