import type { MobileBrowseResult, MobileMethod, MobileModelCatalog, MobileModelSelection, MobilePreview, MobileReady, MobileSessionRequest } from "@shared/mobile";
import type { Agent, Harness, RpcMethods, ServerEvent } from "@shared/protocol";
import { reconnectDelay } from "../logic/backoff";
import { hasMixedRoutes, routeAddress, routesFromAddress, routeSocketUrl, type ConnectionRoute } from "../logic/routes";
import { routeHandshake } from "./routeAuth";
import type { UploadTarget } from "./upload";

type RoutedEndpoint = { routes: ConnectionRoute[]; token: string; deviceId?: string };
type LegacyEndpoint = { hosts: string[]; port: number; secure?: boolean; token: string };
export type Endpoint = RoutedEndpoint | LegacyEndpoint;
export type ConnStatus = "idle" | "connecting" | "online" | "offline" | "unauthorized";

export type { MobileMethod };

type MobileOnly = {
  "agents.create": { params: MobileSessionRequest; result: Agent };
  "mobile.createSession": { params: MobileSessionRequest & { selection: MobileModelSelection }; result: Agent };
  "mobile.models": { params: { agentId?: string; harness?: Harness; switchOnly?: boolean }; result: MobileModelCatalog };
  "mobile.setModel": { params: { agentId: string; selection: MobileModelSelection }; result: MobileModelSelection };
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
  onclose: ((event: { code?: number; reason?: string }) => void) | null;
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

export class TransportError extends Error {}

export class RpcClient {
  status: ConnStatus = "idle";
  route: ConnectionRoute | null = null;
  rttMs: number | null = null;
  private endpoint: RoutedEndpoint | null = null;
  private socket: SocketLike | null = null;
  private openingSocket: SocketLike | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pingProbe: { id: number; result: Promise<number | undefined> } | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private wanted = false;
  private foreground = true;
  private generation = 0;
  private eventListeners = new Set<(event: ServerEvent) => void>();
  private statusListeners = new Set<(status: ConnStatus) => void>();
  private readyListeners = new Set<(ready: MobileReady) => void>();

  constructor(private opts: RpcOptions = {}) {}

  get host() {
    return this.route?.host ?? null;
  }

  imageUploadTarget(): UploadTarget | null {
    if (this.status !== "online" || !this.route || !this.endpoint) return null;
    const { routes, token } = this.endpoint;
    const route = this.route.secure ? this.route : routes.find((candidate) => candidate.secure) ?? this.route;
    return { ...route, token };
  }

  configure(endpoint: Endpoint | null) {
    this.endpoint = endpoint && ("routes" in endpoint ? endpoint : { routes: routesFromAddress(endpoint), token: endpoint.token });
    this.teardown();
    this.attempt = 0;
    if (!this.endpoint?.routes.length) {
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

  pause() {
    this.foreground = false;
    this.stopPing();
  }

  resume() {
    this.foreground = true;
    if (!this.wanted || !this.endpoint) return;
    if (this.status === "online") {
      this.startPing();
      return this.checkPing();
    }
    if (this.status === "unauthorized") return;
    this.attempt = 0;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.setStatus("connecting");
    if (!this.openingSocket) this.open();
  }

  call<M extends MobileMethod>(method: M, params: MobileRpc[M]["params"], timeoutMs = 15_000): Promise<MobileRpc[M]["result"]> {
    const socket = this.socket;
    if (!socket || socket.readyState !== OPEN || this.status !== "online") return Promise.reject(new TransportError("Not connected to your Mac"));
    return this.request(socket, method, params, timeoutMs).reply;
  }

  private request<M extends MobileMethod>(socket: SocketLike, method: M, params: MobileRpc[M]["params"], timeoutMs: number) {
    const id = this.nextId++;
    const started = Date.now();
    const done = this.opts.onCall;
    const reply = new Promise<MobileRpc[M]["result"]>((resolve, reject) => {
      const timer = setTimeout(() => this.rejectRequest(id, new TransportError("The Mac did not answer in time")), timeoutMs);
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
      try {
        socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        this.rejectRequest(id, new TransportError(error instanceof Error ? error.message : String(error)));
      }
    });
    return { id, reply };
  }

  private rejectRequest(id: number, error: Error) {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.reject(error);
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
    const { routes, deviceId, token } = endpoint;
    const mixedRoutes = hasMixedRoutes(routes);
    let index = 0;
    let rejected = 0;
    const next = (badToken = false) => {
      if (generation !== this.generation || this.socket) return;
      this.clearOpeningSocket();
      if (badToken) rejected++;
      const route = routes[index++];
      if (!route) {
        if (rejected === routes.length) this.unauthorized();
        else this.failAttempt(generation);
        return;
      }
      const verifyRoute = mixedRoutes && !route.secure;
      if (verifyRoute && !deviceId) return next();
      const handshake = verifyRoute && deviceId ? routeHandshake(deviceId, token) : null;
      const connectTimeout = this.opts.connectTimeoutMs ?? (route.secure ? 15_000 : 6000);
      const fallbackTimeout = !route.secure && index < routes.length ? this.opts.hostStaggerMs ?? 1500 : connectTimeout;
      this.connectTimer = setTimeout(next, Math.min(connectTimeout, fallbackTimeout));
      this.candidate(route, token, handshake, next);
    };
    next();
  }

  private candidate(route: ConnectionRoute, token: string, handshake: ReturnType<typeof routeHandshake> | null, next: (badToken?: boolean) => void) {
    const address = routeAddress(route);
    let socket: SocketLike;
    try {
      socket = this.makeSocket(routeSocketUrl(route));
    } catch (error) {
      this.opts.log?.(`[rpc] could not open ${address}: ${String(error)}`);
      next();
      return;
    }
    this.openingSocket = socket;
    let authSent = false;
    const send = (data: object) => {
      try {
        socket.send(JSON.stringify(data));
      } catch {
        next();
      }
    };
    socket.onopen = () => {
      if (socket !== this.openingSocket) return;
      authSent = handshake === null;
      send(handshake?.request ?? { auth: token });
    };
    socket.onmessage = (message) => {
      if (socket !== this.openingSocket && socket !== this.socket) return;
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(String(message.data)) as Record<string, unknown>;
      } catch {
        return;
      }
      if (!data || typeof data !== "object") return;
      if (socket === this.openingSocket) {
        if (!authSent) {
          const auth = handshake?.verify(data);
          if (!auth) {
            this.opts.log?.(`[rpc] route proof rejected ${address}`);
            next();
            return;
          }
          authSent = true;
          send(auth);
          return;
        }
        if (!("ready" in data)) return;
        this.adopt(socket, route);
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
    socket.onerror = (event) => this.opts.log?.(`[rpc] socket error ${address} ${String((event as { message?: string })?.message ?? "")}`);
    socket.onclose = (event) => {
      this.opts.log?.(`[rpc] socket closed ${address} code=${event.code} ${event.reason ?? ""}`);
      const rejected = event.code === 4001 || (event.code === 4401 && event.reason === "bad token");
      if (socket === this.socket) {
        if (rejected) this.unauthorized();
        else this.lost();
      } else if (socket === this.openingSocket) {
        next(rejected && authSent);
      }
    };
  }

  private unauthorized() {
    this.teardown();
    this.wanted = false;
    this.setStatus("unauthorized");
  }

  private adopt(socket: SocketLike, route: ConnectionRoute) {
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = null;
    this.openingSocket = null;
    this.socket = socket;
    this.route = route;
    this.attempt = 0;
    this.setStatus("online");
    this.startPing();
  }

  private startPing() {
    if (!this.foreground || this.pingTimer) return;
    this.pingTimer = setInterval(() => void this.checkPing(), this.opts.pingIntervalMs ?? 10_000);
  }

  private checkPing() {
    const socket = this.socket;
    if (!this.foreground || !socket) return;
    if (this.pingProbe) return this.pingProbe.result;
    const started = Date.now();
    const { id, reply } = this.request(socket, "mobile.ping", {}, this.opts.pingTimeoutMs ?? 4000);
    const result = reply.then(() => {
      if (this.pingProbe?.id !== id) return;
      this.pingProbe = null;
      this.rttMs = Date.now() - started;
      return this.rttMs;
    }, (error: Error): undefined => {
      if (this.pingProbe?.id !== id || socket !== this.socket) return;
      this.pingProbe = null;
      this.opts.log?.(`[rpc] connection check failed ${this.host ?? ""}: ${error.message}`);
      this.lost();
    });
    this.pingProbe = { id, result };
    return result;
  }

  private stopPing() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    const probe = this.pingProbe;
    this.pingProbe = null;
    if (probe) this.rejectRequest(probe.id, new Error("Connection check canceled"));
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
    this.stopPing();
    this.clearOpeningSocket();
    if (this.socket) this.closeSocket(this.socket);
    this.socket = null;
    this.route = null;
    this.rttMs = null;
  }

  private clearOpeningSocket() {
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = null;
    if (this.openingSocket) this.closeSocket(this.openingSocket);
    this.openingSocket = null;
  }

  private closeSocket(socket: SocketLike) {
    socket.onopen = null;
    socket.onclose = null;
    socket.onmessage = null;
    socket.onerror = null;
    try {
      socket.close();
    } catch {
    }
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
      pending.reject(new TransportError("Disconnected from your Mac"));
    }
    this.pending.clear();
  }
}
