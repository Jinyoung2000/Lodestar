import { EDITOR_OPTION_DEFAULTS, EDITOR_OPTION_DEFS, parseVscodeEditorOptions, resolveEditorOptions, sanitizeEditorOptions } from "../shared/editorOptions";
import { DefaultsReader, type DefaultsIo, type DefaultsPaths } from "../server/defaults";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed++;
};

check("built-in defaults are VS Code's", EDITOR_OPTION_DEFAULTS.tabSize === 4 && EDITOR_OPTION_DEFAULTS.insertSpaces && EDITOR_OPTION_DEFAULTS.detectIndentation && EDITOR_OPTION_DEFAULTS.minimap && EDITOR_OPTION_DEFAULTS.stickyScroll && EDITOR_OPTION_DEFAULTS.renderWhitespace === "selection" && EDITOR_OPTION_DEFAULTS.showFoldingControls === "mouseover" && EDITOR_OPTION_DEFAULTS.cursorBlinking === "blink" && EDITOR_OPTION_DEFAULTS.scrollBeyondLastLine && !EDITOR_OPTION_DEFAULTS.smoothScrolling && !EDITOR_OPTION_DEFAULTS.formatOnPaste && !EDITOR_OPTION_DEFAULTS.trimTrailingWhitespace);
check("every definition's default passes its own validation", EDITOR_OPTION_DEFS.every((def) => Object.keys(sanitizeEditorOptions({ [def.key]: def.default })).length === 1));
check("keys are unique", new Set(EDITOR_OPTION_DEFS.map((d) => d.key)).size === EDITOR_OPTION_DEFS.length && new Set(EDITOR_OPTION_DEFS.map((d) => d.vscode)).size === EDITOR_OPTION_DEFS.length);

const vscode = parseVscodeEditorOptions({
  "editor.tabSize": 2,
  "editor.minimap.enabled": false,
  "editor.smoothScrolling": true,
  "editor.letterSpacing": -0.2,
  "editor.wordWrap": "bounded",
  "editor.cursorStyle": "bogus",
  "editor.lightbulb.enabled": false,
  "editor.lineNumbers": "interval",
  "files.trimTrailingWhitespace": true,
  "editor.insertSpaces": "yes",
  "editor.stickyScroll.maxLineCount": 99,
});
check("VS Code values are read by their own keys", vscode.tabSize === 2 && vscode.minimap === false && vscode.letterSpacing === -0.2 && vscode.trimTrailingWhitespace === true);
check("smooth scrolling stays off even when VS Code turns it on", !("smoothScrolling" in vscode));
check("bounded wrap, boolean lightbulb and interval line numbers map to ours", vscode.wordWrap === "on" && vscode.lightbulb === "off" && vscode.lineNumbers === "on");
check("wrong types and out of range values are ignored", !("cursorStyle" in vscode) && !("insertSpaces" in vscode) && !("stickyScrollMaxLineCount" in vscode));

const resolved = resolveEditorOptions({ tabSize: 8, bogus: 1, cursorWidth: 99 }, vscode);
check("chosen beats VS Code beats built-in", resolved.values.tabSize === 8 && resolved.sources.tabSize === "agent-nav" && resolved.values.minimap === false && resolved.sources.minimap === "vscode" && resolved.values.stickyScroll === true && resolved.sources.stickyScroll === "builtin");
check("an invalid chosen value falls through", resolved.values.cursorWidth === 0 && resolved.sources.cursorWidth === "builtin");

const paths: DefaultsPaths = { vscodeUserDir: "/vs", claudeSettings: "/claude.json" };
const io: DefaultsIo = { readText: (file) => (file === "/vs/settings.json" ? '{ // c\n "editor.minimap.enabled": false, "editor.tabSize": 2, }' : null), vscodeState: () => null };
const defaults = new DefaultsReader(paths, io).resolve({ defaultPermissionMode: null, defaultModel: null, defaultEffort: null, diffInlineWhenNarrow: null, requestQueuing: null, previewEditors: null, editorOptions: { stickyScroll: false } }, true);
check("the daemon resolver exposes editor options with sources", defaults.editorOptions?.values.tabSize === 2 && defaults.editorOptions.sources.tabSize === "vscode" && defaults.editorOptions.values.stickyScroll === false && defaults.editorOptions.sources.stickyScroll === "agent-nav" && defaults.editorOptions.values.minimap === false);

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("editor options: all passed");
