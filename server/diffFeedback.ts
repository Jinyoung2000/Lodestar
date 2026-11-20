import { randomUUID } from "node:crypto";
import type { DiffFeedback, QueuedMessage, UserAttachment } from "../shared/protocol";

// DIFFFB: diff 피드백 저장 규칙. 파일이나 셸은 건드리지 않는 순수 계산이라 test/diffFeedback.test.ts 에서 돌린다.

const MAX_TEXT = 20_000;
const MAX_CODE = 100_000;
const MAX_ITEMS = 300;

export type NewFeedback = Omit<DiffFeedback, "id" | "state" | "createdAt">;

function clip(value: unknown, max: number) {
  return typeof value === "string" ? value.slice(0, max) : undefined;
}

function line(value: unknown) {
  return Number.isInteger(value) && (value as number) >= 1 ? (value as number) : null;
}

// 받은 값을 거른다. 글이 비었거나 줄이 정수가 아니면 거절한다.
export function createFeedback(input: NewFeedback, now = new Date()): DiffFeedback {
  const text = clip(input.text, MAX_TEXT)?.trim();
  const startLine = line(input.startLine);
  const endLine = line(input.endLine);
  const startColumn = line(input.startColumn) ?? 1;
  const endColumn = line(input.endColumn) ?? 1;
  const path = clip(input.path, 4096);
  const rel = clip(input.rel, 4096);
  if (!text) throw new Error("Feedback text is empty");
  if (!path || !rel || startLine === null || endLine === null || endLine < startLine) throw new Error("Invalid feedback range");
  const codeSelection = clip(input.codeSelection, MAX_CODE);
  const diffHunks = clip(input.diffHunks, MAX_CODE);
  return {
    id: randomUUID(),
    path,
    rel,
    startLine,
    startColumn,
    endLine,
    endColumn,
    text,
    ...(codeSelection ? { codeSelection } : {}),
    ...(diffHunks ? { diffHunks } : {}),
    state: "accepted",
    createdAt: now.toISOString(),
  };
}

// 쌓인 것은 다 두고, 보낸 것은 오래된 것부터 잘라 전체를 MAX_ITEMS 안에 둔다.
export function trimFeedback(list: DiffFeedback[]): DiffFeedback[] {
  let extra = list.length - MAX_ITEMS;
  if (extra <= 0) return list;
  return list.filter((item) => {
    if (extra > 0 && item.state === "submitted") {
      extra--;
      return false;
    }
    return true;
  });
}

// 보낼 대상: 아직 안 보낸 것 중 ids 에 든 것(ids 가 없으면 전부)
export function pendingFeedback(list: DiffFeedback[], ids?: string[]) {
  return list.filter((item) => item.state === "accepted" && (!ids || ids.includes(item.id)));
}

export function markSubmitted(list: DiffFeedback[], sent: DiffFeedback[]) {
  const ids = new Set(sent.map((s) => s.id));
  return list.map((item) => (ids.has(item.id) ? { ...item, state: "submitted" as const } : item));
}

// 보냈다가 큐에서 빼거나 전송이 실패한 피드백을 다시 쌓인 상태로. 목록에 없으면 다시 넣는다.
export function restageFeedback(list: DiffFeedback[], items: DiffFeedback[]) {
  const ids = new Set(items.map((i) => i.id));
  const known = new Set(list.map((i) => i.id));
  return [...list.map((item) => (ids.has(item.id) ? { ...item, state: "accepted" as const } : item)), ...items.filter((i) => !known.has(i.id)).map((i) => ({ ...i, state: "accepted" as const }))];
}

// 큐와 끼어들기 항목에 실을 화면용 필드. 값이 없는 필드는 만들지 않는다.
export function queuedExtras(shown: { display?: string; attachments?: UserAttachment[]; feedback?: DiffFeedback[] }): Partial<QueuedMessage> {
  return {
    ...(shown.display !== undefined ? { shown: shown.display } : {}),
    ...(shown.attachments?.length ? { attachments: shown.attachments } : {}),
    ...(shown.feedback?.length ? { feedback: shown.feedback } : {}),
  };
}

// 큐 항목을 send 의 옵션으로. 묶인 피드백은 이미 보낸 상태라 다시 싣지 않는다.
export function shownOf(item: QueuedMessage): { display?: string; attachments?: UserAttachment[] } {
  return { ...(item.shown !== undefined ? { display: item.shown } : {}), ...(item.attachments?.length ? { attachments: item.attachments } : {}) };
}
