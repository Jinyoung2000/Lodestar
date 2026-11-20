import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { stripAppEnv } from "../claude";
import { withLoginPath } from "../loginPath";
import { trackGroupLeader } from "../processGroups";

// CODEX: Codex 앱 서버(`codex app-server`)와 stdio 로 주고받는 JSON-RPC 클라이언트. 한 줄에 JSON 하나(JSONL)이고 "jsonrpc" 필드는 없다.
// 앱 서버는 데몬 하나에 프로세스 하나를 공유한다. 스레드는 알림과 요청의 threadId 로 구분하고, 작업 폴더는 thread/start 의 cwd 로 스레드마다 준다.
// 메시지 종류: 클라이언트 요청 {id, method, params} -> 응답 {id, result|error} / 서버 알림 {method, params} / 서버가 클라이언트에 보내는 요청 {id, method, params}(승인 등)
export const CODEX_BIN = process.env.AGENT_NAV_CODEX ?? `${process.env.HOME}/.local/bin/codex`;
const TRACE_FILE = process.env.AGENT_NAV_CODEX_TRACE;
const STDERR_TAIL_MAX = 4000;
const INITIALIZE_TIMEOUT_MS = 20_000;

// Claude CLI 와 같은 규칙: 앱 내부 변수를 빼고, 세션의 명령이 node, git, homebrew 도구를 찾도록 로그인 셸 PATH 를 붙인다. ~/.codex 의 로그인은 HOME 으로 찾으므로 그대로 둔다.
function codexEnv(): NodeJS.ProcessEnv {
  const env = stripAppEnv(process.env);
  env.PATH = withLoginPath(env.PATH);
  return env as NodeJS.ProcessEnv;
}

export type AppServerHandlers = {
  onNotification: (method: string, params: Record<string, unknown>) => void;
  // 서버가 보낸 요청에 대한 답을 돌려준다. 사용자 승인처럼 오래 걸려도 된다(답이 올 때까지 서버가 기다린다).
  onRequest: (id: number | string, method: string, params: Record<string, unknown>) => Promise<unknown>;
  onExit: (info: { code: number | null; signal: NodeJS.Signals | null; stderrTail: string }) => void;
};

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; method: string; timer: NodeJS.Timeout | null };

export class AppServerError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
  }
}

export class AppServer {
  private child: ChildProcess;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private stderr = "";
  closed = false;
  // initialize 응답의 userAgent(예: lodestar/0.163.0 ...). 코드 뒤 숫자가 Codex 버전이다.
  userAgent: string | null = null;

  private constructor(
    child: ChildProcess,
    private handlers: AppServerHandlers,
  ) {
    this.child = child;
    createInterface({ input: child.stdout! }).on("line", (line) => this.onLine(line));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (text: string) => {
      this.stderr = (this.stderr + text).slice(-STDERR_TAIL_MAX);
    });
    child.stdin?.on("error", () => undefined);
    child.once("exit", (code, signal) => this.onExit(code, signal));
  }

  get pid() {
    return this.child.pid;
  }

  get stderrTail() {
    return this.stderr.trim();
  }

  // 프로세스를 띄우고 initialize 핸드셰이크까지 마친다. 실패하면(실행 파일이 없음 등) 프로세스를 정리하고 던진다.
  static async start(handlers: AppServerHandlers, bin: string = CODEX_BIN): Promise<AppServer> {
    // detached 로 자기 프로세스 그룹의 리더가 되게 한다: 앱 서버가 낳는 명령 프로세스까지 종료 때 한꺼번에 정리된다(server/processGroups.ts).
    const child = spawn(bin, ["app-server"], { stdio: ["pipe", "pipe", "pipe"], env: codexEnv(), detached: true, windowsHide: true });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve());
      child.once("error", (error) => reject(error));
    });
    trackGroupLeader(child);
    const server = new AppServer(child, handlers);
    try {
      const init = await server.request<{ userAgent?: string }>("initialize", { clientInfo: { name: "lodestar", title: "Lodestar", version: "0.2.0" }, capabilities: null }, INITIALIZE_TIMEOUT_MS);
      server.userAgent = init?.userAgent ?? null;
      server.send({ method: "initialized" });
    } catch (error) {
      server.close();
      throw error;
    }
    return server;
  }

  request<T = unknown>(method: string, params?: unknown, timeoutMs = 0): Promise<T> {
    if (this.closed) return Promise.reject(new AppServerError("Codex app-server is not running"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = timeoutMs > 0 ? setTimeout(() => this.settle(id, new AppServerError(`${method} timed out`)), timeoutMs) : null;
      timer?.unref();
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, method, timer });
      this.send({ id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  // 응답 없는 알림
  notify(method: string, params?: unknown) {
    this.send({ method, ...(params === undefined ? {} : { params }) });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.rejectAll(new AppServerError("Codex app-server closed"));
    // 그룹 전체에 보낸다(음수 pid). 이미 없으면 무시한다.
    const pid = this.child.pid;
    if (pid !== undefined) {
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        try {
          this.child.kill("SIGTERM");
        } catch {
          // 이미 끝났다
        }
      }
    }
  }

  private send(message: Record<string, unknown>) {
    if (this.closed || !this.child.stdin?.writable) return;
    this.trace("out", message);
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private settle(id: number, error: Error | null, value?: unknown) {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    if (entry.timer) clearTimeout(entry.timer);
    if (error) entry.reject(error);
    else entry.resolve(value);
  }

  private rejectAll(error: Error) {
    for (const id of [...this.pending.keys()]) this.settle(id, error);
  }

  private onLine(line: string) {
    if (!line.trim()) return;
    let message: { id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { code?: number; message?: string } };
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    this.trace("in", message);
    if (typeof message.method === "string") {
      const params = message.params ?? {};
      if (message.id === undefined) {
        try {
          this.handlers.onNotification(message.method, params);
        } catch (error) {
          console.error("[codex] notification handler failed", message.method, error);
        }
        return;
      }
      const id = message.id;
      // 처리기가 동기로 던져도(예상과 다른 모양의 요청) 줄 읽기 밖으로 새어 데몬을 죽이지 않고 오류 응답으로 돌려준다. 알림과의 순서가 바뀌지 않게 부르는 것은 지금 한다.
      let handled: Promise<unknown>;
      try {
        handled = this.handlers.onRequest(id, message.method, params);
      } catch (error) {
        handled = Promise.reject(error);
      }
      void handled
        .then((result) => this.send({ id, result: result ?? {} }))
        .catch((error: unknown) => this.send({ id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } }));
      return;
    }
    if (typeof message.id === "number") {
      if (message.error) this.settle(message.id, new AppServerError(message.error.message ?? "Codex app-server error", message.error.code));
      else this.settle(message.id, null, message.result);
    }
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null) {
    const wasClosed = this.closed;
    this.closed = true;
    this.rejectAll(new AppServerError(`Codex app-server exited (${signal ?? code})`));
    if (!wasClosed) this.handlers.onExit({ code, signal, stderrTail: this.stderrTail });
  }

  // 추적 파일에는 계정과 토큰이 들어갈 수 있는 account/* 메시지와 그 응답을 남기지 않는다(로그인 정보는 Lodestar 가 읽거나 남기지 않는다).
  private traceSkipIds = new Set<number | string>();
  private trace(dir: "in" | "out", message: unknown) {
    if (!TRACE_FILE) return;
    const m = message as { id?: number | string; method?: string };
    if (typeof m.method === "string" && m.method.startsWith("account/")) {
      if (m.id !== undefined) this.traceSkipIds.add(m.id);
      return;
    }
    if (m.method === undefined && m.id !== undefined && this.traceSkipIds.delete(m.id)) return;
    try {
      appendFileSync(TRACE_FILE, `${JSON.stringify({ dir, at: new Date().toISOString(), message })}\n`);
    } catch {
      // 추적은 보조라 실패해도 무시한다
    }
  }
}
