import { useSyncExternalStore } from "react";


export type NoticeSeverity = "info" | "warning" | "error";
// keepOpen 이면 누른 뒤에도 알림이 남는다(보통은 버튼을 누르면 닫힌다)
export type NoticeAction = { label: string; run: () => void; primary?: boolean; keepOpen?: boolean; disabled?: boolean };
export type Notice = { id: number; key: string; severity: NoticeSeverity; message: string; detail: string | null; actions: NoticeAction[] };

export type NoticeInput = {
  message: string;
  severity?: NoticeSeverity;
  // 메시지 아래 흐린 글씨로 붙는 이유 한 줄
  detail?: string;
  actions?: NoticeAction[];
  // 같은 key 의 알림은 쌓이지 않고 바뀐다
  key?: string;
  // 사라지는 시간. 기본은 심각도별 HIDE_MS(sticky 면 안 사라짐). null 이면 안 사라진다.
  autoHideMs?: number | null;
};

export const HIDE_MS: Record<NoticeSeverity, number> = { info: 10_000, warning: 12_000, error: 15_000 };

export function isStickyNotice(severity: NoticeSeverity, actionCount: number) {
  return severity === "error" && actionCount > 0;
}

// 이 알림이 저절로 사라질 때까지의 ms. sticky 면 null.
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
  // 너무 많이 쌓이면 가장 오래된 것부터 치운다
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

// 시험과 화면 확인용: 지금 쌓인 알림
export function currentNotices(): Notice[] {
  return notices;
}
