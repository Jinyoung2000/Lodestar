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

export function httpUrl(path: string, params: Record<string, string> = {}) {
  const search = new URLSearchParams(params).toString();
  return `${location.protocol}//${location.host}${path}${search ? `?${search}` : ""}`;
}

const HELD_UPSERT_MAX_MS = 100;
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
