import { autocompletion } from "@codemirror/autocomplete";
import { LSPPlugin, serverCompletionSource, serverDiagnostics, signatureHelp, type LSPClient, type Transport } from "@codemirror/lsp-client";
import type { Language } from "@codemirror/language";
import { setDiagnostics } from "@codemirror/lint";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import DOMPurify from "dompurify";
import { rpc, wsUrl } from "./rpc";
import { builtinSnippetSource } from "./builtinSnippets";
import { completionRowExtras, resolveSupport, resolvingSource, ResolvingClient, suggestDetails } from "./completionResolve";
import { recordDiagnostics } from "./diagnosticsStore";
import { toViewDiagnostics } from "./diagnosticViews";
import { languageByName } from "./languages";
import { semanticTokensCapability } from "./semanticTokens";
import { NavWorkspace } from "./lspWorkspace";
import { hasGroup } from "./editorGroups";
import { baseKeyOf } from "./editorTabs";
import { fileTabKey, focusGroup, getState, openFile, setState, type FileTarget, type LspServerState, type ReferenceGroup } from "./store";
import { S } from "./strings";
import { hint } from "./hint";
import { indentInfoOf } from "./indentLogic";

type Location = { uri: string; range: { start: { line: number; character: number } } };
type LocationLink = { targetUri: string; targetSelectionRange: Location["range"] };
export type SymbolInfo = { name: string; kind: number; containerName?: string; location: Location };

// 열린 에디터 등록부. displayFile 이 다른 파일의 EditorView 를 돌려줘야 해서 탭 키로 찾는다.
const views = new Map<string, EditorView>();
const viewWaiters = new Map<string, ((view: EditorView) => void)[]>();

// 같은 파일이 여러 그룹에 열려 있으면 탭 키가 `기본키`, `기본키#2` ... 로 갈린다(web/editorTabs.ts). 기본 키로 찾으면 활성 탭의 보기를 먼저, 없으면 먼저 열린 보기를 돌려준다.
export function registerView(key: string, view: EditorView) {
  views.set(key, view);
  for (const name of new Set([key, baseKeyOf(key)])) {
    for (const resolve of viewWaiters.get(name) ?? []) resolve(view);
    viewWaiters.delete(name);
  }
}

export function unregisterView(key: string, view: EditorView) {
  if (views.get(key) === view) views.delete(key);
}

export function viewFor(key: string) {
  const exact = views.get(key);
  if (exact) return exact;
  const active = getState().activeTabKey;
  if (active && baseKeyOf(active) === key && views.has(active)) return views.get(active)!;
  for (const [name, view] of views) if (baseKeyOf(name) === key) return view;
  return null;
}

// 지금 키보드 포커스가 있는 에디터의 탭 키. 활성 그룹과 포커스가 어긋나도 사용자가 선택한 쪽을 찾는다.
export function focusedViewKey() {
  for (const [key, view] of views) if (view.hasFocus) return key;
  return null;
}

// diff 의 수정본 쪽 보기(web/diffLsp.ts). 파일 탭이 아니라서 탭 키가 없다. 등록하면 포커스를 받은 이 보기가 명령(팔레트, 단축키)의 대상이 된다.
const diffViews = new Map<EditorView, string>();
let diffViewCount = 0;

export function registerDiffView(workspaceId: string, view: EditorView) {
  const key = `diff-view:${++diffViewCount}`;
  views.set(key, view);
  diffViews.set(view, workspaceId);
  return () => {
    views.delete(key);
    diffViews.delete(view);
  };
}

// 이 보기가 diff 의 수정본 쪽이면 그 워크스페이스, 아니면 null
export const diffWorkspaceOf = (view: EditorView) => diffViews.get(view) ?? null;

function waitForView(key: string) {
  const view = viewFor(key);
  if (view) return Promise.resolve(view);
  return new Promise<EditorView>((resolve) => viewWaiters.set(key, [...(viewWaiters.get(key) ?? []), resolve]));
}

// --- 경로와 URI ---

export function fileUri(absolute: string) {
  return `file://${absolute.split("/").map(encodeURIComponent).join("/")}`;
}

export function uriToPath(uri: string) {
  return decodeURIComponent(new URL(uri).pathname);
}

export function absolutePath(workspaceId: string, path: string) {
  const workspace = getState().workspaces.find((w) => w.id === workspaceId);
  if (!workspace) throw new Error(S.errNoWorkspace);
  if (path.startsWith("/")) return path;
  const parts = workspace.dir.split("/");
  for (const segment of path.split("/")) {
    if (segment === "..") parts.pop();
    else if (segment !== ".") parts.push(segment);
  }
  return parts.join("/");
}

// 절대 경로를 가장 깊은 워크스페이스 기준 상대 경로로 바꾼다. 워크스페이스 밖이면 현재 워크스페이스 기준 ../ 경로.
export function toTarget(absolute: string, fallbackWorkspaceId: string): FileTarget {
  const match = [...getState().workspaces]
    .filter((w) => absolute.startsWith(`${w.dir}/`))
    .sort((a, b) => b.dir.length - a.dir.length)[0];
  if (match) return { workspaceId: match.id, path: absolute.slice(match.dir.length + 1) };
  const base = getState().workspaces.find((w) => w.id === fallbackWorkspaceId)!.dir.split("/");
  const target = absolute.split("/");
  let common = 0;
  while (common < base.length && base[common] === target[common]) common++;
  return {
    workspaceId: fallbackWorkspaceId,
    path: [...Array(base.length - common).fill(".."), ...target.slice(common)].join("/"),
  };
}

// LSP 서버에 문서를 열 때 쓰는 languageId. graphql 은 Relay LSP 가 맡는다(담당 서버는 데몬의 레지스트리가 정한다).
export function languageIdFor(path: string) {
  const ext = path.slice(path.lastIndexOf(".") + 1);
  return (
    { ts: "typescript", mts: "typescript", cts: "typescript", tsx: "typescriptreact", js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascriptreact", graphql: "graphql", gql: "graphql" } as Record<string, string>
  )[ext] ?? null;
}

// --- LSP 세션 (워크스페이스당 하나) ---

const sessions = new Map<string, LSPClient>();

export function lspClient(workspaceId: string) {
  let client = sessions.get(workspaceId);
  if (client) return client;
  const workspace = getState().workspaces.find((w) => w.id === workspaceId)!;
  client = new ResolvingClient({
    rootUri: fileUri(workspace.dir),
    workspace: (c) =>
      new NavWorkspace(c, (uri) => {
        const target = toTarget(uriToPath(uri), workspaceId);
        pushHistory();
        return waitForView(openFile(target) ?? fileTabKey(target.workspaceId, target.path));
      }),
    timeout: 60_000,
    sanitizeHTML: (html) => DOMPurify.sanitize(html),
    // hover 와 시그니처 도움말의 ```typescript 같은 코드 블록을 에디터와 같은 구문 색으로 칠한다(색은 cm-syn-* 클래스가 준다).
    highlightLanguage: highlightLanguageFor,
    notificationHandlers: {
      // 코드와 source 가 든 원본을 남기고(web/diagnosticsStore.ts) 같은 파일의 모든 보기에 밑줄을 그린다. 보기를 못 찾으면 false 로 돌려 serverDiagnostics 가 먼저 연 보기에 그리게 둔다.
      "textDocument/publishDiagnostics": (client, params: { uri: string; version?: number | null; diagnostics: Parameters<typeof recordDiagnostics>[1] & Parameters<typeof toViewDiagnostics>[0] }) => {
        recordDiagnostics(params.uri, params.diagnostics);
        return paintDiagnostics(client, params);
      },
      "$/typescriptVersion": (_client, params: { version: string; source: string }) => {
        setState((s) => ({ lspInfo: { ...s.lspInfo, [workspaceId]: `TypeScript ${params.version} (${params.source})` } }));
        return true;
      },
      // 서버가 typescript-language-server 인지 네이티브(typescript-go)인지 알리는 server/lsp.ts 의 알림. 네이티브는 $/typescriptVersion 을 보내지 않는다.
      "$/lodestar/serverInfo": (_client, params: ServerInfo) => {
        applyServerInfo(workspaceId, params);
        return true;
      },
      // 데몬의 멀티플렉서가 알리는 서버별 상태(TypeScript 외에 Relay 등)
      "$/lodestar/servers": (_client, params: { servers: LspServerState[] }) => {
        setState((s) => ({ lspServers: { ...s.lspServers, [workspaceId]: params.servers } }));
        return true;
      },
    },
    // 편집을 하므로 변경 동기화(500ms 뒤 didChange)와 진단, 자동완성, 시그니처 도움말도 붙인다.
    extensions: [semanticTokensCapability, definitionLinkSupport, codeActionSupport, relatedInformationSupport, resolveSupport, suggestDetails(), ...serverCompletionWithMatches(), signatureHelp({ keymap: false }), serverDiagnostics()],
  });
  sessions.set(workspaceId, client);
  connect(workspaceId, client);
  return client;
}

// 진단을 같은 파일을 보여 주는 모든 보기에 그린다(파일 탭 여럿, diff 의 수정본 쪽). serverDiagnostics() 는 file.getView() 하나(먼저 연 보기)에만 그려서, 같은 파일을 두 곳에 열면 둘째 보기에는 밑줄이 없었다.
// 위치는 보기마다 자기 LSPPlugin 으로 옮긴다(보기마다 아직 서버에 안 보낸 편집이 같지만 syncedDoc 은 각자 들고 있다).
function paintDiagnostics(client: LSPClient, params: { uri: string; version?: number | null; diagnostics: Parameters<typeof toViewDiagnostics>[0] }) {
  const file = client.workspace.getFile(params.uri);
  if (!file || (params.version != null && params.version !== file.version)) return false;
  let painted = false;
  for (const view of (client.workspace as NavWorkspace).viewsOf(params.uri)) {
    const plugin = LSPPlugin.get(view);
    if (!plugin) continue;
    view.dispatch(setDiagnostics(view.state, toViewDiagnostics(params.diagnostics, plugin)));
    painted = true;
  }
  return painted;
}

type ServerInfo = { kind: "native" | "tsls"; label: string; fallback: { label: string; reason: string } | null };

function applyServerInfo(workspaceId: string, info: ServerInfo) {
  setState((s) => {
    const lspFallback = Object.fromEntries(Object.entries(s.lspFallback).filter(([id]) => id !== workspaceId));
    if (info.fallback) lspFallback[workspaceId] = info.fallback;
    return { lspInfo: info.kind === "native" ? { ...s.lspInfo, [workspaceId]: info.label } : s.lspInfo, lspFallback };
  });
}

// definition 응답을 LocationLink 로 받는다: originSelectionRange 는 ⌘ hover 밑줄 범위(예: import 경로 문자열 전체), targetRange 는 정의 미리보기 범위(선언 전체)다.
const definitionLinkSupport = { clientCapabilities: { textDocument: { definition: { linkSupport: true } } } };

// textDocument/codeAction 에 편집이 든 제안(CodeAction)으로 답하게 한다. 이 선언이 없으면 서버가 명령(Command)만 준다.
// 진단의 relatedInformation("'dup' was also declared here")도 받는다(hover 의 관련 위치 블록).
const relatedInformationSupport = { clientCapabilities: { textDocument: { publishDiagnostics: { relatedInformation: true } } } };

const codeActionSupport = {
  clientCapabilities: {
    textDocument: {
      codeAction: {
        codeActionLiteralSupport: { codeActionKind: { valueSet: ["quickfix", "refactor", "refactor.extract", "refactor.inline", "refactor.rewrite", "source", "source.organizeImports"] } },
        isPreferredSupport: true,
        disabledSupport: true,
        dataSupport: true,
        resolveSupport: { properties: ["edit"] },
      },
    },
    workspace: { workspaceEdit: { documentChanges: true } },
  },
};

// LSP 의 hover 코드 블록에 쓰는 언어. 이름 결정과 파서 읽기는 web/languages.ts 가 한다.
export function highlightLanguageFor(name: string): Language | null {
  return languageByName(name);
}

function connect(workspaceId: string, client: LSPClient) {
  setLspStatus(workspaceId, "connecting");
  const socket = new WebSocket(wsUrl("/ws/lsp", { workspaceId }));
  const handlers = new Set<(value: string) => void>();
  const transport: Transport = {
    send: (message) => socket.send(message),
    subscribe: (handler) => handlers.add(handler),
    unsubscribe: (handler) => handlers.delete(handler),
  };
  socket.onmessage = (event) => {
    for (const handler of handlers) handler(String(event.data));
  };
  socket.onopen = () => {
    client.connect(transport);
    setLspStatus(workspaceId, "indexing");
    void client.initializing.then(() => setLspStatus(workspaceId, "ready"));
  };
  socket.onclose = () => {
    setLspStatus(workspaceId, "error");
    setState((s) => ({ lspServers: { ...s.lspServers, [workspaceId]: [] } }));
    if (client.connected) client.disconnect();
    sessions.delete(workspaceId);
  };
}

function setLspStatus(workspaceId: string, status: "connecting" | "indexing" | "ready" | "error") {
  setState((s) => ({ lspStatus: { ...s.lspStatus, [workspaceId]: status } }));
}

// --- 이동 기록 (뒤로/앞으로) ---

type HistoryEntry = { workspaceId: string; path: string; line: number; column: number; group: string };
const back: HistoryEntry[] = [];
const forward: HistoryEntry[] = [];

function currentLocation(): HistoryEntry | null {
  const s = getState();
  const tab = s.tabs.find((t) => t.key === s.activeTabKey);
  if (!tab || (tab.kind !== "file" && tab.kind !== "diff")) return null;
  const view = views.get(tab.key);
  if (!view) return null;
  const head = view.state.selection.main.head;
  const line = view.state.doc.lineAt(head);
  return { workspaceId: tab.workspaceId, path: tab.path, line: line.number, column: head - line.from + 1, group: s.activeGroupId };
}

export function pushHistory() {
  const location = currentLocation();
  if (!location) return;
  back.push(location);
  forward.length = 0;
}

export function goBack() {
  const entry = back.pop();
  if (!entry) return;
  const current = currentLocation();
  if (current) forward.push(current);
  openHistoryEntry(entry);
}

export function goForward() {
  const entry = forward.pop();
  if (!entry) return;
  const current = currentLocation();
  if (current) back.push(current);
  openHistoryEntry(entry);
}

function openHistoryEntry(entry: HistoryEntry) {
  const { group, ...target } = entry;
  if (hasGroup(getState().editorLayout, group)) focusGroup(group);
  openFile(target);
}

// --- 탐색 명령 ---

function positionParams(view: EditorView) {
  const plugin = LSPPlugin.get(view);
  if (!plugin) return null;
  plugin.client.sync();
  return { plugin, params: { textDocument: { uri: plugin.uri }, position: plugin.toPosition(view.state.selection.main.head) } };
}

function normalize(result: Location | Location[] | LocationLink[] | null): Location[] {
  if (!result) return [];
  const list = Array.isArray(result) ? result : [result];
  return list.map((loc) =>
    "targetUri" in loc ? { uri: loc.targetUri, range: loc.targetSelectionRange } : (loc as Location),
  );
}

export function revealLocation(workspaceId: string, location: Location, side = false) {
  const target = toTarget(uriToPath(location.uri), workspaceId);
  openFile({ ...target, line: location.range.start.line + 1, column: location.range.start.character + 1 }, { side, activeGroup: true });
}

export function revealFrom(host: EditorView, workspaceId: string, location: Location, side = false) {
  const plugin = LSPPlugin.get(host);
  if (!side && diffViews.has(host) && plugin?.uri === location.uri) {
    const pos = plugin.fromPosition(location.range.start);
    host.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "center" }) });
    host.focus();
    return;
  }
  revealLocation(workspaceId, location, side);
}

export async function goToDefinition(view: EditorView, workspaceId: string) {
  const request = positionParams(view);
  if (!request) return;
  const result = await request.plugin.client.request<object, Location | Location[] | LocationLink[] | null>(
    "textDocument/definition",
    request.params,
  );
  const [first] = normalize(result);
  if (!first) {
    hint(S.definitionNotFound, view);
    return;
  }
  pushHistory();
  revealFrom(view, workspaceId, first);
}

export async function findReferences(view: EditorView, workspaceId: string) {
  const request = positionParams(view);
  if (!request) return;
  const word = view.state.wordAt(view.state.selection.main.head);
  const result = await request.plugin.client.request<object, Location[] | null>("textDocument/references", {
    ...request.params,
    context: { includeDeclaration: true },
  });
  const locations = normalize(result);
  const byUri = new Map<string, Location[]>();
  for (const loc of locations) byUri.set(loc.uri, [...(byUri.get(loc.uri) ?? []), loc]);

  const groups: ReferenceGroup[] = await Promise.all(
    [...byUri].map(async ([uri, locs]) => {
      const target = toTarget(uriToPath(uri), workspaceId);
      const lines = await rpc
        .call("files.read", { workspaceId: target.workspaceId, path: target.path })
        .then(({ text }) => (text ?? "").split("\n"))
        .catch(() => [] as string[]);
      return {
        ...target,
        hits: locs.map((loc) => ({
          line: loc.range.start.line + 1,
          column: loc.range.start.character + 1,
          text: (lines[loc.range.start.line] ?? "").trim(),
        })),
      };
    }),
  );
  const symbol = word ? view.state.sliceDoc(word.from, word.to) : S.symbolFallback;
  setState({ references: { title: S.referencesTitle(symbol, locations.length), groups } });
}

// typescript-language-server 는 workspace/symbol 범위를 "가장 최근에 요청을 받은 열린 파일"의 프로젝트로 잡는다
// (tsClient.lastFileOrDummy). node_modules 파일이 마지막이면 tsconfig 밖 임시 프로젝트가 범위가 되어 결과가 빈다.
// 그래서 검색 직전에 프로젝트 파일 하나로 가벼운 요청을 보내 기준 파일을 바꾼다.
export async function searchWorkspaceSymbols(workspaceId: string, query: string) {
  const client = lspClient(workspaceId);
  await client.initializing;
  const anchor = projectAnchorUri(client);
  if (!anchor) throw new Error(S.errOpenProjectFile);
  await client.request("textDocument/foldingRange", { textDocument: { uri: anchor } }).catch(() => null);
  return (await client.request<object, SymbolInfo[] | null>("workspace/symbol", { query })) ?? [];
}

function projectAnchorUri(client: LSPClient) {
  const s = getState();
  const active = s.tabs.find((t) => t.key === s.activeTabKey);
  const candidates = client.workspace.files.map((f) => f.uri).filter((uri) => !uri.includes("/node_modules/"));
  if (active && (active.kind === "file" || active.kind === "diff")) {
    const activeUri = fileUri(absolutePath(active.workspaceId, active.path));
    if (candidates.includes(activeUri)) return activeUri;
  }
  return candidates[0] ?? null;
}

// --- 편집 ---

type TextEdit = { range: { start: { line: number; character: number }; end: { line: number; character: number } }; newText: string };

// typescript-language-server 의 formatting 으로 포맷한 전체 글. LSP 를 쓰지 않는 파일이면 null(포맷할 곳이 없다).
export async function lspFormat(view: EditorView, range?: { from: number; to: number }): Promise<string | null> {
  const plugin = LSPPlugin.get(view);
  if (!plugin) return null;
  await plugin.client.initializing;
  plugin.client.sync();
  const doc = view.state.doc;
  const indent = indentInfoOf(view.state);
  const options = { tabSize: indent.size, insertSpaces: indent.useSpaces };
  const params = { textDocument: { uri: plugin.uri }, options, ...(range ? { range: { start: plugin.toPosition(range.from, doc), end: plugin.toPosition(range.to, doc) } } : {}) };
  const edits = (await plugin.client.request<object, TextEdit[] | null>(range ? "textDocument/rangeFormatting" : "textDocument/formatting", params)) ?? [];
  const spans = edits.map((edit) => ({ from: plugin.fromPosition(edit.range.start, doc), to: plugin.fromPosition(edit.range.end, doc), insert: edit.newText })).sort((a, b) => b.from - a.from);
  let text = doc.toString();
  for (const span of spans) text = text.slice(0, span.from) + span.insert + text.slice(span.to);
  return text;
}

// 저장했다고 서버에 알린다(변경은 먼저 보내서 서버가 저장된 내용을 알고 있게 한다). 서버가 아직 안 떴거나 이 파일을 열지 않았으면 아무것도 안 한다.
export function notifySaved(workspaceId: string, path: string, text: string) {
  const client = sessions.get(workspaceId);
  if (!client?.connected) return;
  const uri = fileUri(absolutePath(workspaceId, path));
  if (!client.workspace.getFile(uri)) return;
  client.sync();
  client.notification("textDocument/didSave", { textDocument: { uri }, text });
}

function serverCompletionWithMatches(): Extension[] {
  const resolving = resolvingSource(serverCompletionSource);
  const source: typeof serverCompletionSource = async (context) => {
    const result = await resolving(context);
    if (!result) return result;
    return { ...result, getMatch: (completion, matched) => (completion.displayLabel && completion.displayLabel !== completion.label ? [] : (matched ?? [])) };
  };
  return [autocompletion({ override: [source, builtinSnippetSource], addToOptions: completionRowExtras })];
}
