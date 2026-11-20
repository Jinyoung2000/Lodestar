import { readFileSync } from "node:fs";
import { join } from "node:path";
import WebSocket from "ws";
import type { Agent, RpcMethod, RpcMethods, ServerEvent, ServerMessage, Workspace } from "../../shared/protocol";

// 데몬 RPC 에 붙는 클라이언트. 토큰은 데몬이 쓰는 파일(<home>/token)에서 읽는다.
// 데몬은 브라우저의 교차 출처 접속을 막으려고 Origin 을 검사한다. Node 클라이언트는 그 헤더를 마음대로 쓸 수 있으니 데몬 자신의 출처를 보내고,
// 실제 인증은 토큰이 한다. 토큰이 틀리면 데몬이 403 으로 거절한다(rejected).
export type DaemonSettings = { port: number; home: string };

export type DaemonState = "connecting" | "online" | "offline" | "noToken" | "rejected";

const RETRY_MS = 2000;
const CALL_TIMEOUT_MS = 30_000;

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

export class Daemon {
  state: DaemonState = "connecting";
  workspaces: Workspace[] = [];
  agents: Agent[] = [];
  // 한 번이라도 목록을 받았는지. 받기 전에는 세션이 없다고 단정하지 않는다.
  loaded = false;
  private socket: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private retry: NodeJS.Timeout | null = null;
  private stopped = false;
  private rejected = false;
  private changeListeners = new Set<() => void>();

  constructor(
    private settings: () => DaemonSettings,
    private log: (line: string) => void,
  ) {}

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    this.socket?.terminate();
  }

  // 설정(포트, 홈)이 바뀌었을 때 처음부터 다시 붙는다.
  reconnect() {
    if (this.retry) clearTimeout(this.retry);
    this.socket?.terminate();
    this.loaded = false;
    this.workspaces = [];
    this.agents = [];
    this.setState("connecting");
    this.connect();
  }

  // 상태나 목록이 바뀔 때마다 부른다.
  onChange(listener: () => void) {
    this.changeListeners.add(listener);
    return { dispose: () => this.changeListeners.delete(listener) };
  }

  call<M extends RpcMethod>(method: M, params: RpcMethods[M]["params"]): Promise<RpcMethods[M]["result"]> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("Lodestar is not running."));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Lodestar did not answer ${method}.`));
      }, CALL_TIMEOUT_MS);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }

  private connect() {
    const { port, home } = this.settings();
    let token: string;
    try {
      token = readFileSync(join(home, "token"), "utf8").trim();
    } catch {
      this.setState("noToken");
      this.scheduleRetry();
      return;
    }
    this.rejected = false;
    const origin = `http://127.0.0.1:${port}`;
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/rpc?token=${encodeURIComponent(token)}`, { headers: { origin } });
    this.socket = socket;
    socket.on("open", () => void this.load(socket));
    socket.on("message", (data) => this.onMessage(data.toString()));
    socket.on("unexpected-response", (_request, response) => {
      this.rejected = response.statusCode === 403;
      response.resume();
      socket.terminate();
    });
    socket.on("error", () => undefined);
    socket.on("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error("Lodestar disconnected."));
        this.pending.delete(id);
      }
      this.setState(this.rejected ? "rejected" : "offline");
      this.scheduleRetry();
    });
  }

  private async load(socket: WebSocket) {
    try {
      const [workspaces, agents] = await Promise.all([this.call("workspaces.list", {}), this.call("agents.list", {})]);
      if (this.socket !== socket) return;
      this.workspaces = workspaces;
      this.agents = agents;
      this.loaded = true;
      this.setState("online");
    } catch (error) {
      this.log(`load failed: ${error instanceof Error ? error.message : String(error)}`);
      socket.terminate();
    }
  }

  private onMessage(text: string) {
    const message = JSON.parse(text) as ServerMessage;
    if ("event" in message) {
      this.onEvent(message.event);
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if ("error" in message) pending.reject(new Error(message.error));
    else pending.resolve(message.result);
  }

  private onEvent(event: ServerEvent) {
    if (event.type === "workspaces") this.workspaces = event.workspaces;
    else if (event.type === "agent") this.agents = this.agents.some((a) => a.id === event.agent.id) ? this.agents.map((a) => (a.id === event.agent.id ? event.agent : a)) : [...this.agents, event.agent];
    else if (event.type === "agentRemoved") this.agents = this.agents.filter((a) => a.id !== event.agentId);
    else return;
    this.fire();
  }

  private setState(state: DaemonState) {
    if (this.state === state) return;
    this.state = state;
    this.log(`daemon ${state}`);
    this.fire();
  }

  private fire() {
    for (const listener of this.changeListeners) listener();
  }

  private scheduleRetry() {
    if (this.stopped) return;
    if (this.retry) clearTimeout(this.retry);
    this.retry = setTimeout(() => this.connect(), RETRY_MS);
  }
}
