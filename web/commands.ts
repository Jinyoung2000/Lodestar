import { editorCommandList, editorCommandTitle } from "./editorCommands";
import { BINDINGS, type Binding } from "./keymap";
import { GROUP_KEYLESS_COMMANDS, groupCommandTitle } from "./groupCommandInfo";
import { S } from "./strings";

// B6: 명령 팔레트(⇧⌘P)의 목록. 이름과 키는 단축키 표(web/keymap.ts BINDINGS)에서 읽는다. 표에 없는 명령은 만들지 않는다.
export type PaletteCommand = { command: string; title: string; keycaps: string[] };

const NOT_LISTED = new Set(["escape"]);
export const KEYLESS_COMMANDS = ["keepFile", "undoFile", "newUntitled", "newFilePath", "moveEditorToLeftGroup", "moveEditorToRightGroup", "importVscode", "improvements", "skills", "newNote", "morningReview", "restartDaemon", "focusCommitMessage", "showProblems", "copyType", "copySignature", "handoff", "mergeWorktree", "createWorktreePr", "previewDirection", "focusPaneNext", "focusPanePrev", "quickSwitchSession", "customizeLayout", "toggleSidebarPosition", "alignPanelLeft", "alignPanelRight", "alignPanelCenter", "alignPanelJustify", "toggleActivityBar", "editorFontZoomIn", "editorFontZoomOut", "editorFontZoomReset", "chatFontZoomIn", "chatFontZoomOut", "chatFontZoomReset", ...GROUP_KEYLESS_COMMANDS];
// 데스크톱 앱(Electron)에서만 뜻이 있는 명령. 웹 접속에서는 목록에서 뺀다.
const DESKTOP_ONLY = new Set(["restartDaemon"]);

// hidden 은 설정 Show Board, Show Slack 이 꺼져 숨긴 명령의 이름이다(web/screenVisibility.ts hiddenCommands). 팔레트에서 뺀다.
export function paletteCommands(bindings: Binding[] = BINDINGS, options: { desktop?: boolean; hidden?: ReadonlySet<string> } = {}): PaletteCommand[] {
  const seen = new Set<string>();
  const list: PaletteCommand[] = [];
  for (const binding of bindings) {
    // 같은 명령에 키가 둘 이상이면 표의 첫 키만 보인다
    if (NOT_LISTED.has(binding.command) || seen.has(binding.command) || options.hidden?.has(binding.command)) continue;
    if (options.desktop === false && binding.when === "electron") continue;
    const title = titleOf(binding.command);
    if (!title) continue;
    seen.add(binding.command);
    list.push({ command: binding.command, title, keycaps: keycapsOf(binding) });
  }
  for (const command of KEYLESS_COMMANDS) if ((options.desktop !== false || !DESKTOP_ONLY.has(command)) && !options.hidden?.has(command)) list.push({ command, title: titleOf(command)!, keycaps: [] });
  // EDPARITY: 에디터 명령 등록부(web/editorCommands.ts)의 명령 중 표에 키가 없는 것도 팔레트에 둔다
  for (const editorCommand of editorCommandList()) if (!seen.has(`editor:${editorCommand.id}`)) list.push({ command: `editor:${editorCommand.id}`, title: editorCommand.title, keycaps: [] });
  return list.sort((a, b) => a.title.localeCompare(b.title));
}

export function titleOf(command: string): string | null {
  if (command.startsWith("editor:")) {
    const id = command.slice("editor:".length);
    // 등록부는 에디터 모듈이 불러진 뒤에만 차 있다(단위 시험에서는 비어 있다). 비어 있으면 id 를 낱말로 풀어 이름으로 쓴다.
    return editorCommandTitle(id) ?? id.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());
  }
  if (command.startsWith("focusPaneIndex:")) {
    const arg = command.slice("focusPaneIndex:".length);
    return arg === "last" ? S.focusLastSession : S.focusSessionAt(Number(arg) + 1);
  }
  return S.commandTitles[command] ?? groupCommandTitle(command);
}

// 입력(">" 뒤의 글)의 낱말이 모두 이름에 들어 있는 명령. 순서는 이름순 그대로다.
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

// 키 하나를 키캡 글자 목록으로. chord 는 두 키의 키캡을 이어 붙인다(⌘ K ⌘ N).
export function keycapsOf(binding: Binding): string[] {
  return binding.keys.flatMap((stroke) =>
    stroke.split("+").map((part) => MODIFIER_SYMBOLS[part] ?? CODE_LABELS[part] ?? part.replace(/^(Key|Digit)/, "")),
  );
}
