import { LSPPlugin } from "@codemirror/lsp-client";
import type { EditorView } from "@codemirror/view";

export type SymbolNode = {
  name: string;
  detail: string;
  kind: number;
  from: number;
  to: number;
  nameFrom: number;
  nameTo: number;
  children: SymbolNode[];
};

type Position = { line: number; character: number };
type LspRange = { start: Position; end: Position };
type RawSymbol = { name: string; detail?: string; kind: number; range?: LspRange; selectionRange?: LspRange; location?: { range: LspRange }; children?: RawSymbol[] };

export async function fetchDocumentSymbols(view: EditorView): Promise<SymbolNode[]> {
  return (await fetchDocumentSymbolsOrNull(view)) ?? [];
}

export async function fetchDocumentSymbolsOrNull(view: EditorView): Promise<SymbolNode[] | null> {
  const plugin = LSPPlugin.get(view);
  if (!plugin) return null;
  try {
    await plugin.client.initializing;
    plugin.client.sync();
    const raw = await plugin.client.request<object, RawSymbol[] | null>("textDocument/documentSymbol", { textDocument: { uri: plugin.uri } });
    const doc = view.state.doc;
    const at = (position: Position) => plugin.fromPosition(position, doc);
    return buildTree(raw ?? [], at);
  } catch {
    return null;
  }
}

export function buildTree(raw: RawSymbol[], at: (position: Position) => number): SymbolNode[] {
  const nodes = raw.map((symbol) => toNode(symbol, at));
  const hierarchical = raw.some((symbol) => symbol.children?.length) || raw.every((symbol) => symbol.range);
  return hierarchical ? nodes : nestByRange(nodes);
}

function toNode(symbol: RawSymbol, at: (position: Position) => number): SymbolNode {
  const range = symbol.range ?? symbol.location?.range ?? { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
  const selection = symbol.selectionRange ?? range;
  return {
    name: symbol.name,
    detail: symbol.detail ?? "",
    kind: symbol.kind,
    from: at(range.start),
    to: at(range.end),
    nameFrom: at(selection.start),
    nameTo: at(selection.end),
    children: (symbol.children ?? []).map((child) => toNode(child, at)),
  };
}

function nestByRange(flat: SymbolNode[]): SymbolNode[] {
  const sorted = [...flat].sort((a, b) => a.from - b.from || b.to - a.to);
  const roots: SymbolNode[] = [];
  const stack: SymbolNode[] = [];
  for (const node of sorted) {
    while (stack.length && stack[stack.length - 1]!.to < node.to) stack.pop();
    const parent = stack[stack.length - 1];
    (parent ? parent.children : roots).push(node);
    stack.push(node);
  }
  return roots;
}

export function symbolPathAt(nodes: readonly SymbolNode[], pos: number): SymbolNode[] {
  const path: SymbolNode[] = [];
  let level = nodes;
  for (;;) {
    const hit = level.find((node) => node.from <= pos && pos <= node.to);
    if (!hit) return path;
    path.push(hit);
    level = hit.children;
  }
}

export function flattenSymbols(nodes: readonly SymbolNode[], depth = 0, container = ""): { node: SymbolNode; depth: number; container: string }[] {
  return nodes.flatMap((node) => [{ node, depth, container }, ...flattenSymbols(node.children, depth + 1, node.name)]);
}

const KIND_ICONS: Record<number, string> = {
  1: "symbol-file", 2: "symbol-module", 3: "symbol-namespace", 4: "symbol-package", 5: "symbol-class", 6: "symbol-method", 7: "symbol-property", 8: "symbol-field", 9: "symbol-constructor", 10: "symbol-enum", 11: "symbol-interface", 12: "symbol-method", 13: "symbol-variable", 14: "symbol-constant", 15: "symbol-string", 16: "symbol-numeric", 17: "symbol-boolean", 18: "symbol-array", 19: "symbol-object", 20: "symbol-key", 21: "symbol-null", 22: "symbol-enum-member", 23: "symbol-structure", 24: "symbol-event", 25: "symbol-operator", 26: "symbol-type-parameter",
};
export const symbolIcon = (kind: number) => KIND_ICONS[kind] ?? "symbol-misc";
