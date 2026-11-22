import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { isProviderEnvAllowed, stripAppEnv } from "../claude";
import { findExecutable, withLoginPath } from "../loginPath";
import { trackGroupLeader } from "../processGroups";
import { daemonEnv } from "../sessionEnv";
import { HOME } from "../store";

const TRACE_FILE = process.env.AGENT_NAV_ANTIGRAVITY_TRACE;
const STDERR_TAIL_MAX = 4000;
const INITIALIZE_TIMEOUT_MS = 20_000;
const PROVIDER_ENV_KEYS = ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENAI_USE_VERTEXAI", "GOOGLE_GENAI_USE_GCA", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION"];

export function antigravityBin(env: NodeJS.ProcessEnv = process.env): string {
  if (env.AGENT_NAV_ANTIGRAVITY) return env.AGENT_NAV_ANTIGRAVITY;
  const native = join(env.HOME ?? homedir(), ".local", "bin", "agy");
  if (findExecutable(native, undefined)) return native;
  return findExecutable("agy", withLoginPath(env.PATH)) ?? native;
}

export function acpProcessDir() {
  const dir = join(HOME, "antigravity", "process");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function antigravityEnv(): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = { ...stripAppEnv(process.env), ...daemonEnv() };
  env.PATH = withLoginPath(env.PATH);
  if (!isProviderEnvAllowed()) for (const key of PROVIDER_ENV_KEYS) delete env[key];
  return env as NodeJS.ProcessEnv;
}

export type AcpHandlers = {
  onNotification: (method: string, params: Record<string, unknown>) => void;
  onRequest: (id: number | string, method: string, params: Record<string, unknown>) => Promise<unknown>;
  onExit: (info: { code: number | null; signal: NodeJS.Signals | null; stderrTail: string }) => void;
};

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout | null };

export class AcpError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

export type AcpInitialize = {
  protocolVersion?: number;
  agentCapabilities?: { loadSession?: boolean; promptCapabilities?: { image?: boolean }; sessionCapabilities?: { resume?: unknown; close?: unknown; load?: unknown; additionalDirectories?: unknown }; _meta?: { antigravity?: { systemPrompt?: { append?: boolean } } } };
  agentInfo?: { name?: string; version?: string };
};

export class AcpConnection {
  private child: ChildProcess;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private stderr = "";
  closed = false;
  info: AcpInitialize = {};

  private constructor(
    child: ChildProcess,
    private handlers: AcpHandlers,
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

  get version() {
    return this.info.agentInfo?.version ?? null;
  }

  canResume() {
    return this.info.agentCapabilities?.sessionCapabilities?.resume !== undefined;
  }

  canLoad() {
    return this.info.agentCapabilities?.loadSession === true;
  }

  canAddDirectories() {
    return this.info.agentCapabilities?.sessionCapabilities?.additionalDirectories !== undefined;
  }

  canAppendSystemPrompt() {
    return this.info.agentCapabilities?._meta?.antigravity?.systemPrompt?.append === true;
  }

  canClose() {
    return this.info.agentCapabilities?.sessionCapabilities?.close !== undefined;
  }

  static async start(handlers: AcpHandlers, bin: string = antigravityBin()): Promise<AcpConnection> {
    const child = spawn(bin, ["acp"], { stdio: ["pipe", "pipe", "pipe"], env: antigravityEnv(), cwd: acpProcessDir(), detached: true, windowsHide: true });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve());
      child.once("error", (error) => reject(error));
    });
    trackGroupLeader(child);
    const connection = new AcpConnection(child, handlers);
    try {
      connection.info =
        (await connection.request<AcpInitialize>(
          "initialize",
          { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: "lodestar", title: "Lodestar", version: "0.3.2" } },
          INITIALIZE_TIMEOUT_MS,
        )) ?? {};
    } catch (error) {
      connection.close();
      throw error;
    }
    return connection;
  }

  request<T = unknown>(method: string, params?: unknown, timeoutMs = 0): Promise<T> {
    if (this.closed) return Promise.reject(new AcpError("Antigravity is not running"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = timeoutMs > 0 ? setTimeout(() => this.settle(id, new AcpError(`${method} timed out`)), timeoutMs) : null;
      timer?.unref();
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  notify(method: string, params?: unknown) {
    this.send({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.rejectAll(new AcpError("Antigravity closed"));
    const pid = this.child.pid;
    if (pid === undefined) return;
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try {
        this.child.kill("SIGTERM");
      } catch {
        return;
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
    let message: { id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { code?: number; message?: string; data?: unknown } };
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    this.trace("in", message);
    if (typeof message.method === "string") {
      const params = message.params ?? {};
      if (message.id === undefined || message.id === null) {
        try {
          this.handlers.onNotification(message.method, params);
        } catch (error) {
          console.error("[antigravity] notification handler failed", message.method, error);
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
        .then((result) => this.send({ jsonrpc: "2.0", id, result: result ?? null }))
        .catch((error: unknown) => this.send({ jsonrpc: "2.0", id, error: { code: error instanceof AcpError && error.code ? error.code : -32603, message: error instanceof Error ? error.message : String(error) } }));
      return;
    }
    const id = typeof message.id === "string" ? Number(message.id) : message.id;
    if (typeof id !== "number" || Number.isNaN(id)) return;
    if (message.error) this.settle(id, new AcpError(acpErrorMessage(message.error), message.error.code, message.error.data));
    else this.settle(id, null, message.result);
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null) {
    const wasClosed = this.closed;
    this.closed = true;
    this.rejectAll(new AcpError(`Antigravity exited (${signal ?? code})`));
    if (!wasClosed) this.handlers.onExit({ code, signal, stderrTail: this.stderrTail });
  }

  private trace(dir: "in" | "out", message: unknown) {
    if (!TRACE_FILE) return;
    const m = message as { method?: string };
    if (typeof m.method === "string" && m.method.startsWith("authenticate")) return;
    try {
      appendFileSync(TRACE_FILE, `${JSON.stringify({ dir, at: new Date().toISOString(), message })}\n`);
    } catch {
      return;
    }
  }
}

function acpErrorMessage(error: { message?: string; data?: unknown }) {
  const base = error.message?.trim() || "Antigravity error";
  const data = error.data;
  const detail = typeof data === "string" ? data : data && typeof data === "object" && typeof (data as { message?: unknown }).message === "string" ? (data as { message: string }).message : null;
  return detail && !base.includes(detail) ? `${base}: ${detail}` : base;
}
