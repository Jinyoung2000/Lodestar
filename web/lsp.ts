import { folderOf } from "../shared/sessionFolders";
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
import { indentInfoOf } from "./indentLogic";

type Location = { uri: string; range: { start: { line: number; character: number } } };
type LocationLink = { targetUri: string; targetSelectionRange: Location["range"] };
export type SymbolInfo = { name: string; kind: number; containerName?: string; location: Location };

const views = new Map<string, EditorView>();
const viewWaiters = new Map<string, ((view: EditorView) => void)[]>();

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

export function focusedViewKey() {
  for (const [key, view] of views) if (view.hasFocus) return key;
  return null;
}

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

export const diffWorkspaceOf = (view: EditorView) => diffViews.get(view) ?? null;

function waitForView(key: string) {
  const view = viewFor(key);
  if (view) return Promise.resolve(view);
  return new Promise<EditorView>((resolve) => viewWaiters.set(key, [...(viewWaiters.get(key) ?? []), resolve]));
}

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

export function toTarget(absolute: string, fallbackWorkspaceId: string): FileTarget {
  const workspaces = getState().workspaces;
  const root = folderOf(
    workspaces.map((w) => w.dir).filter((dir) => dir !== absolute),
    absolute,
  );
  const match = root ? workspaces.find((w) => w.dir === root) : undefined;
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

export function languageIdFor(path: string) {
  const ext = path.slice(path.lastIndexOf(".") + 1);
  return (
    { ts: "typescript", mts: "typescript", cts: "typescript", tsx: "typescriptreact", js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascriptreact", graphql: "graphql", gql: "graphql" } as Record<string, string>
  )[ext] ?? null;
}

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
    highlightLanguage: highlightLanguageFor,
    notificationHandlers: {
      "textDocument/publishDiagnostics": (client, params: { uri: string; version?: number | null; diagnostics: Parameters<typeof recordDiagnostics>[1] & Parameters<typeof toViewDiagnostics>[0] }) => {
        recordDiagnostics(params.uri, params.diagnostics);
        return paintDiagnostics(client, params);
      },
      "$/typescriptVersion": (_client, params: { version: string; source: string }) => {
        setState((s) => ({ lspInfo: { ...s.lspInfo, [workspaceId]: `TypeScript ${params.version} (${params.source})` } }));
        return true;
      },
      "$/lodestar/serverInfo": (_client, params: ServerInfo) => {
        applyServerInfo(workspaceId, params);
        return true;
      },
      "$/lodestar/servers": (_client, params: { servers: LspServerState[] }) => {
        setState((s) => ({ lspServers: { ...s.lspServers, [workspaceId]: params.servers } }));
        return true;
      },
    },
    extensions: [semanticTokensCapability, definitionLinkSupport, codeActionSupport, relatedInformationSupport, resolveSupport, suggestDetails(), ...serverCompletionWithMatches(), signatureHelp({ keymap: false }), serverDiagnostics()],
  });
  sessions.set(workspaceId, client);
  connect(workspaceId, client);
  return client;
}

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

const definitionLinkSupport = { clientCapabilities: { textDocument: { definition: { linkSupport: true } } } };

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

type TextEdit = { range: { start: { line: number; character: number }; end: { line: number; character: number } }; newText: string };

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
