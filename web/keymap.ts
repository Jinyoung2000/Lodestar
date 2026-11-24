import type { CommandKeys, KeymapOverrides, KeymapPreset } from "../shared/protocol";

export type When = "terminal" | "notTerminal" | "notEditor" | "editor" | "editorArea" | "editorGroupKeys" | "notComposer" | "notEditorOrComposer" | "electron" | "browserTab" | "searchTab" | "chat" | "approval" | "focusLayout" | "focusNotEditor" | "chatTabs";

export type Binding = { keys: [string] | [string, string]; command: string; when?: When };

export type KeyContext = { inTerminal: boolean; inEditor: boolean; inEditorArea?: boolean; inComposer?: boolean; inBrowser?: boolean; inSearch?: boolean; inElectron?: boolean; inSearchOverlay?: boolean; inChat?: boolean; approvalPending?: boolean; inFocusLayout?: boolean; inFilledText?: boolean; hiddenCommands?: ReadonlySet<string> };

export type KeyInput = { code?: string; key?: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean };

export const CHORD_TIMEOUT_MS = 1500;

const K = "Meta+KeyK";

export const BINDINGS: Binding[] = [
  { keys: ["Meta+KeyS"], command: "save" },
  { keys: ["Alt+Shift+KeyF"], command: "formatDocument", when: "editor" },
  { keys: [K, "Meta+KeyF"], command: "formatSelection", when: "editor" },
  { keys: ["Alt+KeyZ"], command: "editor:toggleWordWrap", when: "editor" },
  { keys: ["Meta+Period"], command: "quickFix", when: "editor" },
  { keys: ["Alt+Meta+Period"], command: "editor:autoFix", when: "editor" },
  { keys: ["Shift+Meta+Semicolon"], command: "editor:breadcrumbsFocus", when: "editor" },
  { keys: ["Shift+Meta+Period"], command: "editor:breadcrumbsFocusAndSelect", when: "editor" },
  { keys: ["Alt+F8"], command: "nextProblem", when: "editor" },
  { keys: ["Alt+Shift+F8"], command: "prevProblem", when: "editor" },
  { keys: ["F8"], command: "nextProblem", when: "editor" },
  { keys: ["Shift+F8"], command: "prevProblem", when: "editor" },
  { keys: ["Meta+Backslash"], command: "splitEditorRight", when: "editorArea" },
  { keys: [K, "Meta+Backslash"], command: "splitEditorDown", when: "editorArea" },
  { keys: [K, "Meta+ArrowLeft"], command: "focusLeftEditorGroup", when: "editorArea" },
  { keys: [K, "Meta+ArrowRight"], command: "focusRightEditorGroup", when: "editorArea" },
  { keys: [K, "Meta+ArrowUp"], command: "focusAboveEditorGroup", when: "editorArea" },
  { keys: [K, "Meta+ArrowDown"], command: "focusBelowEditorGroup", when: "editorArea" },
  { keys: [K, "ArrowLeft"], command: "moveEditorGroupLeft", when: "editorArea" },
  { keys: [K, "ArrowRight"], command: "moveEditorGroupRight", when: "editorArea" },
  { keys: [K, "ArrowUp"], command: "moveEditorGroupUp", when: "editorArea" },
  { keys: [K, "ArrowDown"], command: "moveEditorGroupDown", when: "editorArea" },
  ...[1, 2, 3, 4, 5, 6, 7, 8].map((n): Binding => ({ keys: [`Meta+Digit${n}`], command: `focusEditorGroup:${n - 1}`, when: "editorGroupKeys" })),
  { keys: ["Ctrl+Meta+ArrowLeft"], command: "moveEditorToPreviousGroup", when: "editorArea" },
  { keys: ["Ctrl+Meta+ArrowRight"], command: "moveEditorToNextGroup", when: "editorArea" },
  { keys: ["Ctrl+Meta+Digit1"], command: "moveEditorToFirstGroup", when: "editorArea" },
  { keys: ["Ctrl+Meta+Digit9"], command: "moveEditorToLastGroup", when: "editorArea" },
  { keys: ["Alt+Meta+ArrowLeft"], command: "previousEditor" },
  { keys: ["Alt+Meta+ArrowRight"], command: "nextEditor" },
  { keys: ["Shift+Meta+BracketLeft"], command: "previousEditor" },
  { keys: ["Shift+Meta+BracketRight"], command: "nextEditor" },
  { keys: [K, "Alt+Meta+ArrowLeft"], command: "previousEditorInGroup", when: "editorArea" },
  { keys: [K, "Alt+Meta+ArrowRight"], command: "nextEditorInGroup", when: "editorArea" },
  { keys: [K, "Shift+Meta+ArrowLeft"], command: "moveEditorLeftInGroup", when: "editorArea" },
  { keys: [K, "Shift+Meta+ArrowRight"], command: "moveEditorRightInGroup", when: "editorArea" },
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n): Binding => ({ keys: [`Ctrl+Digit${n}`], command: `openEditorAtIndex:${n - 1}`, when: "editorArea" })),
  { keys: ["Ctrl+Digit0"], command: "lastEditorInGroup", when: "editorArea" },
  { keys: ["Ctrl+Tab"], command: "cycleRecentEditor", when: "editorArea" },
  { keys: ["Ctrl+Shift+Tab"], command: "cycleRecentEditorBack", when: "editorArea" },
  { keys: ["Ctrl+Tab"], command: "sessionSwitcher" },
  { keys: ["Ctrl+Shift+Tab"], command: "sessionSwitcherBack" },
  { keys: [K, "KeyW"], command: "closeEditorsInGroup", when: "editorArea" },
  { keys: [K, "KeyU"], command: "closeUnmodifiedEditors", when: "editorArea" },
  { keys: ["Alt+Meta+KeyT"], command: "closeOtherEditors", when: "editorArea" },
  { keys: [K, "Meta+KeyW"], command: "closeAllEditors", when: "editorArea" },
  { keys: [K, "Shift+Meta+KeyW"], command: "closeAllGroups", when: "editorArea" },
  { keys: [K, "Enter"], command: "keepEditor", when: "editorArea" },
  { keys: [K, "Shift+Enter"], command: "pinEditor", when: "editorArea" },
  { keys: [K, "Meta+KeyM"], command: "toggleMaximizeEditorGroup", when: "editorArea" },
  { keys: ["Alt+Meta+Digit0"], command: "flipEditorGroupLayout", when: "editorArea" },
  { keys: ["Shift+Meta+KeyT"], command: "reopenClosedEditor", when: "editorArea" },
  { keys: [K, "F12"], command: "revealDefinitionAside", when: "editor" },
  { keys: ["Meta+Backslash"], command: "split" },
  { keys: [K, "Meta+Backslash"], command: "splitDown" },
  { keys: ["Shift+Meta+ArrowLeft"], command: "previousChatTab", when: "chatTabs" },
  { keys: ["Shift+Meta+ArrowRight"], command: "nextChatTab", when: "chatTabs" },
  { keys: ["Ctrl+Meta+ArrowLeft"], command: "movePanePrev" },
  { keys: ["Ctrl+Meta+ArrowRight"], command: "movePaneNext" },
  { keys: [K, "Meta+ArrowLeft"], command: "focusPaneLeft" },
  { keys: [K, "Meta+ArrowRight"], command: "focusPaneRight" },
  { keys: [K, "Meta+ArrowUp"], command: "focusPaneUp" },
  { keys: [K, "Meta+ArrowDown"], command: "focusPaneDown" },
  { keys: [K, "ArrowLeft"], command: "focusPaneLeft" },
  { keys: [K, "ArrowRight"], command: "focusPaneRight" },
  { keys: [K, "ArrowUp"], command: "focusPaneUp" },
  { keys: [K, "ArrowDown"], command: "focusPaneDown" },
  ...[1, 2, 3, 4, 5, 6, 7, 8].map((n): Binding => ({ keys: [`Meta+Digit${n}`], command: `focusPaneIndex:${n - 1}` })),
  { keys: ["Meta+Digit9"], command: "focusPaneIndex:last" },
  { keys: ["Meta+KeyW"], command: "close" },
  { keys: [K, "KeyW"], command: "closeAllChats" },
  { keys: [K, "Meta+KeyW"], command: "closeAllSessions" },
  { keys: ["Shift+Meta+KeyT"], command: "reopenClosed" },
  { keys: ["Ctrl+Minus"], command: "sessionBack", when: "notEditor" },
  { keys: ["Ctrl+Shift+Minus"], command: "sessionForward", when: "notEditor" },
  { keys: ["Meta+BracketLeft"], command: "sessionBack", when: "notEditor" },
  { keys: ["Meta+BracketRight"], command: "sessionForward", when: "notEditor" },
  { keys: ["Alt+Meta+ArrowUp"], command: "promptPrev", when: "notEditor" },
  { keys: ["Alt+Meta+ArrowDown"], command: "promptNext", when: "notEditor" },
  { keys: ["Shift+Meta+KeyA"], command: "focusApproval" },
  { keys: ["Meta+Enter"], command: "acceptTool", when: "approval" },
  { keys: ["Alt+Meta+Enter"], command: "skipTool", when: "approval" },
  { keys: ["Meta+Slash"], command: "attachMenu", when: "notEditorOrComposer" },
  { keys: ["Alt+KeyH"], command: "attach" },
  { keys: ["Shift+Meta+KeyI"], command: "cycleEffort" },
  { keys: ["Shift+Meta+KeyM"], command: "models" },
  { keys: ["Ctrl+KeyC"], command: "interrupt", when: "notTerminal" },
  { keys: ["Meta+KeyN"], command: "newSession" },
  { keys: ["Shift+Meta+Escape"], command: "newSession" },
  { keys: [K, "Meta+KeyN"], command: "quickChat" },
  { keys: ["Ctrl+Meta+KeyN"], command: "quickChat" },
  { keys: ["Shift+Meta+KeyN"], command: "newWindow", when: "electron" },
  { keys: ["Shift+Meta+KeyW"], command: "closeWindow", when: "electron" },
  { keys: ["Ctrl+Alt+KeyR"], command: "sessions" },
  { keys: [K], command: "terminalClear", when: "terminal" },
  { keys: [K], command: "search", when: "notEditor" },
  { keys: ["Shift+Meta+KeyP"], command: "commandPalette" },
  { keys: [K, "Meta+KeyS"], command: "keyboardShortcuts" },
  { keys: ["Meta+KeyR"], command: "browserReload", when: "browserTab" },
  { keys: ["Meta+KeyR"], command: "reloadWindow" },
  { keys: ["Meta+KeyP"], command: "quickOpen" },
  { keys: ["Meta+KeyO"], command: "openFolder" },
  { keys: ["Shift+Meta+KeyF"], command: "findInFiles" },
  { keys: ["Shift+Meta+KeyH"], command: "replaceInFiles" },
  { keys: ["F4"], command: "focusNextSearchResult" },
  { keys: ["Shift+F4"], command: "focusPreviousSearchResult" },
  { keys: ["Shift+Meta+KeyO"], command: "gotoSymbol" },
  { keys: ["Ctrl+KeyG"], command: "gotoLine", when: "editorArea" },
  { keys: ["Meta+KeyI"], command: "terminalAsk", when: "terminal" },
  { keys: ["Meta+KeyF"], command: "terminalFind", when: "terminal" },
  { keys: ["Meta+KeyI"], command: "quickAsk" },
  { keys: ["Shift+Meta+KeyB"], command: "btw" },
  { keys: ["Shift+Meta+KeyK"], command: "board", when: "notEditor" },
  { keys: ["Shift+Meta+KeyL"], command: "inbox", when: "notEditor" },
  { keys: ["Alt+Meta+KeyF"], command: "feedback", when: "notEditor" },
  { keys: ["Shift+Meta+KeyX"], command: "feedback" },
  { keys: ["Meta+Comma"], command: "openSettings" },
  { keys: ["Meta+KeyL"], command: "focusChatInput" },
  { keys: ["Meta+KeyB"], command: "toggleFocusSide", when: "focusLayout" },
  { keys: ["Alt+Meta+KeyB"], command: "toggleFocusChat", when: "focusLayout" },
  { keys: ["Meta+KeyB"], command: "toggleSidebar" },
  { keys: ["Meta+KeyJ"], command: "toggleBottom" },
  { keys: ["Alt+Meta+KeyB"], command: "toggleRight" },
  { keys: ["Ctrl+Shift+KeyG"], command: "sourceControl" },
  { keys: ["Shift+Meta+KeyG"], command: "sourceControl", when: "focusNotEditor" },
  { keys: ["Shift+Meta+KeyE"], command: "showFiles" },
  { keys: ["Ctrl+Shift+KeyM"], command: "toggleTabFocusMode" },
  { keys: ["Ctrl+Alt+KeyL"], command: "toggleLayout" },
  { keys: ["Ctrl+Meta+KeyJ"], command: "toggleFloat" },
  { keys: ["Ctrl+Meta+KeyI"], command: "focusSession" },
  { keys: ["Alt+Meta+BracketLeft"], command: "editor:fold", when: "editor" },
  { keys: ["Alt+Meta+BracketRight"], command: "editor:unfold", when: "editor" },
  { keys: [K, "Meta+Digit0"], command: "editor:foldAll", when: "editor" },
  { keys: [K, "Meta+KeyJ"], command: "editor:unfoldAll", when: "editor" },
  { keys: [K, "Meta+KeyL"], command: "editor:toggleFold", when: "editor" },
  { keys: [K, "Shift+Meta+KeyL"], command: "editor:toggleFoldRecursively", when: "editor" },
  { keys: [K, "Meta+BracketLeft"], command: "editor:foldRecursively", when: "editor" },
  { keys: [K, "Meta+BracketRight"], command: "editor:unfoldRecursively", when: "editor" },
  ...[1, 2, 3, 4, 5, 6, 7].map((level): Binding => ({ keys: [K, `Meta+Digit${level}`], command: `editor:foldLevel${level}`, when: "editor" })),
  { keys: [K, "Meta+Slash"], command: "editor:foldAllBlockComments", when: "editor" },
  { keys: [K, "Meta+Digit8"], command: "editor:foldAllMarkerRegions", when: "editor" },
  { keys: [K, "Meta+Digit9"], command: "editor:unfoldAllMarkerRegions", when: "editor" },
  { keys: [K, "Meta+Minus"], command: "editor:foldAllExcept", when: "editor" },
  { keys: [K, "Meta+Equal"], command: "editor:unfoldAllExcept", when: "editor" },
  { keys: ["Ctrl+KeyJ"], command: "editor:joinLines", when: "editor" },
  { keys: [K, "Meta+KeyC"], command: "editor:addCommentLine", when: "editor" },
  { keys: [K, "Meta+KeyU"], command: "editor:removeCommentLine", when: "editor" },
  { keys: [K, "Meta+KeyX"], command: "editor:trimTrailingWhitespace", when: "editor" },
  { keys: ["Ctrl+Shift+Meta+ArrowRight"], command: "editor:smartSelectExpand", when: "editor" },
  { keys: ["Ctrl+Shift+ArrowRight"], command: "editor:smartSelectExpand", when: "editor" },
  { keys: ["Ctrl+Shift+Meta+ArrowLeft"], command: "editor:smartSelectShrink", when: "editor" },
  { keys: ["Ctrl+Shift+ArrowLeft"], command: "editor:smartSelectShrink", when: "editor" },
  { keys: ["Shift+Meta+KeyL"], command: "editor:selectHighlights", when: "editor" },
  { keys: ["Meta+F2"], command: "editor:changeAll", when: "editor" },
  { keys: [K, "Meta+KeyD"], command: "editor:moveSelectionToNextFindMatch", when: "editor" },
  { keys: ["Alt+Shift+KeyI"], command: "editor:insertCursorAtEndOfEachLineSelected", when: "editor" },
  { keys: [K, "Meta+KeyI"], command: "editor:showHover", when: "editor" },
  { keys: ["Alt+Shift+Meta+ArrowLeft"], command: "editor:columnSelectLeft", when: "editor" },
  { keys: ["Alt+Shift+Meta+ArrowRight"], command: "editor:columnSelectRight", when: "editor" },
  { keys: ["Alt+Shift+Meta+ArrowUp"], command: "editor:columnSelectUp", when: "editor" },
  { keys: ["Alt+Shift+Meta+ArrowDown"], command: "editor:columnSelectDown", when: "editor" },
  { keys: ["Alt+Shift+Meta+PageUp"], command: "editor:columnSelectPageUp", when: "editor" },
  { keys: ["Alt+Shift+Meta+PageDown"], command: "editor:columnSelectPageDown", when: "editor" },
  { keys: ["Ctrl+Alt+ArrowLeft"], command: "editor:cursorWordPartLeft", when: "editor" },
  { keys: ["Ctrl+Alt+Shift+ArrowLeft"], command: "editor:cursorWordPartLeftSelect", when: "editor" },
  { keys: ["Ctrl+Alt+ArrowRight"], command: "editor:cursorWordPartRight", when: "editor" },
  { keys: ["Ctrl+Alt+Shift+ArrowRight"], command: "editor:cursorWordPartRightSelect", when: "editor" },
  { keys: ["Ctrl+Alt+Backspace"], command: "editor:deleteWordPartLeft", when: "editor" },
  { keys: ["Ctrl+Alt+Delete"], command: "editor:deleteWordPartRight", when: "editor" },
  { keys: ["Alt+Meta+Backspace"], command: "editor:removeBrackets", when: "editor" },
  { keys: [K, "Meta+KeyB"], command: "editor:setSelectionAnchor", when: "editor" },
  { keys: [K, "Meta+KeyK"], command: "editor:selectFromAnchorToCursor", when: "editor" },
  { keys: ["Escape"], command: "escape" },
  { keys: ["Meta+KeyT"], command: "openBrowser", when: "browserTab" },
  { keys: ["Meta+KeyT"], command: "symbols" },
  { keys: ["Meta+Equal"], command: "browserZoomIn", when: "browserTab" },
  { keys: ["Meta+Minus"], command: "browserZoomOut", when: "browserTab" },
  { keys: ["Meta+Numpad0"], command: "browserZoomReset", when: "browserTab" },
  { keys: ["Meta+KeyF"], command: "browserFind", when: "browserTab" },
  { keys: ["Meta+KeyF"], command: "chatFind", when: "chat" },
  { keys: ["Meta+KeyY"], command: "browserHistory", when: "browserTab" },
  { keys: ["Meta+KeyD"], command: "browserFavorite", when: "browserTab" },
  { keys: ["Shift+Meta+KeyC"], command: "addElement", when: "browserTab" },
  { keys: ["Alt+Meta+KeyC"], command: "commentElements", when: "browserTab" },
  { keys: ["Alt+Meta+KeyL"], command: "searchDetails", when: "searchTab" },
  { keys: ["Meta+Equal"], command: "zoomIn", when: "electron" },
  { keys: ["Shift+Meta+Equal"], command: "zoomIn", when: "electron" },
  { keys: ["Meta+NumpadAdd"], command: "zoomIn", when: "electron" },
  { keys: ["Meta+Minus"], command: "zoomOut", when: "electron" },
  { keys: ["Shift+Meta+Minus"], command: "zoomOut", when: "electron" },
  { keys: ["Meta+NumpadSubtract"], command: "zoomOut", when: "electron" },
  { keys: ["Meta+Numpad0"], command: "zoomReset", when: "electron" },
  { keys: ["Meta+Digit0"], command: "zoomReset", when: "electron" },
];

const ed = (keys: string, command: string): Binding => ({ keys: [keys], command, when: "editor" });
const anywhere = (keys: string, command: string): Binding => ({ keys: [keys], command });

export const WEBSTORM_BINDINGS: Binding[] = [
  ed("Meta+KeyD", "editor:duplicateSelection"),
  ed("Meta+Backspace", "editor:deleteLines"),
  ed("Alt+Meta+Slash", "editor:blockComment"),
  ed("Alt+ArrowUp", "editor:smartSelectExpand"),
  ed("Alt+ArrowDown", "editor:smartSelectShrink"),
  ed("Alt+Shift+ArrowUp", "editor:moveLinesUp"),
  ed("Alt+Shift+ArrowDown", "editor:moveLinesDown"),
  ed("Alt+Enter", "quickFix"),
  ed("Alt+Meta+KeyL", "formatDocument"),
  ed("Ctrl+Shift+KeyJ", "editor:joinLines"),
  ed("Shift+Enter", "editor:insertLineAfter"),
  ed("Alt+Meta+Enter", "editor:insertLineBefore"),
  ed("Meta+Period", "editor:toggleFold"),
  ed("Meta+Equal", "editor:unfold"),
  ed("Meta+Minus", "editor:fold"),
  ed("Alt+Meta+Equal", "editor:unfoldRecursively"),
  ed("Alt+Meta+Minus", "editor:foldRecursively"),
  ed("Shift+Meta+Equal", "editor:unfoldAll"),
  ed("Shift+Meta+Minus", "editor:foldAll"),
  ed("Meta+NumpadAdd", "editor:unfold"),
  ed("Meta+NumpadSubtract", "editor:fold"),
  ed("Ctrl+KeyG", "editor:addSelectionToNextFindMatch"),
  ed("Ctrl+Meta+KeyG", "editor:selectHighlights"),
  ed("Meta+KeyR", "editor:startFindReplace"),
  ed("Meta+KeyB", "editor:goToDeclaration"),
  ed("Alt+Meta+KeyB", "editor:goToImplementation"),
  ed("Meta+KeyY", "editor:peekDefinition"),
  ed("Ctrl+Shift+KeyB", "editor:goToTypeDefinition"),
  ed("Alt+F7", "editor:findReferences"),
  ed("Alt+Meta+F7", "editor:peekReferences"),
  ed("Shift+F6", "editor:rename"),
  ed("F2", "nextProblem"),
  ed("Shift+F2", "prevProblem"),
  ed("Meta+KeyP", "editor:triggerParameterHints"),
  ed("Ctrl+KeyJ", "editor:showHover"),
  ed("F1", "editor:showHover"),
  ed("Ctrl+KeyM", "editor:jumpToBracket"),
  ed("Ctrl+Alt+ArrowDown", "editor:wordHighlightNext"),
  ed("Ctrl+Alt+ArrowUp", "editor:wordHighlightPrev"),
  ed("Meta+BracketLeft", "editor:navigateBack"),
  ed("Alt+Meta+ArrowLeft", "editor:navigateBack"),
  ed("Meta+BracketRight", "editor:navigateForward"),
  ed("Alt+Meta+ArrowRight", "editor:navigateForward"),
  ed("Meta+KeyL", "gotoLine"),
  ed("Meta+F12", "gotoSymbol"),
  ed("Shift+Meta+KeyA", "commandPalette"),
  anywhere("Shift+Meta+KeyO", "quickOpen"),
  anywhere("Meta+KeyE", "quickOpen"),
  anywhere("Meta+KeyO", "symbols"),
  anywhere("Alt+Meta+KeyO", "symbols"),
  anywhere("Shift+Meta+KeyR", "replaceInFiles"),
  anywhere("Alt+F12", "toggleBottom"),
];

export const WEBSTORM_DROPS: readonly { command: string; keys: readonly string[] }[] = [
  { command: "gotoSymbol", keys: ["Shift+Meta+KeyO"] },
  { command: "openFolder", keys: ["Meta+KeyO"] },
  { command: "quickFix", keys: ["Meta+Period"] },
  { command: "gotoLine", keys: ["Ctrl+KeyG"] },
  { command: "previousEditor", keys: ["Alt+Meta+ArrowLeft"] },
  { command: "nextEditor", keys: ["Alt+Meta+ArrowRight"] },
  { command: "editor:joinLines", keys: ["Ctrl+KeyJ"] },
];

const presetCache = new Map<KeymapPreset, Binding[]>();
const overrideCache = new Map<KeymapPreset, WeakMap<CommandKeys, Binding[]>>();

export function bindingsFor(preset: KeymapPreset, overrides?: CommandKeys): Binding[] {
  const base = presetBindings(preset);
  if (!overrides || Object.keys(overrides).length === 0) return base;
  let cache = overrideCache.get(preset);
  if (!cache) {
    cache = new WeakMap();
    overrideCache.set(preset, cache);
  }
  let list = cache.get(overrides);
  if (!list) {
    list = applyOverrides(base, overrides);
    cache.set(overrides, list);
  }
  return list;
}

export function presetBindings(preset: KeymapPreset): Binding[] {
  if (preset !== "webstorm") return BINDINGS;
  let list = presetCache.get(preset);
  if (!list) {
    const dropped = (b: Binding) => WEBSTORM_DROPS.some((d) => d.command === b.command && d.keys.join(" ") === b.keys.join(" "));
    list = [...WEBSTORM_BINDINGS, ...BINDINGS.filter((b) => !dropped(b))];
    presetCache.set(preset, list);
  }
  return list;
}

let activePreset: KeymapPreset = "vscode";
let activeOverrides: KeymapOverrides = {};

export function setKeymapPreset(preset: KeymapPreset) {
  activePreset = preset;
}

export function setKeymapOverrides(overrides: KeymapOverrides | undefined) {
  activeOverrides = overrides ?? {};
}

export function activeKeymapPreset(): KeymapPreset {
  return activePreset;
}

export function activeCommandKeys(): CommandKeys | undefined {
  return activeOverrides[activePreset];
}

export function activeBindings(): Binding[] {
  return bindingsFor(activePreset, activeOverrides[activePreset]);
}

export function applyOverrides(base: readonly Binding[], overrides: CommandKeys): Binding[] {
  const result: Binding[] = [];
  const placed = new Set<string>();
  for (const binding of base) {
    const keys = Object.hasOwn(overrides, binding.command) ? overrides[binding.command] : undefined;
    if (!keys) {
      result.push(binding);
      continue;
    }
    if (placed.has(binding.command)) continue;
    placed.add(binding.command);
    for (const sequence of keys) result.push({ keys: sequence.split(" ") as Binding["keys"], command: binding.command, ...(binding.when ? { when: binding.when } : {}) });
  }
  return result;
}

export function keysOf(bindings: readonly Binding[], command: string): string[] {
  return [...new Set(bindings.filter((b) => b.command === command).map((b) => b.keys.join(" ")))];
}

export function whenOf(bindings: readonly Binding[], command: string): When | undefined {
  return bindings.find((b) => b.command === command)?.when;
}

const CONTEXT_FLAGS = ["inTerminal", "inEditor", "inEditorArea", "inComposer", "inBrowser", "inSearch", "inElectron", "inChat", "approvalPending", "inFocusLayout"] as const;
let possible: KeyContext[] | null = null;

function possibleContexts(): KeyContext[] {
  if (possible) return possible;
  possible = [];
  for (let mask = 0; mask < 1 << CONTEXT_FLAGS.length; mask++) {
    const ctx: KeyContext = { inTerminal: false, inEditor: false };
    CONTEXT_FLAGS.forEach((flag, i) => (ctx[flag] = (mask & (1 << i)) !== 0));
    if (ctx.inTerminal && (ctx.inEditor || ctx.inEditorArea || ctx.inComposer)) continue;
    if (ctx.inEditor && ctx.inComposer) continue;
    possible.push(ctx);
  }
  return possible;
}

export function whenOverlaps(a: When | undefined, b: When | undefined): boolean {
  return a === b || possibleContexts().some((ctx) => whenOk(a, ctx) && whenOk(b, ctx));
}

export function findConflicts(bindings: readonly Binding[], command: string, sequence: string, when: When | undefined, base: readonly Binding[] = bindings): string[] {
  const sharedByDefault = (other: string) => keysOf(base, command).includes(sequence) && keysOf(base, other).includes(sequence);
  return [...new Set(bindings.filter((b) => b.command !== command && b.keys.join(" ") === sequence && whenOverlaps(b.when, when)).map((b) => b.command))].filter((other) => !sharedByDefault(other));
}

const sameKeys = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((key) => b.includes(key));

function withoutDefaults(base: readonly Binding[], overrides: CommandKeys): CommandKeys {
  return Object.fromEntries(Object.entries(overrides).filter(([command, keys]) => base.some((b) => b.command === command) && !sameKeys(keys, keysOf(base, command))));
}

export function assignKeys(base: readonly Binding[], current: CommandKeys | undefined, command: string, sequence: string, takeFrom: readonly string[] = []): CommandKeys {
  const effective = current ? applyOverrides(base, current) : base;
  const next: CommandKeys = { ...current, [command]: [sequence] };
  for (const other of takeFrom) next[other] = keysOf(effective, other).filter((key) => key !== sequence);
  return withoutDefaults(base, next);
}

export function resetKeys(current: CommandKeys | undefined, command: string): CommandKeys {
  const next: CommandKeys = { ...current };
  delete next[command];
  return next;
}

const FUNCTION_KEY = /(^|\+)F([1-9]|1[0-9]|20)$/;

export function isRecordableStroke(stroke: string, first: boolean): boolean {
  if (stroke === "Escape") return false;
  if (!first) return true;
  return /(^|\+)(Ctrl|Alt|Meta)\+/.test(stroke) || FUNCTION_KEY.test(stroke);
}

const CODE_BY_KEY: Record<string, string> = { "\\": "Backslash", "-": "Minus", "=": "Equal", "+": "Equal", "/": "Slash", "left": "ArrowLeft", "right": "ArrowRight", "up": "ArrowUp", "down": "ArrowDown", "esc": "Escape", "escape": "Escape" };

function codeOf(input: KeyInput): string | null {
  if (input.code) return input.code;
  const key = input.key;
  if (!key) return null;
  if (/^[a-z]$/i.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  if (key.startsWith("Arrow")) return key;
  return CODE_BY_KEY[key.toLowerCase()] ?? key;
}

const MODIFIER_CODES = /^(Meta|Shift|Alt|Control|CapsLock|OS)(Left|Right)?$/;

export function strokeOf(input: KeyInput): string | null {
  const code = codeOf(input);
  if (!code || MODIFIER_CODES.test(code)) return null;
  const parts: string[] = [];
  if (input.ctrlKey) parts.push("Ctrl");
  if (input.altKey) parts.push("Alt");
  if (input.shiftKey) parts.push("Shift");
  if (input.metaKey) parts.push("Meta");
  parts.push(code);
  return parts.join("+");
}

export type Pending = { prefix: string; at: number };

export type Step =
  | { kind: "run"; command: string; pending: null }
  | { kind: "pending"; pending: Pending; opens?: string }
  | { kind: "cancel"; pending: null }
  | { kind: "pass"; pending: null };

const usable = (b: Binding, ctx: KeyContext) => whenOk(b.when, ctx) && !ctx.hiddenCommands?.has(b.command);

const whenOk = (when: When | undefined, ctx: KeyContext) => {
  if (when === "terminal") return !!ctx.inTerminal;
  if (when === "notTerminal") return !ctx.inTerminal;
  if (when === "notEditor") return !ctx.inEditor;
  if (when === "editor") return !!ctx.inEditor;
  if (when === "editorArea") return !!ctx.inEditorArea;
  if (when === "editorGroupKeys") return !!ctx.inEditorArea || !!ctx.inFocusLayout;
  if (when === "notComposer") return !ctx.inComposer;
  if (when === "notEditorOrComposer") return !ctx.inEditor && !ctx.inComposer;
  if (when === "electron") return !!ctx.inElectron;
  if (when === "browserTab") return !!ctx.inBrowser;
  if (when === "searchTab") return !!ctx.inSearch;
  if (when === "chat") return !!ctx.inChat && !ctx.inEditor && !ctx.inTerminal;
  if (when === "approval") return !!ctx.approvalPending && !ctx.inEditor && !ctx.inTerminal;
  if (when === "focusLayout") return !!ctx.inFocusLayout;
  if (when === "focusNotEditor") return !!ctx.inFocusLayout && !ctx.inEditor;
  if (when === "chatTabs") return !!ctx.inFocusLayout && !ctx.inEditor && !ctx.inTerminal && !ctx.inFilledText;
  return true;
};

const isModified = (stroke: string) => /(^|\+)(Meta|Ctrl|Alt)\+/.test(stroke);

export function stepKey(pending: Pending | null, stroke: string, ctx: KeyContext, now: number, bindings: Binding[] = activeBindings()): Step {
  const live = pending && now - pending.at <= CHORD_TIMEOUT_MS ? pending : null;
  const opensOf = (key: string) => bindings.find((b) => b.keys.length === 1 && b.keys[0] === key && usable(b, ctx))?.command;
  if (live) {
    const hit = bindings.find((b) => b.keys.length === 2 && b.keys[0] === live.prefix && b.keys[1] === stroke && usable(b, ctx));
    if (ctx.inSearchOverlay) {
      const again = stroke === live.prefix ? opensOf(stroke) : undefined;
      if (again) return { kind: "pending", pending: { prefix: stroke, at: now }, opens: again };
      if (hit && isModified(stroke)) return { kind: "run", command: hit.command, pending: null };
      return { kind: "pass", pending: null };
    }
    if (hit) return { kind: "run", command: hit.command, pending: null };
    return { kind: "cancel", pending: null };
  }
  const terminalOnly = ctx.inTerminal ? bindings.find((b) => b.keys.length === 1 && b.keys[0] === stroke && b.when === "terminal") : undefined;
  if (terminalOnly) return { kind: "run", command: terminalOnly.command, pending: null };
  if (bindings.some((b) => b.keys.length === 2 && b.keys[0] === stroke)) {
    const opens = opensOf(stroke);
    return { kind: "pending", pending: { prefix: stroke, at: now }, ...(opens ? { opens } : {}) };
  }
  const hit = bindings.find((b) => b.keys.length === 1 && b.keys[0] === stroke && usable(b, ctx));
  return hit ? { kind: "run", command: hit.command, pending: null } : { kind: "pass", pending: null };
}

const isMenuKey = (stroke: string) => /(^|\+)(Meta|Alt)\+/.test(stroke);
const alwaysApplies = (b: Binding) => b.when === undefined || b.when === "electron";
export function keyupAwareStrokes(bindings: readonly Binding[]): ReadonlySet<string> {
  return new Set(bindings.filter((b) => b.keys.length === 1 && alwaysApplies(b) && (b.command === "quickOpen" || b.command === "commandPalette")).map((b) => b.keys[0]));
}

export function interceptStrokes(bindings: readonly Binding[]): ReadonlySet<string> {
  const keyup = keyupAwareStrokes(bindings);
  return new Set(bindings.filter((b) => b.keys.length === 1 && alwaysApplies(b)).map((b) => b.keys[0]).filter((stroke) => isMenuKey(stroke) && !keyup.has(stroke)));
}

export function browserStrokes(bindings: readonly Binding[]): ReadonlySet<string> {
  return new Set(bindings.filter((b) => b.when === "browserTab").flatMap((b) => b.keys));
}

export const KEYUP_AWARE_STROKES: ReadonlySet<string> = keyupAwareStrokes(BINDINGS);
export const INTERCEPT_STROKES: ReadonlySet<string> = interceptStrokes(BINDINGS);
export const BROWSER_STROKES: ReadonlySet<string> = browserStrokes(BINDINGS);

const EDITOR_REACHABLE: ReadonlySet<When | undefined> = new Set<When | undefined>([undefined, "editor", "editorArea", "editorGroupKeys", "electron", "notTerminal", "notComposer"]);
const PLAIN_EDITING_KEY = /^(Escape|Enter|Tab|Backspace|Delete|Arrow(Left|Right|Up|Down)|Home|End|PageUp|PageDown|Space)$/;

export function editorTakenStrokes(preset: KeymapPreset, overrides?: CommandKeys): ReadonlySet<string> {
  const presetTaken = preset === "webstorm" ? WEBSTORM_BINDINGS : [];
  const overridden = overrides ? bindingsFor(preset, overrides).filter((b) => Object.hasOwn(overrides, b.command)) : [];
  return new Set([...presetTaken, ...overridden].filter((b) => b.keys.length === 1 && EDITOR_REACHABLE.has(b.when)).map((b) => b.keys[0]).filter((stroke) => !PLAIN_EDITING_KEY.test(stroke)));
}

const ACCELERATOR_KEYS: Record<string, string> = { Equal: "=", Minus: "-", Backslash: "\\", BracketLeft: "[", BracketRight: "]", Period: ".", Comma: ",", Slash: "/", Semicolon: ";", Quote: "'", Backquote: "`", ArrowLeft: "Left", ArrowRight: "Right", ArrowUp: "Up", ArrowDown: "Down", Escape: "Esc", Numpad0: "num0", NumpadAdd: "numadd", NumpadSubtract: "numsub" };
const ACCELERATOR_MODIFIERS: Record<string, string> = { Ctrl: "Ctrl", Alt: "Alt", Shift: "Shift", Meta: "Cmd" };

export function acceleratorOf(stroke: string): string | null {
  const parts = stroke.split("+");
  const code = parts.pop() ?? "";
  const mods = parts.map((m) => ACCELERATOR_MODIFIERS[m]);
  if (mods.some((m) => !m)) return null;
  const key = ACCELERATOR_KEYS[code] ?? (/^Key[A-Z]$/.test(code) ? code.slice(3) : /^Digit[0-9]$/.test(code) ? code.slice(5) : /^(F[0-9]{1,2}|Enter|Backspace|Delete|Tab|Space|Home|End|PageUp|PageDown)$/.test(code) ? code : null);
  return key ? [...mods, key].join("+") : null;
}

export function chordFollowersOf(bindings: readonly Binding[], prefix: string, menuStrokes: ReadonlySet<string>): ReadonlySet<string> {
  return new Set(bindings.flatMap((b) => (b.keys.length === 2 && b.keys[0] === prefix && menuStrokes.has(b.keys[1]) ? [b.keys[1]] : [])));
}

const ACCELERATOR_MODIFIER_STROKES: Record<string, string> = { command: "Meta", cmd: "Meta", commandorcontrol: "Meta", cmdorctrl: "Meta", super: "Meta", meta: "Meta", control: "Ctrl", ctrl: "Ctrl", alt: "Alt", option: "Alt", shift: "Shift" };
const ACCELERATOR_KEY_CODES: Record<string, string> = Object.fromEntries(Object.entries(ACCELERATOR_KEYS).map(([code, key]) => [key.toLowerCase(), code]));

export function strokeOfAccelerator(accelerator: string): string | null {
  const parts = accelerator.split("+");
  const key = parts.pop() ?? "";
  const mods = new Set<string>();
  for (const part of parts) {
    const mod = ACCELERATOR_MODIFIER_STROKES[part.toLowerCase()];
    if (!mod) return null;
    mods.add(mod);
  }
  const code = /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : /^[0-9]$/.test(key) ? `Digit${key}` : /^F[0-9]{1,2}$/i.test(key) ? key.toUpperCase() : (ACCELERATOR_KEY_CODES[key.toLowerCase()] ?? null);
  if (!code) return null;
  return [...["Ctrl", "Alt", "Shift", "Meta"].filter((m) => mods.has(m)), code].join("+");
}

export function menuAccelerator(bindings: readonly Binding[], command: string): string | null {
  const candidates = bindings.filter((b) => b.command === command && b.keys.length === 1 && alwaysApplies(b) && acceleratorOf(b.keys[0]) !== null);
  const binding = candidates.find((b) => !b.keys[0].includes("Numpad")) ?? candidates[0];
  return binding ? acceleratorOf(binding.keys[0]) : null;
}

export function latinKeyOf(e: { key: string; code?: string }): string {
  if (/^[a-z]$/i.test(e.key)) return e.key.toLowerCase();
  const physical = /^Key([A-Z])$/.exec(e.code ?? "");
  return physical ? physical[1].toLowerCase() : e.key;
}

export function terminalKeySequence(e: Pick<KeyboardEvent, "key" | "metaKey" | "altKey" | "shiftKey" | "ctrlKey"> & { code?: string }, hasSelection: boolean): string | null {
  if (e.ctrlKey) return null;
  if (e.metaKey && !e.altKey && !e.shiftKey) {
    if (e.key === "ArrowLeft") return "\x01";
    if (e.key === "ArrowRight") return "\x05";
    if (e.key === "Backspace") return "\x15";
    if (latinKeyOf(e) === "c" && !hasSelection) return "\x19";
  }
  if (e.altKey && !e.metaKey && !e.shiftKey) {
    if (e.key === "ArrowLeft") return "\x1bb";
    if (e.key === "ArrowRight") return "\x1bf";
    if (e.key === "Backspace") return "\x17";
  }
  if (e.shiftKey && !e.metaKey && !e.altKey && e.key === "Enter") return "\x1b\r";
  return null;
}
