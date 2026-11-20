import { LSPPlugin } from "@codemirror/lsp-client";
import type { EditorView } from "@codemirror/view";
import { findReferences as listReferences, pushHistory, revealFrom } from "./lsp";
import { decide, noResultMessage, type PeekKind, type PeekRange, type PeekRef } from "./peekModel";
import { isPeekOpen, loadTexts, makeSession, nearestOf, openPeek, stepPeek } from "./peekView";
import { currentZone, hideZone } from "./peekZone";
import { hint } from "./hint";
import { registerEditorCommands, workspaceIdOfView } from "./editorCommands";


type LspLocation = { uri: string; range: PeekRange };
type LspLocationLink = { targetUri: string; targetRange: PeekRange; targetSelectionRange: PeekRange };
type LspResult = LspLocation | LspLocation[] | LspLocationLink[] | null;

const METHOD: Record<PeekKind, string> = {
  definition: "textDocument/definition",
  typeDefinition: "textDocument/typeDefinition",
  implementation: "textDocument/implementation",
  reference: "textDocument/references",
};

function toRefs(result: LspResult): PeekRef[] {
  if (!result) return [];
  const list = Array.isArray(result) ? result : [result];
  return list.map((item) => ("targetUri" in item ? { uri: item.targetUri, range: item.targetSelectionRange ?? item.targetRange } : { uri: item.uri, range: item.range }));
}

// side 가 true 면 결과가 하나일 때 활성 그룹의 옆 그룹에 연다(Open Definition to the Side).
async function navigate(view: EditorView, workspaceId: string, kind: PeekKind, openInPeek: boolean, side = false) {
  const plugin = LSPPlugin.get(view);
  if (!plugin) return;
  const head = view.state.selection.main.head;
  if (openInPeek && isPeekOpen(view) && currentZone(view)?.arrowAt === head) {
    hideZone(view);
    return;
  }
  plugin.client.sync();
  const position = plugin.toPosition(head);
  const params = { textDocument: { uri: plugin.uri }, position, ...(kind === "reference" ? { context: { includeDeclaration: true } } : {}) };
  const result = await plugin.client.request<object, LspResult>(METHOD[kind], params);
  const refs = toRefs(result);
  const decision = decide(refs, { kind, openInPeek, cursor: { uri: plugin.uri, line: position.line, character: position.character } });
  const word = view.state.wordAt(head);
  if (decision.type === "none") {
    hint(noResultMessage(kind, word ? view.state.sliceDoc(word.from, word.to) : null), view);
    return;
  }
  if (decision.type === "references") {
    await navigate(view, workspaceId, "reference", false);
    return;
  }
  if (decision.type === "jump") {
    pushHistory();
    revealFrom(view, workspaceId, decision.ref, side);
    return;
  }
  const session = makeSession(workspaceId, kind, openInPeek, decision.groups, 0);
  session.index = nearestOf(decision.groups, view);
  await loadTexts(session);
  openPeek(view, session);
}

export async function goToDefinition(view: EditorView, workspaceId: string, side = false) {
  if (stepPeek(view, 1)) return;
  await navigate(view, workspaceId, "definition", false, side);
}

// ⌘K F12, ⌥⌘클릭: 정의를 옆 그룹에 연다
export async function revealDefinitionAside(view: EditorView, workspaceId: string) {
  await navigate(view, workspaceId, "definition", false, true);
}

export async function goToImplementation(view: EditorView, workspaceId: string) {
  await navigate(view, workspaceId, "implementation", false);
}

export async function goToReferences(view: EditorView, workspaceId: string) {
  if (stepPeek(view, -1)) return;
  await navigate(view, workspaceId, "reference", false);
}

export async function peekDefinition(view: EditorView, workspaceId: string) {
  await navigate(view, workspaceId, "definition", true);
}

export async function peekImplementation(view: EditorView, workspaceId: string) {
  await navigate(view, workspaceId, "implementation", true);
}

export async function peekReferences(view: EditorView, workspaceId: string) {
  await navigate(view, workspaceId, "reference", true);
}

export async function findAllReferences(view: EditorView, workspaceId: string) {
  await listReferences(view, workspaceId);
}

export async function goToTypeDefinition(view: EditorView, workspaceId: string) {
  await navigate(view, workspaceId, "typeDefinition", false);
}

export async function peekTypeDefinition(view: EditorView, workspaceId: string) {
  await navigate(view, workspaceId, "typeDefinition", true);
}

registerEditorCommands([
  { id: "goToTypeDefinition", title: "Go to Type Definition", run: (view) => runWithWorkspace(view, goToTypeDefinition) },
  { id: "peekTypeDefinition", title: "Peek Type Definition", run: (view) => runWithWorkspace(view, peekTypeDefinition) },
  { id: "peekReferences", title: "Peek References", run: (view) => runWithWorkspace(view, peekReferences) },
]);

function runWithWorkspace(view: EditorView, run: (view: EditorView, workspaceId: string) => Promise<void>) {
  const workspaceId = workspaceIdOfView(view);
  if (!workspaceId) return false;
  void run(view, workspaceId);
  return true;
}
