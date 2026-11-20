import type { PrThread } from "./prTypes";

// PR 파일 하나의 patch(GitHub 가 주는 unified diff 조각)를 줄 목록으로 풀고, 리뷰 스레드를 줄에 붙인다. 순수 함수만 둔다.

export type DiffLine = { kind: "line"; type: "ctx" | "add" | "del"; oldLine: number | null; newLine: number | null; text: string; noNewline: boolean };
export type DiffHunk = { kind: "hunk"; header: string; context: string };
export type DiffRow = DiffLine | DiffHunk;

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/;

export function parsePatch(patch: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldLine = 0;
  let newLine = 0;
  for (const raw of patch.split("\n")) {
    const hunk = HUNK.exec(raw);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      rows.push({ kind: "hunk", header: raw, context: hunk[3] });
      continue;
    }
    if (rows.length === 0) continue;
    if (raw.startsWith("\\")) {
      const last = rows[rows.length - 1];
      if (last.kind === "line") last.noNewline = true;
      continue;
    }
    const mark = raw[0];
    if (mark === "+") rows.push({ kind: "line", type: "add", oldLine: null, newLine: newLine++, text: raw.slice(1), noNewline: false });
    else if (mark === "-") rows.push({ kind: "line", type: "del", oldLine: oldLine++, newLine: null, text: raw.slice(1), noNewline: false });
    else if (mark === " ") rows.push({ kind: "line", type: "ctx", oldLine: oldLine++, newLine: newLine++, text: raw.slice(1), noNewline: false });
    // 끝의 빈 문자열(마지막 개행)은 줄이 아니다
  }
  return rows;
}

export type Side = "LEFT" | "RIGHT";

export function rowSide(row: DiffLine, side: Side): number | null {
  return side === "LEFT" ? row.oldLine : row.newLine;
}

// 줄 번호가 가리키는 행. LEFT 는 옛 파일 번호(추가 줄에는 없음), RIGHT 는 새 파일 번호(삭제 줄에는 없음).
export function findRow(rows: DiffRow[], side: Side, line: number): number {
  return rows.findIndex((row) => row.kind === "line" && rowSide(row, side) === line);
}

export type ThreadPlacement = { byRow: Map<number, PrThread[]>; unplaced: PrThread[] };

// 스레드는 범위의 끝 줄 아래에 붙는다. 현재 diff 에 줄이 없는(낡은) 스레드와 patch 에 없는 줄은 unplaced 로 남긴다.
export function placeThreads(rows: DiffRow[], threads: PrThread[]): ThreadPlacement {
  const byRow = new Map<number, PrThread[]>();
  const unplaced: PrThread[] = [];
  for (const thread of threads) {
    const index = thread.line === null ? -1 : findRow(rows, thread.side, thread.line);
    if (index === -1) {
      unplaced.push(thread);
      continue;
    }
    byRow.set(index, [...(byRow.get(index) ?? []), thread]);
  }
  return { byRow, unplaced };
}

// 스레드(또는 새 코멘트)가 걸친 행 범위. 시작과 끝이 다른 쪽이어도 patch 순서(행 번호)로 잇는다.
export function rangeRows(rows: DiffRow[], anchor: { line: number; side: Side; startLine?: number | null; startSide?: Side | null }): { from: number; to: number } | null {
  const to = findRow(rows, anchor.side, anchor.line);
  if (to === -1) return null;
  if (anchor.startLine == null) return { from: to, to };
  const from = findRow(rows, anchor.startSide ?? anchor.side, anchor.startLine);
  return from === -1 ? { from: to, to } : { from: Math.min(from, to), to: Math.max(from, to) };
}

// RIGHT 쪽 범위의 새 파일 글. 삭제 줄은 새 파일에 없으므로 빠진다. 제안(suggestion) 코멘트가 바꿀 원문이다.
export function rightText(rows: DiffRow[], startLine: number, endLine: number): string[] {
  const out: string[] = [];
  for (const row of rows) if (row.kind === "line" && row.newLine !== null && row.newLine >= startLine && row.newLine <= endLine) out.push(row.text);
  return out;
}

export type Segment = { kind: "text"; text: string } | { kind: "suggestion"; code: string };

// 코멘트 본문을 일반 글과 ```suggestion 블록으로 가른다. 블록 안 코드는 줄바꿈 그대로 보존한다.
export function splitSuggestions(body: string): Segment[] {
  const out: Segment[] = [];
  const fence = /^```suggestion[^\n]*\n([\s\S]*?)^```[ \t]*$/gm;
  let last = 0;
  for (const match of body.matchAll(fence)) {
    if (match.index > last) out.push({ kind: "text", text: body.slice(last, match.index) });
    out.push({ kind: "suggestion", code: match[1].replace(/\n$/, "") });
    last = match.index + match[0].length;
  }
  if (last < body.length) out.push({ kind: "text", text: body.slice(last) });
  return out;
}

// "Suggest changes" 버튼이 입력창에 넣는 틀. 선택한 줄을 그대로 채워 둔다.
export function suggestionTemplate(lines: string[]): string {
  return "```suggestion\n" + lines.join("\n") + "\n```";
}

export type SplitRow = { left: DiffLine | null; right: DiffLine | null; leftIndex: number; rightIndex: number };

// Split 보기: 연속한 삭제 줄과 추가 줄을 앞에서부터 짝짓는다. 짝이 없는 쪽은 비운다. hunk 행은 그대로 둔다.
export function toSplit(rows: DiffRow[]): (SplitRow | { hunk: DiffHunk; index: number })[] {
  const out: (SplitRow | { hunk: DiffHunk; index: number })[] = [];
  let i = 0;
  while (i < rows.length) {
    const row = rows[i];
    if (row.kind === "hunk") {
      out.push({ hunk: row, index: i });
      i++;
      continue;
    }
    if (row.type === "ctx") {
      out.push({ left: row, right: row, leftIndex: i, rightIndex: i });
      i++;
      continue;
    }
    const dels: number[] = [];
    const adds: number[] = [];
    while (i < rows.length && rows[i].kind === "line" && (rows[i] as DiffLine).type === "del") dels.push(i++);
    while (i < rows.length && rows[i].kind === "line" && (rows[i] as DiffLine).type === "add") adds.push(i++);
    const count = Math.max(dels.length, adds.length);
    for (let k = 0; k < count; k++) {
      const l = dels[k];
      const r = adds[k];
      out.push({ left: l === undefined ? null : (rows[l] as DiffLine), right: r === undefined ? null : (rows[r] as DiffLine), leftIndex: l ?? -1, rightIndex: r ?? -1 });
    }
  }
  return out;
}

// 파일 통계 문구용: patch 가 없는 파일(큰 파일, 바이너리)인지
export const hasPatch = (patch: string | null): patch is string => typeof patch === "string" && patch.length > 0;
