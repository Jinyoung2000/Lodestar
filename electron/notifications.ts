import { app, Notification } from "electron";

export type NotifyPayload = { agentId: string; kind: "response" | "approval"; title: string; body: string; itemId?: string; actionLabel?: string };
export type NotifyAction = { agentId: string; action: "open" | "allow"; itemId?: string };
export type NotifyMode = "route" | "route-and-show";

// AGENT_NAV_NOTIFY_STUB=1 이면 실제 OS 알림을 만들지 않고 인자만 기록한다(검증 창구가 읽는다).
export const NOTIFY_STUB = process.env.AGENT_NAV_NOTIFY_STUB === "1";
// AGENT_NAV_NOTIFY_FOCUSED=1 이면 창이 포커스인 것처럼 OS 알림을 띄우지 않는다(앱 안 토스트 대체 경로 시험용. 창 포커스는 건드리지 않는다).
export const NOTIFY_FOCUSED = process.env.AGENT_NAV_NOTIFY_FOCUSED === "1";
// 시험 알림임을 알 수 있게 제목 앞에 붙일 문구(AGENT_NAV_NOTIFY_PREFIX). 없으면 그대로.
const NOTIFY_PREFIX = process.env.AGENT_NAV_NOTIFY_PREFIX ?? "";

type RealNotification = { agentId: string; title: string; body: string; actions: string[]; events: string[] };
type StubbedNotification = { payload: NotifyPayload; options: { title: string; body: string; silent: boolean; actions: string[] }; bounce: boolean; closed: boolean };

function notificationOptions(payload: NotifyPayload) {
  return { title: payload.title, body: payload.body, silent: true, actions: payload.actionLabel ? [payload.actionLabel] : [] };
}

export function validNotify(value: unknown): value is NotifyPayload {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  const text = (x: unknown, max: number) => typeof x === "string" && x.length <= max;
  return text(v.agentId, 100) && (v.kind === "response" || v.kind === "approval") && text(v.title, 500) && text(v.body, 1000) && (v.itemId === undefined || text(v.itemId, 100)) && (v.actionLabel === undefined || text(v.actionLabel, 50));
}

export class Notifier {
  readonly shown = new Map<string, Notification>();
  // 실제로 띄운 알림의 기록(검증 창구가 읽는다). 받은 이벤트(click, action, close, failed)도 쌓는다.
  readonly realShown: RealNotification[] = [];
  readonly stubbed: StubbedNotification[] = [];

  constructor(private readonly dispatch: (action: NotifyAction, mode: NotifyMode) => Promise<void>) {}

  // 열지 못한 이유는 OS 알림으로 보인다. 창이 하나도 없어도 보이고, 시험 알림 스텁(AGENT_NAV_NOTIFY_STUB)일 때는 띄우지 않고 outcome.notice 에만 남는다.
  showOpenNotice(notice: { title: string; body: string }) {
    if (NOTIFY_STUB || !Notification.isSupported()) return;
    new Notification({ title: `${NOTIFY_PREFIX}${notice.title}`, body: notice.body, silent: true }).show();
  }

  used(payload: NotifyPayload, button: "body" | "action") {
    this.shown.delete(payload.agentId);
    if (button === "action" && payload.itemId) {
      void this.dispatch({ agentId: payload.agentId, action: "allow", itemId: payload.itemId }, "route");
      return;
    }
    void this.dispatch({ agentId: payload.agentId, action: "open" }, "route-and-show");
  }

  show(payload: NotifyPayload) {
    this.clear(payload.agentId);
    const bounce = payload.kind === "approval";
    if (NOTIFY_STUB) {
      this.stubbed.push({ payload, options: notificationOptions(payload), bounce, closed: false });
      return true;
    }
    if (!Notification.isSupported()) return false;
    const title = `${NOTIFY_PREFIX}${payload.title}`;
    const notification = new Notification({ title, body: payload.body, silent: true, ...(payload.actionLabel ? { actions: [{ type: "button", text: payload.actionLabel }] } : {}) });
    const record: RealNotification = { agentId: payload.agentId, title, body: payload.body, actions: payload.actionLabel ? [payload.actionLabel] : [], events: [] };
    this.realShown.push(record);
    notification.on("show", () => record.events.push("show"));
    notification.on("failed", (_event, error) => record.events.push(`failed: ${error}`));
    notification.on("click", () => {
      record.events.push("click");
      this.used(payload, "body");
    });
    notification.on("action", () => {
      record.events.push("action");
      this.used(payload, "action");
    });
    notification.on("close", () => {
      record.events.push("close");
      if (this.shown.get(payload.agentId) === notification) this.shown.delete(payload.agentId);
    });
    this.shown.set(payload.agentId, notification);
    notification.show();
    if (bounce) app.dock?.bounce("informational");
    return true;
  }

  clear(agentId: string) {
    this.shown.get(agentId)?.close();
    this.shown.delete(agentId);
    for (const entry of this.stubbed) if (entry.payload.agentId === agentId) entry.closed = true;
  }
}
