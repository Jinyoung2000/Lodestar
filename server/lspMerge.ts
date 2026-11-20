// 멀티플렉서(server/lspMux.ts)가 서버 여러 개의 응답을 하나로 합치는 데 쓰는 순수 함수들.

export type SyncInfo = { kind: 0 | 1 | 2; openClose: boolean; save: boolean };

// initialize 결과의 textDocumentSync(숫자 또는 객체)를 푼다. @codemirror/lsp-client 도 같은 규칙으로 change 종류를 읽는다.
export function textDocumentSyncOf(value: unknown): SyncInfo {
  if (typeof value === "number") return { kind: value === 1 || value === 2 ? value : 0, openClose: true, save: false };
  const object = (value ?? {}) as { openClose?: boolean; change?: number; save?: unknown };
  const kind = object.change === 1 || object.change === 2 ? object.change : 0;
  return { kind, openClose: object.openClose !== false, save: !!object.save };
}

// 요청 params 의 문서 uri. textDocument.uri 가 보통이고, 일부 요청은 최상위 uri 나 항목 안에 둔다.
export function uriOf(params: any): string | null {
  const uri = params?.textDocument?.uri ?? params?.uri ?? params?.item?.uri;
  return typeof uri === "string" ? uri : null;
}

// 결과에 내용이 없는가. null, 빈 배열, 항목 없는 완성 목록, 빈 hover.
export function isEmptyResult(result: unknown): boolean {
  if (result === null || result === undefined) return true;
  if (Array.isArray(result)) return result.length === 0;
  if (typeof result === "object" && "items" in (result as object)) return ((result as { items?: unknown[] }).items ?? []).length === 0;
  return false;
}

// 주 서버의 기능에, 주 서버에 없고 다른 서버만 가진 `...Provider` 를 더한다. triggerCharacters 같은 세부는 주 서버 것을 그대로 둔다
// (다른 서버의 "(" 나 "," 를 합치면 TypeScript 파일에서 그 글자마다 완성 요청이 나간다).
// 항목 resolve 를 하는 서버가 하나라도 있으면 합친 기능에도 resolveProvider 를 켠다(브라우저는 이 값을 보고 completionItem/resolve 를 부른다).
export function mergeCapabilities(primary: Record<string, any>, extras: Record<string, any>[]): Record<string, any> {
  const merged = { ...primary };
  for (const extra of extras) {
    for (const [key, value] of Object.entries(extra)) {
      if (key.endsWith("Provider") && !merged[key] && value) merged[key] = value;
    }
  }
  for (const key of ["completionProvider", "codeActionProvider"]) {
    const anyResolve = [primary, ...extras].some((caps) => caps[key] && typeof caps[key] === "object" && caps[key].resolveProvider);
    if (anyResolve && merged[key] && !merged[key].resolveProvider) merged[key] = { ...(typeof merged[key] === "object" ? merged[key] : {}), resolveProvider: true };
  }
  return merged;
}

// LSP 증분 변경(range 가 있는 것)과 전체 변경(range 없음)을 글에 적용한다. 위치는 UTF-16 코드 유닛 기준이고 줄 끝은 \n, \r\n, \r 모두다.
export function applyContentChanges(text: string, changes: { range?: { start: Pos; end: Pos }; text: string }[]): string {
  let result = text;
  for (const change of changes) {
    if (!change.range) {
      result = change.text;
      continue;
    }
    const from = offsetAt(result, change.range.start);
    const to = offsetAt(result, change.range.end);
    result = result.slice(0, from) + change.text + result.slice(Math.max(from, to));
  }
  return result;
}

type Pos = { line: number; character: number };

export function offsetAt(text: string, position: Pos): number {
  let lineStart = 0;
  for (let line = 0; line < position.line; line++) {
    const next = nextLineStart(text, lineStart);
    if (next === null) return text.length;
    lineStart = next;
  }
  const next = nextLineStart(text, lineStart);
  let lineEnd = next === null ? text.length : next;
  while (lineEnd > lineStart && (text[lineEnd - 1] === "\n" || text[lineEnd - 1] === "\r")) lineEnd--;
  return Math.min(lineStart + Math.max(position.character, 0), lineEnd);
}

function nextLineStart(text: string, from: number): number | null {
  for (let i = from; i < text.length; i++) {
    if (text[i] === "\n") return i + 1;
    if (text[i] === "\r") return text[i + 1] === "\n" ? i + 2 : i + 1;
  }
  return null;
}

// 서버별 진단을 한 목록으로. 서버 순서(우선순위)대로 잇고, 버전은 가장 새것을 쓴다(브라우저는 자기 문서 버전과 다른 진단을 버린다).
export function mergeDiagnostics(entries: { version: number | null; items: unknown[] }[]): { version: number | null; items: unknown[] } {
  const versions = entries.map((entry) => entry.version).filter((version): version is number => version !== null);
  return { version: versions.length ? Math.max(...versions) : null, items: entries.flatMap((entry) => entry.items) };
}

type MarkedString = string | { language: string; value: string };
type HoverContents = MarkedString | MarkedString[] | { kind: "plaintext" | "markdown"; value: string };
type Hover = { contents: HoverContents; range?: unknown };

// hover 여러 개를 마크다운 한 덩어리로 잇는다. 하나뿐이면 서버가 준 모양 그대로 둔다. range 는 첫 것.
export function mergeHover(results: Hover[]): Hover {
  if (results.length === 1) return results[0]!;
  const pieces = results.map((hover) => hoverMarkdown(hover.contents)).filter((piece) => piece.trim() !== "");
  const range = results.find((hover) => hover.range)?.range;
  return { contents: { kind: "markdown", value: pieces.join("\n\n---\n\n") }, ...(range ? { range } : {}) };
}

export function hoverMarkdown(contents: HoverContents): string {
  const one = (item: MarkedString) => (typeof item === "string" ? item : `\`\`\`${item.language}\n${item.value}\n\`\`\``);
  if (Array.isArray(contents)) return contents.map(one).join("\n\n");
  if (typeof contents === "string" || "language" in contents) return one(contents as MarkedString);
  return contents.value;
}

// definition, references 등의 위치 결과(Location, Location[], LocationLink[])를 배열 하나로 잇고 같은 위치는 한 번만 둔다. 하나뿐이면 그대로.
export function mergeLocations(results: unknown[]): unknown {
  if (results.length === 1) return results[0];
  const seen = new Set<string>();
  const merged: unknown[] = [];
  for (const result of results) {
    for (const location of Array.isArray(result) ? result : [result]) {
      const key = locationKey(location as any);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(location);
    }
  }
  return merged;
}

function locationKey(location: any): string {
  if (location && "targetUri" in location) return `${location.targetUri}#${JSON.stringify(location.targetSelectionRange)}`;
  return `${location?.uri}#${JSON.stringify(location?.range)}`;
}

type Range = { start: Pos; end: Pos };
type ItemDefaults = { commitCharacters?: string[]; editRange?: Range | { insert: Range; replace: Range }; insertTextFormat?: number; insertTextMode?: number; data?: unknown };

// CompletionList.itemDefaults 를 항목에 적는다. data 는 항상 적는다(멀티플렉서가 data 를 서버 키로 감싸므로). 목록이 여럿 합쳐질 때(all)는 나머지 기본값도 항목으로 펼친다.
export function expandItemDefaults<T extends Record<string, any>>(item: T, defaults: ItemDefaults | undefined, all: boolean): T {
  if (!defaults) return item;
  const next: Record<string, any> = { ...item };
  if (next.data === undefined && defaults.data !== undefined) next.data = defaults.data;
  if (all) {
    if (next.commitCharacters === undefined && defaults.commitCharacters) next.commitCharacters = defaults.commitCharacters;
    if (next.insertTextFormat === undefined && defaults.insertTextFormat !== undefined) next.insertTextFormat = defaults.insertTextFormat;
    if (next.insertTextMode === undefined && defaults.insertTextMode !== undefined) next.insertTextMode = defaults.insertTextMode;
    if (next.textEdit === undefined && defaults.editRange) {
      const newText = next.textEditText ?? next.insertText ?? next.label;
      next.textEdit = "insert" in defaults.editRange ? { newText, insert: defaults.editRange.insert, replace: defaults.editRange.replace } : { newText, range: defaults.editRange };
      delete next.textEditText;
    }
  }
  return next as T;
}
