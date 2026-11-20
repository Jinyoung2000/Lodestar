import type { Board, BoardCard, BoardColumn, BoardPriority, BoardRole, BoardSort } from "./protocol";

// 보드의 순수 연산. 데몬(검증된 저장)과 웹(끄는 동안 바로 보여 주는 낙관적 갱신)이 같은 함수를 쓴다.

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

// BOARDUX: 카드 번호의 접두사(LOD-12). 보드는 하나뿐이라 고정한다.
export const BOARD_KEY = "LOD";
export const cardKey = (card: Pick<BoardCard, "number">) => `${BOARD_KEY}-${card.number}`;

export const isPriority = (value: unknown): value is BoardPriority => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 4;

// 라벨 색 팔레트 칸 수(tokens.json 의 label-0 ~ label-7).
export const LABEL_COLORS = 8;

// 라벨의 색 번호. 사용자가 고른 색이 있으면 그것, 없으면 이름(대소문자 무시)으로 정한다. 같은 이름은 언제나 같은 색이다.
export function labelColorOf(labelColors: Record<string, number> | undefined, label: string): number {
  const key = label.trim().toLowerCase();
  const chosen = labelColors?.[key];
  if (typeof chosen === "number" && Number.isInteger(chosen) && chosen >= 0 && chosen < LABEL_COLORS) return chosen;
  let hash = 0;
  for (const ch of key) hash = (hash * 31 + ch.codePointAt(0)!) % 100003;
  return hash % LABEL_COLORS;
}

// 열 안 카드를 정렬 방식대로 늘어놓는다. 원본 배열은 건드리지 않고, 같은 값끼리는 배열 순서를 지킨다(우선순위 없음은 맨 뒤).
export function sortCards<T extends Pick<BoardCard, "priority" | "updatedAt">>(cards: T[], sort: BoardSort): T[] {
  if (sort === "manual") return cards;
  const indexed = cards.map((card, index) => ({ card, index }));
  if (sort === "priority") indexed.sort((a, b) => (a.card.priority || 5) - (b.card.priority || 5) || a.index - b.index);
  else indexed.sort((a, b) => Date.parse(b.card.updatedAt) - Date.parse(a.card.updatedAt) || a.index - b.index);
  return indexed.map((x) => x.card);
}

// 번호가 없는 옛 카드(priority/number 필드가 생기기 전 board.json)에 번호를 매긴다. 처음 읽을 때 만든 시각 순(같으면 배열 순서)으로 1부터, 이미 번호가 있는 카드는 그대로 두고 겹치면 뒤의 카드가 새 번호를 받는다.
export function numberCards<T extends { id: string; createdAt: string; number?: unknown }>(cards: T[], nextNumber: unknown): { numbers: Map<string, number>; next: number } {
  const numbers = new Map<string, number>();
  const used = new Set<number>();
  // 안전한 정수만 번호로 본다. 깨진 board.json 의 nextNumber 가 2^53 을 넘으면 max += 1 이 그대로라 새 카드끼리 번호가 겹쳤다.
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

// 열 순서대로 다시 묶는다. 열에 속하지 않는 카드(깨진 파일)는 첫 열 끝으로 모은다.
export function regroup(columns: BoardColumn[], cards: BoardCard[]): BoardCard[] {
  const known = new Set(columns.map((c) => c.id));
  const orphans = cards.filter((c) => !known.has(c.columnId)).map((c) => ({ ...c, columnId: columns[0].id }));
  const all = [...cards.filter((c) => known.has(c.columnId)), ...orphans];
  return columns.flatMap((col) => all.filter((c) => c.columnId === col.id));
}

// 카드를 columnId 열의 index 번째로 옮긴다. index 는 옮기는 카드를 뺀 열 안의 위치이고 범위를 벗어나면 끝으로 보정한다.
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

// 화면에서 일부 카드만 보일 때(검색, 필터), "보이는 카드 beforeId 앞" 을 열 전체 기준 index 로 바꾼다. beforeId 가 null 이면 끝.
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
