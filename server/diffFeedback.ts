import { randomUUID } from "node:crypto";
import type { DiffFeedback, QueuedMessage, UserAttachment } from "../shared/protocol";

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

export function pendingFeedback(list: DiffFeedback[], ids?: string[]) {
  return list.filter((item) => item.state === "accepted" && (!ids || ids.includes(item.id)));
}

export function markSubmitted(list: DiffFeedback[], sent: DiffFeedback[]) {
  const ids = new Set(sent.map((s) => s.id));
  return list.map((item) => (ids.has(item.id) ? { ...item, state: "submitted" as const } : item));
}

export function restageFeedback(list: DiffFeedback[], items: DiffFeedback[]) {
  const ids = new Set(items.map((i) => i.id));
  const known = new Set(list.map((i) => i.id));
  return [...list.map((item) => (ids.has(item.id) ? { ...item, state: "accepted" as const } : item)), ...items.filter((i) => !known.has(i.id)).map((i) => ({ ...i, state: "accepted" as const }))];
}

export function queuedExtras(shown: { display?: string; attachments?: UserAttachment[]; feedback?: DiffFeedback[] }): Partial<QueuedMessage> {
  return {
    ...(shown.display !== undefined ? { shown: shown.display } : {}),
    ...(shown.attachments?.length ? { attachments: shown.attachments } : {}),
    ...(shown.feedback?.length ? { feedback: shown.feedback } : {}),
  };
}

export function shownOf(item: QueuedMessage): { display?: string; attachments?: UserAttachment[] } {
  return { ...(item.shown !== undefined ? { display: item.shown } : {}), ...(item.attachments?.length ? { attachments: item.attachments } : {}) };
}
