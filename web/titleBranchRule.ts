import type { GitInfo } from "../shared/protocol";

export type TitleBranchInput = {
  sessionsView: boolean;
  session: { cwd: string; worktreeBranch: string | null; inWorktree: boolean } | null;
  info: GitInfo | undefined;
};

export type TitleBranchView =
  | { kind: "none" }
  | { kind: "branch" | "detached"; label: string; tooltip: string; switchable: boolean };

const DETACHED = "HEAD";

export function titleBranchOf(input: TitleBranchInput): TitleBranchView {
  const { session, info } = input;
  if (!input.sessionsView || !session) return { kind: "none" };
  if (!info) return session.worktreeBranch ? branchView(session.worktreeBranch, session) : { kind: "none" };
  if (!info.repoRoot) return { kind: "none" };
  if (info.branch === DETACHED) {
    const short = info.headShort ?? DETACHED;
    return { kind: "detached", label: short, tooltip: `Detached HEAD at ${short}\n${session.cwd}`, switchable: !session.inWorktree };
  }
  if (info.branch) return branchView(info.branch, session);
  return { kind: "none" };
}

function branchView(name: string, session: NonNullable<TitleBranchInput["session"]>): TitleBranchView {
  return { kind: "branch", label: name, tooltip: `${name}\n${session.cwd}`, switchable: !session.inWorktree };
}
