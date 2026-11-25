import { EditorView } from "@codemirror/view";
import type { SymbolNode } from "./documentSymbols";
import { viewFor } from "./lsp";
import { openFile } from "./store";

export function revealSymbol(tabKey: string, workspaceId: string, path: string, node: SymbolNode, options: { side?: boolean; focus?: boolean } = {}) {
  const view = viewFor(tabKey);
  if (!view) return;
  if (options.side) {
    const line = view.state.doc.lineAt(node.nameFrom);
    openFile({ workspaceId, path, line: line.number, column: node.nameFrom - line.from + 1 }, { side: true });
    return;
  }
  view.dispatch({ selection: { anchor: node.nameFrom } });
  scrollNearTop(view, node.nameFrom);
  if (options.focus !== false) view.focus();
}

export function scrollNearTop(view: EditorView, pos: number) {
  const coords = view.coordsAtPos(pos);
  const box = view.scrollDOM.getBoundingClientRect();
  if (coords && coords.top >= box.top && coords.bottom <= box.bottom) return;
  view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: "start", yMargin: view.defaultLineHeight * 3 }) });
}
