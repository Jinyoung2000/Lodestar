import type { ChangeScope } from "../shared/protocol";
import { setChangesScope } from "./store";
import { S } from "./strings";

// Q2: 입력창 위 칩의 개수는 이 세션이 만든 변경(Session 범위)이고, Changes 패널의 기본은 Branch 범위라 숫자가 달랐다.
// 칩에서 들어오면 패널을 Session 범위로 열고, 패널이 다른 범위에 있을 때는 칩 툴팁에 그 차이를 알린다.

const SCOPE_NAME: Record<ChangeScope, () => string> = {
  branch: () => S.branchChanges,
  uncommitted: () => S.scopeUncommitted,
  session: () => S.scopeSession,
  lastTurn: () => S.scopeLastTurn,
};

// worktree 세션은 Branch 와 Session 이 같아서 설명이 필요 없다.
// shellNote: 동시에 돌던 다른 세션 때문에 Bash 로 바뀐 파일 일부를 세지 못했다(FIX5-0).
export function changesChipTitle(branch: string | null, panelScope: ChangeScope, worktree: boolean, shellNote = false): string {
  const title = panelScope === "session" || worktree ? S.viewAllChanges(branch) : S.changesChipDiffers(SCOPE_NAME[panelScope]());
  return shellNote ? `${title.replace(/\.$/, "")}. ${S.shellNoteTip}` : title;
}

// 패널이 이미 Session 범위(worktree 세션은 Branch 가 같은 목록)면 범위와 선택한 파일을 그대로 둔다.
export function openSessionChanges(agentId: string, panelScope: ChangeScope, worktree: boolean, openPanel: () => void) {
  if (panelScope !== "session" && !worktree) setChangesScope(agentId, "session");
  openPanel();
}
