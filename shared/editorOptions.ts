export type EditorOptions = {
  tabSize: number;
  insertSpaces: boolean;
  detectIndentation: boolean;
  wordWrap: "off" | "on";
  lineNumbers: "on" | "off" | "relative";
  renderLineHighlight: "none" | "gutter" | "line" | "all";
  renderWhitespace: "none" | "boundary" | "selection" | "trailing" | "all";
  indentGuides: boolean;
  highlightActiveIndentGuide: boolean;
  bracketPairColorization: boolean;
  matchBrackets: "always" | "near" | "never";
  folding: boolean;
  foldingHighlight: boolean;
  foldingStrategy: "auto" | "indentation";
  showFoldingControls: "always" | "never" | "mouseover";
  // EDPARITY(E): 개요 눈금자
  overviewRulerBorder: boolean;
  hideCursorInOverviewRuler: boolean;
  minimap: boolean;
  minimapRenderCharacters: boolean;
  minimapShowSlider: "always" | "mouseover";
  stickyScroll: boolean;
  stickyScrollMaxLineCount: number;
  cursorStyle: "line" | "block" | "underline" | "line-thin" | "block-outline" | "underline-thin";
  cursorBlinking: "blink" | "smooth" | "phase" | "expand" | "solid";
  cursorWidth: number;
  scrollBeyondLastLine: boolean;
  scrollBeyondLastColumn: number;
  smoothScrolling: boolean;
  roundedSelection: boolean;
  selectionHighlight: boolean;
  occurrencesHighlight: "off" | "singleFile";
  autoClosingBrackets: "always" | "languageDefined" | "beforeWhitespace" | "never";
  autoClosingQuotes: "always" | "languageDefined" | "beforeWhitespace" | "never";
  autoSurround: "languageDefined" | "quotes" | "brackets" | "never";
  trimAutoWhitespace: boolean;
  emptySelectionClipboard: boolean;
  formatOnPaste: boolean;
  letterSpacing: number;
  lightbulb: "on" | "onCode" | "off";
  trimTrailingWhitespace: boolean;
  insertFinalNewline: boolean;
  trimFinalNewlines: boolean;
};

export type EditorOptionKey = keyof EditorOptions;

type Base<K extends EditorOptionKey> = { key: K; vscode: string; title: string; description: string; keywords?: string };
export type EditorOptionDef = {
  [K in EditorOptionKey]: Base<K> &
    (EditorOptions[K] extends boolean
      ? { kind: "boolean"; default: EditorOptions[K] }
      : EditorOptions[K] extends number
        ? { kind: "number"; default: EditorOptions[K]; min: number; max: number; step: number }
        : { kind: "enum"; default: EditorOptions[K]; options: { value: EditorOptions[K]; label: string }[] });
}[EditorOptionKey];

const opts = <T extends string>(...values: [T, string][]) => values.map(([value, label]) => ({ value, label }));

export const EDITOR_OPTION_DEFS: readonly EditorOptionDef[] = [
  { key: "tabSize", vscode: "editor.tabSize", kind: "number", default: 4, min: 1, max: 16, step: 1, title: "Tab size", description: "Columns one Tab stands for. Overridden per file when Detect indentation is on and the file's indentation is clear.", keywords: "indent spaces" },
  { key: "insertSpaces", vscode: "editor.insertSpaces", kind: "boolean", default: true, title: "Insert spaces when pressing Tab", description: "Indent with spaces instead of tab characters. Detect indentation can override this for a file.", keywords: "indent tabs" },
  { key: "detectIndentation", vscode: "editor.detectIndentation", kind: "boolean", default: true, title: "Detect indentation", description: "Read Tab size and Insert spaces from the file when it is opened.", keywords: "indent tabs spaces" },
  { key: "wordWrap", vscode: "editor.wordWrap", kind: "enum", default: "off", options: opts(["off", "Off"], ["on", "On"]), title: "Word wrap", description: "Wrap long lines at the editor width. Alt+Z toggles it for the current editor.", keywords: "wrap" },
  { key: "lineNumbers", vscode: "editor.lineNumbers", kind: "enum", default: "on", options: opts(["on", "On"], ["off", "Off"], ["relative", "Relative"]), title: "Line numbers", description: "Numbers in the gutter. Relative counts lines from the cursor." },
  { key: "renderLineHighlight", vscode: "editor.renderLineHighlight", kind: "enum", default: "line", options: opts(["none", "None"], ["gutter", "Gutter"], ["line", "Line"], ["all", "Gutter and line"]), title: "Current line highlight", description: "Where the current line is marked." },
  { key: "renderWhitespace", vscode: "editor.renderWhitespace", kind: "enum", default: "selection", options: opts(["none", "None"], ["boundary", "Boundary"], ["selection", "Selection"], ["trailing", "Trailing"], ["all", "All"]), title: "Render whitespace", description: "Draw dots for spaces and arrows for tabs: never, between words, only in the selection, only at line ends, or everywhere.", keywords: "invisible" },
  { key: "indentGuides", vscode: "editor.guides.indentation", kind: "boolean", default: true, title: "Indent guides", description: "Vertical lines at each indentation level." },
  { key: "highlightActiveIndentGuide", vscode: "editor.guides.highlightActiveIndentation", kind: "boolean", default: true, title: "Highlight active indent guide", description: "Draw the guide of the block the cursor is in brighter." },
  { key: "bracketPairColorization", vscode: "editor.bracketPairColorization.enabled", kind: "boolean", default: true, title: "Bracket pair colorization", description: "Color matching brackets by nesting depth." },
  { key: "matchBrackets", vscode: "editor.matchBrackets", kind: "enum", default: "always", options: opts(["always", "Always"], ["near", "Near the cursor"], ["never", "Never"]), title: "Match brackets", description: "Mark the bracket that pairs with the one at the cursor." },
  { key: "folding", vscode: "editor.folding", kind: "boolean", default: true, title: "Code folding", description: "Fold and unfold blocks from the gutter." },
  { key: "foldingHighlight", vscode: "editor.foldingHighlight", kind: "boolean", default: true, title: "Folded line highlight", description: "Tint the background of a folded line." },
  { key: "foldingStrategy", vscode: "editor.foldingStrategy", kind: "enum", default: "auto", options: opts(["auto", "Auto"], ["indentation", "Indentation"]), title: "Folding strategy", description: "Auto folds by the language's syntax where it has one and by indentation otherwise. Indentation always folds by indentation." },
  { key: "showFoldingControls", vscode: "editor.showFoldingControls", kind: "enum", default: "mouseover", options: opts(["mouseover", "On mouse over"], ["always", "Always"], ["never", "Never"]), title: "Folding controls", description: "When the fold arrows show in the gutter. Folded blocks always show theirs." },
  { key: "overviewRulerBorder", vscode: "editor.overviewRulerBorder", kind: "boolean", default: true, title: "Overview ruler border", description: "A thin line along the left and top edge of the strip next to the scrollbar.", keywords: "overview ruler scrollbar" },
  { key: "hideCursorInOverviewRuler", vscode: "editor.hideCursorInOverviewRuler", kind: "boolean", default: false, title: "Hide cursor in overview ruler", description: "Do not mark the cursor line on the strip next to the scrollbar.", keywords: "overview ruler cursor" },
  { key: "minimap", vscode: "editor.minimap.enabled", kind: "boolean", default: true, title: "Minimap", description: "A small overview of the file next to the scrollbar. In a narrow editor it shrinks with the editor, like VS Code.", keywords: "overview" },
  { key: "minimapRenderCharacters", vscode: "editor.minimap.renderCharacters", kind: "boolean", default: true, title: "Minimap characters", description: "Draw the actual letters in the minimap instead of color blocks." },
  { key: "minimapShowSlider", vscode: "editor.minimap.showSlider", kind: "enum", default: "mouseover", options: opts(["mouseover", "On mouse over"], ["always", "Always"]), title: "Minimap slider", description: "When the box that marks the visible part of the file shows." },
  { key: "stickyScroll", vscode: "editor.stickyScroll.enabled", kind: "boolean", default: true, title: "Sticky scroll", description: "Keep the lines that open the current blocks (function, class) pinned at the top while you scroll.", keywords: "sticky header scope" },
  { key: "stickyScrollMaxLineCount", vscode: "editor.stickyScroll.maxLineCount", kind: "number", default: 5, min: 1, max: 20, step: 1, title: "Sticky scroll lines", description: "Most lines pinned at once." },
  { key: "cursorStyle", vscode: "editor.cursorStyle", kind: "enum", default: "line", options: opts(["line", "Line"], ["block", "Block"], ["underline", "Underline"], ["line-thin", "Thin line"], ["block-outline", "Block outline"], ["underline-thin", "Thin underline"]), title: "Cursor style", description: "Shape of the text cursor." },
  { key: "cursorBlinking", vscode: "editor.cursorBlinking", kind: "enum", default: "blink", options: opts(["blink", "Blink"], ["smooth", "Smooth"], ["phase", "Phase"], ["expand", "Expand"], ["solid", "Solid"]), title: "Cursor blinking", description: "How the cursor blinks." },
  { key: "cursorWidth", vscode: "editor.cursorWidth", kind: "number", default: 0, min: 0, max: 8, step: 1, title: "Cursor width", description: "Width in px of the line cursor. 0 uses 2px." },
  { key: "scrollBeyondLastLine", vscode: "editor.scrollBeyondLastLine", kind: "boolean", default: true, title: "Scroll beyond last line", description: "Let the last line scroll up to the top of the editor." },
  { key: "scrollBeyondLastColumn", vscode: "editor.scrollBeyondLastColumn", kind: "number", default: 4, min: 0, max: 100, step: 1, title: "Scroll beyond last column", description: "Extra columns the editor can scroll to the right of the longest line." },
  { key: "smoothScrolling", vscode: "editor.smoothScrolling", kind: "boolean", default: false, title: "Smooth scrolling", description: "Animate scrolling when the editor jumps (go to line, reveal)." },
  { key: "roundedSelection", vscode: "editor.roundedSelection", kind: "boolean", default: true, title: "Rounded selection", description: "Round the corners of the selection." },
  { key: "selectionHighlight", vscode: "editor.selectionHighlight", kind: "boolean", default: true, title: "Highlight selection matches", description: "Mark other places that contain the selected text." },
  { key: "occurrencesHighlight", vscode: "editor.occurrencesHighlight", kind: "enum", default: "singleFile", options: opts(["singleFile", "In this file"], ["off", "Off"]), title: "Highlight occurrences", description: "Mark every use of the symbol under the cursor in this file. F7 and Shift+F7 jump between them." },
  { key: "autoClosingBrackets", vscode: "editor.autoClosingBrackets", kind: "enum", default: "languageDefined", options: opts(["languageDefined", "By language"], ["always", "Always"], ["beforeWhitespace", "Before whitespace"], ["never", "Never"]), title: "Auto close brackets", description: "Type a closing bracket for you." },
  { key: "autoClosingQuotes", vscode: "editor.autoClosingQuotes", kind: "enum", default: "languageDefined", options: opts(["languageDefined", "By language"], ["always", "Always"], ["beforeWhitespace", "Before whitespace"], ["never", "Never"]), title: "Auto close quotes", description: "Type a closing quote for you." },
  { key: "autoSurround", vscode: "editor.autoSurround", kind: "enum", default: "languageDefined", options: opts(["languageDefined", "By language"], ["quotes", "Quotes"], ["brackets", "Brackets"], ["never", "Never"]), title: "Auto surround", description: "Typing a bracket or quote with text selected wraps the selection." },
  { key: "trimAutoWhitespace", vscode: "editor.trimAutoWhitespace", kind: "boolean", default: true, title: "Trim auto whitespace", description: "Remove the indentation Enter added when you leave the line without typing on it." },
  { key: "emptySelectionClipboard", vscode: "editor.emptySelectionClipboard", kind: "boolean", default: true, title: "Copy line without selection", description: "Copy and cut act on the whole current line when nothing is selected." },
  { key: "formatOnPaste", vscode: "editor.formatOnPaste", kind: "boolean", default: false, title: "Format on paste", description: "Format pasted text with the language's formatter." },
  { key: "letterSpacing", vscode: "editor.letterSpacing", kind: "number", default: 0, min: -5, max: 20, step: 0.1, title: "Letter spacing", description: "Extra space between code characters, in px." },
  { key: "lightbulb", vscode: "editor.lightbulb.enabled", kind: "enum", default: "onCode", options: opts(["onCode", "On code"], ["on", "On"], ["off", "Off"]), title: "Code action light bulb", description: "Show a light bulb at the cursor line when Quick Fix has suggestions." },
  { key: "trimTrailingWhitespace", vscode: "files.trimTrailingWhitespace", kind: "boolean", default: false, title: "Trim trailing whitespace on save", description: "Remove spaces and tabs at line ends when saving." },
  { key: "insertFinalNewline", vscode: "files.insertFinalNewline", kind: "boolean", default: false, title: "Insert final newline on save", description: "End the file with a line break when saving." },
  { key: "trimFinalNewlines", vscode: "files.trimFinalNewlines", kind: "boolean", default: false, title: "Trim final newlines on save", description: "Remove extra blank lines at the end of the file when saving." },
];

export const EDITOR_OPTION_DEFAULTS = Object.fromEntries(EDITOR_OPTION_DEFS.map((def) => [def.key, def.default])) as EditorOptions;

const DEF_BY_KEY = new Map<string, EditorOptionDef>(EDITOR_OPTION_DEFS.map((def) => [def.key, def]));

// 한 값이 이 설정의 허용 값인지. 맞으면 그 값(숫자는 범위 안으로 한정하지 않고 범위 밖이면 거절)을 돌려주고 아니면 undefined.
export function acceptEditorOption(def: EditorOptionDef, value: unknown): unknown {
  if (def.kind === "boolean") return typeof value === "boolean" ? value : undefined;
  if (def.kind === "number") return typeof value === "number" && Number.isFinite(value) && value >= def.min && value <= def.max ? value : undefined;
  return typeof value === "string" && def.options.some((o) => o.value === value) ? value : undefined;
}

// 직접 고른 값 모음 정리: 모르는 키와 허용 밖 값은 버린다.
export function sanitizeEditorOptions(raw: unknown): Partial<EditorOptions> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    const def = DEF_BY_KEY.get(key);
    const ok = def ? acceptEditorOption(def, value) : undefined;
    if (def && ok !== undefined) out[key] = ok;
  }
  return out as Partial<EditorOptions>;
}

const NOT_FROM_VSCODE: ReadonlySet<EditorOptionKey> = new Set(["smoothScrolling"]);

export function parseVscodeEditorOptions(settings: Record<string, unknown>): Partial<EditorOptions> {
  const out: Record<string, unknown> = {};
  for (const def of EDITOR_OPTION_DEFS) {
    if (NOT_FROM_VSCODE.has(def.key)) continue;
    let value = settings[def.vscode];
    // [typescript] 같은 언어별 블록과 중첩 객체 표기(editor.minimap: {enabled})는 읽지 않는다. 최상위 점 표기만 본다.
    if (def.key === "wordWrap" && (value === "bounded" || value === "wordWrapColumn")) value = "on";
    if (def.key === "lightbulb" && typeof value === "boolean") value = value ? "on" : "off";
    if (def.key === "lineNumbers" && value === "interval") value = "on";
    const ok = value === undefined ? undefined : acceptEditorOption(def, value);
    if (ok !== undefined) out[def.key] = ok;
  }
  return out as Partial<EditorOptions>;
}

export type EditorOptionSource = "agent-nav" | "vscode" | "builtin";
export type ResolvedEditorOptions = { values: EditorOptions; sources: Record<EditorOptionKey, EditorOptionSource> };

export function resolveEditorOptions(chosen: unknown, vscode: Partial<EditorOptions>): ResolvedEditorOptions {
  const picked = sanitizeEditorOptions(chosen);
  const values = { ...EDITOR_OPTION_DEFAULTS } as Record<string, unknown>;
  const sources = {} as Record<string, EditorOptionSource>;
  for (const def of EDITOR_OPTION_DEFS) {
    const mine = picked[def.key];
    const theirs = vscode[def.key];
    if (mine !== undefined) (values[def.key] = mine), (sources[def.key] = "agent-nav");
    else if (theirs !== undefined) (values[def.key] = theirs), (sources[def.key] = "vscode");
    else sources[def.key] = "builtin";
  }
  return { values: values as EditorOptions, sources: sources as Record<EditorOptionKey, EditorOptionSource> };
}
