import { titleOf } from "./commands";
import { activeBindings, BINDINGS, type Binding, type When } from "./keymap";
import { S } from "./strings";

export type ShortcutRow = {
  command: string;
  title: string;
  category: string;
  keys: string[][];
  when: string | null;
  search: string;
  changed: boolean;
};

export const GENERAL = "General";
const NOT_LISTED = new Set(["escape"]);

const KEY_WORDS: Record<string, string> = { "⌘": "cmd command meta", "⌃": "ctrl control", "⌥": "alt option", "⇧": "shift", "←": "left", "→": "right", "↑": "up", "↓": "down", "⌫": "backspace delete", "↵": "enter return", ".": "period dot", ",": "comma", "⎋": "escape esc", "⇥": "tab" };

const MODIFIER_SYMBOLS: Record<string, string> = { Ctrl: "⌃", Alt: "⌥", Shift: "⇧", Meta: "⌘" };
const KEY_SYMBOLS: Record<string, string> = { Backslash: "\\", Minus: "-", Slash: "/", Equal: "=", Period: ".", Semicolon: ";", Comma: ",", Enter: "↵", Escape: "⎋", Backspace: "⌫", Tab: "⇥", Space: "Space", ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓", Numpad0: "NumPad0", NumpadAdd: "NumPad+", NumpadSubtract: "NumPad-", BracketLeft: "[", BracketRight: "]", Quote: "'", Backquote: "`", Delete: "⌦", Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown" };

export function strokeLabel(stroke: string) {
  const parts = stroke.split("+");
  const code = parts.pop() ?? "";
  return parts.map((p) => MODIFIER_SYMBOLS[p] ?? p).join("") + (KEY_SYMBOLS[code] ?? code.replace(/^(Key|Digit)/, ""));
}

export function preferredBinding(command: string, bindings: readonly Binding[] = activeBindings()): Binding | undefined {
  return bindings.find((b) => b.command === command && !b.when) ?? bindings.find((b) => b.command === command);
}

export function commandKeyLabel(command: string, bindings: readonly Binding[] = activeBindings()): string | null {
  const binding = preferredBinding(command, bindings);
  return binding ? binding.keys.map(strokeLabel).join(" ") : null;
}

export function commandKeyLabels(command: string, bindings: readonly Binding[] = activeBindings()): string[] {
  return [...new Set(bindings.filter((b) => b.command === command).map((b) => b.keys.map(strokeLabel).join(" ")))];
}

export function categoryOf(title: string) {
  const at = title.indexOf(": ");
  return at > 0 ? title.slice(0, at) : GENERAL;
}

export function shortcutRows(bindings: Binding[] = BINDINGS, options: { desktop?: boolean; hidden?: ReadonlySet<string>; changed?: ReadonlySet<string> } = {}): ShortcutRow[] {
  const byCommand = new Map<string, Binding[]>();
  for (const binding of bindings) {
    if (NOT_LISTED.has(binding.command) || options.hidden?.has(binding.command)) continue;
    if (options.desktop === false && binding.when === "electron") continue;
    byCommand.set(binding.command, [...(byCommand.get(binding.command) ?? []), binding]);
  }
  for (const command of options.changed ?? []) if (!byCommand.has(command) && !NOT_LISTED.has(command) && !options.hidden?.has(command)) byCommand.set(command, []);
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
    rows.push({ command, title, category, keys, when, search: `${title} ${category} ${when ?? ""} ${keyWords}`.toLowerCase(), changed: !!options.changed?.has(command) });
  }
  return rows.sort((a, b) => (a.category === b.category ? a.title.localeCompare(b.title) : a.category === GENERAL ? -1 : b.category === GENERAL ? 1 : a.category.localeCompare(b.category)));
}

function commonWhen(whens: (When | undefined)[]) {
  const first = whens[0];
  if (!first || whens.some((w) => w !== first)) return null;
  return S.shortcutWhen[first] ?? null;
}

export function filterShortcuts(rows: ShortcutRow[], query: string) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return words.length ? rows.filter((row) => words.every((w) => row.search.includes(w))) : rows;
}

export function groupByCategory(rows: ShortcutRow[]) {
  const groups: { category: string; rows: ShortcutRow[] }[] = [];
  for (const row of rows) {
    const last = groups.at(-1);
    if (last && last.category === row.category) last.rows.push(row);
    else groups.push({ category: row.category, rows: [row] });
  }
  return groups;
}
