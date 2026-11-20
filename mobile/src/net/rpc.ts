// 데몬의 모바일 포트(/mobile/ws)와 주고받는 클라이언트. React Native 에 의존하지 않아 노드에서 실제 서버로 시험한다(test/rpc.test.ts).
// 인증은 연결 뒤 첫 프레임으로 한다(토큰이 주소에 남지 않게). 끊기면 지수 백오프로 다시 붙고, 붙을 때마다 onReady 가 불려 저장소가 놓친 이벤트를 다시 맞춘다.
import type { MobileBrowseResult, MobileMethod, MobileReady, MobileWorktreeRequest } from "@shared/mobile";
import type { Agent, ImageRef, RpcMethods, ServerEvent } from "@shared/protocol";
import { reconnectDelay } from "../logic/backoff";

export type Endpoint = { hosts: string[]; port: number; token: string };
// unauthorized: 데스크톱에서 이 장치를 해제했다(4401). 다시 페어링해야 하므로 재연결하지 않는다.
export type ConnStatus = "idle" | "connecting" | "online" | "offline" | "unauthorized";

export type { MobileMethod };

// 폰이 부르는 RPC 의 인자와 결과. 새 세션은 폴더(와 worktree)와 첫 글만 보낸다(권한 모드와 모델은 데몬이 채운다). mobile.browse 는 폰 전용이라 RpcMethods 에 없다.
type MobileOnly = {
  "agents.create": { params: { workspaceId: string | null; prompt: string; images?: ImageRef[]; worktree?: MobileWorktreeRequest }; result: Agent };
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
  // 시험에서 짧게 줄이는 값들
  pingIntervalMs?: number;
  pingTimeoutMs?: number;
  connectTimeoutMs?: number;
  hostStaggerMs?: number;
  backoff?: (attempt: number) => number;
  log?: (line: string) => void;
  // 호출 하나가 끝났을 때(성공이든 실패든) 걸린 시간. 성능 계측용
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

  // 붙을 곳을 정한다. null 이면 연결을 끊고 쉰다.
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

  // 앱이 앞으로 왔다. 연결이 살아 있는지 짧게 확인하고(소켓이 죽었는데 OS 가 몰랐을 수 있다), 아니면 기다리지 않고 다시 붙는다.
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

  // 인증이 끝날 때마다(처음과 재연결 뒤) 불린다
  onReady(listener: (ready: MobileReady) => void) {
    this.readyListeners.add(listener);
    return () => this.readyListeners.delete(listener);
  }

  // --- 연결 ---

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
    // 한 번 실패한 뒤 다시 시도하는 동안은 offline 을 유지한다(화면 문구가 깜박이지 않게)
    if (this.status !== "offline") this.setStatus("connecting");
    // 마지막으로 성공한 주소를 먼저, 안 되면 정해진 간격으로 다음 후보를 함께 시도한다(먼저 인증이 끝난 주소가 이긴다).
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
    // 어느 주소로도 정해진 시간 안에 인증이 안 되면 이 시도는 실패다
    this.connectTimer = setTimeout(() => {
      if (generation === this.generation && !this.socket) this.failAttempt(generation);
    }, this.opts.connectTimeoutMs ?? 6000);
  }

  private candidate(generation: number, host: string, endpoint: Endpoint) {
    let socket: SocketLike;
    try {
      socket = this.makeSocket(`ws://${host.includes(":") ? `[${host}]` : host}:${endpoint.port}/mobile/ws`);
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
      // null 이나 숫자 같은 프레임은 버린다(아래의 in 검사가 던지면 앱이 죽는다)
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
      if (event.code === 4401) {
        // 토큰이 안 통한다: 해제됐거나 다른 Mac 이다. 계속 두드리지 않는다.
        this.teardown();
        this.wanted = false;
        this.setStatus("unauthorized");
        return;
      }
      if (socket === this.socket) this.lost();
      else this.afterCandidateClosed(generation);
    };
  }

  // 후보 하나가 안 붙고 닫혔다: 아직 안 해 본 주소가 있으면 기다리지 않고 바로 시도하고, 전부 실패했으면 이 시도를 접는다.
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

  // 응답이 없는 연결은 닫고 바로 다시 붙는다
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
        // 이미 닫혔다
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
