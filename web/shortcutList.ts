import { titleOf } from "./commands";
import { activeBindings, BINDINGS, type Binding, type When } from "./keymap";
import { S } from "./strings";

// FIX6C: 키보드 단축키 목록 화면(web/ShortcutsView.tsx)의 모델. 단축키 표(web/keymap.ts BINDINGS)와 명령 이름(S.commandTitles)에서 만들어서 표를 고치면 목록도 같이 바뀐다.
// 범주는 명령 이름의 "범주: 이름" 앞부분이고, 앞부분이 없는 명령은 General 이다.
export type ShortcutRow = {
  command: string;
  title: string;
  category: string;
  // 키 조합 하나가 단계 글자 목록 하나(chord 의 한 단계는 `⌘K` 처럼 붙여 쓴 글자 하나). 같은 명령에 키가 여럿이면 여러 개다(⌘= 과 ⇧⌘=).
  keys: string[][];
  // 모든 키가 같은 조건에서만 들을 때의 안내(없으면 어디서나)
  when: string | null;
  // 검색에 쓰는 소문자 글. 이름, 범주, 조건 안내, 키 이름(⌘ 은 cmd 도 된다)
  search: string;
};

export const GENERAL = "General";
const NOT_LISTED = new Set(["escape"]);

// 글자 한 개를 검색어로 풀어 쓴 말(⌘ 는 cmd, command)
const KEY_WORDS: Record<string, string> = { "⌘": "cmd command meta", "⌃": "ctrl control", "⌥": "alt option", "⇧": "shift", "←": "left", "→": "right", "↑": "up", "↓": "down", "⌫": "backspace delete", "↵": "enter return", ".": "period dot", ",": "comma", "⎋": "escape esc", "⇥": "tab" };

// 앱의 다른 곳(사이드바 `⇧⌘K`, 승인 카드 `⌘↵`)과 같은 기호 규칙: 수정키는 ⌃⌥⇧⌘ 기호, 키 이름은 기호나 글자 하나.
const MODIFIER_SYMBOLS: Record<string, string> = { Ctrl: "⌃", Alt: "⌥", Shift: "⇧", Meta: "⌘" };
const KEY_SYMBOLS: Record<string, string> = { Backslash: "\\", Minus: "-", Slash: "/", Equal: "=", Period: ".", Semicolon: ";", Comma: ",", Enter: "↵", Escape: "⎋", Backspace: "⌫", Tab: "⇥", Space: "Space", ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓", Numpad0: "NumPad0", NumpadAdd: "NumPad+", NumpadSubtract: "NumPad-", BracketLeft: "[", BracketRight: "]", Quote: "'", Backquote: "`", Delete: "⌦", Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown" };

// "Shift+Meta+KeyK" -> "⇧⌘K". chord 의 단계 하나가 붙어 있는 글자 하나다.
export function strokeLabel(stroke: string) {
  const parts = stroke.split("+");
  const code = parts.pop() ?? "";
  return parts.map((p) => MODIFIER_SYMBOLS[p] ?? p).join("") + (KEY_SYMBOLS[code] ?? code.replace(/^(Key|Digit)/, ""));
}

export function commandKeyLabel(command: string, bindings: readonly Binding[] = activeBindings()): string | null {
  const binding = bindings.find((b) => b.command === command);
  return binding ? binding.keys.map(strokeLabel).join(" ") : null;
}

export function categoryOf(title: string) {
  const at = title.indexOf(": ");
  return at > 0 ? title.slice(0, at) : GENERAL;
}

export function shortcutRows(bindings: Binding[] = BINDINGS, options: { desktop?: boolean; hidden?: ReadonlySet<string> } = {}): ShortcutRow[] {
  const byCommand = new Map<string, Binding[]>();
  for (const binding of bindings) {
    if (NOT_LISTED.has(binding.command) || options.hidden?.has(binding.command)) continue;
    if (options.desktop === false && binding.when === "electron") continue;
    byCommand.set(binding.command, [...(byCommand.get(binding.command) ?? []), binding]);
  }
  const rows: ShortcutRow[] = [];
  for (const [command, list] of byCommand) {
    const title = titleOf(command);
    if (!title) continue;
    const seen = new Set<string>();
    const keys: string[][] = [];
    for (const binding of list) {
      const id = binding.keys.join(" ");
      if (seen.has(id)) continue;
      seen.add(id);
      keys.push(binding.keys.map(strokeLabel));
    }
    const when = commonWhen(list.map((b) => b.when));
    const category = categoryOf(title);
    const keyWords = keys.flat().map((step) => `${step} ${[...step].map((ch) => KEY_WORDS[ch] ?? "").join(" ")}`).join(" ");
    rows.push({ command, title, category, keys, when, search: `${title} ${category} ${when ?? ""} ${keyWords}`.toLowerCase() });
  }
  return rows.sort((a, b) => (a.category === b.category ? a.title.localeCompare(b.title) : a.category === GENERAL ? -1 : b.category === GENERAL ? 1 : a.category.localeCompare(b.category)));
}

// 키가 모두 같은 조건에서만 듣는 명령만 조건을 안내한다. 어디서나 듣는 키가 하나라도 있으면 안내가 틀리므로 비운다.
function commonWhen(whens: (When | undefined)[]) {
  const first = whens[0];
  if (!first || whens.some((w) => w !== first)) return null;
  return S.shortcutWhen[first] ?? null;
}

// 낱말이 모두 들어 있는 행만. 입력이 비면 전부.
export function filterShortcuts(rows: ShortcutRow[], query: string) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return words.length ? rows.filter((row) => words.every((w) => row.search.includes(w))) : rows;
}

// 화면이 범주 머리줄을 그릴 자리를 알도록 범주별로 묶는다. 순서는 rows 그대로다.
export function groupByCategory(rows: ShortcutRow[]) {
  const groups: { category: string; rows: ShortcutRow[] }[] = [];
  for (const row of rows) {
    const last = groups.at(-1);
    if (last && last.category === row.category) last.rows.push(row);
    else groups.push({ category: row.category, rows: [row] });
  }
  return groups;
}
