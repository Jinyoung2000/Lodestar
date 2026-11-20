export type PeekKind = "definition" | "typeDefinition" | "implementation" | "reference";

// LSP 의 0 기반 줄과 열. 끝은 일치 범위를 칠할 때만 쓴다.
export type PeekRange = { start: { line: number; character: number }; end: { line: number; character: number } };
export type PeekRef = { uri: string; range: PeekRange };
export type PeekGroup = { uri: string; refs: PeekRef[] };

export type Decision = { type: "none" } | { type: "jump"; ref: PeekRef } | { type: "peek"; groups: PeekGroup[] } | { type: "references" };

const compareRef = (a: PeekRef, b: PeekRef) =>
  a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character || a.range.end.line - b.range.end.line || a.range.end.character - b.range.end.character;

export function groupRefs(refs: PeekRef[]): PeekGroup[] {
  const sorted = [...refs].sort(compareRef);
  const groups: PeekGroup[] = [];
  for (const ref of sorted) {
    const group = groups[groups.length - 1];
    if (group?.uri === ref.uri) {
      const last = group.refs[group.refs.length - 1];
      if (compareRef(last, ref) !== 0) group.refs.push(ref);
    } else groups.push({ uri: ref.uri, refs: [ref] });
  }
  return groups;
}

export const flatten = (groups: PeekGroup[]) => groups.flatMap((g) => g.refs);

function containsCursor(ref: PeekRef, uri: string, line: number, character: number) {
  if (ref.uri !== uri) return false;
  const { start, end } = ref.range;
  const afterStart = line > start.line || (line === start.line && character >= start.character);
  const beforeEnd = line < end.line || (line === end.line && character <= end.character);
  return afterStart && beforeEnd;
}

export function decide(refs: PeekRef[], options: { kind: PeekKind; openInPeek: boolean; cursor: { uri: string; line: number; character: number } }): Decision {
  const groups = groupRefs(refs);
  const flat = flatten(groups);
  if (flat.length === 0) return { type: "none" };
  if (options.openInPeek || flat.length > 1) return { type: "peek", groups };
  const [only] = flat;
  if (options.kind === "definition" && containsCursor(only, options.cursor.uri, options.cursor.line, options.cursor.character)) return { type: "references" };
  return { type: "jump", ref: only };
}

export function nearestIndex(groups: PeekGroup[], uri: string, line: number, character: number): number {
  const flat = flatten(groups);
  const inside = flat.findIndex((ref) => containsCursor(ref, uri, line, character));
  if (inside !== -1) return inside;
  let best = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  flat.forEach((ref, index) => {
    if (ref.uri !== uri) return;
    const distance = Math.abs(ref.range.start.line - line);
    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  });
  return best === -1 ? 0 : best;
}

// 다음, 이전 결과의 번호. 끝에서 처음으로 돌아간다.
export const stepIndex = (index: number, delta: 1 | -1, count: number) => (count === 0 ? 0 : (index + delta + count) % count);

export function previewLine(lineText: string, startCharacter: number, endCharacter: number): { text: string; matchStart: number; matchEnd: number } {
  let from = Math.max(0, startCharacter - 8);
  while (from > 0 && /[\w$]/.test(lineText[from - 1] ?? "") && /[\w$]/.test(lineText[from] ?? "")) from--;
  const before = lineText.slice(from, startCharacter).replace(/^\s+/, "");
  const inside = lineText.slice(startCharacter, Math.min(endCharacter, lineText.length));
  const after = lineText.slice(endCharacter).replace(/\s+$/, "");
  return { text: before + inside + after, matchStart: before.length, matchEnd: before.length + inside.length };
}

const KIND_TITLE: Record<PeekKind, string> = { definition: "Definitions", typeDefinition: "Type Definitions", implementation: "Implementations", reference: "References" };

// 머리줄 오른쪽 meta: "References (12)"
export const peekMeta = (kind: PeekKind, count: number) => `${KIND_TITLE[kind]} (${count})`;

// 결과 없음 안내. 이름이 있으면 "No definition found for 'x'" 꼴.
export function noResultMessage(kind: PeekKind, word: string | null): string {
  const noun = kind === "definition" ? "definition" : kind === "typeDefinition" ? "type definition" : kind === "implementation" ? "implementation" : "references";
  return word ? `No ${noun} found for '${word}'` : `No ${noun} found`;
}

// 결과 파일의 이름과 폴더. 폴더는 워크스페이스 안이면 상대 경로, 밖이면 절대 경로.
export function splitPath(path: string): { name: string; dir: string } {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? { name: path, dir: "" } : { name: path.slice(slash + 1), dir: path.slice(0, slash) };
}
