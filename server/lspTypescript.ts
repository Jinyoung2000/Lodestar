import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { ChildLink, LinkCallbacks } from "./lspMux";
import { DiagnosticPuller } from "./lspDiagnostics";
import { parseJson, readMessages, writeMessage } from "./lspStdio";
import { planLanguageServer, type LspPlan } from "./tsResolve";

const require = createRequire(import.meta.url);
const TSLS_CLI = join(dirname(require.resolve("typescript-language-server/package.json")), "lib/cli.mjs");
const BUNDLED_TS_VERSION = (require("typescript/package.json") as { version: string }).version;
const BUNDLED_TSSERVER = join(dirname(require.resolve("typescript/package.json")), "lib/tsserver.js");
const NOT_ADDED_REASON = "This folder was not added as a workspace (a pull request checkout or a repository Lodestar downloaded), so its own TypeScript is not run.";

const NO_TSSERVER_WARNING = /provides no tsserver\.js/;

const nativeFailures = new Map<string, string>();

export function startTypescript(workspaceDir: string, callbacks: LinkCallbacks, options: { bundledOnly?: boolean } = {}): ChildLink {
  const history: string[] = [];
  let initId: unknown = null;
  let initialized = false;
  let closed = false;
  let server: ServerProcess | null = null;

  const plan: Promise<LspPlan> = options.bundledOnly ? Promise.resolve({ kind: "tsls", tsserverPath: BUNDLED_TSSERVER, workspaceVersion: null, reason: NOT_ADDED_REASON }) : planLanguageServer(workspaceDir);
  void plan.then((chosen) => {
    if (closed) return;
    const failure = chosen.kind === "native" ? nativeFailures.get(failureKey(chosen)) : undefined;
    if (chosen.kind === "native" && !failure) launchNative(chosen);
    else launchTsls(chosen.kind === "native" ? tslsFallbackPlan(chosen, failure!) : chosen);
  });

  function launchNative(chosen: Extract<LspPlan, { kind: "native" }>) {
    const child = spawn(chosen.exe, ["--lsp", "--stdio"], { cwd: workspaceDir, stdio: ["pipe", "pipe", "pipe"] });
    child.stdin.on("error", () => {});
    console.log(`[lsp] start native typescript-go ${chosen.version} pid=${child.pid} dir=${workspaceDir} exe=${chosen.exe}`);
    const puller = new DiagnosticPuller(
      (message) => writeMessage(child, JSON.stringify(message)),
      (message) => emit(JSON.stringify(message)),
    );
    let failed = false;
    const fail = (reason: string) => {
      if (failed || closed) return;
      failed = true;
      puller.dispose();
      child.kill();
      if (initialized) {
        console.error(`[lsp] native server stopped: ${reason}`);
        nativeFailures.set(failureKey(chosen), reason);
        callbacks.exit("language server exited");
        return;
      }
      console.error(`[lsp] native server failed before initialize, falling back to typescript-language-server: ${reason}`);
      nativeFailures.set(failureKey(chosen), reason);
      launchTsls(tslsFallbackPlan(chosen, reason));
    };
    server = {
      send: (text) => {
        const message = parseJson(text);
        if (message) puller.observe(message);
        writeMessage(child, text);
      },
      stop: () => {
        failed = true;
        puller.dispose();
        child.kill();
      },
    };
    readMessages(child, (body) => {
      const message = parseJson(body);
      if (!message) return emit(body);
      if (puller.handleResponse(message)) return;
      if (message.method === "window/logMessage" && Number((message.params as { type?: number }).type) >= 3) return;
      if (message.method === "workspace/diagnostic/refresh" && message.id !== undefined) {
        writeMessage(child, JSON.stringify({ jsonrpc: "2.0", id: message.id, result: null }));
        puller.refreshAll();
        return;
      }
      if (!initialized && message.id === initId && message.method === undefined) {
        if (message.error) return fail(`initialize failed: ${JSON.stringify(message.error)}`);
        initialized = true;
        history.length = 0;
        emit(serverInfo({ kind: "native", label: `TypeScript ${chosen.version} (native)`, fallback: null }));
        emit(body);
        puller.start();
        return;
      }
      emit(body);
    });
    child.stderr.on("data", (chunk: Buffer) => console.error(`[lsp stderr] ${chunk.toString().trim()}`));
    child.on("error", (error) => fail(`spawn failed: ${error.message}`));
    child.on("exit", (code, signal) => {
      console.log(`[lsp] exit native pid=${child.pid} code=${code} signal=${signal}`);
      fail(`exited with code ${code ?? signal}`);
    });
    for (const text of history) server.send(text);
  }

  function launchTsls(chosen: Extract<LspPlan, { kind: "tsls" }>) {
    const child = spawn(process.execPath, [TSLS_CLI, "--stdio"], {
      cwd: workspaceDir,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    });
    child.stdin.on("error", () => {});
    console.log(`[lsp] start typescript-language-server pid=${child.pid} dir=${workspaceDir} tsserver=${chosen.tsserverPath ?? "bundled"}${chosen.reason ? ` reason=${chosen.reason}` : ""}`);
    let bannerReason: string | null = null;
    server = {
      send: (text) => writeMessage(child, withTsserverPath(text, chosen.tsserverPath)),
      stop: () => child.kill(),
    };
    readMessages(child, (body) => {
      const message = parseJson(body);
      if (message?.method === "window/showMessage" && NO_TSSERVER_WARNING.test(String((message.params as { message?: string }).message))) {
        bannerReason = String((message.params as { message?: string }).message);
        emit(serverInfo({ kind: "tsls", label: `TypeScript ${BUNDLED_TS_VERSION} (bundled)`, fallback: fallbackMark(chosen.reason ?? bannerReason) }));
        return;
      }
      if (message && !initialized && message.id === initId && message.method === undefined) {
        initialized = true;
        history.length = 0;
        if (chosen.reason && !bannerReason) emit(serverInfo({ kind: "tsls", label: `TypeScript ${BUNDLED_TS_VERSION} (bundled)`, fallback: fallbackMark(chosen.reason) }));
      }
      emit(body);
    });
    child.stderr.on("data", (chunk: Buffer) => console.error(`[lsp stderr] ${chunk.toString().trim()}`));
    child.on("error", (error) => {
      console.error(`[lsp] typescript-language-server spawn failed: ${error.message}`);
      if (!closed) callbacks.exit("language server exited");
    });
    child.on("exit", (code) => {
      console.log(`[lsp] exit pid=${child.pid} code=${code}`);
      if (!closed) callbacks.exit("language server exited");
    });
    for (const text of history) server.send(text);
  }

  function emit(body: string) {
    if (!closed) callbacks.message(body);
  }

  return {
    send: (text) => {
      if (!initialized) {
        history.push(text);
        if (initId === null) initId = initializeId(text);
      }
      server?.send(text);
    },
    stop: () => {
      closed = true;
      server?.stop();
    },
  };
}

type ServerProcess = { send: (text: string) => void; stop: () => void };

function serverInfo(params: { kind: "native" | "tsls"; label: string; fallback: { label: string; reason: string } | null }) {
  return JSON.stringify({ jsonrpc: "2.0", method: "$/lodestar/serverInfo", params });
}

function fallbackMark(reason: string | null) {
  return reason ? { label: `TS ${BUNDLED_TS_VERSION.split(".").slice(0, 2).join(".")} (bundled)`, reason } : null;
}

function tslsFallbackPlan(chosen: Extract<LspPlan, { kind: "native" }>, reason: string): Extract<LspPlan, { kind: "tsls" }> {
  return { kind: "tsls", tsserverPath: null, workspaceVersion: chosen.version, reason: `Native TypeScript ${chosen.version} language server failed: ${reason}` };
}

function failureKey(chosen: Extract<LspPlan, { kind: "native" }>) {
  let mtime = 0;
  try {
    mtime = statSync(chosen.exe).mtimeMs;
  } catch {
  }
  return `${chosen.exe}:${mtime}`;
}

function initializeId(text: string) {
  const message = parseJson(text);
  return message?.method === "initialize" ? message.id : null;
}

function withTsserverPath(text: string, tsserverPath: string | null) {
  if (!tsserverPath) return text;
  const message = parseJson(text) as { method?: string; params?: { initializationOptions?: object } } | null;
  if (message?.method !== "initialize" || !message.params) return text;
  message.params.initializationOptions = { ...message.params.initializationOptions, tsserver: { path: tsserverPath } };
  return JSON.stringify(message);
}
