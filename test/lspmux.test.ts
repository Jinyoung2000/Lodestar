// server/lspMux.ts 시험. 가짜 자식 언어 서버 둘(TypeScript 역할의 주 서버, Relay 역할의 지연 시작 서버)을 프로세스 없이 붙여
// 확인한다: 요청 id 재매핑 양방향, initialize 기능 병합, 동기화 종류 변환, 진단 병합, completion 의 data 감싸기와 resolve 라우팅,
// 한 서버 오류와 무응답, 지연 시작과 준비 신호, 자식 하나의 죽음, 주 서버의 죽음, 연결 정리.
// 실행: npm test
import { LspMultiplexer, type ChildDef, type ChildLink, type LinkCallbacks, type Msg } from "../server/lspMux";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed++;
};
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const json = (value: unknown) => JSON.stringify(value);

type Handler = (message: Msg, server: FakeServer) => void;

// 프로세스 없는 자식 서버. 받은 메시지를 모으고, 요청에는 handler 가 답한다.
class FakeServer {
  received: Msg[] = [];
  stopped = false;
  starts = 0;
  callbacks!: LinkCallbacks;
  constructor(
    public name: string,
    public handler: Handler,
  ) {}
  def(fields: Partial<ChildDef> & { key: string }): ChildDef {
    return {
      serverId: this.name,
      label: this.name,
      languages: ["typescript", "typescriptreact"],
      dir: null,
      rootDir: null,
      start: (callbacks) => {
        this.starts++;
        this.callbacks = callbacks;
        const link: ChildLink = {
          send: (text) => {
            const message = JSON.parse(text) as Msg;
            this.received.push(message);
            this.handler(message, this);
          },
          stop: () => {
            this.stopped = true;
          },
        };
        return link;
      },
      ...fields,
    };
  }
  push(message: object) {
    this.callbacks.message(json({ jsonrpc: "2.0", ...message }));
  }
  reply(id: number | string | undefined, result: unknown) {
    this.push({ id, result });
  }
  methods(method: string) {
    return this.received.filter((m) => m.method === method);
  }
}

function tsHandler(caps: Record<string, unknown>, answers: Record<string, (message: Msg) => unknown> = {}): Handler {
  return (message, server) => {
    if (message.method === "initialize") return server.reply(message.id, { capabilities: caps });
    if (message.id !== undefined && message.method && answers[message.method]) {
      const answer = answers[message.method]!(message);
      if (answer !== NO_ANSWER) server.reply(message.id, answer);
    }
  };
}
const NO_ANSWER = Symbol("no answer");

class Browser {
  received: Msg[] = [];
  closed: { code: number; reason: string } | null = null;
  mux: LspMultiplexer;
  constructor(defs: ChildDef[], options: { graceMs?: number; requestTimeoutMs?: number } = {}) {
    this.mux = new LspMultiplexer(defs, {
      toBrowser: (text) => this.received.push(JSON.parse(text) as Msg),
      closeBrowser: (code, reason) => (this.closed = { code, reason }),
      graceMs: options.graceMs ?? 60,
      requestTimeoutMs: options.requestTimeoutMs ?? 600,
    });
  }
  send(message: object) {
    this.mux.fromBrowser(json({ jsonrpc: "2.0", ...message }));
  }
  async until(predicate: () => boolean, label: string, ms = 3000) {
    const deadline = Date.now() + ms;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`timeout: ${label}`);
      await sleep(10);
    }
  }
  response(id: number | string) {
    return this.received.find((m) => m.id === id && m.method === undefined);
  }
  async request(id: number | string, method: string, params: unknown) {
    this.send({ id, method, params });
    await this.until(() => !!this.response(id), `response to ${method} #${id}`);
    return this.response(id)!;
  }
  async init() {
    const response = await this.request(1, "initialize", { processId: null, rootUri: "file:///ws", capabilities: {} });
    this.send({ method: "initialized", params: {} });
    return response;
  }
  statuses() {
    const last = [...this.received].reverse().find((m) => m.method === "$/lodestar/servers");
    return (last?.params.servers ?? []) as { id: string; key: string; state: string; reason?: string; dir: string | null }[];
  }
  diagnosticsOf(uri: string) {
    const last = [...this.received].reverse().find((m) => m.method === "textDocument/publishDiagnostics" && m.params.uri === uri);
    return (last?.params.diagnostics ?? []) as { message: string }[];
  }
}

const URI = "file:///ws/app/a.tsx";
const OUTSIDE = "file:///ws/other/b.tsx";
const GQL = "file:///ws/app/q.graphql";
const open = (browser: Browser, uri: string, text: string, languageId = "typescriptreact") =>
  browser.send({ method: "textDocument/didOpen", params: { textDocument: { uri, languageId, version: 1, text } } });

// Relay 역할: 첫 문서를 받은 뒤 일정 시간이 지나야 준비 신호(window/showStatus 요청)를 보낸다.
function relayHandler(caps: Record<string, unknown>, answers: Record<string, (message: Msg) => unknown> = {}, readyAfterMs = 40): Handler {
  const base = tsHandler(caps, answers);
  let signaled = false;
  return (message, server) => {
    base(message, server);
    if (message.method === "textDocument/didOpen" && !signaled) {
      signaled = true;
      setTimeout(() => server.push({ id: 900, method: "window/showStatus", params: { message: "The Relay extension is ready", type: 3 } }), readyAfterMs);
    }
  };
}
const isReady = (message: Msg) => message.method === "window/showStatus" && /ready/i.test(String(message.params?.message));

const TS_CAPS = { textDocumentSync: { openClose: true, change: 2 }, hoverProvider: true, referencesProvider: true, completionProvider: { triggerCharacters: ["."] }, definitionProvider: true };
const RELAY_CAPS = { textDocumentSync: { openClose: true, change: 1 }, hoverProvider: true, referencesProvider: true, definitionProvider: true, completionProvider: { resolveProvider: true }, renameProvider: true };

function setup(options: { tsCaps?: Record<string, unknown>; tsAnswers?: Record<string, (m: Msg) => unknown>; relayAnswers?: Record<string, (m: Msg) => unknown>; relayCaps?: Record<string, unknown>; readyAfterMs?: number; muxOptions?: { graceMs?: number; requestTimeoutMs?: number }; relayExtra?: Partial<ChildDef> } = {}) {
  const ts = new FakeServer("typescript", tsHandler(options.tsCaps ?? TS_CAPS, options.tsAnswers));
  const relay = new FakeServer("relay", relayHandler(options.relayCaps ?? RELAY_CAPS, options.relayAnswers, options.readyAfterMs));
  const defs = [
    ts.def({ key: "typescript", primary: true, eager: true }),
    relay.def({ key: "relay:/ws/app", languages: ["typescript", "typescriptreact", "javascript", "graphql"], dir: "/ws/app", rootDir: "/ws/app", staticCapabilities: { hoverProvider: true, referencesProvider: true, definitionProvider: true, renameProvider: true, completionProvider: { resolveProvider: true } }, isReadySignal: isReady, ...options.relayExtra }),
  ];
  return { ts, relay, browser: new Browser(defs, options.muxOptions) };
}

// 1. initialize: 주 서버의 기능에 Relay 의 정적 기능을 더하고, 동기화 종류와 triggerCharacters 는 주 서버 것
{
  const { ts, relay, browser } = setup();
  const response = await browser.init();
  const caps = response.result.capabilities;
  check("initialize: 응답 id 는 브라우저의 id", response.id === 1);
  check("initialize: 주 서버만 initialize 를 받고 Relay 는 아직 안 뜸", ts.methods("initialize").length === 1 && relay.starts === 0);
  check("initialize: textDocumentSync 와 triggerCharacters 는 주 서버 것", caps.textDocumentSync.change === 2 && json(caps.completionProvider.triggerCharacters) === '["."]');
  check("initialize: 주 서버에 없고 Relay 만 가진 renameProvider 를 더함", caps.renameProvider === true);
  check("initialize: 한쪽이라도 resolve 를 하면 resolveProvider 를 켬", caps.completionProvider.resolveProvider === true);
  check("initialize: 서버 상태 알림에 Relay 는 idle", json(browser.statuses().map((s) => `${s.id}:${s.state}`)) === '["typescript:ready","relay:idle"]', json(browser.statuses()));
  check("initialize: 상태에 dir 이 실림", browser.statuses()[1]?.dir === "/ws/app");
  browser.mux.dispose();
}

// 2. 요청 id 재매핑 (브라우저 -> 서버): 서로 다른 id 공간, 순서가 뒤바뀐 응답
{
  const delayed: Msg[] = [];
  const { ts, relay, browser } = setup({
    tsAnswers: { "textDocument/hover": (m) => (delayed.push(m), NO_ANSWER) },
    relayAnswers: { "textDocument/hover": (m) => ({ contents: `relay saw id ${m.id}` }) },
  });
  await browser.init();
  open(browser, URI, "const a = 1");
  await browser.until(() => relay.methods("textDocument/didOpen").length === 1, "relay didOpen");
  await browser.until(() => browser.statuses()[1]?.state === "ready", "relay ready");
  browser.send({ id: 500, method: "textDocument/hover", params: { textDocument: { uri: URI }, position: { line: 0, character: 1 } } });
  browser.send({ id: 501, method: "textDocument/hover", params: { textDocument: { uri: URI }, position: { line: 0, character: 2 } } });
  await browser.until(() => delayed.length === 2, "ts 가 두 요청을 받음");
  const relayIds = relay.methods("textDocument/hover").map((m) => m.id);
  check("id 재매핑: 자식은 브라우저 id 를 모르고 자기 번호를 받음", relayIds.every((id) => typeof id === "number" && id !== 500 && id !== 501) && relayIds.length === 2, json(relayIds));
  // TS 가 501 을 먼저, 500 을 나중에 답한다
  ts.reply(delayed[1]!.id, { contents: "ts second" });
  ts.reply(delayed[0]!.id, { contents: "ts first" });
  await browser.until(() => !!browser.response(500) && !!browser.response(501), "두 응답");
  const a = json(browser.response(500)!.result);
  const b = json(browser.response(501)!.result);
  check("id 재매핑: 응답이 각자 자기 요청에 돌아감", a.includes("ts first") && a.includes(`relay saw id ${relayIds[0]}`) && b.includes("ts second") && b.includes(`relay saw id ${relayIds[1]}`), `${a} | ${b}`);
  check("hover 병합: 마크다운 한 덩어리로 이음", browser.response(500)!.result.contents.kind === "markdown");
  browser.mux.dispose();
}

// 3. 서버 -> 브라우저 요청의 id 재매핑 (workspace/configuration, client/registerCapability, window/workDoneProgress/create)
{
  const { ts, relay, browser } = setup();
  await browser.init();
  open(browser, URI, "x");
  await browser.until(() => browser.statuses()[1]?.state === "ready", "relay ready");
  ts.push({ id: 1, method: "workspace/configuration", params: { items: [{ section: "typescript" }] } });
  relay.push({ id: 1, method: "client/registerCapability", params: { registrations: [] } });
  relay.push({ id: 2, method: "window/workDoneProgress/create", params: { token: "t" } });
  await browser.until(() => browser.received.filter((m) => m.method && m.id !== undefined && m.method !== "window/showStatus").length === 3, "서버 요청 3개");
  const ids = browser.received.filter((m) => m.method && m.id !== undefined).map((m) => m.id);
  check("서버 요청: 같은 번호(1)가 두 서버에서 와도 브라우저에는 서로 다른 id", new Set(ids).size === 3 && ids.every((id) => typeof id === "string" && id.startsWith("mux-")), json(ids));
  const configId = browser.received.find((m) => m.method === "workspace/configuration")!.id!;
  const registerId = browser.received.find((m) => m.method === "client/registerCapability")!.id!;
  const progressId = browser.received.find((m) => m.method === "window/workDoneProgress/create")!.id!;
  browser.send({ id: registerId, result: null });
  browser.send({ id: configId, result: [{ strict: true }] });
  browser.send({ id: progressId, error: { code: -32601, message: "nope" } });
  await browser.until(() => ts.received.some((m) => m.id === 1 && m.result) && relay.received.filter((m) => m.method === undefined).length >= 2, "응답이 각 서버로");
  check("서버 요청: 응답이 요청한 서버에게 원래 id 로 돌아감", json(ts.received.find((m) => m.id === 1 && m.method === undefined)) .includes("strict") && relay.received.some((m) => m.id === 1 && m.method === undefined && m.result === null));
  check("서버 요청: 오류 응답도 원래 id 로 전달", relay.received.some((m) => m.id === 2 && m.method === undefined && m.error?.code === -32601));
  check("서버 요청: 다른 서버에는 새지 않음", !relay.received.some((m) => m.id === 1 && json(m).includes("strict")));
  browser.mux.dispose();
}

// 4. 동기화 종류 변환: 주 서버(증분)는 브라우저가 보낸 그대로, Relay(전체)는 데몬이 들고 있는 글, 동기화 안 받는 서버는 건너뜀
{
  const ts = new FakeServer("typescript", tsHandler(TS_CAPS));
  const full = new FakeServer("relay", relayHandler(RELAY_CAPS));
  const none = new FakeServer("none", relayHandler({ hoverProvider: true }));
  const defs = [
    ts.def({ key: "typescript", primary: true, eager: true }),
    full.def({ key: "relay", dir: "/ws/app", rootDir: "/ws/app", isReadySignal: isReady }),
    none.def({ key: "none", dir: "/ws/app", rootDir: "/ws/app" }),
  ];
  const browser = new Browser(defs);
  await browser.init();
  open(browser, URI, "line one\nline two\n");
  await browser.until(() => full.methods("textDocument/didOpen").length === 1 && none.methods("textDocument/didOpen").length === 1, "didOpen");
  browser.send({ method: "textDocument/didChange", params: { textDocument: { uri: URI, version: 2 }, contentChanges: [{ range: { start: { line: 1, character: 5 }, end: { line: 1, character: 8 } }, text: "TWO" }] } });
  browser.send({ method: "textDocument/didChange", params: { textDocument: { uri: URI, version: 3 }, contentChanges: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, text: "// " }] } });
  await browser.until(() => full.methods("textDocument/didChange").length === 2, "relay didChange");
  const tsChange = ts.methods("textDocument/didChange")[0]!.params;
  check("동기화: 주 서버는 브라우저의 증분 변경 그대로", tsChange.contentChanges[0].range.start.line === 1 && tsChange.contentChanges[0].text === "TWO");
  const last = full.methods("textDocument/didChange")[1]!.params;
  check("동기화: 전체 동기화 서버는 변경이 쌓인 전체 글을 받음", last.contentChanges.length === 1 && !last.contentChanges[0].range && last.contentChanges[0].text === "// line one\nline TWO\n" && last.textDocument.version === 3, json(last));
  check("동기화: 동기화 안 받는 서버(0)에는 didChange 없음", none.methods("textDocument/didChange").length === 0);
  // 닫으면 모두에게 didClose, 이후 변경은 무시
  browser.send({ method: "textDocument/didClose", params: { textDocument: { uri: URI } } });
  await browser.until(() => full.methods("textDocument/didClose").length === 1, "didClose");
  check("동기화: didClose 는 연 서버 모두에게", ts.methods("textDocument/didClose").length === 1 && none.methods("textDocument/didClose").length === 1);
  browser.mux.dispose();
}

// 5. 담당 문서: 경로 범위 밖과 담당 언어가 아닌 문서는 해당 서버에 가지 않음
{
  const { ts, relay, browser } = setup();
  await browser.init();
  open(browser, OUTSIDE, "outside");
  open(browser, "file:///ws/app/style.css", "a{}", "css");
  open(browser, GQL, "query Q { me { id } }", "graphql");
  await sleep(100);
  check("담당: 범위 밖 파일은 Relay 를 띄우지 않음", relay.methods("textDocument/didOpen").every((m) => m.params.textDocument.uri !== OUTSIDE));
  check("담당: css 는 어느 서버도 받지 않음", ts.methods("textDocument/didOpen").every((m) => !String(m.params.textDocument.uri).endsWith(".css")) && relay.methods("textDocument/didOpen").every((m) => !String(m.params.textDocument.uri).endsWith(".css")));
  await browser.until(() => relay.methods("textDocument/didOpen").length === 1, "relay graphql didOpen");
  check("담당: graphql 문서는 Relay 만 받음", relay.methods("textDocument/didOpen")[0]!.params.textDocument.uri === GQL && ts.methods("textDocument/didOpen").every((m) => m.params.textDocument.uri !== GQL));
  // 범위 밖 TS 문서의 hover 는 주 서버에만
  const hover = await browser.request(20, "textDocument/hover", { textDocument: { uri: OUTSIDE }, position: { line: 0, character: 0 } });
  check("담당: 범위 밖 문서의 요청은 Relay 에 안 감", relay.methods("textDocument/hover").length === 0 && hover.id === 20);
  browser.mux.dispose();
}

// 6. 지연 시작과 준비 신호: 첫 문서에 서버를 띄우고, 문서는 준비 전에 열어 주되 요청은 준비될 때까지 붙든다
{
  const { relay, browser } = setup({ relayAnswers: { "textDocument/hover": () => ({ contents: "relay hover" }) }, readyAfterMs: 150 });
  await browser.init();
  check("지연 시작: 문서를 열기 전에는 Relay 프로세스가 없음", relay.starts === 0);
  open(browser, URI, "doc");
  await browser.until(() => relay.starts === 1 && relay.methods("textDocument/didOpen").length === 1, "relay 시작과 didOpen");
  check("지연 시작: 준비 전에 문서를 열어 줌", browser.statuses()[1]?.state === "starting", json(browser.statuses()));
  check("지연 시작: 초기화는 문서가 든 폴더를 rootUri 로", relay.methods("initialize")[0]!.params.rootUri === "file:///ws/app" && relay.methods("initialize")[0]!.params.workspaceFolders[0].uri === "file:///ws/app");
  check("지연 시작: initialize 뒤 initialized 를 데몬이 보냄", relay.methods("initialized").length === 1);
  const started = Date.now();
  const hover = await browser.request(30, "textDocument/hover", { textDocument: { uri: URI }, position: { line: 0, character: 0 } });
  check("준비 신호: 요청이 준비될 때까지 붙들렸다가 응답", Date.now() - started >= 100 && json(hover.result).includes("relay hover"), `${Date.now() - started}ms`);
  check("준비 신호: window/showStatus 요청에는 데몬이 답하고 브라우저에는 안 감", relay.received.some((m) => m.id === 900 && m.result === null) && !browser.received.some((m) => m.method === "window/showStatus"));
  check("준비 신호: 상태가 ready", browser.statuses()[1]?.state === "ready");
  browser.mux.dispose();
}

// 7. 따라잡기: 서버가 초기화되는 동안 열고 고친 문서는 최신 글로 열린다
{
  const { relay, browser } = setup({ readyAfterMs: 20 });
  // 첫 initialize 응답을 늦춘다
  const original = relay.handler;
  relay.handler = (message, server) => {
    if (message.method === "initialize") return void setTimeout(() => original(message, server), 120);
    original(message, server);
  };
  await browser.init();
  open(browser, URI, "first");
  await browser.until(() => relay.starts === 1, "relay 시작");
  open(browser, "file:///ws/app/b.tsx", "second", "typescriptreact");
  browser.send({ method: "textDocument/didChange", params: { textDocument: { uri: URI, version: 2 }, contentChanges: [{ text: "first edited" }] } });
  await browser.until(() => relay.methods("textDocument/didOpen").length === 2, "따라잡기 didOpen 두 개", 4000);
  const opens = relay.methods("textDocument/didOpen").map((m) => `${m.params.textDocument.uri.split("/").pop()}=${m.params.textDocument.text}@${m.params.textDocument.version}`).sort();
  check("따라잡기: 늦게 뜬 서버가 열린 문서를 현재 글로 받음", json(opens) === json(["a.tsx=first edited@2", "b.tsx=second@1"]), json(opens));
  check("따라잡기: 초기화 전에 도착한 didChange 가 중복 전달되지 않음", relay.methods("textDocument/didChange").length === 0, String(relay.methods("textDocument/didChange").length));
  browser.mux.dispose();
}

// 8. 진단: (uri, 서버)로 들고 합쳐 다시 발행
{
  const { ts, relay, browser } = setup();
  await browser.init();
  open(browser, URI, "doc");
  await browser.until(() => browser.statuses()[1]?.state === "ready", "relay ready");
  ts.push({ method: "textDocument/publishDiagnostics", params: { uri: URI, version: 1, diagnostics: [{ message: "ts error" }] } });
  relay.push({ method: "textDocument/publishDiagnostics", params: { uri: URI, version: 1, diagnostics: [{ message: "relay error" }] } });
  check("진단: 두 서버의 진단이 한 목록으로 (주 서버 먼저)", json(browser.diagnosticsOf(URI).map((d) => d.message)) === '["ts error","relay error"]', json(browser.diagnosticsOf(URI)));
  ts.push({ method: "textDocument/publishDiagnostics", params: { uri: URI, version: 2, diagnostics: [] } });
  check("진단: 한 서버가 비워도 다른 서버 진단은 남음", json(browser.diagnosticsOf(URI).map((d) => d.message)) === '["relay error"]');
  const last = [...browser.received].reverse().find((m) => m.method === "textDocument/publishDiagnostics")!;
  check("진단: 버전은 가장 새것", last.params.version === 2);
  ts.push({ method: "textDocument/publishDiagnostics", params: { uri: URI, version: 3, diagnostics: [{ message: "ts again" }] } });
  relay.callbacks.exit("relay crashed");
  check("진단: 서버가 죽으면 그 서버 진단만 걷어 다시 발행", json(browser.diagnosticsOf(URI).map((d) => d.message)) === '["ts again"]', json(browser.diagnosticsOf(URI)));
  browser.mux.dispose();
}

// 9. completion: isIncomplete OR, data 를 서버 키로 감싸고 resolve 를 맞는 서버로 보내 원래 data 로 풀어서 전달
{
  const { ts, relay, browser } = setup({
    tsCaps: { ...TS_CAPS, completionProvider: { triggerCharacters: ["."], resolveProvider: true } },
    tsAnswers: {
      "textDocument/completion": () => ({ isIncomplete: false, items: [{ label: "tsItem", data: { file: "a.ts", n: 1 } }, { label: "noData" }] }),
      "completionItem/resolve": (m) => ({ ...m.params, documentation: "from ts" }),
    },
    relayAnswers: {
      "textDocument/completion": () => ({ isIncomplete: true, items: [{ label: "relayField", data: "opaque" }], itemDefaults: { data: "default-data", commitCharacters: ["."] } }),
      "completionItem/resolve": (m) => ({ ...m.params, documentation: "from relay" }),
    },
  });
  await browser.init();
  open(browser, URI, "doc");
  await browser.until(() => browser.statuses()[1]?.state === "ready", "relay ready");
  const response = await browser.request(40, "textDocument/completion", { textDocument: { uri: URI }, position: { line: 0, character: 0 } });
  const items = response.result.items as { label: string; data: { __mux: string; data: unknown }; commitCharacters?: string[] }[];
  check("completion: 두 서버 항목을 한 목록으로", json(items.map((i) => i.label)) === '["tsItem","noData","relayField"]');
  check("completion: isIncomplete 는 OR", response.result.isIncomplete === true);
  check("completion: 항목 data 를 서버 키로 감쌈", items[0]!.data.__mux === "typescript" && json(items[0]!.data.data) === '{"file":"a.ts","n":1}' && items[2]!.data.__mux === "relay:/ws/app" && items[2]!.data.data === "opaque", json(items.map((i) => i.data)));
  check("completion: data 가 없는 항목도 감쌈", items[1]!.data.__mux === "typescript" && items[1]!.data.data === undefined);
  check("completion: 목록이 여럿이면 itemDefaults 를 항목으로 펼침", json(items[2]!.commitCharacters) === '["."]');
  const resolvedRelay = await browser.request(41, "completionItem/resolve", items[2]);
  const relayResolve = relay.methods("completionItem/resolve")[0]!.params;
  check("resolve: Relay 항목은 Relay 로만, data 는 원래 값으로", relay.methods("completionItem/resolve").length === 1 && ts.methods("completionItem/resolve").length === 0 && relayResolve.data === "opaque" && relayResolve.label === "relayField", json(relayResolve));
  check("resolve: 응답의 data 도 원래 값(감싸이지 않음)", resolvedRelay.result.documentation === "from relay" && resolvedRelay.result.data === "opaque");
  const resolvedTs = await browser.request(42, "completionItem/resolve", items[0]);
  check("resolve: TS 항목은 TS 로, data 는 원래 객체", ts.methods("completionItem/resolve").length === 1 && json(ts.methods("completionItem/resolve")[0]!.params.data) === '{"file":"a.ts","n":1}' && resolvedTs.result.documentation === "from ts");
  const resolvedNoData = await browser.request(43, "completionItem/resolve", items[1]);
  check("resolve: data 가 없던 항목은 data 속성 없이 전달", !("data" in ts.methods("completionItem/resolve")[1]!.params) && resolvedNoData.result.documentation === "from ts");
  // 감싸이지 않은 항목(예: 예전 캐시)은 주 서버로
  await browser.request(44, "completionItem/resolve", { label: "raw", data: { x: 1 } });
  check("resolve: 감싸이지 않은 항목은 주 서버로", ts.methods("completionItem/resolve").length === 3);
  browser.mux.dispose();
}
// 9b. resolve 를 못 하는 서버의 항목은 서버에 묻지 않고 받은 그대로(data 만 되돌려) 돌려줌
{
  const { ts, browser } = setup({ tsAnswers: { "textDocument/completion": () => ({ items: [{ label: "plain", data: 7 }] }) } });
  await browser.init();
  open(browser, URI, "doc");
  const list = await browser.request(46, "textDocument/completion", { textDocument: { uri: URI }, position: { line: 0, character: 0 } });
  const resolved = await browser.request(47, "completionItem/resolve", list.result.items[0]);
  check("resolve: resolveProvider 없는 서버는 묻지 않고 data 를 되돌려 응답", ts.methods("completionItem/resolve").length === 0 && resolved.result.data === 7 && resolved.result.label === "plain", json(resolved.result));
  browser.mux.dispose();
}

// 10. 한 서버가 오류이거나 답하지 않아도 나머지 결과는 돌려줌
{
  const { ts, relay, browser } = setup({
    tsAnswers: { "textDocument/definition": () => [{ uri: "file:///ws/app/def.ts", range: { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } } }] },
    relayAnswers: { "textDocument/definition": () => NO_ANSWER, "textDocument/hover": () => NO_ANSWER },
    muxOptions: { graceMs: 80, requestTimeoutMs: 400 },
  });
  await browser.init();
  open(browser, URI, "doc");
  await browser.until(() => browser.statuses()[1]?.state === "ready", "relay ready");
  const started = Date.now();
  const definition = await browser.request(50, "textDocument/definition", { textDocument: { uri: URI }, position: { line: 0, character: 0 } });
  check("무응답: 내용이 있는 결과 뒤 grace 만 더 기다리고 나머지 결과를 돌려줌", json(definition.result).includes("def.ts") && Date.now() - started < 300, `${Date.now() - started}ms`);
  await browser.until(() => relay.methods("$/cancelRequest").length >= 1, "무응답 서버에 취소 전달");
  check("무응답: 답하지 않은 서버에 $/cancelRequest", relay.methods("$/cancelRequest").length >= 1);
  // 오류 응답
  relay.handler = (message, server) => {
    if (message.method === "textDocument/references") server.push({ id: message.id, error: { code: -32001, message: "schema is missing" } });
    else if (message.method === "textDocument/hover") server.push({ id: message.id, error: { code: -32001, message: "schema is missing" } });
  };
  ts.handler = (message, server) => {
    if (message.method === "textDocument/hover") server.reply(message.id, { contents: "ts only" });
    if (message.method === "textDocument/references") server.reply(message.id, [{ uri: "file:///ws/app/ref.ts", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }]);
  };
  const hover = await browser.request(51, "textDocument/hover", { textDocument: { uri: URI }, position: { line: 0, character: 0 } });
  check("오류: 한 서버가 오류여도 나머지 hover 를 돌려줌", hover.error === undefined && json(hover.result).includes("ts only"), json(hover));
  const refs = await browser.request(52, "textDocument/references", { textDocument: { uri: URI }, position: { line: 0, character: 0 }, context: { includeDeclaration: true } });
  check("오류: references 도 나머지 결과", json(refs.result).includes("ref.ts"));
  // 모두 답이 없으면 데드라인에 null
  ts.handler = () => {};
  relay.handler = () => {};
  const t0 = Date.now();
  const none = await browser.request(53, "textDocument/hover", { textDocument: { uri: URI }, position: { line: 0, character: 0 } });
  check("타임아웃: 모두 답하지 않으면 데드라인에 null", none.result === null && Date.now() - t0 >= 350, `${Date.now() - t0}ms`);
  browser.mux.dispose();
}

// 11. 위치 결과 병합: 같은 위치는 한 번만
{
  const same = { uri: "file:///ws/app/same.ts", range: { start: { line: 3, character: 0 }, end: { line: 3, character: 4 } } };
  const { browser } = setup({
    tsAnswers: { "textDocument/definition": () => [same] },
    relayAnswers: { "textDocument/definition": () => [same, { uri: "file:///ws/app/other.ts", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } }] },
  });
  await browser.init();
  open(browser, URI, "doc");
  await browser.until(() => browser.statuses()[1]?.state === "ready", "relay ready");
  const response = await browser.request(60, "textDocument/definition", { textDocument: { uri: URI }, position: { line: 0, character: 0 } });
  check("definition 병합: 중복 위치 제거", (response.result as unknown[]).length === 2, json(response.result));
  browser.mux.dispose();
}

// 12. 자식 하나(Relay)가 죽어도 나머지 유지
{
  const { ts, relay, browser } = setup({ relayAnswers: { "textDocument/hover": () => NO_ANSWER } });
  ts.handler = tsHandler(TS_CAPS, { "textDocument/hover": () => ({ contents: "ts alive" }), "textDocument/definition": () => [{ uri: "file:///ws/app/d.ts", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }] });
  await browser.init();
  open(browser, URI, "doc");
  await browser.until(() => browser.statuses()[1]?.state === "ready", "relay ready");
  browser.send({ id: 70, method: "textDocument/hover", params: { textDocument: { uri: URI }, position: { line: 0, character: 0 } } });
  await browser.until(() => relay.methods("textDocument/hover").length === 1, "relay 가 hover 를 받음");
  relay.callbacks.exit("exited with code 1");
  await browser.until(() => !!browser.response(70), "hover 응답");
  check("자식 사망: 진행 중이던 요청은 남은 서버 결과로 응답", json(browser.response(70)!.result).includes("ts alive") && browser.response(70)!.error === undefined);
  check("자식 사망: 상태가 failed 와 이유", browser.statuses()[1]?.state === "failed" && browser.statuses()[1]?.reason === "exited with code 1", json(browser.statuses()));
  check("자식 사망: 연결은 유지", browser.closed === null);
  const definition = await browser.request(71, "textDocument/definition", { textDocument: { uri: URI }, position: { line: 0, character: 0 } });
  check("자식 사망: 이후 요청은 죽은 서버를 건너뜀", json(definition.result).includes("d.ts") && relay.methods("textDocument/definition").length === 0);
  browser.send({ method: "textDocument/didChange", params: { textDocument: { uri: URI, version: 2 }, contentChanges: [{ text: "changed" }] } });
  await sleep(50);
  check("자식 사망: 죽은 서버로 didChange 를 보내지 않음", relay.methods("textDocument/didChange").length === 0 && ts.methods("textDocument/didChange").length === 1);
  browser.mux.dispose();
}

// 13. 시작 실패(프로세스 없이 곧바로 exit)와 준비 시간 초과
{
  const { browser, relay } = setup({ relayExtra: { readyTimeoutMs: 120 }, readyAfterMs: 5000 });
  await browser.init();
  open(browser, URI, "doc");
  await browser.until(() => browser.statuses()[1]?.state === "failed", "준비 시간 초과", 2000);
  check("준비 시간 초과: 이유와 함께 failed", /did not become ready/.test(browser.statuses()[1]?.reason ?? ""), json(browser.statuses()));
  check("준비 시간 초과: 프로세스를 정리함", relay.stopped);
  const hover = await browser.request(80, "textDocument/hover", { textDocument: { uri: URI }, position: { line: 0, character: 0 } });
  check("준비 시간 초과: 이후 요청은 주 서버만(여기선 응답 없음 = null)", hover.result === null);
  browser.mux.dispose();
}
{
  const ts = new FakeServer("typescript", tsHandler(TS_CAPS, { "textDocument/hover": () => ({ contents: "ts" }) }));
  let problem: FakeServer | null = null;
  const defs = [
    ts.def({ key: "typescript", primary: true, eager: true }),
    {
      key: "relay:/ws/app",
      serverId: "relay",
      label: "Relay",
      languages: ["typescriptreact"],
      dir: "/ws/app",
      rootDir: "/ws/app",
      staticCapabilities: { hoverProvider: true },
      start: (callbacks: LinkCallbacks): ChildLink => {
        queueMicrotask(() => callbacks.exit("Could not find node_modules/relay-compiler"));
        problem = new FakeServer("problem", () => {});
        return { send: () => {}, stop: () => {} };
      },
    } satisfies ChildDef,
  ];
  const browser = new Browser(defs);
  await browser.init();
  open(browser, URI, "doc");
  await browser.until(() => browser.statuses()[1]?.state === "failed", "시작 불가");
  const hover = await browser.request(81, "textDocument/hover", { textDocument: { uri: URI }, position: { line: 0, character: 0 } });
  check("시작 불가: 이유가 상태에 남고 주 서버 결과는 그대로", browser.statuses()[1]?.reason === "Could not find node_modules/relay-compiler" && json(hover.result).includes("ts") && problem !== null);
  browser.mux.dispose();
}

// 14. 주 서버가 죽으면 연결을 닫고 모든 자식을 정리, dispose 도 모든 자식을 정리
{
  const { ts, relay, browser } = setup();
  await browser.init();
  open(browser, URI, "doc");
  await browser.until(() => browser.statuses()[1]?.state === "ready", "relay ready");
  ts.callbacks.exit("language server exited");
  check("주 서버 사망: 브라우저 연결을 1011 로 닫음", browser.closed?.code === 1011);
  check("주 서버 사망: Relay 도 정리", relay.stopped);
}
{
  const { ts, relay, browser } = setup();
  await browser.init();
  open(browser, URI, "doc");
  await browser.until(() => browser.statuses()[1]?.state === "ready", "relay ready");
  browser.mux.dispose();
  check("연결 종료: 모든 자식 정리", ts.stopped && relay.stopped);
  const before = ts.received.length;
  browser.send({ id: 90, method: "textDocument/hover", params: { textDocument: { uri: URI }, position: { line: 0, character: 0 } } });
  check("연결 종료: 이후 메시지는 무시", ts.received.length === before);
}

// 15. shutdown 은 떠 있는 서버 모두에게, 아직 안 뜬 서버는 띄우지 않음
{
  const { ts, relay, browser } = setup({ tsAnswers: { shutdown: () => null } });
  await browser.init();
  const response = await browser.request(95, "shutdown", null);
  check("shutdown: 응답하고 안 뜬 Relay 는 띄우지 않음", response.result === null && relay.starts === 0 && ts.methods("shutdown").length === 1);
  browser.mux.dispose();
}

console.log(failed === 0 ? "all passed" : `${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
