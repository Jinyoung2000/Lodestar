import { useRef, useState, type KeyboardEvent } from "react";
import type { BoardCard, BoardColumn } from "../shared/protocol";
import { cardBodyFrom, cardTitleFrom, findSourceCard, pickColumn, plainExcerpt } from "../shared/toBoard";
import { hint } from "./hint";
import { Popup } from "./Popup";
import { rpc } from "./rpc";
import { boardFailed, openCard, topWorkspaceId, useStore } from "./store";
import { S } from "./strings";
import { closeToBoard, rememberColumn, rememberedColumn, useToBoardRequest, type ToBoardRequest } from "./toBoardState";
import { Button } from "./ui/button";

// 대화의 한 부분(답, 말, 드래그로 고른 글, 할 일)을 Board 카드로 만들기 전에 제목을 고치고 열을 고르는 작은 팝오버. 앱에 하나만 뜨고 App 이 그린다.
// 같은 부분의 카드가 이미 있으면 새로 만들기 전에 그 카드를 열지 묻는다. 만든 뒤 확인은 알림 카드가 아니라 누른 자리의 말풍선(web/hint.ts)이다.
export function ToBoardPopover() {
  const request = useToBoardRequest();
  if (!request) return null;
  return (
    <Popup anchor={request.anchor} placement={request.placement} align={request.align} label={S.toBoardPopupLabel} className="popup-toboard" onClose={closeToBoard}>
      <ToBoardBody key={request.nonce} request={request} />
    </Popup>
  );
}

function ToBoardBody({ request }: { request: ToBoardRequest }) {
  const board = useStore((s) => s.board);
  const [addAnother, setAddAnother] = useState(false);
  const existing = findSourceCard(board, { agentId: request.agentId, itemId: request.itemId, part: request.part });
  if (!board) return null;
  if (existing && !addAnother) return <AlreadyOnBoard card={existing} columns={board.columns} onAddAnother={() => setAddAnother(true)} />;
  return <NewCardForm request={request} columns={board.columns} />;
}

function AlreadyOnBoard({ card, columns, onAddAnother }: { card: BoardCard; columns: BoardColumn[]; onAddAnother: () => void }) {
  const column = columns.find((c) => c.id === card.columnId);
  return (
    <div className="toboard">
      <div className="toboard-heading">{S.toBoardAlready}</div>
      <div className="toboard-existing">{S.toBoardAlreadyIn(card.title, column?.name ?? "")}</div>
      <div className="toboard-actions">
        <Button variant="secondary" size="sm" onClick={onAddAnother}>
          {S.toBoardAddAnother}
        </Button>
        <Button
          variant="primary"
          size="sm"
          autoFocus
          onClick={() => {
            closeToBoard();
            openCard(card.id);
          }}
        >
          {S.toBoardOpenCard}
        </Button>
      </div>
    </div>
  );
}

function NewCardForm({ request, columns }: { request: ToBoardRequest; columns: BoardColumn[] }) {
  const titleRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState(() => cardTitleFrom(request.text));
  const [columnId, setColumnId] = useState(() => pickColumn({ columns }, rememberedColumn()));
  const [busy, setBusy] = useState(false);
  const agent = useStore((s) => s.agents.find((a) => a.id === request.agentId));

  const submit = async () => {
    const next = title.trim();
    if (!next) {
      if (titleRef.current) hint(S.toBoardNoTitle, titleRef.current);
      return;
    }
    if (busy || !agent) return;
    setBusy(true);
    try {
      await rpc.call("board.createCard", {
        title: next,
        body: cardBodyFrom({ text: request.text, sessionTitle: agent.title, agentId: agent.id, itemId: request.itemId }),
        columnId,
        workspaceId: topWorkspaceId(agent.workspaceId),
        agentIds: [agent.id],
        source: { agentId: agent.id, itemId: request.itemId, part: request.part },
      });
      rememberColumn(columnId);
      closeToBoard();
      hint(S.addedToBoard, request.rect, { check: true });
    } catch (error) {
      setBusy(false);
      boardFailed(error);
    }
  };

  return (
    <div className="toboard">
      <input
        ref={titleRef}
        className="input toboard-title"
        aria-label={S.toBoardTitle}
        value={title}
        autoFocus
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void submit();
          }
        }}
      />
      <ColumnChoice columns={columns} value={columnId} onChange={setColumnId} />
      <div className="toboard-excerpt">{plainExcerpt(request.text)}</div>
      <div className="toboard-actions">
        <Button variant="secondary" size="sm" onClick={closeToBoard}>
          {S.cancel}
        </Button>
        <Button variant="primary" size="sm" disabled={busy} onClick={() => void submit()}>
          {S.toBoardAdd}
        </Button>
      </div>
    </div>
  );
}

// 열은 5개 안팎이라 드롭다운 대신 한눈에 보이는 알약으로 둔다. 좌우 화살표로 옮기고 Tab 으로는 고른 알약 하나만 지난다.
function ColumnChoice({ columns, value, onChange }: { columns: BoardColumn[]; value: string; onChange: (id: string) => void }) {
  const move = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = columns[(index + step + columns.length) % columns.length];
    onChange(next.id);
    (event.currentTarget.parentElement?.children[columns.indexOf(next)] as HTMLElement | undefined)?.focus();
  };
  return (
    <div className="toboard-columns" role="radiogroup" aria-label={S.toBoardColumn}>
      {columns.map((column, index) => (
        <button key={column.id} type="button" role="radio" aria-checked={column.id === value} tabIndex={column.id === value ? 0 : -1} className="toboard-column" data-on={column.id === value || undefined} onClick={() => onChange(column.id)} onKeyDown={(e) => move(e, index)}>
          {column.name}
        </button>
      ))}
    </div>
  );
}
