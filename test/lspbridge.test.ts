// server/lsp.ts 의 서버 선택과 되돌리기 시험. 가짜 네이티브 실행 파일(node 스크립트)과 진짜 typescript-language-server 를 /tmp 의 가짜 워크스페이스에서 돌린다.
// 확인: 네이티브 시작과 진단 pull 을 publishDiagnostics 로 바꿔 줌, 초기화 전 실패와 초기화 오류와 초기화 후 종료의 되돌리기(워크스페이스당 한 번 기억),
// "provides no tsserver.js" 경고가 브라우저에 가지 않음, TS5 워크스페이스는 그대로 typescript-language-server.
// 실행: npm test
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { WebSocket } from "ws";
import { bridgeLsp } from "../server/lsp";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed++;
};

type Message = { id?: number | string; method?: string; params?: Record<string, any>; result?: any; error?: any };

class FakeSocket extends EventEmitter {
  readyState = 1;
  OPEN = 1;
  received: Message[] = [];
  closedWith: number | null = null;
  send(data: string) {
    this.received.push(JSON.parse(data) as Message);
    this.emit("received");
  }
  close(code?: number) {
    this.readyState = 3;
    this.closedWith = code ?? 1000;
    this.emit("received");
    this.emit("close");
  }
  toServer(message: object) {
    this.emit("message", Buffer.from(JSON.stringify(message)));
  }
  async until(predicate: (messages: Message[]) => boolean, label: string, ms = 20_000) {
    const deadline = Date.now() + ms;
    while (!predicate(this.received)) {
      if (Date.now() > deadline) throw new Error(`timeout: ${label}\n${JSON.stringify(this.received.map((m) => m.method ?? `#${m.id}`))}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 100);
        this.once("received", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }
}

const root = mkdtempSync(join(tmpdir(), "lsp-bridge-"));
const pkgName = `typescript-${process.platform}-${process.arch}`;
const fakeSource = `#!/usr/bin/env node
const fs = require("fs");
const mode = fs.readFileSync(process.cwd() + "/.fake-mode", "utf8").trim();
fs.appendFileSync(process.cwd() + "/starts.log", "start\\n");
if (mode === "die") process.exit(3);
let buf = Buffer.alloc(0);
let changes = 0;
const send = (m) => { const t = JSON.stringify(m); process.stdout.write("Content-Length: " + Buffer.byteLength(t) + "\\r\\n\\r\\n" + t); };
process.stdin.on("data", (c) => {
  buf = Buffer.concat([buf, c]);
  for (;;) {
    const he = buf.indexOf("\\r\\n\\r\\n"); if (he < 0) return;
    const len = Number(/Content-Length: (\\d+)/i.exec(buf.subarray(0, he).toString())[1]);
    if (buf.length < he + 4 + len) return;
    const m = JSON.parse(buf.subarray(he + 4, he + 4 + len).toString()); buf = buf.subarray(he + 4 + len);
    if (m.method === "initialize") {
      if (mode === "initerror") return send({ jsonrpc: "2.0", id: m.id, error: { code: -32603, message: "boom" } });
      send({ jsonrpc: "2.0", method: "window/logMessage", params: { type: 3, message: "noise" } });
      send({ jsonrpc: "2.0", id: m.id, result: { capabilities: { hoverProvider: true, diagnosticProvider: { interFileDependencies: true, workspaceDiagnostics: false } }, serverInfo: { name: "typescript-go", version: "7.0.2" } } });
      if (mode === "diepost") setTimeout(() => process.exit(4), 100);
    } else if (m.method === "textDocument/didChange") changes++;
    else if (m.method === "textDocument/diagnostic") send({ jsonrpc: "2.0", id: m.id, result: { kind: "full", items: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 1, message: "changes=" + changes }] } });
    else if (m.method === "textDocument/hover") send({ jsonrpc: "2.0", id: m.id, result: { contents: { kind: "markdown", value: "\`\`\`typescript\\nconst x: number\\n\`\`\`" } } });
    else if (m.method === "shutdown") send({ jsonrpc: "2.0", id: m.id, result: null });
    else if (m.method === "exit") process.exit(0);
  }
});
`;

// 가짜 TypeScript 7 워크스페이스: tsserver.js 가 없고 플랫폼 패키지에 가짜 tsc 가 있다.
function fakeNativeWorkspace(name: string, mode: "ok" | "die" | "initerror" | "diepost") {
  const base = join(root, name);
  const nodeModules = join(base, "node_modules");
  mkdirSync(join(nodeModules, "typescript/lib"), { recursive: true });
  writeFileSync(join(nodeModules, "typescript/package.json"), JSON.stringify({ name: "typescript", version: "7.0.2" }));
  const exeDir = join(nodeModules, "@typescript", pkgName, "lib");
  mkdirSync(exeDir, { recursive: true });
  writeFileSync(join(exeDir, "tsc"), fakeSource);
  chmodSync(join(exeDir, "tsc"), 0o755);
  const project = join(base, "proj");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, ".fake-mode"), mode);
  writeFileSync(join(project, "a.ts"), "export const x = 1;\n");
  return { project, uri: `file://${join(project, "a.ts")}`, starts: () => (existsSync(join(project, "starts.log")) ? readFileSync(join(project, "starts.log"), "utf8").split("\n").filter(Boolean).length : 0) };
}

function connect(project: string) {
  const socket = new FakeSocket();
  bridgeLsp(socket as unknown as WebSocket, project);
  // 브라우저는 열리자마자 initialize 를 보낸다(서버 선택이 끝나기 전).
  socket.toServer({ jsonrpc: "2.0", id: 1, method: "initialize", params: { processId: null, rootUri: `file://${project}`, capabilities: { textDocument: { diagnostic: {}, publishDiagnostics: {} } }, workspaceFolders: null } });
  return socket;
}

const infoOf = (messages: Message[]) => messages.filter((m) => m.method === "$/lodestar/serverInfo").map((m) => m.params!);
const initDone = (messages: Message[]) => messages.some((m) => m.id === 1 && m.result);
const showMessages = (messages: Message[]) => messages.filter((m) => m.method === "window/showMessage");

async function nativeWorks() {
  const ws = fakeNativeWorkspace("native-ok", "ok");
  const socket = connect(ws.project);
  await socket.until(initDone, "initialize response");
  const info = infoOf(socket.received);
  check("네이티브: serverInfo 가 initialize 응답보다 먼저 가고 라벨이 TypeScript 7.0.2 (native)", info.length === 1 && info[0]!.kind === "native" && info[0]!.label === "TypeScript 7.0.2 (native)" && info[0]!.fallback === null, JSON.stringify(info));
  check("네이티브: 서버가 initialize 응답을 주고 한 번만 시작", ws.starts() === 1 && socket.received.find((m) => m.id === 1)?.result?.serverInfo?.name === "typescript-go");
  check("네이티브: window/logMessage(info)는 브라우저로 보내지 않음", !socket.received.some((m) => m.method === "window/logMessage"));

  socket.toServer({ jsonrpc: "2.0", method: "initialized", params: {} });
  socket.toServer({ jsonrpc: "2.0", method: "textDocument/didOpen", params: { textDocument: { uri: ws.uri, languageId: "typescript", version: 0, text: "export const x = 1;\n" } } });
  await socket.until((ms) => ms.some((m) => m.method === "textDocument/publishDiagnostics"), "first publishDiagnostics");
  const first = socket.received.find((m) => m.method === "textDocument/publishDiagnostics")!;
  check("진단 pull 결과를 publishDiagnostics 로 보냄(version 은 didOpen 의 것)", first.params!.uri === ws.uri && first.params!.version === 0 && first.params!.diagnostics.length === 1 && first.params!.diagnostics[0].message === "changes=0", JSON.stringify(first.params));

  socket.toServer({ jsonrpc: "2.0", method: "textDocument/didChange", params: { textDocument: { uri: ws.uri, version: 1 }, contentChanges: [{ text: "export const x = 2;\n" }] } });
  await socket.until((ms) => ms.some((m) => m.method === "textDocument/publishDiagnostics" && m.params!.version === 1), "diagnostics after change");
  const second = socket.received.filter((m) => m.method === "textDocument/publishDiagnostics").at(-1)!;
  check("편집 뒤 다시 pull 해서 새 version 으로 보냄", second.params!.version === 1 && second.params!.diagnostics[0].message === "changes=1", JSON.stringify(second.params));

  socket.toServer({ jsonrpc: "2.0", id: 7, method: "textDocument/hover", params: { textDocument: { uri: ws.uri }, position: { line: 0, character: 14 } } });
  await socket.until((ms) => ms.some((m) => m.id === 7), "hover");
  check("일반 요청은 그대로 서버로 가고 응답이 돌아옴", socket.received.find((m) => m.id === 7)?.result?.contents?.value.includes("const x: number") === true);

  socket.toServer({ jsonrpc: "2.0", method: "textDocument/didClose", params: { textDocument: { uri: ws.uri } } });
  socket.close();
}

async function nativeFailsBeforeInitialize(name: string, mode: "die" | "initerror") {
  const ws = fakeNativeWorkspace(name, mode);
  const socket = connect(ws.project);
  await socket.until(initDone, "fallback initialize response");
  const caps = socket.received.find((m) => m.id === 1)!.result?.capabilities;
  check(`${mode}: typescript-language-server 가 같은 initialize 에 응답(기록을 다시 보냄)`, !!caps && "hoverProvider" in caps && socket.received.find((m) => m.id === 1)?.result?.serverInfo?.name !== "typescript-go");
  await socket.until((ms) => infoOf(ms).some((i) => i.kind === "tsls"), "tsls serverInfo");
  const info = infoOf(socket.received).find((i) => i.kind === "tsls")!;
  check(`${mode}: 상태 줄 표시 TS 5.9 (bundled)와 이유`, info.fallback?.label === "TS 5.9 (bundled)" && /Native TypeScript 7\.0\.2 language server failed/.test(info.fallback.reason), JSON.stringify(info));
  check(`${mode}: provides no tsserver.js 경고가 브라우저에 가지 않음`, !showMessages(socket.received).some((m) => /provides no tsserver\.js/.test(String(m.params!.message))));
  check(`${mode}: 네이티브는 한 번만 시도`, ws.starts() === 1);
  socket.toServer({ jsonrpc: "2.0", method: "initialized", params: {} });
  socket.close();

  const again = connect(ws.project);
  await again.until(initDone, "second connection initialize");
  check(`${mode}: 같은 워크스페이스의 다음 연결은 네이티브를 다시 시도하지 않음`, ws.starts() === 1 && infoOf(again.received).some((i) => i.kind === "tsls" && i.fallback));
  again.close();
}

async function nativeDiesAfterInitialize() {
  const ws = fakeNativeWorkspace("native-diepost", "diepost");
  const socket = connect(ws.project);
  await socket.until((ms) => initDone(ms) && true, "initialize response");
  await socket.until(() => socket.closedWith !== null, "socket closed");
  check("초기화 뒤 네이티브가 죽으면 소켓을 1011 로 닫음", socket.closedWith === 1011, String(socket.closedWith));
  const again = connect(ws.project);
  await again.until(initDone, "next connection initialize");
  check("다음 연결은 typescript-language-server", again.received.find((m) => m.id === 1)?.result?.serverInfo?.name !== "typescript-go" && infoOf(again.received).some((i) => i.kind === "tsls"));
  again.close();
}

async function ts5StaysOnLanguageServer() {
  // 이 레포의 TypeScript 5.9.3 을 워크스페이스 TypeScript 로 건다: 번들이 아닌 워크스페이스 tsserver 로 돌고 되돌림 표시가 없다.
  const base = join(root, "ts5");
  mkdirSync(join(base, "node_modules"), { recursive: true });
  symlinkSync(join(dirname(fileURLToPath(import.meta.url)), "../node_modules/typescript"), join(base, "node_modules/typescript"));
  const project = join(base, "proj");
  mkdirSync(project, { recursive: true });
  const socket = connect(project);
  await socket.until(initDone, "ts5 initialize response");
  await new Promise((resolve) => setTimeout(resolve, 500));
  check("TS5 워크스페이스: 되돌림 표시 없음, 경고 배너 없음", !infoOf(socket.received).some((i) => i.fallback) && showMessages(socket.received).length === 0, JSON.stringify(socket.received.map((m) => m.method)));
  socket.close();
}

async function main() {
  await nativeWorks();
  await nativeFailsBeforeInitialize("native-die", "die");
  await nativeFailsBeforeInitialize("native-initerror", "initerror");
  await nativeDiesAfterInitialize();
  await ts5StaysOnLanguageServer();
}

main()
  .catch((error) => {
    console.error(error);
    failed++;
  })
  .finally(() => {
    rmSync(root, { recursive: true, force: true });
    if (failed) {
      console.error(`${failed} failed`);
      process.exit(1);
    }
    console.log("all passed");
    process.exit(0);
  });
