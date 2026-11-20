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

// typescript-language-server 가 워크스페이스 TypeScript 에 tsserver.js 가 없을 때 띄우는 경고. 사용자가 할 수 있는 일이 없어 배너로 보이지 않고 상태 줄 표시로 바꾼다.
const NO_TSSERVER_WARNING = /provides no tsserver\.js/;

// 네이티브 서버가 시작하지 못했거나 초기화 전에 죽은 워크스페이스. 실행 파일이 바뀌면(재설치) 다시 시도한다.
const nativeFailures = new Map<string, string>();

// TypeScript 서버 하나처럼 보이는 연결. 워크스페이스 TypeScript 가 7 이상이면 네이티브 `tsc --lsp --stdio` 를, 아니면 typescript-language-server 를 띄운다.
// 네이티브가 초기화 전에 실패하면 typescript-language-server 로 바꿔 끼우고, 초기화 뒤에 죽으면 callbacks.exit 로 알려 브라우저 연결을 닫게 한다.
// bundledOnly 면 그 폴더의 TypeScript(네이티브 실행 파일, tsserver.js)를 찾지도 돌리지도 않고 앱에 들어 있는 tsserver 만 쓴다(server/folderTrust.ts).
// typescript-language-server 는 경로를 받지 않으면 작업 폴더에서 위로 node_modules/typescript 를 스스로 찾아 쓰므로 번들 경로를 명시해 넘긴다.
export function startTypescript(workspaceDir: string, callbacks: LinkCallbacks, options: { bundledOnly?: boolean } = {}): ChildLink {
  // initialize 는 서버를 고르는 동안(비동기) 도착할 수 있다. 쌓아 두었다가 서버가 뜨면 비운다.
  // 네이티브가 초기화 전에 실패하면 이 기록을 그대로 typescript-language-server 에 다시 보낸다.
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
        // 초기화가 끝난 뒤에는 브라우저가 이 서버의 기능 목록으로 동작 중이라 자리에서 바꿔 끼울 수 없다. 다음 연결부터 typescript-language-server 를 쓴다.
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
      // Electron 안에서는 process.execPath 가 Electron 이라, node 로 돌게 한다. 일반 node 에서는 무해하다.
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
    // 띄우지 못하면(실행 파일이 없어짐, 프로세스 한도) error 만 오고 exit 는 오지 않는다. 듣는 쪽이 없으면 처리되지 않은 예외로 데몬이 죽는다.
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

// 브라우저 상태 줄이 쓰는 알림. 서버가 무엇인지(label)와, 워크스페이스 TypeScript 를 못 써서 번들 5.x 로 돌아왔다면 그 이유.
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
    // 파일이 없으면 mtime 0 으로 둔다.
  }
  return `${chosen.exe}:${mtime}`;
}

function initializeId(text: string) {
  const message = parseJson(text);
  return message?.method === "initialize" ? message.id : null;
}

// initialize 에 워크스페이스 tsserver.js 위치를 실어 보낸다(typescript-language-server 전용).
function withTsserverPath(text: string, tsserverPath: string | null) {
  if (!tsserverPath) return text;
  const message = parseJson(text) as { method?: string; params?: { initializationOptions?: object } } | null;
  if (message?.method !== "initialize" || !message.params) return text;
  message.params.initializationOptions = { ...message.params.initializationOptions, tsserver: { path: tsserverPath } };
  return JSON.stringify(message);
}
