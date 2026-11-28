import type { MobileCodexDefaults, MobileDefaults, MobileCustomProvider, MobileBrowseResult, PhoneFeedbackRequest, MobileMethod, MobileModelCatalog, MobileModelSelection, MobilePreview, MobileReady, MobileSessionRequest, MobileWalkthrough } from "@shared/mobile";
import type { Agent, Harness, RpcMethods, ServerEvent } from "@shared/protocol";
import { reconnectDelay } from "../logic/backoff";
import { hasMixedRoutes, routeAddress, routeLabel, routesFromAddress, routeSocketUrl, type ConnectionRoute } from "../logic/routes";
import { relayHost, RelaySocket, type RelayEndpoint, type RelaySocketFactory } from "./relay";
import { routeHandshake } from "./routeAuth";
import { isRelayTarget, type UploadTarget } from "./upload";

type RoutedEndpoint = { routes: ConnectionRoute[]; token: string; deviceId?: string; relay?: RelayEndpoint };
type LegacyEndpoint = { hosts: string[]; port: number; secure?: boolean; token: string };
export type Endpoint = RoutedEndpoint | LegacyEndpoint;
export type ConnStatus = "idle" | "connecting" | "online" | "offline" | "unauthorized";
export type ConnFailure = "mac-off-relay" | "relay-silent" | "mac-silent";

const RELAY_MAC_OFFLINE = 4404;

export type { MobileMethod };

type MobileOnly = {
  "mobile.defaults": { params: Record<string, never>; result: MobileDefaults };
  "mobile.setCodexDefaults": { params: Partial<MobileCodexDefaults>; result: MobileCodexDefaults };
  "agents.create": { params: MobileSessionRequest; result: Agent };
  "mobile.createSession": { params: MobileSessionRequest & { selection: MobileModelSelection }; result: Agent };
  "mobile.models": { params: { agentId?: string; harness?: Harness; switchOnly?: boolean; providerId?: string }; result: MobileModelCatalog };
  "mobile.providers": { params: Record<string, never>; result: MobileCustomProvider[] };
  "mobile.setModel": { params: { agentId: string; selection: MobileModelSelection }; result: MobileModelSelection };
  "mobile.preview": { params: { agentId: string; itemId: string; target: string; thumb?: boolean; edge?: number }; result: MobilePreview };
  "mobile.walkthrough": { params: { agentId: string; itemId: string; source: string }; result: MobileWalkthrough };
  "mobile.browse": { params: { path?: string }; result: MobileBrowseResult };
  "mobile.feedback": { params: PhoneFeedbackRequest; result: Agent };
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
  relaySocket?: RelaySocketFactory;
  relayPingIntervalMs?: number;
  relayHeadStartMs?: number;
  pingIntervalMs?: number;
  pingTimeoutMs?: number;
  connectTimeoutMs?: number;
  backoff?: (attempt: number) => number;
  log?: (line: string) => void;
  onCall?: (method: string, ms: number, ok: boolean, error?: unknown) => void;
};

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

const OPEN = 1;

export class TransportError extends Error {}

export class RpcClient {
  status: ConnStatus = "idle";
  route: ConnectionRoute | null = null;
  rttMs: number | null = null;
  failure: ConnFailure | null = null;
  private endpoint: RoutedEndpoint | null = null;
  private socket: SocketLike | null = null;
  private opening = new Set<SocketLike>();
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pingProbe: { id: number; result: Promise<number | undefined> } | null = null;
  private connectTimers = new Set<ReturnType<typeof setTimeout>>();
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
    const { routes, token, relay } = this.endpoint;
    if (this.route.relay) return relay ? { relay, token } : null;
    const route = this.route.secure ? this.route : routes.find((candidate) => candidate.secure) ?? this.route;
    return { ...route, token };
  }

  get viaRelay() {
    return this.route?.relay === true;
  }

  hostUrl(path: string): string | null {
    const target = this.imageUploadTarget();
    return target && !isRelayTarget(target) ? `${routeAddress(target)}${path}` : null;
  }

  private candidates(endpoint: RoutedEndpoint): ConnectionRoute[] {
    const direct = endpoint.routes.filter((route) => !route.relay);
    return endpoint.relay ? [...direct, { host: relayHost(endpoint.relay), port: 443, secure: true, relay: true }] : direct;
  }

  configure(endpoint: Endpoint | null) {
    this.endpoint = endpoint && ("routes" in endpoint ? endpoint : { routes: routesFromAddress(endpoint), token: endpoint.token });
    this.teardown();
    this.attempt = 0;
    if (!this.endpoint?.routes.length && !this.endpoint?.relay) {
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
    if (!this.opening.size && !this.connectTimers.size) this.open();
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
      const timer = setTimeout(() => {
        this.rejectRequest(id, new TransportError("The Mac did not answer in time"));
        if (method !== "mobile.ping" && socket === this.socket) void this.checkPing();
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          done?.(method, Date.now() - started, true);
          resolve(value as never);
        },
        reject: (error) => {
          done?.(method, Date.now() - started, false, error);
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
    const { deviceId, token } = endpoint;
    const routes = this.candidates(endpoint);
    const mixedRoutes = hasMixedRoutes(routes);
    const direct = routes.filter((route) => !route.relay);
    const relayed = routes.filter((route) => route.relay);
    const live = () => generation === this.generation && !this.socket;
    let rejected = 0;
    let running = 0;
    let relayStarted = false;
    let relayFailure: ConnFailure = "relay-silent";
    const startRelay = () => {
      if (relayStarted || !live()) return;
      relayStarted = true;
      for (const route of relayed) tryRoute(route);
    };
    const tryRoute = (route: ConnectionRoute) => {
      const verifyRoute = mixedRoutes && !route.secure;
      if (verifyRoute && !deviceId) return;
      running++;
      let socket: SocketLike | null = null;
      let ended = false;
      const end = (badToken = false, closeCode?: number) => {
        if (ended || !live()) return;
        ended = true;
        this.disarm(timer);
        if (socket) this.dropOpening(socket);
        if (badToken) rejected++;
        if (route.relay && closeCode === RELAY_MAC_OFFLINE) relayFailure = "mac-off-relay";
        running--;
        startRelay();
        if (running > 0) return;
        if (rejected === routes.length) return this.unauthorized();
        this.failure = relayed.length ? relayFailure : "mac-silent";
        this.failAttempt(generation);
      };
      const timer = this.arm(() => end(), this.opts.connectTimeoutMs ?? (route.secure ? 15_000 : 6000));
      socket = this.candidate(route, token, verifyRoute && deviceId ? routeHandshake(deviceId, token) : null, end);
      if (!socket) end();
    };
    for (const route of direct) tryRoute(route);
    if (!live()) return;
    if (!running) startRelay();
    else if (relayed.length) this.arm(startRelay, this.opts.relayHeadStartMs ?? 400);
    if (running || !live()) return;
    this.failure = "mac-silent";
    this.failAttempt(generation);
  }

  private candidate(route: ConnectionRoute, token: string, handshake: ReturnType<typeof routeHandshake> | null, next: (badToken?: boolean, closeCode?: number) => void): SocketLike | null {
    const address = routeLabel(route);
    const relay = this.endpoint?.relay;
    let socket: SocketLike;
    try {
      socket = route.relay && relay ? new RelaySocket(relay, this.opts.relaySocket) : this.makeSocket(routeSocketUrl(route));
    } catch (error) {
      this.opts.log?.(`[rpc] could not open ${address}: ${String(error)}`);
      return null;
    }
    this.opening.add(socket);
    let authSent = false;
    const send = (data: object) => {
      try {
        socket.send(JSON.stringify(data));
      } catch {
        next();
      }
    };
    socket.onopen = () => {
      if (!this.opening.has(socket)) return;
      authSent = handshake === null;
      send(handshake?.request ?? { auth: token });
    };
    socket.onmessage = (message) => {
      if (!this.opening.has(socket) && socket !== this.socket) return;
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(String(message.data)) as Record<string, unknown>;
      } catch {
        return;
      }
      if (!data || typeof data !== "object") return;
      if (this.opening.has(socket)) {
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
      } else if (this.opening.has(socket)) {
        next(rejected && (authSent || route.relay === true), event.code);
      }
    };
    return socket;
  }

  private unauthorized() {
    this.teardown();
    this.wanted = false;
    this.setStatus("unauthorized");
  }

  private adopt(socket: SocketLike, route: ConnectionRoute) {
    this.opening.delete(socket);
    this.clearOpening();
    this.socket = socket;
    this.route = route;
    this.attempt = 0;
    this.failure = null;
    this.setStatus("online");
    this.startPing();
  }

  private startPing() {
    if (!this.foreground || this.pingTimer) return;
    const interval = this.route?.relay ? this.opts.relayPingIntervalMs ?? 25_000 : this.opts.pingIntervalMs ?? 10_000;
    this.pingTimer = setInterval(() => void this.checkPing(), interval);
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
    this.clearOpening();
    if (this.socket) this.closeSocket(this.socket);
    this.socket = null;
    this.route = null;
    this.rttMs = null;
  }

  private arm(run: () => void, ms: number) {
    const timer = setTimeout(() => {
      this.connectTimers.delete(timer);
      run();
    }, ms);
    this.connectTimers.add(timer);
    return timer;
  }

  private disarm(timer: ReturnType<typeof setTimeout>) {
    clearTimeout(timer);
    this.connectTimers.delete(timer);
  }

  private dropOpening(socket: SocketLike) {
    this.opening.delete(socket);
    this.closeSocket(socket);
  }

  private clearOpening() {
    for (const timer of this.connectTimers) clearTimeout(timer);
    this.connectTimers.clear();
    for (const socket of this.opening) this.closeSocket(socket);
    this.opening.clear();
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
