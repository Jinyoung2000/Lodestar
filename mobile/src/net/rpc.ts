import type { MobileBrowseResult, MobileMethod, MobilePreview, MobileReady, MobileWorktreeRequest } from "@shared/mobile";
import type { Agent, ImageRef, RpcMethods, ServerEvent } from "@shared/protocol";
import { reconnectDelay } from "../logic/backoff";

export type Endpoint = { hosts: string[]; port: number; secure?: boolean; token: string };
export type ConnStatus = "idle" | "connecting" | "online" | "offline" | "unauthorized";

export type { MobileMethod };

type MobileOnly = {
  "agents.create": { params: { workspaceId: string | null; prompt: string; images?: ImageRef[]; worktree?: MobileWorktreeRequest }; result: Agent };
  "mobile.preview": { params: { agentId: string; itemId: string; target: string }; result: MobilePreview };
  "mobile.browse": { params: { path?: string }; result: MobileBrowseResult };
};
type MobileRpc = { [M in MobileMethod]: M extends keyof MobileOnly ? MobileOnly[M] : M extends keyof RpcMethods ? RpcMethods[M] : never };

type SocketLike = {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code?: number }) => void) | null;
  onerror: ((event: unknown) => void) | null;
};

export type RpcOptions = {
  socket?: (url: string) => SocketLike;
  pingIntervalMs?: number;
  pingTimeoutMs?: number;
  connectTimeoutMs?: number;
  hostStaggerMs?: number;
  backoff?: (attempt: number) => number;
  log?: (line: string) => void;
  onCall?: (method: string, ms: number, ok: boolean) => void;
};

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

const OPEN = 1;

export class RpcClient {
  status: ConnStatus = "idle";
  host: string | null = null;
  rttMs: number | null = null;
  private endpoint: Endpoint | null = null;
  private socket: SocketLike | null = null;
  private candidates: SocketLike[] = [];
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private attempt = 0;
  private lastGoodHost: string | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private wanted = false;
  private startNextHost: (() => boolean) | null = null;
  private generation = 0;
  private eventListeners = new Set<(event: ServerEvent) => void>();
  private statusListeners = new Set<(status: ConnStatus) => void>();
  private readyListeners = new Set<(ready: MobileReady) => void>();

  constructor(private opts: RpcOptions = {}) {}

  configure(endpoint: Endpoint | null) {
    this.endpoint = endpoint;
    this.lastGoodHost = null;
    this.teardown();
    this.attempt = 0;
    if (!endpoint) {
      this.wanted = false;
      this.setStatus("idle");
      return;
    }
    this.wanted = true;
    this.open();
  }

  stop() {
    this.wanted = false;
    this.teardown();
    this.setStatus("idle");
  }

  resume() {
    if (!this.wanted || !this.endpoint) return;
    if (this.status === "online") {
      void this.call("mobile.ping", {}, this.opts.pingTimeoutMs ?? 1500).catch(() => this.dropAndReconnect());
      return;
    }
    if (this.status === "unauthorized") return;
    this.attempt = 0;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.setStatus("connecting");
    if (this.candidates.length === 0) this.open();
  }

  call<M extends MobileMethod>(method: M, params: MobileRpc[M]["params"], timeoutMs = 15_000): Promise<MobileRpc[M]["result"]> {
    const socket = this.socket;
    if (!socket || socket.readyState !== OPEN || this.status !== "online") return Promise.reject(new Error("Not connected to your Mac"));
    const id = this.nextId++;
    const started = Date.now();
    const done = this.opts.onCall;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("The Mac did not answer in time"));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          done?.(method, Date.now() - started, true);
          resolve(value as never);
        },
        reject: (error) => {
          done?.(method, Date.now() - started, false);
          reject(error);
        },
        timer,
      });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }

  onEvent(listener: (event: ServerEvent) => void) {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onStatus(listener: (status: ConnStatus) => void) {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  onReady(listener: (ready: MobileReady) => void) {
    this.readyListeners.add(listener);
    return () => this.readyListeners.delete(listener);
  }

  private setStatus(status: ConnStatus) {
    if (this.status === status) return;
    this.status = status;
    for (const listener of this.statusListeners) listener(status);
  }

  private makeSocket(url: string): SocketLike {
    return this.opts.socket ? this.opts.socket(url) : (new (globalThis as unknown as { WebSocket: new (url: string) => SocketLike }).WebSocket(url) as SocketLike);
  }

  private open() {
    const endpoint = this.endpoint;
    if (!endpoint || !this.wanted) return;
    const generation = ++this.generation;
    if (this.status !== "offline") this.setStatus("connecting");
    const hosts = [...endpoint.hosts].sort((a, b) => Number(b === this.lastGoodHost) - Number(a === this.lastGoodHost));
    let next = 0;
    const startNext = () => {
      if (generation !== this.generation || this.socket || next >= hosts.length) return false;
      this.candidate(generation, hosts[next++], endpoint);
      return true;
    };
    this.startNextHost = startNext;
    startNext();
    const stagger = this.opts.hostStaggerMs ?? 350;
    const staggered = () => {
      if (generation !== this.generation || this.socket) return;
      if (startNext()) setTimeout(staggered, stagger);
    };
    if (hosts.length > 1) setTimeout(staggered, stagger);
    this.connectTimer = setTimeout(() => {
      if (generation === this.generation && !this.socket) this.failAttempt(generation);
    }, this.opts.connectTimeoutMs ?? 6000);
  }

  private candidate(generation: number, host: string, endpoint: Endpoint) {
    let socket: SocketLike;
    try {
      const authority = host.includes(":") ? `[${host}]` : host;
      const port = endpoint.secure && endpoint.port === 443 ? "" : `:${endpoint.port}`;
      socket = this.makeSocket(`${endpoint.secure ? "wss" : "ws"}://${authority}${port}/mobile/ws`);
    } catch {
      this.afterCandidateClosed(generation);
      return;
    }
    this.candidates.push(socket);
    socket.onopen = () => {
      if (generation !== this.generation) return socket.close();
      socket.send(JSON.stringify({ auth: endpoint.token }));
    };
    socket.onmessage = (message) => {
      if (generation !== this.generation) return;
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(String(message.data)) as Record<string, unknown>;
      } catch {
        return;
      }
      if (!data || typeof data !== "object") return;
      if (!this.socket) {
        if (!("ready" in data)) return;
        this.adopt(socket, host);
        for (const listener of this.readyListeners) listener(data.ready as MobileReady);
        return;
      }
      if (socket !== this.socket) return;
      if ("event" in data) {
        for (const listener of this.eventListeners) listener(data.event as ServerEvent);
        return;
      }
      const id = typeof data.id === "number" ? data.id : -1;
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      if (typeof data.error === "string") pending.reject(new Error(data.error));
      else pending.resolve(data.result);
    };
    socket.onerror = (event) => this.opts.log?.(`[rpc] socket error ${host} ${String((event as { message?: string })?.message ?? "")}`);
    socket.onclose = (event) => {
      this.opts.log?.(`[rpc] socket closed ${host} code=${event.code}`);
      this.candidates = this.candidates.filter((c) => c !== socket);
      if (generation !== this.generation) return;
      if (event.code === 4401 || event.code === 4001) {
        this.teardown();
        this.wanted = false;
        this.setStatus("unauthorized");
        return;
      }
      if (socket === this.socket) this.lost();
      else this.afterCandidateClosed(generation);
    };
  }

  private afterCandidateClosed(generation: number) {
    if (generation !== this.generation || this.socket) return;
    if (this.startNextHost?.()) return;
    if (this.candidates.length === 0) this.failAttempt(generation);
  }

  private adopt(socket: SocketLike, host: string) {
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = null;
    this.socket = socket;
    this.host = host;
    this.lastGoodHost = host;
    this.attempt = 0;
    for (const other of this.candidates) if (other !== socket) other.close();
    this.candidates = [socket];
    this.setStatus("online");
    this.startPing();
  }

  private startPing() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      const started = Date.now();
      void this.call("mobile.ping", {}, this.opts.pingTimeoutMs ?? 4000).then(() => (this.rttMs = Date.now() - started)).catch(() => this.dropAndReconnect());
    }, this.opts.pingIntervalMs ?? 10_000);
  }

  private dropAndReconnect() {
    if (!this.socket) return;
    const socket = this.socket;
    this.lost();
    socket.close();
  }

  private lost() {
    this.teardownSocket();
    this.rejectPending();
    this.setStatus("offline");
    this.schedule();
  }

  private failAttempt(generation: number) {
    if (generation !== this.generation) return;
    this.teardownSocket();
    this.setStatus("offline");
    this.schedule();
  }

  private schedule() {
    if (!this.wanted || this.reconnectTimer) return;
    const delay = (this.opts.backoff ?? reconnectDelay)(this.attempt++);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay);
  }

  private teardownSocket() {
    this.generation++;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = null;
    const sockets = new Set([...this.candidates, ...(this.socket ? [this.socket] : [])]);
    this.socket = null;
    this.candidates = [];
    for (const socket of sockets) {
      socket.onclose = null;
      socket.onmessage = null;
      socket.onerror = null;
      try {
        socket.close();
      } catch {
      }
    }
    this.host = null;
  }

  private teardown() {
    this.teardownSocket();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.rejectPending();
  }

  private rejectPending() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Disconnected from your Mac"));
    }
    this.pending.clear();
  }
}
