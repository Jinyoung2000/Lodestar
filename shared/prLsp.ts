import type { PrFile, PrLocalTarget } from "./prTypes";
import { findRow, parsePatch, type DiffRow } from "./prDiff";

// PR diff 의 언어 기능(hover, 정의 이동, 참조)이 쓰는 순수 판단. DOM 과 LSP 연결은 web/prLsp*.ts 가 하고, 여기는 값만 다룬다.

// 로컬 워크스페이스 후보 하나. 데몬이 폴더마다 HEAD 와 head 커밋 유무를 읽어 채운다(server/prLocal.ts).
export type PrLocalCandidate = {
  workspaceId: string;
  dir: string;
  // 사이드바에 보이는 프로젝트 폴더이면 참, worktree 로 붙은 하위 워크스페이스이면 거짓
  topLevel: boolean;
  headSha: string | null;
  // 브랜치 위이면 이름, detached 이면 null
  branch: string | null;
  hasCommit: boolean;
};

export type PrLocalInput = {
  headRef: string;
  headSha: string;
  // Checkout 버튼이 이 PR 의 worktree 를 만들 자리(<repo>.worktrees/<브랜치>). 이 폴더가 후보에 있으면 가장 먼저 쓴다.
  checkoutDir: string | null;
};

// 체크아웃 여부와 쓸 폴더를 고른다. 후보는 이미 이 PR 의 저장소를 가리키는 원격이 있는 폴더들이다.
// 1) HEAD 가 head 커밋이거나 head 브랜치인 폴더: Checkout 이 만든 worktree, 커밋까지 같은 폴더, 하위 worktree 순으로 우선한다.
// 2) 그런 폴더가 없고 head 커밋이 로컬 git 에 있으면 commit. 프로젝트 폴더를 먼저 쓴다(node_modules 가 있는 쪽이라 import 가 풀린다).
// 3) 저장소는 있는데 커밋이 없으면 fetch-needed. 4) 후보가 없으면 no-workspace.
export function chooseLocalTarget(input: PrLocalInput, candidates: PrLocalCandidate[]): PrLocalTarget {
  if (candidates.length === 0) return { kind: "no-workspace" };
  const sha = input.headSha.toLowerCase();
  const exactOf = (c: PrLocalCandidate) => c.headSha !== null && c.headSha.toLowerCase() === sha;
  const checkedOut = candidates
    .filter((c) => exactOf(c) || (c.branch !== null && c.branch === input.headRef))
    .map((c) => ({ c, score: (c.dir === input.checkoutDir ? 4 : 0) + (exactOf(c) ? 2 : 0) + (c.topLevel ? 0 : 1) }))
    .sort((a, b) => b.score - a.score)[0];
  if (checkedOut) return { kind: "checked-out", workspaceId: checkedOut.c.workspaceId, dir: checkedOut.c.dir, branch: checkedOut.c.branch, exact: exactOf(checkedOut.c) };
  const top = (list: PrLocalCandidate[]) => list.find((c) => c.topLevel) ?? list[0];
  const withCommit = candidates.filter((c) => c.hasCommit);
  if (withCommit.length) {
    const pick = top(withCommit);
    return { kind: "commit", workspaceId: pick.workspaceId, dir: pick.dir };
  }
  const pick = top(candidates);
  return { kind: "fetch-needed", workspaceId: pick.workspaceId, dir: pick.dir };
}

// 절대 경로가 폴더 안이면 폴더 기준 상대 경로, 밖이면 null
export function relPathIn(dir: string, absolute: string): string | null {
  const base = dir.endsWith("/") ? dir : `${dir}/`;
  return absolute.startsWith(base) ? absolute.slice(base.length) : null;
}

// patch 의 줄 글과 문서(실제 파일)의 줄 글이 같은가. CRLF 파일이면 patch 쪽에 \r 이 남을 수 있어 끝의 \r 은 무시한다.
export function sameCodeLine(docLine: string, patchLine: string): boolean {
  return docLine.replace(/\r$/, "") === patchLine.replace(/\r$/, "");
}

const WORD = /[\p{L}\p{N}_$]/u;

// 글 안 offset 에 걸친 식별자 범위. offset 이 글자 사이에 있으면 그 앞뒤 중 식별자에 닿는 쪽을 쓴다(캐럿 규칙). 식별자가 아니면 null.
export function wordRangeAt(text: string, offset: number): { from: number; to: number } | null {
  const chars = Array.from(text);
  // 코드 포인트 인덱스와 UTF-16 인덱스를 함께 센다(이모지 같은 두 단위 글자가 있어도 offset 은 UTF-16 기준)
  const starts: number[] = [];
  let at = 0;
  for (const ch of chars) {
    starts.push(at);
    at += ch.length;
  }
  starts.push(at);
  const idx = starts.findIndex((s) => s >= offset);
  const i = idx === -1 ? chars.length : idx;
  const isWord = (k: number) => k >= 0 && k < chars.length && WORD.test(chars[k]);
  const k = isWord(i) && starts[i] === offset ? i : isWord(i - 1) ? i - 1 : isWord(i) ? i : -1;
  if (k === -1) return null;
  let a = k;
  let b = k;
  while (isWord(a - 1)) a--;
  while (isWord(b + 1)) b++;
  return { from: starts[a], to: starts[b + 1] };
}

export type DefinitionTarget =
  // 같은 PR 의 변경 파일이고 그 줄이 보이는 hunk 안에 있다. row 는 그 파일 patch 행 번호
  | { kind: "pr"; path: string; row: number; line: number }
  // 그 밖(변경 안 된 파일, hunk 밖의 줄, 삭제된 파일): 로컬 파일을 에디터 탭으로 연다
  | { kind: "local" };

const rowsCache = new Map<string, DiffRow[]>();
function rowsOf(patch: string): DiffRow[] {
  let rows = rowsCache.get(patch);
  if (!rows) {
    rows = parsePatch(patch);
    if (rowsCache.size > 200) rowsCache.clear();
    rowsCache.set(patch, rows);
  }
  return rows;
}

// 정의 이동 결과(폴더 기준 상대 경로 rel, 0부터 센 줄)를 PR diff 안으로 보낼지 정한다.
export function resolveDefinitionTarget(files: PrFile[], rel: string | null, line0: number): DefinitionTarget {
  if (rel === null) return { kind: "local" };
  const file = files.find((f) => f.path === rel);
  if (!file || file.status === "removed" || !file.patch) return { kind: "local" };
  const row = findRow(rowsOf(file.patch), "RIGHT", line0 + 1);
  return row === -1 ? { kind: "local" } : { kind: "pr", path: file.path, row, line: line0 + 1 };
}

// sha 로 쓸 수 있는 문자열(abbreviated 도 허용). git show 에 넘기기 전 검사
export const isSha = (value: unknown): value is string => typeof value === "string" && /^[0-9a-fA-F]{7,40}$/.test(value);

// git show <sha>:<path> 에 넣을 저장소 상대 경로인가. 옵션처럼 읽히거나 위로 올라가는 경로는 거절한다.
export function isRepoRelativePath(path: unknown): path is string {
  return typeof path === "string" && path.length > 0 && !path.startsWith("/") && !path.startsWith("-") && !path.includes("\0") && !path.split("/").some((part) => part === ".." || part === "");
}
