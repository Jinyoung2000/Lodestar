import type { GitProblem } from "./gitProblems";

// SCM: Source Control 보기의 타입과, git 없이 시험할 수 있는 순수 함수(상태 줄 해석, 폴더 트리, 묶음 판정).
// 서버(server/scm.ts)와 화면(web/SourceControl.tsx)이 같이 쓴다.

export type ScmCode = "M" | "A" | "D" | "R" | "C" | "T" | "U" | "!";

export type ScmEntry = {
  // 저장소 루트 기준 경로
  rel: string;
  path: string;
  code: ScmCode;
  // R, C 이면 옛 경로(저장소 루트 기준)
  from?: string;
  // 충돌이면 git 의 XY 두 글자 (UU, AA, DU ...)
  conflict?: string;
};

export type ScmLastCommit = {
  hash: string;
  subject: string;
  parents: number;
  // 원격 추적 브랜치 어디엔가 이미 올라간 커밋
  pushed: boolean;
};

export type ScmStatus = {
  // null 이면 저장소가 아니다
  repoRoot: string | null;
  hasHead: boolean;
  branch: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  hasRemote: boolean;
  staged: ScmEntry[];
  changes: ScmEntry[];
  conflicts: ScmEntry[];
  // 머지가 진행 중이다 (MERGE_HEAD). 스테이지된 게 없어도 커밋해서 머지를 끝낼 수 있다.
  merging: boolean;
  lastCommit: ScmLastCommit | null;
  // FIX6B: 진행 중인 병합이나 리베이스. merging 은 병합일 때만 true 다(옛 필드). 옛 데몬이 안 보내면 없다.
  operation?: ScmOperation | null;
  // 진행 중 작업 한 줄 설명 (병합은 MERGE_MSG 첫 줄, 리베이스는 "feature 를 리베이스 중 2/5")
  operationText?: string;
  // 병합 커밋 메시지 초안(.git/MERGE_MSG 에서 # 줄을 뺀 것)
  mergeMessage?: string;
};

export type ScmOperation = "merge" | "rebase";

export type ScmCommitOptions = {
  message: string;
  amend?: boolean;
  // 스테이지된 게 없을 때 모든 변경을 스테이지하고 커밋한다 (사용자가 확인 창에서 고른 뒤에만 true)
  stageAll?: boolean;
  // 이미 push 한 커밋을 amend 하는 것을 사용자가 확인했다
  confirmPushedAmend?: boolean;
  // 훅을 건너뛴다. 훅이 실패한 뒤 사용자가 버튼으로 고른 경우에만 true
  noVerify?: boolean;
  then?: "push" | "sync";
};

export type ScmCommitResult =
  | { status: "committed"; summary: string; pushError: string | null }
  | { status: "needsStageAll" }
  | { status: "nothingToCommit" }
  | { status: "amendPushed" }
  | { status: "conflicts" }
  | { status: "failed"; output: string; hook: boolean };

// 버린 변경: 되돌린 추적 파일 수와 휴지통으로 옮긴 새 파일 수
export type ScmDiscardResult = { restored: number; trashed: number };

export type ScmCommit = {
  hash: string;
  short: string;
  subject: string;
  author: string;
  // ISO 8601
  date: string;
  // 이 커밋을 가리키는 브랜치와 태그 (HEAD 는 "HEAD")
  refs: string[];
  parents: number;
};

export type ScmCommitFile = { rel: string; code: ScmCode; from?: string; additions: number; deletions: number };

export type ScmWorktree = {
  path: string;
  branch: string | null;
  head: string;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  // 저장소의 주 작업 폴더
  main: boolean;
};

export type ScmRepoWorktrees = { name: string; root: string; worktrees: ScmWorktree[] };

// --- git status 해석 ---

const CONFLICT_PAIRS = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

// `git status --porcelain -z --untracked-files=all` 출력. 항목은 "XY 경로\0", 이름 바뀜과 복사는 "XY 새경로\0옛경로\0" 이다.
export function parseStatus(raw: string, root: string): Pick<ScmStatus, "staged" | "changes" | "conflicts"> {
  const staged: ScmEntry[] = [];
  const changes: ScmEntry[] = [];
  const conflicts: ScmEntry[] = [];
  const parts = raw.split("\0");
  const make = (rel: string, code: ScmCode, from?: string, conflict?: string): ScmEntry => ({ rel, path: `${root}/${rel}`, code, ...(from ? { from } : {}), ...(conflict ? { conflict } : {}) });
  for (let i = 0; i < parts.length; i++) {
    const item = parts[i];
    if (item.length < 4 || item[2] !== " ") continue;
    const x = item[0];
    const y = item[1];
    const rel = item.slice(3);
    // 이름 바뀜과 복사는 옛 경로가 다음 토큰이다. X 와 Y 어느 쪽에 R 이 와도 하나만 따라온다.
    const from = x === "R" || x === "C" || y === "R" || y === "C" ? parts[++i] : undefined;
    const pair = `${x}${y}`;
    if (pair === "!!") continue;
    if (pair === "??") {
      changes.push(make(rel, "U"));
      continue;
    }
    if (CONFLICT_PAIRS.has(pair)) {
      conflicts.push(make(rel, "!", undefined, pair));
      continue;
    }
    if (x !== " ") staged.push(make(rel, toCode(x), x === "R" || x === "C" ? from : undefined));
    if (y !== " ") changes.push(make(rel, toCode(y), y === "R" || y === "C" ? from : undefined));
  }
  const byRel = (a: ScmEntry, b: ScmEntry) => a.rel.localeCompare(b.rel);
  return { staged: staged.sort(byRel), changes: changes.sort(byRel), conflicts: conflicts.sort(byRel) };
}

function toCode(letter: string): ScmCode {
  return letter === "M" || letter === "A" || letter === "D" || letter === "R" || letter === "C" || letter === "T" ? letter : "M";
}

// --- 목록 보기와 트리 보기 ---

export type ScmTreeNode = { name: string; path: string; entry: ScmEntry | null; children: ScmTreeNode[] };

export function buildScmTree(entries: readonly ScmEntry[]): ScmTreeNode[] {
  const root: ScmTreeNode = { name: "", path: "", entry: null, children: [] };
  for (const entry of entries) {
    const parts = entry.rel.split("/");
    let node = root;
    parts.forEach((name, index) => {
      const path = parts.slice(0, index + 1).join("/");
      let child = node.children.find((c) => c.path === path);
      if (!child) {
        child = { name, path, entry: index === parts.length - 1 ? entry : null, children: [] };
        node.children.push(child);
      }
      node = child;
    });
  }
  const squash = (node: ScmTreeNode): ScmTreeNode => {
    const children = node.children.map(squash);
    if (!node.entry && children.length === 1 && !children[0].entry && node.path) return { ...children[0], name: `${node.name}/${children[0].name}` };
    return { ...node, children };
  };
  const sort = (nodes: ScmTreeNode[]): ScmTreeNode[] => nodes.sort((a, b) => Number(!!a.entry) - Number(!!b.entry) || a.name.localeCompare(b.name)).map((n) => ({ ...n, children: sort(n.children) }));
  return sort(root.children.map(squash));
}

// 폴더 아래 모든 파일 항목
export function scmEntriesUnder(node: ScmTreeNode): ScmEntry[] {
  return node.entry ? [node.entry] : node.children.flatMap(scmEntriesUnder);
}

export const scmBasename = (rel: string) => rel.slice(rel.lastIndexOf("/") + 1);
export const scmDirname = (rel: string) => (rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "");

// --- 커밋 메시지 정리 ---

// 모델 답에서 제목 한 줄만 남긴다: 코드 펜스, 따옴표, 트레일러, 본문을 지운다.
export function cleanCommitMessage(raw: string): string {
  const lines = raw
    .replace(/```[a-z]*\n?/gi, "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^co-authored-by:/i.test(l) && !/^generated with/i.test(l));
  const first = (lines[0] ?? "").replace(/^["'`]+|["'`]+$/g, "").trim();
  return first.length > 100 ? `${first.slice(0, 97).trimEnd()}...` : first;
}

// RPC 대상: 세션이 있으면 그 세션의 작업 폴더(agentId), 없으면 작업 폴더(workspaceId)의 저장소.
export type ScmTarget = { agentId?: string; workspaceId?: string };

// --- FIX6B: pull, push, fetch 와 병합 이어가기 ---

// ff: 빨리 감기만(갈라지면 멈춘다), merge: 병합 커밋을 만든다, rebase: 내 커밋을 원격 위로 다시 쌓는다
export type ScmPullMode = "ff" | "merge" | "rebase";

// git 이 성공했거나, 실패했을 때 분류한 문제. conflicts 는 병합이나 리베이스가 충돌로 멈췄을 때 충돌 파일 수다.
export type ScmSyncResult = { ok: true; output: string } | { ok: false; output: string; problem: GitProblem; conflicts?: number };

export type ScmOperationResult = { ok: true; summary: string } | { ok: false; output: string; problem: GitProblem };

// --- FIX6B: 파일 diff 와 hunk 단위 stage ---

// staged: HEAD 대 인덱스, changes: 인덱스 대 작업 트리
export type ScmDiffSection = "staged" | "changes";

export type ScmHunkInfo = { index: number; oldStart: number; oldLines: number; newStart: number; newLines: number; hash: string };

export type ScmFileDiff = {
  rel: string;
  // 비교 기준 쪽과 현재 쪽 내용. 없는 쪽(새 파일의 기준, 지운 파일의 현재)은 null
  original: string | null;
  modified: string | null;
  binary: boolean;
  // 너무 커서 내용을 안 보낸 경우
  tooLarge: boolean;
  hunks: ScmHunkInfo[];
};
