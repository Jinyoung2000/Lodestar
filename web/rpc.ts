import type { RpcMethod, RpcMethods, ServerEvent, ServerMessage } from "../shared/protocol";
import { S } from "./strings";
import { frameAfterGap, UpsertHold } from "./upsertHold";

export const TOKEN =
  document.querySelector<HTMLMetaElement>('meta[name="agent-nav-token"]')?.content ?? "";

export function wsUrl(path: string, params: Record<string, string> = {}) {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const search = new URLSearchParams({ ...params, token: TOKEN });
  return `${protocol}//${location.host}${path}?${search}`;
}

// FILEATTACH: 같은 출처의 데몬 HTTP 주소. 업로드 폴백(POST /attachments)이 쓴다.
export function httpUrl(path: string, params: Record<string, string> = {}) {
  const search = new URLSearchParams(params).toString();
  return `${location.protocol}//${location.host}${path}${search ? `?${search}` : ""}`;
}

const HELD_UPSERT_MAX_MS = 100;
// 응답이 흐를 때 같은 대화를 다시 그리는 간격의 하한. 응답 글은 초당 최대 20번 갱신된다.
const HELD_UPSERT_MIN_GAP_MS = 50;

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

class RpcClient {
  private socket: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private queue: string[] = [];
  private eventListeners = new Set<(event: ServerEvent) => void>();
  private statusListeners = new Set<(connected: boolean) => void>();

  connect() {
    const socket = new WebSocket(wsUrl("/ws/rpc"));
    this.socket = socket;
    socket.onopen = () => {
      for (const text of this.queue.splice(0)) socket.send(text);
      for (const listener of this.statusListeners) listener(true);
    };
    socket.onmessage = (message) => {
      const data = JSON.parse(String(message.data)) as ServerMessage;
      if ("event" in data) {
        if (data.event.type === "timelineUpsert") {
          this.holdUpsert(data.event);
          return;
        }
        this.releaseUpserts();
        this.dispatch(data.event);
        return;
      }
      // 응답이 앞선 이벤트보다 먼저 처리되지 않게, 쥐고 있던 항목 갱신을 먼저 내보낸다
      this.releaseUpserts();
      const pending = this.pending.get(data.id);
      if (!pending) return;
      this.pending.delete(data.id);
      if ("error" in data) pending.reject(new Error(data.error));
      else pending.resolve(data.result);
    };
    socket.onclose = () => {
      this.releaseUpserts();
      for (const listener of this.statusListeners) listener(false);
      for (const pending of this.pending.values()) pending.reject(new Error(S.daemonDisconnected));
      this.pending.clear();
      // 실패로 알린 요청을 다음 연결에서 보내지 않는다. 보내면 실패로 보고 다시 보낸 메시지가 두 번 간다.
      this.queue = [];
      setTimeout(() => this.connect(), 1000);
    };
  }

  call<M extends RpcMethod>(method: M, params: RpcMethods[M]["params"]): Promise<RpcMethods[M]["result"]> {
    const id = this.nextId++;
    const text = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(text);
      else this.queue.push(text);
    });
  }

  private dispatch(event: ServerEvent) {
    for (const listener of this.eventListeners) listener(event);
  }

  // 같은 항목의 timelineUpsert 는 한 프레임에 마지막 것만 내보낸다(web/upsertHold.ts).
  private upserts = new UpsertHold<string, Extract<ServerEvent, { type: "timelineUpsert" }>>((events) => {
    for (const event of events) this.dispatch(event);
  }, frameAfterGap(HELD_UPSERT_MIN_GAP_MS, HELD_UPSERT_MAX_MS));

  private holdUpsert(event: Extract<ServerEvent, { type: "timelineUpsert" }>) {
    this.upserts.hold(`${event.agentId}\u0000${event.item.id}`, event);
  }

  private releaseUpserts() {
    this.upserts.release();
  }

  onEvent(listener: (event: ServerEvent) => void) {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onStatus(listener: (connected: boolean) => void) {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }
}

export const rpc = new RpcClient();
