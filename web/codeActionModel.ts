export type ActionLike = { title: string; kind?: string; isPreferred?: boolean; disabled?: { reason: string }; diagnostics?: unknown[]; edit?: unknown };

export function kindContains(parent: string, child: string) {
  return parent === "" || parent === child || child.startsWith(`${parent}.`);
}

export type GroupId = "quickfix" | "extract" | "inline" | "rewrite" | "move" | "surround" | "source" | "other";
export type ActionGroup = { id: GroupId; kind: string; title: string; icon: "lightbulb" | "wrench" };

export const ACTION_GROUPS: readonly ActionGroup[] = [
  { id: "quickfix", kind: "quickfix", title: "Quick Fix", icon: "lightbulb" },
  { id: "extract", kind: "refactor.extract", title: "Extract", icon: "wrench" },
  { id: "inline", kind: "refactor.inline", title: "Inline", icon: "wrench" },
  { id: "rewrite", kind: "refactor.rewrite", title: "Rewrite", icon: "wrench" },
  { id: "move", kind: "refactor.move", title: "Move", icon: "wrench" },
  { id: "surround", kind: "refactor.extract.surround", title: "Surround With", icon: "wrench" },
  { id: "source", kind: "source", title: "Source Action", icon: "wrench" },
  { id: "other", kind: "", title: "More Actions...", icon: "lightbulb" },
];

export function groupOf(kind: string | undefined): ActionGroup {
  const value = kind ?? "@@none@@";
  return ACTION_GROUPS.find((group) => kindContains(group.kind, value)) ?? ACTION_GROUPS[ACTION_GROUPS.length - 1]!;
}

// 자동 트리거(전구)와 ⌘. 는 Source Action 을 요청 필터에서 뺀다(includeSourceActions 가 거짓). 그래서 organizeImports 같은 제안은 목록에 안 나온다.
export function isSourceAction(action: ActionLike) {
  return kindContains("source", action.kind ?? "@@none@@");
}

export function sortActions<T extends ActionLike>(actions: readonly T[]): T[] {
  const rank = (action: T) => (action.diagnostics?.length ? 0 : 2) + (action.isPreferred ? 0 : 1);
  return actions.map((action, index) => ({ action, index })).sort((a, b) => rank(a.action) - rank(b.action) || a.index - b.index).map((entry) => entry.action);
}

export const isQuickFix = (action: ActionLike) => kindContains("quickfix", action.kind ?? "@@none@@");

export const hasAutoFix = (actions: readonly ActionLike[]) => actions.some((action) => !action.disabled && !!action.kind && isQuickFix(action) && !!action.isPreferred);

export type MenuRow<T extends ActionLike = ActionLike> =
  | { type: "header"; title: string }
  | { type: "action"; action: T; group: ActionGroup; label: string; disabled: boolean; hint: string | null; canPreview: boolean };

export const REFACTOR_KEY_LABEL = "⌃⇧R";

function hintOf(action: ActionLike) {
  return action.kind && kindContains("refactor", action.kind) ? REFACTOR_KEY_LABEL : null;
}

// 번들 Z2o. showHeaders 가 켜져 있으면(editor.codeActionWidget.showHeaders 기본 켬) 그룹 머리줄 + 제안들, 꺼져 있으면 평평한 목록.
// 사용 불가(disabled) 제안은 showDisabled 일 때만 들어가고, 그 줄의 글자는 제목이 아니라 사유다.
export function buildRows<T extends ActionLike>(actions: readonly T[], options: { showHeaders: boolean; showDisabled: boolean }): MenuRow<T>[] {
  const sorted = sortActions(actions).filter((action) => !action.disabled || options.showDisabled);
  const rowOf = (action: T, group: ActionGroup): MenuRow<T> => ({
    type: "action",
    action,
    group,
    label: action.disabled ? action.disabled.reason : action.title,
    disabled: !!action.disabled,
    hint: options.showHeaders ? hintOf(action) : null,
    canPreview: !action.disabled && canPreview(action),
  });
  if (!options.showHeaders) return sorted.map((action) => rowOf(action, groupOf(undefined)));
  const rows: MenuRow<T>[] = [];
  for (const group of ACTION_GROUPS) {
    const members = sorted.filter((action) => groupOf(action.kind) === group);
    if (!members.length) continue;
    rows.push({ type: "header", title: group.title });
    for (const action of members) rows.push(rowOf(action, group));
  }
  return rows;
}

export function canPreview(action: ActionLike) {
  const kind = action.kind;
  if (kind && ["refactor.extract", "refactor.inline", "refactor.rewrite", "refactor.move", "source"].some((parent) => kindContains(parent, kind))) return true;
  return action.edit !== undefined && action.edit !== null;
}

// 키보드로 갈 수 있는 줄(사용 불가와 머리줄은 건너뛴다)
export function focusableIndexes(rows: readonly MenuRow[]) {
  const indexes: number[] = [];
  rows.forEach((row, index) => {
    if (row.type === "action" && !row.disabled) indexes.push(index);
  });
  return indexes;
}

export function stepFocus(rows: readonly MenuRow[], current: number, delta: 1 | -1) {
  const indexes = focusableIndexes(rows);
  if (!indexes.length) return -1;
  const at = indexes.indexOf(current);
  if (at < 0) return delta === 1 ? indexes[0]! : indexes[indexes.length - 1]!;
  return indexes[(at + delta + indexes.length) % indexes.length]!;
}

export const MENU_TEXT = {
  showDisabled: "Show Disabled",
  hideDisabled: "Hide Disabled",
  noActions: "No code actions available",
  noAutoFix: "No auto fixes available",
  apply: (key: string) => `${key} to Apply`,
  applyPreview: (key: string, previewKey: string) => `${key} to Apply, ${previewKey} to Preview`,
};

export const MAC_KEYS = { quickFix: "⌘.", autoFix: "⌥⌘.", accept: "Enter", preview: "⌘Enter" };

// ---- 전구 ----

export type LightbulbMode = "off" | "onCode" | "on";

export function shouldRequestLightbulb(mode: LightbulbMode, selectionEmpty: boolean, lineText: string, column: number) {
  if (mode === "off") return false;
  if (mode === "on" || !selectionEmpty) return true;
  if (lineText.length === 0) return false;
  if (column === 1) return !/\s/.test(lineText[0]!);
  if (column === lineText.length + 1) return !/\s/.test(lineText[lineText.length - 1]!);
  return !(/\s/.test(lineText[column - 2]!) && /\s/.test(lineText[column - 1]!));
}

export function indentColumns(text: string, tabSize: number) {
  let columns = 0;
  for (const ch of text) {
    if (ch === " ") columns++;
    else if (ch === "\t") columns += tabSize - (columns % tabSize);
    else break;
  }
  return columns;
}

export type LightbulbPlacement = { kind: "none" } | { kind: "gutter"; line: number } | { kind: "widget"; line: number; column: number };

export type PlacementInput = {
  line: number; // 커서 줄(1부터)
  column: number; // 커서 열(1부터)
  lineCount: number;
  lineText: (line: number) => string;
  indentWidth: number; // 커서 줄의 앞 공백 칸 수
  spaceWidth: number; // 공백 한 칸의 px 폭
  hidden?: (line: number) => boolean; // 접힌 줄
};

export function placeLightbulb(input: PlacementInput): LightbulbPlacement {
  const { line: c, column: l, lineCount, lineText, spaceWidth } = input;
  const hidden = input.hidden ?? (() => false);
  let y = c;
  let w = 1;
  if (!(spaceWidth * input.indentWidth > 22)) {
    const blankOrIndented = (n: number) => {
      const text = lineText(n);
      return /^\s*$|^\s+/.test(text) || text.length <= w;
    };
    if (c > 1 && !hidden(c - 1)) {
      const last = c === lineCount;
      const prev = c > 1 && blankOrIndented(c - 1);
      const next = !last && blankOrIndented(c + 1);
      const here = blankOrIndented(c);
      if (!next && !prev) return { kind: "gutter", line: c };
      if (prev || last || (prev && !here)) y -= 1;
      else if (next || (!next && !prev && here)) y += 1;
    } else if (c === 1 && (c === lineCount || (!blankOrIndented(c + 1) && !blankOrIndented(c)))) {
      return { kind: "gutter", line: c };
    } else if (c < lineCount && !hidden(c + 1)) {
      y += 1;
    } else if (l * spaceWidth < 22) {
      return { kind: "none" };
    }
    w = /^\S\s*$/.test(lineText(y)) ? 2 : 1;
  }
  return { kind: "widget", line: y, column: w };
}

export function lightbulbInfo(actions: readonly ActionLike[], labels: { autoFix: string; quickFix: string }) {
  const autoFix = hasAutoFix(actions);
  const title = autoFix && labels.autoFix ? `Show Code Actions. Preferred Quick Fix Available (${labels.autoFix})` : !autoFix && labels.quickFix ? `Show Code Actions (${labels.quickFix})` : "Show Code Actions";
  return { icon: autoFix ? ("lightbulb-autofix" as const) : ("light-bulb" as const), autoFix, title };
}

// ---- 메뉴 놓는 자리 ----
// 번들 컨텍스트 뷰 규칙: 기준점 아래에 놓고, 아래가 모자라고 위가 더 넓으면 위로 뒤집는다. 가로로 넘치면 왼쪽으로 민다. 어느 쪽에도 안 들어가면 넓은 쪽에 놓고 높이를 줄인다.
export type MenuAnchor = { x: number; top: number; bottom: number };
export type MenuPlacement = { left: number; top: number; maxHeight: number; above: boolean };

export function placeMenu(anchor: MenuAnchor, size: { width: number; height: number }, viewport: { width: number; height: number }, margin = 0): MenuPlacement {
  const spaceBelow = viewport.height - anchor.bottom - margin;
  const spaceAbove = anchor.top - margin;
  const above = size.height > spaceBelow && spaceAbove > spaceBelow;
  const room = Math.max(0, above ? spaceAbove : spaceBelow);
  const height = Math.min(size.height, room);
  const left = Math.max(0, Math.min(anchor.x, viewport.width - size.width));
  return { left, top: above ? anchor.top - height : anchor.bottom, maxHeight: room, above };
}
