import type { Board, BoardCard, BoardColumn, BoardPriority, BoardRole, BoardSort } from "./protocol";

export const BOARD_ROLES: { role: BoardRole; name: string }[] = [
  { role: "backlog", name: "Backlog" },
  { role: "todo", name: "Todo" },
  { role: "inProgress", name: "In Progress" },
  { role: "review", name: "Review" },
  { role: "done", name: "Done" },
];

export const BOARD_LIMITS = { columns: 12, cards: 2000, title: 200, body: 20_000, columnName: 40, label: 32, labels: 10, links: 20, linkUrl: 2000, linkTitle: 200, sourcePart: 400, labelColors: 200 };

export function defaultBoard(): Board {
  return { columns: BOARD_ROLES.map(({ role, name }) => ({ id: role, name, role })), cards: [], nextNumber: 1, labelColors: {} };
}

export const BOARD_KEY = "LOD";
export const cardKey = (card: Pick<BoardCard, "number">) => `${BOARD_KEY}-${card.number}`;

export const isPriority = (value: unknown): value is BoardPriority => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 4;

export const LABEL_COLORS = 8;

export function labelColorOf(labelColors: Record<string, number> | undefined, label: string): number {
  const key = label.trim().toLowerCase();
  const chosen = labelColors?.[key];
  if (typeof chosen === "number" && Number.isInteger(chosen) && chosen >= 0 && chosen < LABEL_COLORS) return chosen;
  let hash = 0;
  for (const ch of key) hash = (hash * 31 + ch.codePointAt(0)!) % 100003;
  return hash % LABEL_COLORS;
}

export function sortCards<T extends Pick<BoardCard, "priority" | "updatedAt">>(cards: T[], sort: BoardSort): T[] {
  if (sort === "manual") return cards;
  const indexed = cards.map((card, index) => ({ card, index }));
  if (sort === "priority") indexed.sort((a, b) => (a.card.priority || 5) - (b.card.priority || 5) || a.index - b.index);
  else indexed.sort((a, b) => Date.parse(b.card.updatedAt) - Date.parse(a.card.updatedAt) || a.index - b.index);
  return indexed.map((x) => x.card);
}

export function numberCards<T extends { id: string; createdAt: string; number?: unknown }>(cards: T[], nextNumber: unknown): { numbers: Map<string, number>; next: number } {
  const numbers = new Map<string, number>();
  const used = new Set<number>();
  const valid = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n > 0;
  let max = valid(nextNumber) ? nextNumber - 1 : 0;
  for (const card of cards) if (valid(card.number)) max = Math.max(max, card.number);
  const order = cards.map((card, index) => ({ card, index })).sort((a, b) => Date.parse(a.card.createdAt) - Date.parse(b.card.createdAt) || a.index - b.index);
  for (const { card } of order) {
    if (valid(card.number) && !used.has(card.number)) {
      numbers.set(card.id, card.number);
      used.add(card.number);
    }
  }
  for (const { card } of order) {
    if (numbers.has(card.id)) continue;
    max += 1;
    numbers.set(card.id, max);
  }
  return { numbers, next: max + 1 };
}

export const cardsOf = (board: Board, columnId: string) => board.cards.filter((c) => c.columnId === columnId);

export const columnByRole = (board: Pick<Board, "columns">, role: BoardRole): BoardColumn | null => board.columns.find((c) => c.role === role) ?? null;

export function regroup(columns: BoardColumn[], cards: BoardCard[]): BoardCard[] {
  const known = new Set(columns.map((c) => c.id));
  const orphans = cards.filter((c) => !known.has(c.columnId)).map((c) => ({ ...c, columnId: columns[0].id }));
  const all = [...cards.filter((c) => known.has(c.columnId)), ...orphans];
  return columns.flatMap((col) => all.filter((c) => c.columnId === col.id));
}

export function moveCardIn(board: Board, id: string, columnId: string, index: number): Board {
  const card = board.cards.find((c) => c.id === id);
  if (!card || !board.columns.some((c) => c.id === columnId)) return board;
  const rest = board.cards.filter((c) => c.id !== id);
  const target = rest.filter((c) => c.columnId === columnId);
  const at = Math.max(0, Math.min(Math.trunc(index), target.length));
  target.splice(at, 0, { ...card, columnId });
  const cards = board.columns.flatMap((col) => (col.id === columnId ? target : rest.filter((c) => c.columnId === col.id)));
  return { ...board, cards };
}

export function indexBefore(board: Board, columnId: string, movingId: string, beforeId: string | null): number {
  const column = cardsOf(board, columnId).filter((c) => c.id !== movingId);
  if (beforeId === null) return column.length;
  const at = column.findIndex((c) => c.id === beforeId);
  return at === -1 ? column.length : at;
}

export function moveColumnIn(board: Board, id: string, index: number): Board {
  const from = board.columns.findIndex((c) => c.id === id);
  if (from === -1) return board;
  const columns = board.columns.filter((c) => c.id !== id);
  columns.splice(Math.max(0, Math.min(Math.trunc(index), columns.length)), 0, board.columns[from]);
  return { ...board, columns, cards: regroup(columns, board.cards) };
}
