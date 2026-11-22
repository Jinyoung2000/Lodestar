import type { KeyboardEvent } from "react";
import type { Agent, QueuedMessage } from "../shared/protocol";
import { FeedbackAttachmentChip } from "./DiffFeedbackChips";
import { CloseSmall, Edit, Newline } from "./icons";
import type { PendingRef } from "./pendingMessages";
import { rpc } from "./rpc";
import { flash, setState } from "./store";
import { S } from "./strings";
import { Markdown } from "./Timeline";

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

export function restoreToComposer(paneId: string, text: string) {
  setState((s) => ({ composerPrefill: { ...s.composerPrefill, [paneId]: { text, nonce: Date.now(), append: true } }, focusComposer: { paneId, nonce: Date.now() } }));
}

export async function editPending(agentId: string, paneId: string, pending: PendingRef) {
  const taken = await takePending(agentId, pending);
  if (taken) restoreToComposer(paneId, taken.text);
}

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
