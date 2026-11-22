import type { ChangeScope } from "../shared/protocol";
import { setChangesScope } from "./store";
import { S } from "./strings";

const SCOPE_NAME: Record<ChangeScope, () => string> = {
  branch: () => S.branchChanges,
  uncommitted: () => S.scopeUncommitted,
  session: () => S.scopeSession,
  lastTurn: () => S.scopeLastTurn,
};

export function changesChipTitle(branch: string | null, panelScope: ChangeScope, worktree: boolean, shellNote = false): string {
  const title = panelScope === "session" || worktree ? S.viewAllChanges(branch) : S.changesChipDiffers(SCOPE_NAME[panelScope]());
  return shellNote ? `${title.replace(/\.$/, "")}. ${S.shellNoteTip}` : title;
}

export function openSessionChanges(agentId: string, panelScope: ChangeScope, worktree: boolean, openPanel: () => void) {
  if (panelScope !== "session" && !worktree) setChangesScope(agentId, "session");
  openPanel();
}
