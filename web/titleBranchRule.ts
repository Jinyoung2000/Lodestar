import type { GitInfo } from "../shared/protocol";

// 제목줄 브랜치 칩이 무엇을 보일지 정하는 규칙. 화면(web/TitleBranch.tsx)은 이 결과만 그린다.
export type TitleBranchInput = {
  // 가운데 화면이 세션 격자일 때만 보인다(Board, Inbox 같은 화면에서는 세션이 없는 것과 같다)
  sessionsView: boolean;
  // 포커스된 칸의 세션. 새 세션 화면과 퀵 챗은 세션이 아니라 null
  session: { cwd: string; worktreeBranch: string | null; inWorktree: boolean } | null;
  // 서버에서 읽은 git 상태. 아직 못 읽었으면 undefined
  info: GitInfo | undefined;
};

export type TitleBranchView =
  | { kind: "none" }
  | { kind: "branch" | "detached"; label: string; tooltip: string; switchable: boolean };

const DETACHED = "HEAD";

export function titleBranchOf(input: TitleBranchInput): TitleBranchView {
  const { session, info } = input;
  if (!input.sessionsView || !session) return { kind: "none" };
  // 읽기 전에는 worktree 세션이 만들어질 때 적어 둔 이름을 쓴다. 읽은 뒤에는 git 이 말하는 지금 값이 이긴다(터미널에서 checkout 해도 따라간다).
  if (!info) return session.worktreeBranch ? branchView(session.worktreeBranch, session) : { kind: "none" };
  if (!info.repoRoot) return { kind: "none" };
  if (info.branch === DETACHED) {
    const short = info.headShort ?? DETACHED;
    return { kind: "detached", label: short, tooltip: `Detached HEAD at ${short}\n${session.cwd}`, switchable: !session.inWorktree };
  }
  if (info.branch) return branchView(info.branch, session);
  // 커밋이 없는 저장소의 이름 없는 상태 등, 보일 이름이 없다
  return { kind: "none" };
}

function branchView(name: string, session: NonNullable<TitleBranchInput["session"]>): TitleBranchView {
  return { kind: "branch", label: name, tooltip: `${name}\n${session.cwd}`, switchable: !session.inWorktree };
}
