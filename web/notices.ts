import { useSyncExternalStore } from "react";


export type NoticeSeverity = "info" | "warning" | "error";
export type NoticeAction = { label: string; run: () => void; primary?: boolean; keepOpen?: boolean; disabled?: boolean };
export type Notice = { id: number; key: string; severity: NoticeSeverity; message: string; detail: string | null; actions: NoticeAction[] };

export type NoticeInput = {
  message: string;
  severity?: NoticeSeverity;
  detail?: string;
  actions?: NoticeAction[];
  key?: string;
  autoHideMs?: number | null;
};

export const HIDE_MS: Record<NoticeSeverity, number> = { info: 10_000, warning: 12_000, error: 15_000 };

export function isStickyNotice(severity: NoticeSeverity, actionCount: number) {
  return severity === "error" && actionCount > 0;
}

export function defaultHideMs(severity: NoticeSeverity, actionCount: number) {
  return isStickyNotice(severity, actionCount) ? null : HIDE_MS[severity];
}
const MAX_VISIBLE = 4;

let notices: Notice[] = [];
let nextId = 1;
const timers = new Map<number, ReturnType<typeof setTimeout>>();
const hideMs = new Map<number, number>();
const listeners = new Set<() => void>();

function emit(next: Notice[]) {
  notices = next;
  for (const listener of listeners) listener();
}

export function notify(input: NoticeInput): number {
  const actions = input.actions ?? [];
  const key = input.key ?? input.message;
  const previous = notices.find((n) => n.key === key);
  if (previous) dismissNotice(previous.id);
  const notice: Notice = { id: nextId++, key, severity: input.severity ?? "info", message: input.message, detail: input.detail ?? null, actions };
  const kept = [...notices, notice];
  for (const old of kept.slice(0, Math.max(0, kept.length - MAX_VISIBLE))) forget(old.id);
  emit(kept.slice(-MAX_VISIBLE));
  const hide = input.autoHideMs === undefined ? defaultHideMs(notice.severity, actions.length) : input.autoHideMs;
  if (hide !== null) {
    hideMs.set(notice.id, hide);
    startTimer(notice.id);
  }
  return notice.id;
}

export function holdNotice(id: number, held: boolean) {
  if (!hideMs.has(id)) return;
  if (held) clearTimer(id);
  else startTimer(id);
}

function startTimer(id: number) {
  clearTimer(id);
  timers.set(id, setTimeout(() => dismissNotice(id), hideMs.get(id) ?? HIDE_MS.info));
}

export function dismissNotice(id: number) {
  forget(id);
  if (notices.some((n) => n.id === id)) emit(notices.filter((n) => n.id !== id));
}

function clearTimer(id: number) {
  const timer = timers.get(id);
  if (timer) clearTimeout(timer);
  timers.delete(id);
}

function forget(id: number) {
  clearTimer(id);
  hideMs.delete(id);
}

export function useNotices(): Notice[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => notices,
  );
}

export function currentNotices(): Notice[] {
  return notices;
}
