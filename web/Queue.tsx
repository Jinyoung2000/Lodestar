import type { KeyboardEvent } from "react";
import type { Agent, QueuedMessage } from "../shared/protocol";
import { FeedbackAttachmentChip } from "./DiffFeedbackChips";
import { CloseSmall, Edit, Newline } from "./icons";
import type { PendingRef } from "./pendingMessages";
import { rpc } from "./rpc";
import { flash, setState } from "./store";
import { S } from "./strings";
import { Markdown } from "./Timeline";

// 대화 맨 아래의 큐(B3-08): 응답 중에 보낸 메시지가 줄을 서 있는 자리. 턴이 정상으로 끝나면 맨 앞부터 이어서 나간다.
// 말풍선에 마우스를 올리거나 행에 포커스를 두면 Edit(입력창으로 되돌림), Send Immediately(지금 끼어들기), Remove from Queue. 행에서 Delete 나 Backspace 도 Remove.
// 끼어들기로 보낸 메시지는 모델이 받을 때까지 그 위에 Steering 으로 보인다(B3-09). QUEUECANCEL: 아직 안 넘어갔으면 Edit 과 Cancel 이 있고, 이미 넘어갔으면 "Already sent to Claude" 만 보인다.
export function QueuedMessages({ agent, paneId }: { agent: Agent; paneId: string }) {
  const queue = agent.queue ?? [];
  const steering = agent.steering ?? [];
  return (
    <>
      {steering.length > 0 && <SteeringMessages agentId={agent.id} paneId={paneId} steering={steering} />}
      {queue.length > 0 && <QueueList agent={agent} paneId={paneId} queue={queue} />}
    </>
  );
}

// 큐나 끼어들기 대기에서 거두고 입력창에 쓴 글을 돌려받는다. 거두지 못했으면 null(이미 나갔다).
// 같은 항목에 대한 요청이 끝나기 전의 두 번째 요청(더블클릭, 키 반복)은 무시한다.
const inFlight = new Set<string>();
export async function takePending(agentId: string, pending: PendingRef): Promise<{ text: string } | null> {
  if (inFlight.has(pending.id)) return null;
  inFlight.add(pending.id);
  try {
    if (pending.kind === "queue") {
      const removed = await rpc.call("agents.dequeue", { agentId, queueId: pending.id });
      if (!removed) flash(S.alreadySent);
      return removed;
    }
    const result = await rpc.call("agents.cancelSteering", { agentId, steeringId: pending.id });
    if (!result?.cancelled) {
      flash(S.alreadySent);
      return null;
    }
    return { text: result.text };
  } finally {
    inFlight.delete(pending.id);
  }
}

// 거둔 글을 입력창으로 되돌린다(입력창에 글이 있으면 아래 줄에 붙인다).
export function restoreToComposer(paneId: string, text: string) {
  setState((s) => ({ composerPrefill: { ...s.composerPrefill, [paneId]: { text, nonce: Date.now(), append: true } }, focusComposer: { paneId, nonce: Date.now() } }));
}

export async function editPending(agentId: string, paneId: string, pending: PendingRef) {
  const taken = await takePending(agentId, pending);
  if (taken) restoreToComposer(paneId, taken.text);
}

// DIFFFB: 큐와 끼어들기 항목은 모델에 간 프롬프트(text)가 아니라 입력창에 쓴 글(shown)과 피드백 칩을 보인다.
function QueuedBubble({ agentId, item }: { agentId: string; item: QueuedMessage }) {
  const chips = (item.attachments ?? []).filter((a) => a.kind === "diffFeedback");
  const text = item.shown ?? item.text;
  return (
    <>
      {chips.length > 0 && (
        <div className="user-attachments">
          {chips.map((chip) => (
            <FeedbackAttachmentChip key={chip.id} agentId={agentId} attachment={chip} />
          ))}
        </div>
      )}
      {/* 첨부한 코드 선택은 글 끝에 코드 블록으로 붙는다. 보낸 말풍선처럼 마크다운으로 그려 펜스가 날것으로 보이지 않게 한다. */}
      {(text !== "" || chips.length === 0) && (
        <div className="row-user queued-bubble">
          <Markdown className="row-user-text" text={text} breaks linkify={false} />
        </div>
      )}
    </>
  );
}

function SteeringMessages({ agentId, paneId, steering }: { agentId: string; paneId: string; steering: QueuedMessage[] }) {
  return (
    <section className="queued" aria-label={S.steering}>
      <div className="queued-label" title={S.steeringTip}>
        {S.steering}
      </div>
      {steering.map((item) => (
        <PendingRow key={item.id} agentId={agentId} paneId={paneId} pending={{ kind: "steering", id: item.id }} item={item} />
      ))}
    </section>
  );
}

function QueueList({ agent, paneId, queue }: { agent: Agent; paneId: string; queue: QueuedMessage[] }) {
  return (
    <section className="queued" aria-label={S.queued}>
      <div className="queued-label" title={S.queuedTip}>
        {S.queued}
      </div>
      {queue.map((item) => (
        <PendingRow key={item.id} agentId={agent.id} paneId={paneId} pending={{ kind: "queue", id: item.id }} item={item} />
      ))}
    </section>
  );
}

function PendingRow({ agentId, paneId, pending, item }: { agentId: string; paneId: string; pending: PendingRef; item: QueuedMessage }) {
  const sent = item.sent === true;
  const run = (promise: Promise<unknown>) => void promise.catch((error: Error) => flash(error.message));
  const cancelLabel = pending.kind === "queue" ? S.queueRemove : S.steeringCancel;
  const cancel = async (thenFocusComposer: boolean) => {
    const taken = await takePending(agentId, pending);
    if (taken && thenFocusComposer) setState({ focusComposer: { paneId, nonce: Date.now() } });
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.key !== "Delete" && e.key !== "Backspace") || e.shiftKey || e.altKey || e.metaKey || e.ctrlKey || sent) return;
    e.preventDefault();
    // 지워질 행 대신 이웃 행으로 포커스를 옮겨 두고, 이웃이 없으면 거둔 뒤 입력창으로 보낸다.
    const row = e.currentTarget;
    const neighbor = [row.nextElementSibling, row.previousElementSibling].find((el): el is HTMLElement => el instanceof HTMLElement && el.classList.contains("queued-item")) ?? null;
    neighbor?.focus();
    run(cancel(neighbor === null));
  };
  return (
    <div className="queued-item" tabIndex={0} role="group" aria-label={item.shown ?? item.text} onKeyDown={onKeyDown}>
      {!sent && (
        <div className="queued-actions">
          <button type="button" className="icon-button" aria-label={S.queueEdit} title={S.queueEdit} onClick={() => run(editPending(agentId, paneId, pending))}>
            <Edit />
          </button>
          {pending.kind === "queue" && (
            <button type="button" className="icon-button" aria-label={S.queueSendNow} title={S.queueSendNow} onClick={() => run(rpc.call("agents.sendQueuedNow", { agentId, queueId: item.id }))}>
              <Newline />
            </button>
          )}
          <button type="button" className="icon-button" aria-label={cancelLabel} title={cancelLabel} onClick={() => run(cancel(false))}>
            <CloseSmall />
          </button>
        </div>
      )}
      <QueuedBubble agentId={agentId} item={item} />
      {sent && <div className="queued-sent">{S.alreadySent}</div>}
    </div>
  );
}
