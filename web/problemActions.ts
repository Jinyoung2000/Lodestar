import { LSPPlugin } from "@codemirror/lsp-client";
import { EditorView } from "@codemirror/view";
import { diagnosticLabel, type LspDiagnostic } from "./diagnosticsStore";
import { toTarget, uriToPath, viewFor } from "./lsp";
import { setQuickAnchor } from "./quickAnchor";
import { rpc } from "./rpc";
import { activePane, addAttachment, fileTabKey, getState, openFile, setState } from "./store";
import { S } from "./strings";
import { hint } from "./hint";

export type RelatedLocation = { workspaceId: string; path: string; line: number; column: number; message: string; code: string };

export type ProblemContext = {
  workspaceId: string;
  path: string;
  tabKey: string;
  from: number;
  to: number;
  startLine: number;
  endLine: number;
  code: string;
  message: string;
  label: string | null;
  related: RelatedLocation[];
};

const RELATED_MAX = 3;

export async function loadRelated(workspaceId: string, diagnostics: LspDiagnostic[]): Promise<RelatedLocation[]> {
  const items = diagnostics.flatMap((d) => d.relatedInformation ?? []).slice(0, RELATED_MAX);
  return Promise.all(
    items.map(async (item) => {
      const target = toTarget(uriToPath(item.location.uri), workspaceId);
      const open = viewFor(fileTabKey(target.workspaceId, target.path));
      const text = open ? open.state.doc.toString() : ((await rpc.call("files.read", { workspaceId: target.workspaceId, path: target.path }).catch(() => ({ text: null }))).text ?? "");
      const line = item.location.range.start.line;
      return { ...target, line: line + 1, column: item.location.range.start.character + 1, message: item.message, code: (text.split("\n")[line] ?? "").trim() };
    }),
  );
}

export function problemContext(view: EditorView, workspaceId: string, diagnostic: LspDiagnostic, related: RelatedLocation[]): ProblemContext | null {
  const plugin = LSPPlugin.get(view);
  if (!plugin) return null;
  const target = toTarget(uriToPath(plugin.uri), workspaceId);
  const doc = view.state.doc;
  const from = plugin.unsyncedChanges.mapPos(plugin.fromPosition(diagnostic.range.start, plugin.syncedDoc));
  const to = plugin.unsyncedChanges.mapPos(plugin.fromPosition(diagnostic.range.end, plugin.syncedDoc));
  const first = doc.lineAt(from);
  const last = doc.lineAt(Math.max(from, to));
  return {
    workspaceId: target.workspaceId,
    path: target.path,
    tabKey: fileTabKey(target.workspaceId, target.path),
    from,
    to,
    startLine: first.number,
    endLine: last.number,
    code: doc.sliceString(first.from, last.to),
    message: diagnostic.message,
    label: diagnosticLabel(diagnostic),
    related,
  };
}

function describe(ctx: ProblemContext) {
  const related = ctx.related.map((r) => `- ${r.path}(${r.line}, ${r.column}): ${r.message}${r.code ? `\n  ${r.code}` : ""}`).join("\n");
  return [`문제: ${ctx.message}${ctx.label ? ` (${ctx.label})` : ""}`, `위치: ${ctx.path}:${ctx.startLine}${ctx.endLine > ctx.startLine ? `-${ctx.endLine}` : ""}`, related ? `관련 위치:\n${related}` : ""].filter(Boolean).join("\n");
}

export function explainProblem(view: EditorView, ctx: ProblemContext) {
  const state = getState();
  const model = state.settings?.quickModel ?? "haiku";
  const question = `이 TypeScript 문제가 왜 생기는지와 고칠 방법을 설명해 줘. 파일은 고치지 말고 설명만 해 줘.\n\n${describe(ctx)}`;
  const context = { path: ctx.path, startLine: ctx.startLine, endLine: ctx.endLine, text: ctx.code };
  const id = `quick-${Date.now()}`;
  view.dispatch({ effects: setQuickAnchor.of({ from: ctx.from, to: ctx.to }) });
  setState({
    quick: {
      run: { id, workspaceId: ctx.workspaceId, model, question, context, answer: "", status: "running", sessionId: null },
      workspaceId: ctx.workspaceId,
      path: ctx.path,
      startLine: ctx.startLine,
      endLine: ctx.endLine,
      text: ctx.code,
      tabKey: ctx.tabKey,
      from: ctx.from,
      to: ctx.to,
      rel: null,
    },
  });
  void rpc.call("quick.ask", { id, workspaceId: ctx.workspaceId, model, question, context });
}

export function fixWithClaude(ctx: ProblemContext) {
  const pane = activePane();
  const text = `${describe(ctx)}\n\n${ctx.code}`;
  setState((s) => ({ composerPrefill: { ...s.composerPrefill, [pane.id]: { text: S.fixWithClaudePrompt, nonce: Date.now() } } }));
  addAttachment(pane.id, { workspaceId: ctx.workspaceId, path: ctx.path, startLine: ctx.startLine, endLine: ctx.endLine, text });
  hint(S.fixWithClaudeReady);
}

export { gotoProblem } from "./markerView";

export function openRelated(r: RelatedLocation) {
  openFile({ workspaceId: r.workspaceId, path: r.path, line: r.line, column: r.column });
}
