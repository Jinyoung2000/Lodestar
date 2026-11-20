import type { Board, BoardPriority } from "../shared/protocol";
import { boardLabels } from "./BoardFilter";
import { LabelChip, PriorityIcon, StatusIcon, stopEscape } from "./BoardParts";
import { confirmAction } from "./ConfirmDialog";
import { rpc } from "./rpc";
import { boardFailed, closeBoardCard, getState, openCard } from "./store";
import { S } from "./strings";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";

// BOARDUX: 카드 우클릭 메뉴(상태, 우선순위, 라벨, 삭제). 메뉴는 보드에 하나만 두고 카드가 좌표와 함께 연다.
// only 가 "priority" 면 카드의 우선순위 아이콘을 눌렀을 때처럼 우선순위 항목만 보인다.

export type CardMenuState = { cardId: string; x: number; y: number; only: "priority" | null };

export function CardContextMenu({ board, state, onClose, onAnnounce }: { board: Board; state: CardMenuState; onClose: () => void; onAnnounce: (text: string) => void }) {
  const card = board.cards.find((c) => c.id === state.cardId);
  if (!card) return null;
  const column = board.columns.find((c) => c.id === card.columnId);
  const labels = boardLabels(board);

  const setPriority = (value: string) => {
    const priority = Number(value) as BoardPriority;
    if (priority === card.priority) return;
    rpc.call("board.updateCard", { id: card.id, patch: { priority } }).catch(boardFailed);
    onAnnounce(S.priorityChanged(card.title, S.priorityNames[priority]));
  };
  const setStatus = (columnId: string) => {
    if (columnId === card.columnId) return;
    rpc.call("board.moveCard", { id: card.id, columnId, index: Number.MAX_SAFE_INTEGER }).catch(boardFailed);
  };
  const toggleLabel = (label: string) => {
    const has = card.labels.some((l) => l.toLowerCase() === label.toLowerCase());
    const next = has ? card.labels.filter((l) => l.toLowerCase() !== label.toLowerCase()) : [...card.labels, label];
    rpc.call("board.updateCard", { id: card.id, patch: { labels: next } }).catch(boardFailed);
  };
  const remove = async () => {
    if (!(await confirmAction(S.confirmDeleteCard(card.title), S.deleteButton, undefined, "warning"))) return;
    if (getState().boardCardId === card.id) closeBoardCard();
    rpc.call("board.deleteCard", { id: card.id }).catch(boardFailed);
  };

  return (
    <DropdownMenu open onOpenChange={(open) => !open && onClose()}>
      <DropdownMenuTrigger asChild>
        <button type="button" className="menu-anchor" style={{ left: state.x, top: state.y }} tabIndex={-1} aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        aria-label={S.cardMenu}
        onEscapeKeyDown={stopEscape}
        onCloseAutoFocus={(event) => {
          // 메뉴를 닫으면 사라지는 앵커가 아니라 카드로 포커스를 돌려 키보드 흐름이 이어지게 한다.
          event.preventDefault();
          document.querySelector<HTMLElement>(`[data-card-id="${CSS.escape(card.id)}"]`)?.focus();
        }}
      >
        {state.only === "priority" ? (
          <PriorityItems value={card.priority} onChange={setPriority} />
        ) : (
          <>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <StatusIcon role={column?.role ?? null} />
                {S.cardMenuStatus}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent onEscapeKeyDown={stopEscape}>
                <DropdownMenuRadioGroup value={card.columnId} onValueChange={setStatus}>
                  {board.columns.map((c) => (
                    <DropdownMenuRadioItem key={c.id} value={c.id}>
                      <StatusIcon role={c.role} />
                      {c.name}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <PriorityIcon priority={card.priority} />
                {S.priority}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent onEscapeKeyDown={stopEscape}>
                <PriorityItems value={card.priority} onChange={setPriority} />
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>{S.cardMenuLabels}</DropdownMenuSubTrigger>
              <DropdownMenuSubContent onEscapeKeyDown={stopEscape}>
                {labels.length === 0 && <DropdownMenuItem disabled>{S.filterNoLabels}</DropdownMenuItem>}
                {labels.map((label) => (
                  <DropdownMenuCheckboxItem key={label} checked={card.labels.some((l) => l.toLowerCase() === label.toLowerCase())} onSelect={(e) => e.preventDefault()} onCheckedChange={() => toggleLabel(label)}>
                    <LabelChip label={label} />
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => openCard(card.id)}>{S.cardMenuOpen}</DropdownMenuItem>
            <DropdownMenuItem danger onSelect={remove}>
              {S.deleteCard}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// 우선순위 다섯 단계. 오른쪽의 숫자는 보드에서 카드에 마우스를 올리거나 포커스한 채 누르는 단축키다.
function PriorityItems({ value, onChange }: { value: BoardPriority; onChange: (value: string) => void }) {
  return (
    <DropdownMenuRadioGroup value={String(value)} onValueChange={onChange}>
      {S.priorityNames.map((name, i) => (
        <DropdownMenuRadioItem key={name} value={String(i)}>
          <PriorityIcon priority={i as BoardPriority} />
          {name}
          <span className="menu-hint">{i}</span>
        </DropdownMenuRadioItem>
      ))}
    </DropdownMenuRadioGroup>
  );
}
