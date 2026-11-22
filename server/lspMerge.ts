
export type SyncInfo = { kind: 0 | 1 | 2; openClose: boolean; save: boolean };

export function textDocumentSyncOf(value: unknown): SyncInfo {
  if (typeof value === "number") return { kind: value === 1 || value === 2 ? value : 0, openClose: true, save: false };
  const object = (value ?? {}) as { openClose?: boolean; change?: number; save?: unknown };
  const kind = object.change === 1 || object.change === 2 ? object.change : 0;
  return { kind, openClose: object.openClose !== false, save: !!object.save };
}

export function uriOf(params: any): string | null {
  const uri = params?.textDocument?.uri ?? params?.uri ?? params?.item?.uri;
  return typeof uri === "string" ? uri : null;
}

export function isEmptyResult(result: unknown): boolean {
  if (result === null || result === undefined) return true;
  if (Array.isArray(result)) return result.length === 0;
  if (typeof result === "object" && "items" in (result as object)) return ((result as { items?: unknown[] }).items ?? []).length === 0;
  return false;
}

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

export function mergeDiagnostics(entries: { version: number | null; items: unknown[] }[]): { version: number | null; items: unknown[] } {
  const versions = entries.map((entry) => entry.version).filter((version): version is number => version !== null);
  return { version: versions.length ? Math.max(...versions) : null, items: entries.flatMap((entry) => entry.items) };
}

type MarkedString = string | { language: string; value: string };
type HoverContents = MarkedString | MarkedString[] | { kind: "plaintext" | "markdown"; value: string };
type Hover = { contents: HoverContents; range?: unknown };

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
