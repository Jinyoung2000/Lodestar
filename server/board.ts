import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BOARD_LIMITS, columnByRole, defaultBoard, isPriority, LABEL_COLORS, moveCardIn, moveColumnIn, numberCards, regroup } from "../shared/board";
import type { Board, BoardCard, BoardColumn, BoardPriority, BoardRole, CardLink, CardPatch, CardSource, NewCard } from "../shared/protocol";
import { HOME } from "./store";
import { T } from "./strings";

const BOARD_FILE = join(HOME, "board.json");

// 칸반 보드의 저장과 검증. 값은 전부 여기서 검사하고 저장한다: 파일은 임시 파일에 쓴 뒤 rename 으로 바꿔서 도중에 끊겨도 반쪽 파일이 남지 않는다.
// 워크스페이스와 세션이 실제로 있는지는 이 클래스가 모르므로 호출하는 쪽(server/index.ts)이 먼저 확인한다.
export class BoardStore {
  private board: Board;

  constructor() {
    mkdirSync(HOME, { recursive: true });
    this.board = this.load();
  }

  get() {
    return this.board;
  }

  private load(): Board {
    if (!existsSync(BOARD_FILE)) return defaultBoard();
    try {
      const raw = JSON.parse(readFileSync(BOARD_FILE, "utf8"));
      const board = sanitizeBoard(raw);
      // 우선순위와 번호가 생기기 전 파일이면 방금 매긴 번호를 바로 저장한다(다음에 읽어도 같은 번호, 다음 번호도 이어짐).
      if (needsMigration(raw)) {
        this.board = board;
        this.save();
      }
      return board;
    } catch {
      // 읽을 수 없는 파일은 덮어쓰지 않고 옆으로 치운다.
      const aside = `${BOARD_FILE}.corrupt-${Date.now()}`;
      renameSync(BOARD_FILE, aside);
      console.error(`[board] ${T.errBoardCorrupt(aside)}`);
      return defaultBoard();
    }
  }

  private save() {
    const tmp = `${BOARD_FILE}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.board, null, 2));
    renameSync(tmp, BOARD_FILE);
  }

  private commit(next: Board) {
    this.board = next;
    this.save();
  }

  card(id: string): BoardCard {
    const card = this.board.cards.find((c) => c.id === id);
    if (!card) throw new Error(T.errUnknownCard(String(id)));
    return card;
  }

  column(id: string): BoardColumn {
    const column = this.board.columns.find((c) => c.id === id);
    if (!column) throw new Error(T.errUnknownColumn(String(id)));
    return column;
  }

  createCard(input: NewCard): BoardCard {
    if (!input || typeof input !== "object") throw new Error(T.errCardField("params"));
    if (this.board.cards.length >= BOARD_LIMITS.cards) throw new Error(T.errCardLimit(BOARD_LIMITS.cards));
    const column = input.columnId === undefined ? this.board.columns[0] : this.column(input.columnId);
    const now = new Date().toISOString();
    const card: BoardCard = {
      id: randomUUID(),
      columnId: column.id,
      title: checkTitle(input.title),
      body: input.body === undefined ? "" : checkBody(input.body),
      labels: input.labels === undefined ? [] : checkLabels(input.labels),
      priority: input.priority === undefined ? 0 : checkPriority(input.priority),
      number: this.board.nextNumber,
      workspaceId: checkOptionalId(input.workspaceId, "workspaceId"),
      agentIds: input.agentIds === undefined ? [] : checkIds(input.agentIds, "agentIds"),
      links: input.links === undefined ? [] : checkLinks(input.links),
      ...sanitizeSource(input.source, true),
      createdAt: now,
      updatedAt: now,
    };
    this.commit(moveCardIn({ ...this.board, cards: [...this.board.cards, card], nextNumber: card.number + 1 }, card.id, column.id, Number.MAX_SAFE_INTEGER));
    return card;
  }

  updateCard(id: string, patch: CardPatch): BoardCard {
    const current = this.card(id);
    if (!patch || typeof patch !== "object") throw new Error(T.errCardField("patch"));
    const next: BoardCard = { ...current, updatedAt: new Date().toISOString() };
    if (patch.title !== undefined) next.title = checkTitle(patch.title);
    if (patch.body !== undefined) next.body = checkBody(patch.body);
    if (patch.labels !== undefined) next.labels = checkLabels(patch.labels);
    if (patch.priority !== undefined) next.priority = checkPriority(patch.priority);
    if (patch.links !== undefined) next.links = checkLinks(patch.links);
    if (patch.workspaceId !== undefined) next.workspaceId = checkOptionalId(patch.workspaceId, "workspaceId");
    this.replaceCard(next);
    return next;
  }

  deleteCard(id: string) {
    this.card(id);
    this.commit({ ...this.board, cards: this.board.cards.filter((c) => c.id !== id) });
  }

  moveCard(id: string, columnId: string, index: number): BoardCard {
    const before = this.card(id);
    this.column(columnId);
    if (typeof index !== "number" || !Number.isInteger(index)) throw new Error(T.errBadIndex);
    const next = moveCardIn(this.board, id, columnId, index);
    // 열이 바뀔 때만 수정 시각을 갱신한다 (열 안 순서 바꾸기는 카드 내용이 아니다).
    const stamp = before.columnId === columnId ? before.updatedAt : new Date().toISOString();
    const cards = next.cards.map((c) => (c.id === id ? { ...c, updatedAt: stamp } : c));
    this.commit({ ...next, cards });
    return cards.find((c) => c.id === id)!;
  }

  linkAgent(cardId: string, agentId: string): BoardCard {
    const card = this.card(cardId);
    if (card.agentIds.includes(agentId)) return card;
    const next = { ...card, agentIds: [...card.agentIds, agentId], updatedAt: new Date().toISOString() };
    this.replaceCard(next);
    return next;
  }

  unlinkAgent(cardId: string, agentId: string): BoardCard {
    const card = this.card(cardId);
    const next = { ...card, agentIds: card.agentIds.filter((a) => a !== agentId) };
    this.replaceCard(next);
    return next;
  }

  // 자동 이동 대상. 대화의 한 부분을 담아 만든 카드는 그 세션이 도는 것과 상관없으므로 제외한다(다른 세션을 붙여 시작한 경우는 대상).
  cardsLinkedTo(agentId: string) {
    return this.board.cards.filter((c) => c.agentIds.includes(agentId) && c.source?.agentId !== agentId);
  }

  // 지워진 세션과 워크스페이스를 카드에서 뗀다. 바뀐 것이 있으면 true.
  prune(liveAgentIds: Set<string>, liveWorkspaceIds: Set<string>) {
    let changed = false;
    const cards = this.board.cards.map((card) => {
      const agentIds = card.agentIds.filter((a) => liveAgentIds.has(a));
      const workspaceId = card.workspaceId && !liveWorkspaceIds.has(card.workspaceId) ? null : card.workspaceId;
      if (agentIds.length === card.agentIds.length && workspaceId === card.workspaceId) return card;
      changed = true;
      return { ...card, agentIds, workspaceId };
    });
    if (changed) this.commit({ ...this.board, cards });
    return changed;
  }

  // 자동 이동: 카드들을 목적지 열의 끝으로 옮긴다. 목적지 열이 없으면(사용자가 지움) 아무것도 하지 않는다.
  moveToRole(cardIds: string[], from: BoardRole[], to: BoardRole) {
    const target = columnByRole(this.board, to);
    if (!target) return false;
    const fromIds = new Set(from.flatMap((role) => columnByRole(this.board, role)?.id ?? []));
    let board = this.board;
    let changed = false;
    for (const id of cardIds) {
      const card = board.cards.find((c) => c.id === id);
      if (!card || !fromIds.has(card.columnId)) continue;
      board = moveCardIn(board, id, target.id, Number.MAX_SAFE_INTEGER);
      board = { ...board, cards: board.cards.map((c) => (c.id === id ? { ...c, updatedAt: new Date().toISOString() } : c)) };
      changed = true;
    }
    if (changed) this.commit(board);
    return changed;
  }

  addColumn(name: string): BoardColumn {
    if (this.board.columns.length >= BOARD_LIMITS.columns) throw new Error(T.errColumnLimit(BOARD_LIMITS.columns));
    const column: BoardColumn = { id: randomUUID(), name: checkColumnName(name), role: null };
    this.commit({ ...this.board, columns: [...this.board.columns, column] });
    return column;
  }

  renameColumn(id: string, name: string): BoardColumn {
    const column = { ...this.column(id), name: checkColumnName(name) };
    this.commit({ ...this.board, columns: this.board.columns.map((c) => (c.id === id ? column : c)) });
    return column;
  }

  deleteColumn(id: string) {
    const index = this.board.columns.findIndex((c) => c.id === id);
    if (index === -1) throw new Error(T.errUnknownColumn(String(id)));
    if (this.board.columns.length === 1) throw new Error(T.errLastColumn);
    const columns = this.board.columns.filter((c) => c.id !== id);
    // 카드는 바로 앞 열(첫 열을 지우면 다음 열)의 끝으로 옮긴다.
    const heir = columns[Math.max(0, index - 1)];
    const kept = this.board.cards.filter((c) => c.columnId !== id);
    const moved = this.board.cards.filter((c) => c.columnId === id).map((c) => ({ ...c, columnId: heir.id }));
    this.commit({ ...this.board, columns, cards: columns.flatMap((col) => [...kept.filter((c) => c.columnId === col.id), ...(col.id === heir.id ? moved : [])]) });
  }

  moveColumn(id: string, index: number) {
    this.column(id);
    if (typeof index !== "number" || !Number.isInteger(index)) throw new Error(T.errBadIndex);
    this.commit(moveColumnIn(this.board, id, index));
  }

  // 라벨 색을 팔레트 번호로 고정하거나(null 이면 기본 색으로) 되돌린다. 키는 소문자라 대소문자가 다른 같은 라벨은 한 색이다.
  setLabelColor(label: string, color: number | null) {
    const key = checkLabels([label])[0].toLowerCase();
    const labelColors = { ...this.board.labelColors };
    if (color === null) delete labelColors[key];
    else {
      if (typeof color !== "number" || !Number.isInteger(color) || color < 0 || color >= LABEL_COLORS) throw new Error(T.errCardField("color"));
      if (!(key in labelColors) && Object.keys(labelColors).length >= BOARD_LIMITS.labelColors) throw new Error(T.errCardField("color"));
      labelColors[key] = color;
    }
    this.commit({ ...this.board, labelColors });
  }

  private replaceCard(next: BoardCard) {
    this.commit({ ...this.board, cards: this.board.cards.map((c) => (c.id === next.id ? next : c)) });
  }
}

// --- 입력 검사 ---

function checkTitle(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(T.errCardTitle);
  const title = value.replace(/\s+/g, " ").trim();
  if (title.length > BOARD_LIMITS.title) throw new Error(T.errCardTitleLong(BOARD_LIMITS.title));
  return title;
}

function checkBody(value: unknown): string {
  if (typeof value !== "string") throw new Error(T.errCardField("body"));
  if (value.length > BOARD_LIMITS.body) throw new Error(T.errCardBodyLong(BOARD_LIMITS.body));
  return value;
}

function checkLabels(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > BOARD_LIMITS.labels) throw new Error(T.errCardLabel(BOARD_LIMITS.label));
  const labels: string[] = [];
  for (const raw of value) {
    if (typeof raw !== "string" || !raw.trim() || raw.trim().length > BOARD_LIMITS.label) throw new Error(T.errCardLabel(BOARD_LIMITS.label));
    const label = raw.trim();
    if (!labels.some((l) => l.toLowerCase() === label.toLowerCase())) labels.push(label);
  }
  return labels;
}

function checkLinks(value: unknown): CardLink[] {
  if (!Array.isArray(value)) throw new Error(T.errCardLink);
  if (value.length > BOARD_LIMITS.links) throw new Error(T.errCardLinks(BOARD_LIMITS.links));
  const links: CardLink[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || typeof (raw as CardLink).url !== "string") throw new Error(T.errCardLink);
    const { url, title } = raw as CardLink;
    if (url.length > BOARD_LIMITS.linkUrl) throw new Error(T.errCardLink);
    let parsed: URL;
    try {
      parsed = new URL(url.trim());
    } catch {
      throw new Error(T.errCardLink);
    }
    // 화면에서 눌러 열리는 주소라 javascript: 나 file: 같은 스킴은 받지 않는다.
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error(T.errCardLink);
    if (title !== null && title !== undefined && (typeof title !== "string" || title.length > BOARD_LIMITS.linkTitle)) throw new Error(T.errCardField("links.title"));
    if (!links.some((l) => l.url === parsed.href)) links.push({ url: parsed.href, title: title?.trim() || null });
  }
  return links;
}

function checkPriority(value: unknown): BoardPriority {
  if (!isPriority(value)) throw new Error(T.errCardField("priority"));
  return value;
}

function checkOptionalId(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !value) throw new Error(T.errCardField(field));
  return value;
}

// TOBOARD: 없으면 null. 있으면 세 필드의 모양을 검사한다. 세션이 실제로 있는지는 호출하는 쪽이 확인한다.
function checkSource(value: unknown): CardSource | null {
  if (value === undefined || value === null) return null;
  const input = value as Partial<CardSource>;
  if (typeof input !== "object" || typeof input.agentId !== "string" || !input.agentId || typeof input.itemId !== "string" || !input.itemId) throw new Error(T.errCardField("source"));
  if (input.part !== null && input.part !== undefined && (typeof input.part !== "string" || input.part.length > BOARD_LIMITS.sourcePart)) throw new Error(T.errCardField("source.part"));
  return { agentId: input.agentId, itemId: input.itemId, part: input.part ?? null };
}

function checkIds(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || !v)) throw new Error(T.errCardField(field));
  return [...new Set(value as string[])];
}

function checkColumnName(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > BOARD_LIMITS.columnName) throw new Error(T.errColumnName(BOARD_LIMITS.columnName));
  return value.trim();
}

// 디스크의 source 는 모양이 틀리면 버린다(카드 전체를 버리지 않는다). 새 카드(strict)는 틀리면 던진다. 없으면 필드를 만들지 않아 옛 카드의 파일 모양이 그대로 남는다.
function sanitizeSource(raw: unknown, strict = false): { source: CardSource } | Record<string, never> {
  try {
    const source = checkSource(raw);
    return source ? { source } : {};
  } catch (error) {
    if (strict) throw error;
    return {};
  }
}

// 디스크에서 읽은 보드는 믿지 않고 모양을 다시 맞춘다. 모양이 아예 틀리면 던져서 파일을 치우게 한다.
function sanitizeBoard(raw: unknown): Board {
  const input = raw as Partial<Board> | null;
  if (!input || !Array.isArray(input.columns) || !Array.isArray(input.cards) || input.columns.length === 0) throw new Error("bad board");
  const roles = new Set<string>(["backlog", "todo", "inProgress", "review", "done"]);
  const columns: BoardColumn[] = input.columns.map((c) => {
    const column = c as Partial<BoardColumn>;
    if (typeof column.id !== "string" || typeof column.name !== "string") throw new Error("bad column");
    return { id: column.id, name: column.name, role: typeof column.role === "string" && roles.has(column.role) ? column.role : null };
  });
  const rawCards = input.cards as Partial<BoardCard>[];
  const { numbers, next } = numberCards(
    rawCards.filter((c): c is Partial<BoardCard> & { id: string; createdAt: string } => !!c && typeof c.id === "string").map((c) => ({ id: c.id, number: c.number, createdAt: typeof c.createdAt === "string" ? c.createdAt : "" })),
    input.nextNumber,
  );
  const cards: BoardCard[] = input.cards.map((c) => {
    const card = c as Partial<BoardCard>;
    if (typeof card.id !== "string" || typeof card.title !== "string" || typeof card.columnId !== "string") throw new Error("bad card");
    const now = new Date().toISOString();
    return {
      id: card.id,
      columnId: card.columnId,
      title: card.title,
      body: typeof card.body === "string" ? card.body : "",
      labels: Array.isArray(card.labels) ? card.labels.filter((l): l is string => typeof l === "string") : [],
      priority: isPriority(card.priority) ? card.priority : 0,
      number: numbers.get(card.id)!,
      workspaceId: typeof card.workspaceId === "string" ? card.workspaceId : null,
      agentIds: Array.isArray(card.agentIds) ? card.agentIds.filter((a): a is string => typeof a === "string") : [],
      links: Array.isArray(card.links) ? card.links.filter((l): l is CardLink => !!l && typeof l.url === "string").map((l) => ({ url: l.url, title: typeof l.title === "string" ? l.title : null })) : [],
      ...sanitizeSource(card.source),
      createdAt: typeof card.createdAt === "string" ? card.createdAt : now,
      updatedAt: typeof card.updatedAt === "string" ? card.updatedAt : now,
    };
  });
  return { columns, cards: regroup(columns, cards), nextNumber: next, labelColors: sanitizeLabelColors(input.labelColors) };
}

function sanitizeLabelColors(raw: unknown): Record<string, number> {
  const colors: Record<string, number> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return colors;
  for (const [label, color] of Object.entries(raw)) {
    if (Object.keys(colors).length >= BOARD_LIMITS.labelColors) break;
    if (typeof color === "number" && Number.isInteger(color) && color >= 0 && color < LABEL_COLORS && label.trim()) colors[label.trim().toLowerCase()] = color;
  }
  return colors;
}

// 읽은 파일에 새 필드가 빠져 있으면 번호를 새로 매겼으므로 저장해야 한다.
function needsMigration(raw: unknown): boolean {
  const input = raw as Partial<Board>;
  return typeof input.nextNumber !== "number" || (input.cards as Partial<BoardCard>[]).some((c) => typeof c?.number !== "number" || !isPriority(c.priority));
}
