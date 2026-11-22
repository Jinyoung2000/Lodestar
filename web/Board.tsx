import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { cardKey, indexBefore, moveCardIn, sortCards } from "../shared/board";
import type { Board, BoardCard, BoardColumn, BoardPriority, BoardSort } from "../shared/protocol";
import { BoardFilter, FilterChips, type Filters, hasFilters } from "./BoardFilter";
import { LabelChip, PriorityIcon, StatusIcon, stopEscape } from "./BoardParts";
import { CardContextMenu, type CardMenuState } from "./BoardCardMenu";
import { CardDetail } from "./CardDetail";
import { Markdown } from "./Timeline";
import { DotSpinner, LinkIcon, More, Plus, Search, Spark } from "./icons";
import { MorningReviewPanel } from "./MorningReview";
import { runReviewNow } from "./reviewActions";
import { latinKeyOf } from "./keymap";
import { rpc } from "./rpc";
import { boardFailed, closeBoardCard, getState, isTopWorkspace, openCard, setBoardLocal, topWorkspaceId, useStore } from "./store";
import { confirmAction } from "./ConfirmDialog";
import { SplitDetail } from "./SplitDetail";
import { S } from "./strings";
import { Button } from "./ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "./ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

const DRAG_THRESHOLD = 5;
const EDGE_SCROLL = 48;
const ALL = "all";
const SORT_KEY = "agent-nav:board-sort";
const SORTS: BoardSort[] = ["manual", "priority", "updated"];

type Drag = {
  cardId: string;
  x: number;
  y: number;
  grabX: number;
  grabY: number;
  width: number;
  columnId: string;
  beforeId: string | null;
};

export function BoardView() {
  const board = useStore((s) => s.board);
  const boardCardId = useStore((s) => s.boardCardId);
  const workspaces = useStore((s) => s.workspaces);
  const review = useStore((s) => s.review);
  const [query, setQuery] = useState("");
  const [workspaceFilter, setWorkspaceFilter] = useState(ALL);
  const [filters, setFilters] = useState<Filters>({ priorities: [], labels: [] });
  const [sort, setSortState] = useState<BoardSort>(readSort);
  const [adding, setAdding] = useState<string | null>(null);
  const [addingColumn, setAddingColumn] = useState(false);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [menu, setMenu] = useState<CardMenuState | null>(null);
  const [announce, setAnnounce] = useState("");
  const scrollerRef = useRef<HTMLDivElement>(null);
  const focusAfter = useRef<string | null>(null);
  const suppressClick = useRef(false);
  const hoverId = useRef<string | null>(null);

  const setSort = (next: BoardSort) => {
    setSortState(next);
    try {
      localStorage.setItem(SORT_KEY, next);
    } catch {
    }
  };

  useLayoutEffect(() => {
    const id = focusAfter.current;
    if (!id) return;
    focusAfter.current = null;
    scrollerRef.current?.querySelector<HTMLElement>(`[data-card-id="${CSS.escape(id)}"]`)?.focus();
  }, [board]);

  useEffect(() => {
    if (!boardCardId) return;
    scrollerRef.current?.querySelector<HTMLElement>(`[data-card-id="${CSS.escape(boardCardId)}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
  }, [boardCardId]);

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      if ((event.target as HTMLElement | null)?.closest("input, textarea, select, [contenteditable='true'], [role='menu'], [role='dialog'], [role='listbox'], .cm-editor, .xterm")) return;
      const current = getState().board;
      if (!current) return;
      const focused = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>("[data-card-id]")?.dataset.cardId ?? null;
      const cardId = focused ?? hoverId.current;
      const card = cardId ? current.cards.find((c) => c.id === cardId) : undefined;
      if (latinKeyOf(event) === "c") {
        event.preventDefault();
        const column = (card && current.columns.find((c) => c.id === card.columnId)) ?? current.columns.find((c) => c.role === "backlog") ?? current.columns[0];
        setAdding(column.id);
      } else if (card && /^[0-4]$/.test(event.key)) {
        event.preventDefault();
        const priority = Number(event.key) as BoardPriority;
        if (priority === card.priority) return;
        rpc.call("board.updateCard", { id: card.id, patch: { priority } }).catch(boardFailed);
        setAnnounce(S.priorityChanged(card.title, S.priorityNames[priority]));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!board) {
    return (
      <section className="board" aria-label={S.board}>
        <div className="pane-header">
          <span className="agent-title">{S.board}</span>
        </div>
        <div className="empty-hint">{S.boardUnavailable}</div>
      </section>
    );
  }

  const q = query.trim().toLowerCase();
  const matches = (card: BoardCard) => {
    if (workspaceFilter !== ALL && topWorkspaceId(card.workspaceId) !== workspaceFilter) return false;
    if (filters.priorities.length > 0 && !filters.priorities.includes(card.priority)) return false;
    if (filters.labels.length > 0 && !card.labels.some((l) => filters.labels.includes(l.toLowerCase()))) return false;
    if (!q) return true;
    return cardKey(card).toLowerCase().includes(q) || card.title.toLowerCase().includes(q) || card.body.toLowerCase().includes(q) || card.labels.some((l) => l.toLowerCase().includes(q));
  };
  const visibleOf = (columnId: string) => sortCards(board.cards.filter((c) => c.columnId === columnId && (matches(c) || c.id === boardCardId)), sort);
  const topWorkspaces = workspaces.filter(isTopWorkspace);
  const firstColumn = board.columns.find((c) => c.role === "backlog") ?? board.columns[0];
  const sorted = sort !== "manual";

  const moveTo = (cardId: string, columnId: string, beforeId: string | null) => {
    const current = getState().board;
    if (!current) return;
    if (sorted && current.cards.find((c) => c.id === cardId)?.columnId === columnId) return;
    const index = indexBefore(current, columnId, cardId, beforeId);
    const next = moveCardIn(current, cardId, columnId, index);
    if (next.cards.every((c, i) => c.id === current.cards[i].id && c.columnId === current.cards[i].columnId)) return;
    setBoardLocal(next);
    rpc.call("board.moveCard", { id: cardId, columnId, index }).catch(boardFailed);
    const column = next.columns.find((c) => c.id === columnId);
    const position = next.cards.filter((c) => c.columnId === columnId).findIndex((c) => c.id === cardId) + 1;
    setAnnounce(S.cardMoved(current.cards.find((c) => c.id === cardId)?.title ?? "", column?.name ?? "", position, next.cards.filter((c) => c.columnId === columnId).length));
  };

  const locate = (x: number, y: number, movingId: string) => {
    const columns = Array.from(scrollerRef.current?.querySelectorAll<HTMLElement>("[data-column-id]") ?? []);
    if (!columns.length) return null;
    const rects = columns.map((el) => el.getBoundingClientRect());
    let at = rects.findIndex((r) => x >= r.left && x <= r.right);
    if (at === -1) at = x < rects[0].left ? 0 : x > rects[rects.length - 1].right ? rects.length - 1 : rects.findIndex((r) => r.left > x);
    const column = columns[at];
    const cards = Array.from(column.querySelectorAll<HTMLElement>("[data-card-id]")).filter((el) => el.dataset.cardId !== movingId);
    const before = cards.find((el) => {
      const r = el.getBoundingClientRect();
      return y < r.top + r.height / 2;
    });
    return { columnId: column.dataset.columnId!, beforeId: sorted ? null : (before?.dataset.cardId ?? null) };
  };

  const onCardPointerDown = (event: ReactPointerEvent<HTMLElement>, card: BoardCard) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("a, button, input") || !event.currentTarget.contains(event.target as Node)) return;
    const element = event.currentTarget;
    const rect = element.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;
    let dragging = false;
    let last: Drag | null = null;
    const move = (e: PointerEvent) => {
      if (!dragging) {
        if (Math.hypot(e.clientX - startX, e.clientY - startY) < DRAG_THRESHOLD) return;
        dragging = true;
        getSelection()?.removeAllRanges();
      }
      const scroller = scrollerRef.current;
      if (scroller) {
        const edge = scroller.getBoundingClientRect();
        if (e.clientX < edge.left + EDGE_SCROLL) scroller.scrollLeft -= EDGE_SCROLL / 2;
        else if (e.clientX > edge.right - EDGE_SCROLL) scroller.scrollLeft += EDGE_SCROLL / 2;
      }
      const target = locate(e.clientX, e.clientY, card.id);
      if (!target) return;
      last = { cardId: card.id, x: e.clientX, y: e.clientY, grabX: startX - rect.left, grabY: startY - rect.top, width: rect.width, ...target };
      setDrag(last);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", onKey, true);
      if (!dragging) return;
      suppressClick.current = true;
      setTimeout(() => (suppressClick.current = false), 0);
      setDrag(null);
      if (last) moveTo(card.id, last.columnId, last.beforeId);
    };
    const cancel = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", onKey, true);
      setDrag(null);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape" || !dragging) return;
      e.stopPropagation();
      e.preventDefault();
      cancel();
      suppressClick.current = true;
      window.addEventListener("pointerup", () => setTimeout(() => (suppressClick.current = false), 0), { once: true });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", onKey, true);
  };

  const focusNeighbor = (card: BoardCard, key: string) => {
    const own = visibleOf(card.columnId);
    const at = own.findIndex((c) => c.id === card.id);
    let target: BoardCard | undefined;
    if (key === "ArrowUp") target = own[at - 1];
    else if (key === "ArrowDown") target = own[at + 1];
    else {
      const step = key === "ArrowLeft" ? -1 : 1;
      for (let i = board.columns.findIndex((c) => c.id === card.columnId) + step; i >= 0 && i < board.columns.length && !target; i += step) {
        const cards = visibleOf(board.columns[i].id);
        target = cards[Math.min(at, cards.length - 1)];
      }
    }
    if (!target) return;
    const element = scrollerRef.current?.querySelector<HTMLElement>(`[data-card-id="${CSS.escape(target.id)}"]`);
    element?.focus();
    element?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
  };

  const onCardKeyDown = (event: KeyboardEvent<HTMLElement>, card: BoardCard) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect();
      setMenu({ cardId: card.id, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, only: null });
      return;
    }
    if (!event.altKey && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      openCard(card.id);
      return;
    }
    if (event.metaKey || event.ctrlKey || event.shiftKey) return;
    if (!event.altKey) {
      if (!event.key.startsWith("Arrow")) return;
      event.preventDefault();
      focusNeighbor(card, event.key);
      return;
    }
    const own = visibleOf(card.columnId);
    const at = own.findIndex((c) => c.id === card.id);
    let target: { columnId: string; beforeId: string | null } | null = null;
    if (sorted && (event.key === "ArrowUp" || event.key === "ArrowDown")) target = null;
    else if (event.key === "ArrowUp") target = at > 0 ? { columnId: card.columnId, beforeId: own[at - 1].id } : null;
    else if (event.key === "ArrowDown") target = at < own.length - 1 ? { columnId: card.columnId, beforeId: own[at + 2]?.id ?? null } : null;
    else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      const columnIndex = board.columns.findIndex((c) => c.id === card.columnId) + (event.key === "ArrowLeft" ? -1 : 1);
      const column = board.columns[columnIndex];
      if (column) target = { columnId: column.id, beforeId: sorted ? null : (visibleOf(column.id)[at]?.id ?? null) };
    } else return;
    event.preventDefault();
    if (!target) return;
    focusAfter.current = card.id;
    moveTo(card.id, target.columnId, target.beforeId);
  };

  const dragging = drag ? board.cards.find((c) => c.id === drag.cardId) : null;
  const filtered = !!q || workspaceFilter !== ALL || hasFilters(filters);

  return (
    <div className="split-view">
      <section className="board" aria-label={S.board}>
        <div className="pane-header">
          <span className="agent-title board-header-title">{S.board}</span>
          <label className="board-search">
            <Search size={14} />
            <input className="input" aria-label={S.boardSearch} placeholder={S.boardSearchPlaceholder} value={query} onChange={(e) => setQuery(e.target.value)} />
          </label>
          <Select value={workspaceFilter} onValueChange={setWorkspaceFilter}>
            <SelectTrigger aria-label={S.boardWorkspaceFilter} title={S.boardWorkspaceFilter}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent onEscapeKeyDown={stopEscape}>
              <SelectItem value={ALL}>{S.allWorkspaces}</SelectItem>
              {topWorkspaces.map((w) => (
                <SelectItem key={w.id} value={w.id}>
                  {w.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <BoardFilter board={board} filters={filters} onChange={setFilters} />
          <Select value={sort} onValueChange={(value) => setSort(value as BoardSort)}>
            <SelectTrigger aria-label={S.boardSort} title={sorted ? S.sortedHint(S.sortNames[sort]) : S.boardSort}>
              <span className="board-sort-prefix">{S.sortPrefix}</span>
              <SelectValue />
            </SelectTrigger>
            <SelectContent onEscapeKeyDown={stopEscape}>
              {SORTS.map((value) => (
                <SelectItem key={value} value={value}>
                  {S.sortNames[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="spacer" />
          {review && (
            <Button variant="secondary" size="sm" disabled={review.running} title={S.reviewNowTip} onClick={() => void runReviewNow()}>
              {review.running ? <DotSpinner state="running" /> : <Spark size={14} />} {S.reviewNow}
            </Button>
          )}
          <Button variant="primary" size="sm" onClick={() => setAdding(firstColumn.id)}>
            <Plus size={14} /> {S.newCard}
          </Button>
        </div>
        {hasFilters(filters) && <FilterChips filters={filters} onChange={setFilters} />}
        <MorningReviewPanel />
        <div className="board-columns" ref={scrollerRef} data-dragging={drag ? "" : undefined}>
          {board.columns.map((column, index) => (
            <ColumnView
              key={column.id}
              board={board}
              column={column}
              index={index}
              cards={visibleOf(column.id)}
              total={board.cards.filter((c) => c.columnId === column.id).length}
              filtered={filtered}
              sorted={sorted}
              adding={adding === column.id}
              onAdd={(open) => setAdding(open ? column.id : null)}
              defaultWorkspaceId={workspaceFilter === ALL ? null : workspaceFilter}
              drag={drag}
              suppressClick={suppressClick}
              onCardPointerDown={onCardPointerDown}
              onCardKeyDown={onCardKeyDown}
              onMenu={setMenu}
              onHover={(id) => (hoverId.current = id)}
            />
          ))}
          <div className="board-add-column">
            {addingColumn ? (
              <NameInput
                label={S.newColumnPlaceholder}
                initial=""
                onSubmit={(name) => {
                  setAddingColumn(false);
                  rpc.call("board.addColumn", { name }).catch(boardFailed);
                }}
                onCancel={() => setAddingColumn(false)}
              />
            ) : (
              <Button variant="ghost" size="icon" aria-label={S.addColumn} disabled={board.columns.length >= 12} title={board.columns.length >= 12 ? S.columnLimit : S.addColumn} onClick={() => setAddingColumn(true)}>
                <Plus size={14} />
              </Button>
            )}
          </div>
        </div>
        {drag && dragging && (
          <div className="card card-ghost" style={{ width: drag.width, transform: `translate(${drag.x - drag.grabX}px, ${drag.y - drag.grabY}px)` }}>
            <span className="card-title">{dragging.title}</span>
          </div>
        )}
        {menu && <CardContextMenu board={board} state={menu} onClose={() => setMenu(null)} onAnnounce={setAnnounce} />}
        <div className="sr-only" role="status" aria-live="polite">
          {announce}
        </div>
      </section>
      {boardCardId && (
        <SplitDetail compact widthKey="boardDetailWidth" label={S.cardDetailAria} title={S.cardDetail} closeLabel={S.closeCard} onClose={closeBoardCard}>
          <CardDetail cardId={boardCardId} onClose={closeBoardCard} />
        </SplitDetail>
      )}
    </div>
  );
}

function readSort(): BoardSort {
  try {
    const saved = localStorage.getItem(SORT_KEY);
    return SORTS.includes(saved as BoardSort) ? (saved as BoardSort) : "manual";
  } catch {
    return "manual";
  }
}

function ColumnView({
  board,
  column,
  index,
  cards,
  total,
  filtered,
  sorted,
  adding,
  onAdd,
  defaultWorkspaceId,
  drag,
  suppressClick,
  onCardPointerDown,
  onCardKeyDown,
  onMenu,
  onHover,
}: {
  board: Board;
  column: BoardColumn;
  index: number;
  cards: BoardCard[];
  total: number;
  filtered: boolean;
  sorted: boolean;
  adding: boolean;
  onAdd: (open: boolean) => void;
  defaultWorkspaceId: string | null;
  drag: Drag | null;
  suppressClick: React.RefObject<boolean>;
  onCardPointerDown: (event: ReactPointerEvent<HTMLElement>, card: BoardCard) => void;
  onCardKeyDown: (event: KeyboardEvent<HTMLElement>, card: BoardCard) => void;
  onMenu: (menu: CardMenuState) => void;
  onHover: (cardId: string | null) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const dropHere = drag && drag.columnId === column.id;
  const showLine = dropHere && !(sorted && board.cards.find((c) => c.id === drag.cardId)?.columnId === column.id);

  const remove = async () => {
    const ok = await confirmAction(total > 0 ? S.confirmDeleteColumn(column.name, total) : S.confirmDeleteEmptyColumn(column.name), S.deleteButton, undefined, "warning");
    if (ok) rpc.call("board.deleteColumn", { id: column.id }).catch(boardFailed);
  };

  return (
    <div className="board-column" data-role={column.role ?? "custom"} data-column-id={column.id} data-drop={dropHere ? "" : undefined} role="group" aria-label={S.cardsOf(column.name)}>
      <div className="board-column-head">
        {renaming ? (
          <NameInput
            label={S.columnName}
            initial={column.name}
            onSubmit={(name) => {
              setRenaming(false);
              if (name !== column.name) rpc.call("board.renameColumn", { id: column.id, name }).catch(boardFailed);
            }}
            onCancel={() => setRenaming(false)}
          />
        ) : (
          <>
            <StatusIcon role={column.role} />
            <span className="agent-title" title={column.name}>
              {column.name}
            </span>
            <span className="board-column-count xs">{S.cardCount(cards.length, total)}</span>
            <span className="spacer" />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="icon" className="column-menu-button" aria-label={S.columnMenu} title={S.columnMenu}>
                  <More />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => setRenaming(true)}>{S.renameColumn}</DropdownMenuItem>
                <DropdownMenuItem disabled={index === 0} onSelect={() => void rpc.call("board.moveColumn", { id: column.id, index: index - 1 }).catch(boardFailed)}>
                  {S.moveColumnLeft}
                </DropdownMenuItem>
                <DropdownMenuItem disabled={index === board.columns.length - 1} onSelect={() => void rpc.call("board.moveColumn", { id: column.id, index: index + 1 }).catch(boardFailed)}>
                  {S.moveColumnRight}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem danger disabled={board.columns.length === 1} onSelect={remove}>
                  {S.deleteColumn}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button size="icon" aria-label={S.newCardIn(column.name)} title={S.newCardIn(column.name)} onClick={() => onAdd(true)}>
              <Plus />
            </Button>
          </>
        )}
      </div>
      <div className="board-column-body">
        {adding && (
          <NameInput
            label={S.cardTitle}
            placeholder={S.cardTitlePlaceholder}
            initial=""
            keepOpen
            onSubmit={(title) => void rpc.call("board.createCard", { title, columnId: column.id, workspaceId: defaultWorkspaceId }).catch(boardFailed)}
            onCancel={() => onAdd(false)}
          />
        )}
        {cards.map((card) => (
          <div key={card.id} className="card-slot">
            {showLine && drag.beforeId === card.id && <div className="drop-line" />}
            <CardView card={card} role={column.role} dragging={drag?.cardId === card.id} suppressClick={suppressClick} onPointerDown={onCardPointerDown} onKeyDown={onCardKeyDown} onMenu={onMenu} onHover={onHover} />
          </div>
        ))}
        {showLine && drag.beforeId === null && <div className="drop-line" />}
        {cards.length === 0 && !adding && !dropHere && <div className="faint xs board-empty">{filtered && total > 0 ? S.noMatches : S.emptyColumn}</div>}
      </div>
    </div>
  );
}

function CardView({
  card,
  role,
  dragging,
  suppressClick,
  onPointerDown,
  onKeyDown,
  onMenu,
  onHover,
}: {
  card: BoardCard;
  role: BoardColumn["role"];
  dragging: boolean;
  suppressClick: React.RefObject<boolean>;
  onPointerDown: (event: ReactPointerEvent<HTMLElement>, card: BoardCard) => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>, card: BoardCard) => void;
  onMenu: (menu: CardMenuState) => void;
  onHover: (cardId: string | null) => void;
}) {
  const workspace = useStore((s) => s.workspaces.find((w) => w.id === card.workspaceId));
  const agents = useStore((s) => s.agents);
  const selected = useStore((s) => s.boardCardId === card.id);
  const sessions = card.agentIds.map((id) => agents.find((a) => a.id === id)).filter((a) => !!a);
  return (
    <article
      className="card"
      tabIndex={0}
      role="button"
      aria-label={S.cardAria(card.title)}
      title={S.cardMoveHint}
      data-card-id={card.id}
      data-priority={card.priority}
      data-dragging={dragging ? "" : undefined}
      data-selected={selected ? "" : undefined}
      onPointerDown={(e) => onPointerDown(e, card)}
      onPointerEnter={() => onHover(card.id)}
      onPointerLeave={() => onHover(null)}
      onKeyDown={(e) => onKeyDown(e, card)}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu({ cardId: card.id, x: e.clientX, y: e.clientY, only: null });
      }}
      onClick={(e) => {
        if (!e.currentTarget.contains(e.target as Node)) return;
        if (!suppressClick.current) openCard(card.id);
      }}
    >
      <div className="card-top">
        <span className="card-key" aria-label={S.cardKeyAria(cardKey(card))}>
          {cardKey(card)}
        </span>
        <span title={new Date(card.createdAt).toLocaleString()}>{shortDate(card.createdAt)}</span>
        {card.links.length > 0 && (
          <span className="card-meta-item">
            <LinkIcon size={12} /> {card.links.length}
          </span>
        )}
        <span className="spacer" />
        <button
          type="button"
          className="card-priority"
          data-none={card.priority === 0 ? "" : undefined}
          aria-label={S.priorityAria(S.priorityNames[card.priority])}
          title={S.priorityNames[card.priority]}
          onClick={(e) => {
            e.stopPropagation();
            const rect = e.currentTarget.getBoundingClientRect();
            onMenu({ cardId: card.id, x: rect.left, y: rect.bottom, only: "priority" });
          }}
        >
          <PriorityIcon priority={card.priority} />
        </button>
      </div>
      <span className="card-title" title={card.title}>
        {card.title}
      </span>
      {card.body.trim() && <Markdown className="card-body" text={card.body} />}
      <div className="card-tags">
        <StatusIcon role={role} />
        {card.labels.map((label) => (
          <LabelChip key={label} label={label} />
        ))}
      </div>
      {(workspace || sessions.length > 0) && (
        <div className="card-meta">
          {workspace && <span className="card-meta-item card-workspace">{workspace.name}</span>}
          {sessions.slice(0, 2).map((agent, i) => (
            <span key={agent.id} className="card-meta-item card-session" data-extra={i > 0 ? "" : undefined} title={agent.title}>
              <span className="dot" data-state={agent.status} />
              {i === 0 && <span className="card-session-title">{agent.title}</span>}
            </span>
          ))}
          {sessions.length > 2 && <span>+{sessions.length - 2}</span>}
        </div>
      )}
    </article>
  );
}

function NameInput({ label, placeholder, initial, keepOpen = false, onSubmit, onCancel }: { label: string; placeholder?: string; initial: string; keepOpen?: boolean; onSubmit: (value: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(initial);
  const done = useRef(false);
  useEffect(() => () => void (done.current = true), []);
  const submit = () => {
    const text = value.trim();
    if (!text) return onCancel();
    if (!keepOpen) done.current = true;
    onSubmit(text);
    if (keepOpen) setValue("");
  };
  return (
    <input
      className="input name-input"
      aria-label={label}
      placeholder={placeholder ?? label}
      value={value}
      autoFocus
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.nativeEvent.isComposing) {
          e.preventDefault();
          submit();
        } else if (e.key === "Escape") {
          e.stopPropagation();
          done.current = true;
          onCancel();
        }
      }}
      onBlur={() => {
        if (done.current) return;
        if (!keepOpen && value.trim() && value.trim() !== initial) submit();
        else onCancel();
      }}
    />
  );
}

function shortDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
