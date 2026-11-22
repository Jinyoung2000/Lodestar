import type { PullRequest } from "../shared/protocol";
import { S } from "./strings";

export type WorktreeMenuState = {
  merge: { disabled: boolean; reason: string | null };
  pr: { kind: "create"; disabled: boolean; reason: string | null } | { kind: "open"; url: string; reason: string };
};

export function worktreeMenuState(input: { branch: string; target: string; unmerged: number | null; prs: PullRequest[] | undefined }): WorktreeMenuState {
  const nothing = input.unmerged === 0;
  const open = input.prs?.find((pr) => pr.state.toUpperCase() === "OPEN");
  return {
    merge: { disabled: nothing, reason: nothing ? S.mergeNothingTip(input.branch, input.target) : null },
    pr: open ? { kind: "open", url: open.url, reason: S.prOpenTip(open.number, open.title) } : { kind: "create", disabled: nothing, reason: nothing ? S.prNothingTip(input.branch, input.target) : null },
  };
}
