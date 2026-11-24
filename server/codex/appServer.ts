import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { stripAppEnv } from "../claude";
import { findExecutable, withLoginPath } from "../loginPath";
import { trackGroupLeader } from "../processGroups";

// CODEX: Codex 앱 서버(`codex app-server`)와 stdio 로 주고받는 JSON-RPC 클라이언트. 한 줄에 JSON 하나(JSONL)이고 "jsonrpc" 필드는 없다.
// 메시지 종류: 클라이언트 요청 {id, method, params} -> 응답 {id, result|error} / 서버 알림 {method, params} / 서버가 클라이언트에 보내는 요청 {id, method, params}(승인 등)
export function codexBin(env: NodeJS.ProcessEnv = process.env): string {
  if (env.AGENT_NAV_CODEX) return env.AGENT_NAV_CODEX;
  const native = join(env.HOME ?? homedir(), ".local", "bin", "codex");
  if (findExecutable(native, undefined)) return native;
  return findExecutable("codex", withLoginPath(env.PATH)) ?? native;
}
const TRACE_FILE = process.env.AGENT_NAV_CODEX_TRACE;
const STDERR_TAIL_MAX = 4000;
const INITIALIZE_TIMEOUT_MS = 20_000;

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

  static async start(handlers: AppServerHandlers, bin: string = codexBin()): Promise<AppServer> {
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
    const pid = this.child.pid;
    if (pid !== undefined) {
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        try {
          this.child.kill("SIGTERM");
        } catch {
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
    }
  }
}
