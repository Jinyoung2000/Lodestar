import type { PullRequest } from "../shared/protocol";
import { S } from "./strings";

// 워크트리 세션 메뉴의 Merge 와 Pull Request 항목 상태(round-5 발견 14). 합친 뒤에도 두 항목이 그대로 남아 눌러야 "이미 합쳐짐" 을 아는 문제였다.
// unmerged 는 기준 브랜치에 아직 없는 커밋 수(모르면 null: 서버가 누르는 순간 다시 확인하므로 켜 둔다). prs 는 이 브랜치의 PR 목록(모르면 undefined).
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
