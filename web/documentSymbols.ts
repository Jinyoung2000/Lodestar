import { LSPPlugin } from "@codemirror/lsp-client";
import type { EditorView } from "@codemirror/view";

// textDocument/documentSymbol 결과를 문서 위치(from, to)가 있는 트리로 바꾼다. 심볼로 이동(⇧⌘O), 경로 줄의 심볼 단계, 고정 스크롤이 같이 쓴다.
// 서버는 계층형(DocumentSymbol[])이나 평평한 목록(SymbolInformation[])을 준다. 평평한 목록은 container 이름이 아니라 범위 포함 관계로 트리를 다시 만든다.
export type SymbolNode = {
  name: string;
  detail: string;
  // LSP SymbolKind 숫자(1 File ... 26 TypeParameter)
  kind: number;
  // 선언 전체 범위
  from: number;
  to: number;
  // 이름 범위(이동할 때 커서가 가는 곳)
  nameFrom: number;
  nameTo: number;
  children: SymbolNode[];
};

type Position = { line: number; character: number };
type LspRange = { start: Position; end: Position };
type RawSymbol = { name: string; detail?: string; kind: number; range?: LspRange; selectionRange?: LspRange; location?: { range: LspRange }; children?: RawSymbol[] };

// 열린 문서의 심볼 트리. 서버가 못 답하거나 파일이 LSP 대상이 아니면 빈 배열.
export async function fetchDocumentSymbols(view: EditorView): Promise<SymbolNode[]> {
  return (await fetchDocumentSymbolsOrNull(view)) ?? [];
}

// fetchDocumentSymbols 와 같되 "심볼 정보를 주는 서버가 없음(LSP 대상이 아니거나 요청 실패)"을 null 로 구분한다. 빈 배열은 서버가 답했는데 심볼이 없다는 뜻.
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

// 순수 함수: 서버 응답과 위치 변환으로 트리를 만든다(단위 시험용으로 분리).
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

// pos 를 품은 심볼의 경로(바깥에서 안쪽 순서). 경로 줄과 고정 스크롤이 쓴다.
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

// 트리를 펼친 목록(깊이 포함). 심볼로 이동 목록이 쓴다.
export function flattenSymbols(nodes: readonly SymbolNode[], depth = 0, container = ""): { node: SymbolNode; depth: number; container: string }[] {
  return nodes.flatMap((node) => [{ node, depth, container }, ...flattenSymbols(node.children, depth + 1, node.name)]);
}

const KIND_ICONS: Record<number, string> = {
  1: "symbol-file", 2: "symbol-module", 3: "symbol-namespace", 4: "symbol-package", 5: "symbol-class", 6: "symbol-method", 7: "symbol-property", 8: "symbol-field", 9: "symbol-constructor", 10: "symbol-enum", 11: "symbol-interface", 12: "symbol-method", 13: "symbol-variable", 14: "symbol-constant", 15: "symbol-string", 16: "symbol-numeric", 17: "symbol-boolean", 18: "symbol-array", 19: "symbol-object", 20: "symbol-key", 21: "symbol-null", 22: "symbol-enum-member", 23: "symbol-structure", 24: "symbol-event", 25: "symbol-operator", 26: "symbol-type-parameter",
};
export const symbolIcon = (kind: number) => KIND_ICONS[kind] ?? "symbol-misc";
