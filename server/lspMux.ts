import { fileURLToPath, pathToFileURL } from "node:url";
import { applyContentChanges, expandItemDefaults, isEmptyResult, mergeCapabilities, mergeDiagnostics, mergeHover, mergeLocations, textDocumentSyncOf, uriOf, type SyncInfo } from "./lspMerge";

// 브라우저의 LSP 연결 하나를 받아 여러 언어 서버(자식)에 나눠 보내고, 응답과 알림을 하나의 서버처럼 합쳐 돌려주는 멀티플렉서.
// 자식 프로세스는 직접 띄우지 않는다. 레지스트리(server/lspRegistry.ts)가 만든 ChildDef.start 가 연결(ChildLink)을 준다.
// @codemirror/lsp-client 는 에디터 뷰마다 LSPPlugin 하나만 붙여서, 같은 .tsx 에 TypeScript 와 Relay 를 함께 붙이려면 서버 쪽에서 합쳐야 한다.

export type Msg = { jsonrpc?: "2.0"; id?: number | string; method?: string; params?: any; result?: any; error?: any };

export type LinkCallbacks = {
  message(text: string): void;
  // 자식이 끝났다. 시작 실패와 죽음 모두 이 한 가지로 알린다.
  exit(reason: string): void;
};

export type ChildLink = { send(text: string): void; stop(): void };

export type ChildDef = {
  // 같은 레지스트리 항목의 자식이 여럿일 수 있어(Relay 는 relay config 폴더마다) 자식마다 고유한 키.
  key: string;
  serverId: string;
  label: string;
  // 브라우저에 돌려줄 initialize 결과의 기준이 되는 서버. 이 서버가 죽으면 연결을 닫는다.
  primary?: boolean;
  // true 면 연결 직후 시작한다. false 면 담당 문서가 처음 열릴 때 시작한다.
  eager?: boolean;
  // 담당 문서의 languageId 와 경로 범위(null 이면 모든 경로).
  languages: readonly string[];
  dir: string | null;
  // 지연 시작 서버의 initialize rootUri 로 쓸 폴더.
  rootDir: string | null;
  // 지연 시작 서버가 뜨기 전에도 라우팅이 알 수 있는 기능(initialize 결과와 같은 모양의 일부).
  staticCapabilities?: Record<string, unknown>;
  // initialize 응답 뒤에도 서버가 준비를 끝내기 전에는 요청을 못 받는 서버(Relay)의 준비 신호. 없으면 initialize 응답이 곧 준비다.
  isReadySignal?: (message: Msg) => boolean;
  readyTimeoutMs?: number;
  start(callbacks: LinkCallbacks): ChildLink;
};

export type ServerState = "idle" | "starting" | "ready" | "failed";
export type ServerStatus = { key: string; id: string; label: string; primary: boolean; state: ServerState; dir: string | null; reason?: string };

export type MuxOptions = {
  toBrowser(text: string): void;
  closeBrowser(code: number, reason: string): void;
  // 내용이 있는 응답이 하나 온 뒤 나머지 서버를 더 기다려 주는 시간.
  graceMs?: number;
  // 요청 하나가 서버를 기다리는 최대 시간.
  requestTimeoutMs?: number;
};

type ChildState = "idle" | "initializing" | "warming" | "ready" | "dead";

type Child = {
  def: ChildDef;
  state: ChildState;
  link: ChildLink | null;
  capabilities: Record<string, any> | null;
  sync: SyncInfo;
  nextId: number;
  initId: number | null;
  queue: Part[];
  failure: string | null;
  warmTimer: ReturnType<typeof setTimeout> | null;
};

type MergeKind = "first" | "hover" | "locations" | "completion" | "codeActions" | "concat" | "resolve" | "all";

type Part = {
  fan: Fan;
  child: Child;
  state: "queued" | "sent" | "done" | "failed";
  childId: number | null;
  params: unknown;
  result?: unknown;
  error?: unknown;
};

type Fan = {
  browserId: number | string;
  method: string;
  merge: MergeKind;
  parts: Part[];
  finished: boolean;
  graceTimer: ReturnType<typeof setTimeout> | null;
  deadlineTimer: ReturnType<typeof setTimeout> | null;
};

type Doc = { uri: string; languageId: string; version: number; text: string; opened: Set<string> };

const ROUTES: Record<string, { capability: string; merge: MergeKind }> = {
  "textDocument/hover": { capability: "hoverProvider", merge: "hover" },
  "textDocument/definition": { capability: "definitionProvider", merge: "locations" },
  "textDocument/declaration": { capability: "declarationProvider", merge: "locations" },
  "textDocument/typeDefinition": { capability: "typeDefinitionProvider", merge: "locations" },
  "textDocument/implementation": { capability: "implementationProvider", merge: "locations" },
  "textDocument/references": { capability: "referencesProvider", merge: "locations" },
  "textDocument/completion": { capability: "completionProvider", merge: "completion" },
  "textDocument/codeAction": { capability: "codeActionProvider", merge: "codeActions" },
  "textDocument/inlayHint": { capability: "inlayHintProvider", merge: "concat" },
  "textDocument/documentHighlight": { capability: "documentHighlightProvider", merge: "first" },
  "textDocument/documentSymbol": { capability: "documentSymbolProvider", merge: "first" },
  "textDocument/foldingRange": { capability: "foldingRangeProvider", merge: "first" },
  "textDocument/signatureHelp": { capability: "signatureHelpProvider", merge: "first" },
  "textDocument/selectionRange": { capability: "selectionRangeProvider", merge: "first" },
  "textDocument/formatting": { capability: "documentFormattingProvider", merge: "first" },
  "textDocument/rangeFormatting": { capability: "documentRangeFormattingProvider", merge: "first" },
  "textDocument/onTypeFormatting": { capability: "documentOnTypeFormattingProvider", merge: "first" },
  "textDocument/rename": { capability: "renameProvider", merge: "first" },
  "textDocument/prepareRename": { capability: "renameProvider", merge: "first" },
  "textDocument/semanticTokens/full": { capability: "semanticTokensProvider", merge: "first" },
  "textDocument/semanticTokens/full/delta": { capability: "semanticTokensProvider", merge: "first" },
  "textDocument/semanticTokens/range": { capability: "semanticTokensProvider", merge: "first" },
  "textDocument/linkedEditingRange": { capability: "linkedEditingRangeProvider", merge: "first" },
  "textDocument/documentLink": { capability: "documentLinkProvider", merge: "first" },
  "textDocument/codeLens": { capability: "codeLensProvider", merge: "first" },
  "workspace/symbol": { capability: "workspaceSymbolProvider", merge: "concat" },
};

const RESOLVE_METHODS = new Set(["completionItem/resolve", "codeAction/resolve"]);
const REQUEST_CANCELLED = { code: -32800, message: "Request cancelled" };
const SERVER_EXITED = { code: -32603, message: "Language server exited" };
const NO_DOC_LANGUAGES: Record<string, string> = { ts: "typescript", mts: "typescript", cts: "typescript", tsx: "typescriptreact", js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascriptreact", graphql: "graphql", gql: "graphql" };

export class LspMultiplexer {
  private children: Child[];
  private docs = new Map<string, Doc>();
  private fans = new Map<number | string, Fan>();
  private serverRequests = new Map<string, { child: Child; id: number | string }>();
  private diagnostics = new Map<string, Map<string, { version: number | null; items: unknown[] }>>();
  private initParams: any = null;
  private browserSync: SyncInfo = { kind: 0, openClose: true, save: false };
  private browserInitId: number | string | null = null;
  private browserInitialized = false;
  private serial = 0;
  private lastStatus = "";
  private disposed = false;
  private graceMs: number;
  private requestTimeoutMs: number;

  constructor(
    defs: ChildDef[],
    private options: MuxOptions,
  ) {
    this.graceMs = options.graceMs ?? 2000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 25_000;
    this.children = defs.map((def) => ({ def, state: "idle", link: null, capabilities: null, sync: { kind: 0, openClose: true, save: false }, nextId: 1, initId: null, queue: [], failure: null, warmTimer: null }));
    for (const child of this.children) if (child.def.eager) this.openLink(child);
  }

  // 브라우저가 보낸 메시지 하나.
  fromBrowser(text: string) {
    if (this.disposed) return;
    let message: Msg;
    try {
      message = JSON.parse(text) as Msg;
    } catch {
      return;
    }
    if (!message || typeof message !== "object") return;
    try {
      if (message.method === undefined) this.onBrowserResponse(message);
      else if (message.id !== undefined) this.onBrowserRequest(message);
      else this.onBrowserNotification(message);
    } catch (error) {
      console.error(`[lsp] mux failed on ${message.method ?? "response"}: ${(error as Error).message}`);
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const fan of [...this.fans.values()]) this.clearFan(fan);
    this.fans.clear();
    for (const child of this.children) {
      if (child.warmTimer) clearTimeout(child.warmTimer);
      child.link?.stop();
    }
  }

  statuses(): ServerStatus[] {
    return this.children.map((child) => ({
      key: child.def.key,
      id: child.def.serverId,
      label: child.def.label,
      primary: !!child.def.primary,
      dir: child.def.dir,
      state: child.state === "dead" ? "failed" : child.state === "idle" ? "idle" : child.state === "ready" ? "ready" : "starting",
      ...(child.failure ? { reason: child.failure } : {}),
    }));
  }

  // --- 브라우저에서 온 요청 ---

  private onBrowserRequest(message: Msg) {
    const method = message.method!;
    if (method === "initialize") return this.initialize(message);
    if (method === "shutdown") return this.startFan(message, "all", this.children.filter((c) => c.state === "ready"));
    if (RESOLVE_METHODS.has(method)) return this.resolveRequest(message);
    if (method === "workspace/executeCommand") return this.startFan(message, "first", this.commandTargets(message.params?.command));
    const route = ROUTES[method];
    if (!route) return this.startFan(message, "first", this.primaryTargets());
    this.startFan(message, route.merge, this.targetsFor(route.capability, message.params));
  }

  private initialize(message: Msg) {
    this.initParams = message.params;
    this.browserInitId = message.id!;
    for (const child of this.children) if (child.def.eager) this.sendInitialize(child);
  }

  // completionItem/resolve 와 codeAction/resolve 는 그 항목을 만든 서버로 간다(항목의 data 에 서버 키를 감싸 두었다).
  private resolveRequest(message: Msg) {
    const item = message.params ?? {};
    const key = item.data?.__mux;
    const child = this.children.find((c) => c.def.key === key) ?? this.children.find((c) => c.def.primary);
    const unwrapped = key ? withData(item, item.data.data) : item;
    const capability = message.method === "codeAction/resolve" ? "codeActionProvider" : "completionProvider";
    // 죽었거나 resolve 를 못 하는 서버의 항목은 받은 그대로(data 만 되돌려) 돌려준다.
    if (!child || child.state === "dead" || (child.capabilities && !child.capabilities[capability]?.resolveProvider)) return this.reply(message.id!, unwrapped);
    this.startFan({ ...message, params: unwrapped }, "resolve", [child]);
  }

  private commandTargets(command: unknown) {
    const owners = this.children.filter((c) => c.state === "ready" && (c.capabilities?.executeCommandProvider?.commands as string[] | undefined)?.includes(String(command)));
    return owners.length ? owners : this.primaryTargets();
  }

  private primaryTargets() {
    return this.children.filter((c) => c.def.primary && c.state !== "dead");
  }

  private targetsFor(capability: string, params: any): Child[] {
    const uri = uriOf(params);
    const doc = uri ? this.docs.get(uri) : undefined;
    const languageId = doc?.languageId ?? (uri ? NO_DOC_LANGUAGES[uri.slice(uri.lastIndexOf(".") + 1).toLowerCase()] : undefined);
    // 어느 언어인지 모르는 문서(모르는 확장자)는 예전처럼 주 서버가 받는다.
    if (uri && !languageId) return this.primaryTargets();
    return this.children.filter((child) => {
      if (child.state === "dead") return false;
      if (uri && !this.handles(child, uri, languageId!)) return false;
      const caps = child.capabilities ?? child.def.staticCapabilities;
      return !!caps?.[capability];
    });
  }

  private handles(child: Child, uri: string, languageId: string) {
    if (!child.def.languages.includes(languageId)) return false;
    if (child.def.dir === null) return true;
    const path = pathOfUri(uri);
    return path !== null && (path === child.def.dir || path.startsWith(`${child.def.dir}/`));
  }

  private startFan(message: Msg, merge: MergeKind, targets: Child[]) {
    const id = message.id!;
    if (targets.length === 0) return this.reply(id, null);
    const fan: Fan = { browserId: id, method: message.method!, merge, parts: [], finished: false, graceTimer: null, deadlineTimer: null };
    this.fans.set(id, fan);
    fan.parts = targets.map((child) => ({ fan, child, state: "queued", childId: null, params: message.params }));
    fan.deadlineTimer = setTimeout(() => this.finish(fan), this.requestTimeoutMs);
    for (const part of fan.parts) this.dispatch(part);
    this.evaluate(fan);
  }

  private dispatch(part: Part) {
    const { child } = part;
    if (child.state === "ready") return this.sendPart(part);
    part.state = "queued";
    child.queue.push(part);
    if (child.state === "idle") this.startLazy(child);
  }

  private sendPart(part: Part) {
    const { child, fan } = part;
    part.childId = child.nextId++;
    part.state = "sent";
    child.link!.send(JSON.stringify({ jsonrpc: "2.0", id: part.childId, method: fan.method, params: part.params }));
  }

  // --- 브라우저에서 온 알림 ---

  private onBrowserNotification(message: Msg) {
    switch (message.method) {
      case "initialized":
        this.browserInitialized = true;
        for (const child of this.children) if (child.def.eager && child.state === "ready") child.link!.send(JSON.stringify(message));
        return;
      case "textDocument/didOpen":
        return this.didOpen(message);
      case "textDocument/didChange":
        return this.didChange(message);
      case "textDocument/didClose":
        return this.didClose(message);
      case "textDocument/didSave":
        return this.forwardToOpened(message, (child) => !!child.def.primary || child.sync.save);
      case "$/cancelRequest":
        return this.cancelRequest(message.params?.id);
      default:
        for (const child of this.children) if (child.state === "ready") child.link!.send(JSON.stringify(message));
    }
  }

  private didOpen(message: Msg) {
    const td = message.params.textDocument;
    const doc: Doc = { uri: td.uri, languageId: td.languageId, version: td.version ?? 0, text: td.text ?? "", opened: new Set() };
    this.docs.set(doc.uri, doc);
    for (const child of this.children) {
      if (child.state === "dead" || !this.handles(child, doc.uri, doc.languageId)) continue;
      if (canSync(child)) this.openOn(child, doc);
      else if (child.state === "idle") this.startLazy(child);
    }
  }

  private openOn(child: Child, doc: Doc) {
    if (doc.opened.has(child.def.key) || !child.sync.openClose) return;
    doc.opened.add(child.def.key);
    child.link!.send(JSON.stringify({ jsonrpc: "2.0", method: "textDocument/didOpen", params: { textDocument: { uri: doc.uri, languageId: doc.languageId, version: doc.version, text: doc.text } } }));
  }

  private didChange(message: Msg) {
    const { textDocument, contentChanges } = message.params;
    const doc = this.docs.get(textDocument.uri);
    if (!doc) return;
    doc.version = textDocument.version ?? doc.version;
    doc.text = applyContentChanges(doc.text, contentChanges ?? []);
    for (const child of this.children) {
      if (!canSync(child) || !doc.opened.has(child.def.key)) continue;
      // 주 서버는 브라우저가 보낸 그대로 받는다(브라우저는 이 서버의 동기화 종류에 맞춰 변경을 만든다).
      // 다른 서버가 전체 동기화(1)만 받으면 우리가 들고 있는 전체 글을 보낸다. 증분(2)을 받는 서버는 받은 변경을 그대로 받는다(전체 글 변경도 증분 모드에서 유효하다). 동기화를 안 받는 서버(0)는 건너뛴다.
      if (!child.def.primary && child.sync.kind === 0) continue;
      const params = !child.def.primary && child.sync.kind === 1 ? { textDocument, contentChanges: [{ text: doc.text }] } : message.params;
      child.link!.send(JSON.stringify({ jsonrpc: "2.0", method: "textDocument/didChange", params }));
    }
  }

  private didClose(message: Msg) {
    const uri = message.params.textDocument.uri;
    this.forwardToOpened(message, () => true);
    this.docs.delete(uri);
    this.diagnostics.delete(uri);
  }

  private forwardToOpened(message: Msg, wants: (child: Child) => boolean) {
    const doc = this.docs.get(message.params?.textDocument?.uri);
    if (!doc) return;
    for (const child of this.children) {
      if (canSync(child) && doc.opened.has(child.def.key) && wants(child)) child.link!.send(JSON.stringify(message));
    }
  }

  private cancelRequest(id: unknown) {
    const fan = this.fans.get(id as number | string);
    if (!fan) return;
    this.reply(fan.browserId, undefined, REQUEST_CANCELLED);
    this.finish(fan, false);
  }

  private onBrowserResponse(message: Msg) {
    const pending = this.serverRequests.get(String(message.id));
    if (!pending) return;
    this.serverRequests.delete(String(message.id));
    if (pending.child.state === "dead") return;
    pending.child.link?.send(JSON.stringify({ jsonrpc: "2.0", id: pending.id, ...(message.error ? { error: message.error } : { result: message.result ?? null }) }));
  }

  // --- 자식 시작과 준비 ---

  private openLink(child: Child) {
    if (child.link) return;
    child.link = child.def.start({
      message: (text) => this.fromChild(child, text),
      exit: (reason) => this.childExited(child, reason),
    });
  }

  private startLazy(child: Child) {
    if (child.state !== "idle" || !this.initParams) return;
    this.openLink(child);
    this.sendInitialize(child);
  }

  private sendInitialize(child: Child) {
    child.state = "initializing";
    child.initId = child.nextId++;
    const params = child.def.eager ? this.initParams : lazyInitializeParams(this.initParams, child.def);
    child.link!.send(JSON.stringify({ jsonrpc: "2.0", id: child.initId, method: "initialize", params }));
    this.emitStatus();
  }

  private onInitialized(child: Child, message: Msg) {
    if (message.error) {
      if (child.def.primary) return this.reply(this.browserInitId!, undefined, message.error);
      return this.childExited(child, `initialize failed: ${JSON.stringify(message.error)}`);
    }
    const capabilities = (message.result?.capabilities ?? {}) as Record<string, any>;
    child.capabilities = capabilities;
    child.sync = textDocumentSyncOf(capabilities.textDocumentSync);
    if (child.def.primary) {
      this.browserSync = child.sync;
      child.state = "ready";
      const merged = mergeCapabilities(capabilities, this.children.filter((c) => c !== child).map((c) => c.def.staticCapabilities ?? {}));
      this.reply(this.browserInitId!, { ...message.result, capabilities: merged });
      this.emitStatus();
      return;
    }
    // 지연 시작 서버: 브라우저가 아닌 우리가 initialized 를 보낸다.
    child.link!.send(JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} }));
    if (!child.def.isReadySignal) return this.becomeReady(child);
    child.state = "warming";
    child.warmTimer = setTimeout(() => this.childExited(child, "did not become ready in time"), child.def.readyTimeoutMs ?? 45_000);
    // Relay 는 첫 문서를 받아야 소스와 스키마를 읽기 시작하고 준비 신호를 보낸다. 문서는 준비 전에 열어 주고, 요청만 준비될 때까지 붙든다.
    this.catchUp(child);
    this.emitStatus();
  }

  private becomeReady(child: Child) {
    if (child.warmTimer) clearTimeout(child.warmTimer);
    child.warmTimer = null;
    child.state = "ready";
    this.catchUp(child);
    const queued = child.queue;
    child.queue = [];
    for (const part of queued) if (!part.fan.finished) this.sendPart(part);
    this.emitStatus();
  }

  // 따라잡기: 서버가 뜨는 동안 열린 문서를 현재 글로 연다.
  private catchUp(child: Child) {
    for (const doc of this.docs.values()) if (this.handles(child, doc.uri, doc.languageId)) this.openOn(child, doc);
  }

  private childExited(child: Child, reason: string) {
    if (this.disposed || child.state === "dead") return;
    child.state = "dead";
    child.failure = reason;
    if (child.warmTimer) clearTimeout(child.warmTimer);
    child.warmTimer = null;
    child.link?.stop();
    console.error(`[lsp] ${child.def.key} stopped: ${reason}`);
    if (child.def.primary) {
      this.options.closeBrowser(1011, reason);
      this.dispose();
      return;
    }
    child.queue = [];
    for (const fan of [...this.fans.values()]) {
      for (const part of fan.parts) {
        if (part.child !== child || part.state === "done" || part.state === "failed") continue;
        part.state = "failed";
        part.error = SERVER_EXITED;
      }
      this.evaluate(fan);
    }
    for (const [muxId, pending] of this.serverRequests) if (pending.child === child) this.serverRequests.delete(muxId);
    this.dropDiagnosticsOf(child);
    this.emitStatus();
  }

  // --- 자식에서 온 메시지 ---

  private fromChild(child: Child, text: string) {
    if (this.disposed) return;
    let message: Msg;
    try {
      message = JSON.parse(text) as Msg;
    } catch {
      return this.options.toBrowser(text);
    }
    try {
      if (message.method === undefined) return this.onChildResponse(child, message);
      if (message.id !== undefined) return this.onChildRequest(child, message);
      this.onChildNotification(child, message, text);
    } catch (error) {
      console.error(`[lsp] mux failed on child ${child.def.key} ${message.method ?? "response"}: ${(error as Error).message}`);
    }
  }

  private onChildResponse(child: Child, message: Msg) {
    if (child.initId !== null && message.id === child.initId) {
      child.initId = null;
      return this.onInitialized(child, message);
    }
    for (const fan of this.fans.values()) {
      const part = fan.parts.find((p) => p.child === child && p.childId === message.id && p.state === "sent");
      if (!part) continue;
      if (message.error) {
        part.state = "failed";
        part.error = message.error;
      } else {
        part.state = "done";
        part.result = message.result;
      }
      return this.evaluate(fan);
    }
  }

  private onChildRequest(child: Child, message: Msg) {
    if (message.method === "window/showStatus") {
      child.link?.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: null }));
      if (child.state === "warming" && child.def.isReadySignal?.(message)) this.becomeReady(child);
      return;
    }
    const muxId = `mux-${++this.serial}`;
    this.serverRequests.set(muxId, { child, id: message.id! });
    this.options.toBrowser(JSON.stringify({ ...message, id: muxId }));
  }

  private onChildNotification(child: Child, message: Msg, text: string) {
    if (message.method === "textDocument/publishDiagnostics") return this.onDiagnostics(child, message);
    if (message.method === "window/logMessage" && !child.def.primary && Number(message.params?.type) >= 3) return;
    this.options.toBrowser(text);
  }

  // --- 진단 ---
  // publishDiagnostics 는 uri 단위 덮어쓰기라, 두 서버가 같은 파일에 보내면 마지막 것만 남는다. (uri, 서버)로 들고 합쳐서 다시 낸다.

  private onDiagnostics(child: Child, message: Msg) {
    const { uri, version, diagnostics } = message.params;
    const byChild = this.diagnostics.get(uri) ?? new Map();
    byChild.set(child.def.key, { version: version ?? null, items: diagnostics ?? [] });
    this.diagnostics.set(uri, byChild);
    this.publishDiagnostics(uri);
  }

  private publishDiagnostics(uri: string) {
    const byChild = this.diagnostics.get(uri);
    if (!byChild) return;
    const ordered = this.children.map((c) => byChild.get(c.def.key)).filter((entry): entry is NonNullable<typeof entry> => !!entry);
    const merged = mergeDiagnostics(ordered);
    this.options.toBrowser(JSON.stringify({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri, ...(merged.version === null ? {} : { version: merged.version }), diagnostics: merged.items } }));
  }

  private dropDiagnosticsOf(child: Child) {
    for (const [uri, byChild] of [...this.diagnostics]) {
      if (!byChild.delete(child.def.key)) continue;
      this.publishDiagnostics(uri);
      if (byChild.size === 0) this.diagnostics.delete(uri);
    }
  }

  // --- 팬아웃 응답 합치기 ---

  private evaluate(fan: Fan) {
    if (fan.finished) return;
    const parts = fan.parts;
    const settled = (part: Part) => part.state === "done" || part.state === "failed";
    if (fan.merge === "first") {
      // 우선순위 순서로 훑어 처음으로 내용이 있는 결과를 낸다. 앞선 서버가 아직 답하지 않았으면 기다린다.
      for (const part of parts) {
        if (!settled(part)) return;
        if (part.state === "done" && !isEmptyResult(part.result)) return this.finish(fan);
      }
      return this.finish(fan);
    }
    if (parts.every(settled)) return this.finish(fan);
    const hasContent = parts.some((part) => part.state === "done" && !isEmptyResult(part.result));
    if (!hasContent) return;
    // 준비 중인 서버(뜨는 중, 워밍업)는 이미 나온 내용을 막지 않는다. 준비된 서버가 늦으면 grace 만큼만 더 기다린다.
    if (parts.filter((part) => !settled(part)).every((part) => part.child.state !== "ready")) return this.finish(fan);
    if (!fan.graceTimer) fan.graceTimer = setTimeout(() => this.finish(fan), this.graceMs);
  }

  private finish(fan: Fan, respond = true) {
    if (fan.finished) return;
    fan.finished = true;
    this.clearFan(fan);
    this.fans.delete(fan.browserId);
    for (const part of fan.parts) {
      if (part.state === "queued") part.child.queue = part.child.queue.filter((queued) => queued !== part);
      else if (part.state === "sent" && part.child.state === "ready") part.child.link?.send(JSON.stringify({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id: part.childId } }));
    }
    if (!respond) return;
    const done = fan.parts.filter((part) => part.state === "done");
    const failed = fan.parts.find((part) => part.state === "failed" && part.error && part.error !== SERVER_EXITED) ?? fan.parts.find((part) => part.state === "failed");
    if (done.length === 0) return failed ? this.reply(fan.browserId, undefined, failed.error) : this.reply(fan.browserId, null);
    // 내용이 있는 결과가 없을 때, 주 서버가 오류로 답했다면(예: 이름을 바꿀 수 없는 자리) 그 오류를 돌려준다. 다른 서버의 빈 응답이 가리지 않게.
    if (done.every((part) => isEmptyResult(part.result)) && failed?.child.def.primary && failed.error !== SERVER_EXITED) return this.reply(fan.browserId, undefined, failed.error);
    this.reply(fan.browserId, this.combine(fan, done));
  }

  private clearFan(fan: Fan) {
    if (fan.graceTimer) clearTimeout(fan.graceTimer);
    if (fan.deadlineTimer) clearTimeout(fan.deadlineTimer);
    fan.graceTimer = null;
    fan.deadlineTimer = null;
  }

  private combine(fan: Fan, done: Part[]): unknown {
    const contentful = done.filter((part) => !isEmptyResult(part.result));
    if (contentful.length === 0) return done[0]!.result ?? null;
    const results = contentful.map((part) => ({ key: part.child.def.key, result: part.result as any }));
    switch (fan.merge) {
      case "first":
      case "resolve":
        return results[0]!.result;
      case "all":
        return null;
      case "hover":
        return mergeHover(results.map((r) => r.result));
      case "locations":
        return mergeLocations(results.map((r) => r.result));
      case "concat":
        return results.length === 1 ? results[0]!.result : results.flatMap((r) => (Array.isArray(r.result) ? r.result : [r.result]));
      case "codeActions":
        return results.flatMap((r) => (Array.isArray(r.result) ? r.result : []).map((action: any) => (typeof action.command === "string" ? action : withData(action, wrap(r.key, action.data)))));
      case "completion":
        return mergeCompletion(results);
    }
  }

  private reply(id: number | string, result?: unknown, error?: unknown) {
    this.options.toBrowser(JSON.stringify(error !== undefined ? { jsonrpc: "2.0", id, error } : { jsonrpc: "2.0", id, result: result ?? null }));
  }

  // --- 상태 표시 ---

  private emitStatus() {
    if (this.disposed || !this.initParams) return;
    const servers = this.statuses();
    const serialized = JSON.stringify(servers);
    if (serialized === this.lastStatus) return;
    this.lastStatus = serialized;
    this.options.toBrowser(JSON.stringify({ jsonrpc: "2.0", method: "$/lodestar/servers", params: { servers } }));
  }
}

// 문서 동기화를 받을 수 있는 상태. 준비 신호를 기다리는 서버도 문서는 받는다.
function canSync(child: Child) {
  return child.state === "ready" || child.state === "warming";
}

function lazyInitializeParams(params: any, def: ChildDef) {
  const rootUri = def.rootDir ? pathToFileURL(def.rootDir).href : params?.rootUri ?? null;
  return { ...params, rootUri, workspaceFolders: def.rootDir ? [{ uri: rootUri, name: def.rootDir.slice(def.rootDir.lastIndexOf("/") + 1) }] : params?.workspaceFolders ?? null };
}

function pathOfUri(uri: string) {
  try {
    return fileURLToPath(uri);
  } catch {
    return null;
  }
}

function wrap(key: string, data: unknown) {
  return { __mux: key, data };
}

// data 가 undefined 면 속성을 두지 않는다.
function withData<T extends Record<string, unknown>>(item: T, data: unknown): T {
  const { data: _old, ...rest } = item;
  return (data === undefined ? rest : { ...rest, data }) as T;
}

function mergeCompletion(results: { key: string; result: any }[]) {
  const lists = results.map(({ key, result }) => ({ key, list: (Array.isArray(result) ? { items: result } : result) as { items: any[]; isIncomplete?: boolean; itemDefaults?: any } }));
  const multi = lists.length > 1;
  const items = lists.flatMap(({ key, list }) =>
    list.items.map((item) => {
      const expanded = expandItemDefaults(item, list.itemDefaults, multi);
      return withData(expanded, wrap(key, expanded.data));
    }),
  );
  const only = multi ? null : lists[0]!.list.itemDefaults;
  const itemDefaults = only ? (({ data: _data, ...rest }) => rest)(only) : undefined;
  return { isIncomplete: lists.some(({ list }) => !!list.isIncomplete), items, ...(itemDefaults && Object.keys(itemDefaults).length ? { itemDefaults } : {}) };
}
