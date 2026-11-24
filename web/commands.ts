import { editorCommandList, editorCommandTitle } from "./editorCommands";
import { BINDINGS, type Binding } from "./keymap";
import { GROUP_KEYLESS_COMMANDS, groupCommandTitle } from "./groupCommandInfo";
import { S } from "./strings";

export type PaletteCommand = { command: string; title: string; keycaps: string[] };

const NOT_LISTED = new Set(["escape"]);
export const KEYLESS_COMMANDS = ["keepFile", "undoFile", "newUntitled", "newFilePath", "moveEditorToLeftGroup", "moveEditorToRightGroup", "importVscode", "improvements", "skills", "automations", "newAutomation", "morningReview", "restartDaemon", "focusCommitMessage", "showProblems", "copyType", "copySignature", "handoff", "addFolderToSession", "removeFolderFromSession", "moveChatToFolder", "newProject", "mergeWorktree", "createWorktreePr", "previewDirection", "focusPaneNext", "focusPanePrev", "quickSwitchSession", "customizeLayout", "toggleSidebarPosition", "alignPanelLeft", "alignPanelRight", "alignPanelCenter", "alignPanelJustify", "toggleActivityBar", "editorFontZoomIn", "editorFontZoomOut", "editorFontZoomReset", "chatFontZoomIn", "chatFontZoomOut", "chatFontZoomReset", ...GROUP_KEYLESS_COMMANDS];
const DESKTOP_ONLY = new Set(["restartDaemon"]);

export function paletteCommands(bindings: Binding[] = BINDINGS, options: { desktop?: boolean; hidden?: ReadonlySet<string>; unbound?: readonly string[] } = {}): PaletteCommand[] {
  const seen = new Set<string>();
  const list: PaletteCommand[] = [];
  for (const binding of bindings) {
    if (NOT_LISTED.has(binding.command) || seen.has(binding.command) || options.hidden?.has(binding.command)) continue;
    if (options.desktop === false && binding.when === "electron") continue;
    const title = titleOf(binding.command);
    if (!title) continue;
    seen.add(binding.command);
    list.push({ command: binding.command, title, keycaps: keycapsOf(binding) });
  }
  for (const command of options.unbound ?? []) {
    const title = titleOf(command);
    if (title && !seen.has(command) && !options.hidden?.has(command) && !NOT_LISTED.has(command)) {
      seen.add(command);
      list.push({ command, title, keycaps: [] });
    }
  }
  for (const command of KEYLESS_COMMANDS) if ((options.desktop !== false || !DESKTOP_ONLY.has(command)) && !options.hidden?.has(command)) list.push({ command, title: titleOf(command)!, keycaps: [] });
  for (const editorCommand of editorCommandList()) if (!seen.has(`editor:${editorCommand.id}`)) list.push({ command: `editor:${editorCommand.id}`, title: editorCommand.title, keycaps: [] });
  return list.sort((a, b) => a.title.localeCompare(b.title));
}

export function titleOf(command: string): string | null {
  if (command.startsWith("editor:")) {
    const id = command.slice("editor:".length);
    return editorCommandTitle(id) ?? id.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());
  }
  if (command.startsWith("focusPaneIndex:")) {
    const arg = command.slice("focusPaneIndex:".length);
    return arg === "last" ? S.focusLastSession : S.focusSessionAt(Number(arg) + 1);
  }
  return S.commandTitles[command] ?? groupCommandTitle(command);
}

export function filterCommands(list: PaletteCommand[], query: string): PaletteCommand[] {
  const words = query.replace(/^>/, "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return list;
  return list.filter((c) => words.every((w) => c.title.toLowerCase().includes(w)));
}

const MODIFIER_SYMBOLS: Record<string, string> = { Ctrl: "⌃", Alt: "⌥", Shift: "⇧", Meta: "⌘" };
const CODE_LABELS: Record<string, string> = {
  Backslash: "\\",
  Minus: "-",
  Slash: "/",
  Equal: "=",
  Numpad0: "NumPad0",
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
  Escape: "Esc",
  Enter: "Enter",
  Backspace: "⌫",
  Delete: "⌦",
  Tab: "⇥",
  Period: ".",
  Comma: ",",
  Semicolon: ";",
  Quote: "'",
  Backquote: "`",
  BracketLeft: "[",
  BracketRight: "]",
  NumpadAdd: "NumPad+",
  NumpadSubtract: "NumPad-",
};

export function keycapsOf(binding: Binding): string[] {
  return binding.keys.flatMap((stroke) =>
    stroke.split("+").map((part) => MODIFIER_SYMBOLS[part] ?? CODE_LABELS[part] ?? part.replace(/^(Key|Digit)/, "")),
  );
}
