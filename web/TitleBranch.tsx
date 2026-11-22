import { useState } from "react";
import type { Agent, BranchesResult, GitInfo, Workspace } from "../shared/protocol";
import { Codicon } from "./icons";
import { BranchChip } from "./NewSession";
import { refreshGit } from "./store";
import { titleBranchOf } from "./titleBranchRule";
import { announceWorkspaceChanged } from "./workspaceEvents";

export function TitleBranch({ agent, workspace, info, sessionsView }: { agent: Agent | null; workspace?: Workspace; info: GitInfo | undefined; sessionsView: boolean }) {
  const view = titleBranchOf({
    sessionsView,
    session: workspace ? { cwd: workspace.dir, worktreeBranch: null, inWorktree: false } : agent ? { cwd: agent.cwd, worktreeBranch: agent.worktree?.branch ?? null, inWorktree: agent.worktree !== null } : null,
    info,
  });
  return (
    <div className="title-branch-slot">
      {view.kind !== "none" && view.switchable && (workspace || agent) && (
        <SwitchableBranch key={workspace?.id ?? agent?.id} agentId={workspace ? null : agent?.id ?? null} workspaceId={workspace?.id ?? agent?.workspaceId ?? null} label={view.label} tooltip={view.tooltip} />
      )}
      {view.kind !== "none" && !view.switchable && (
        <span className="title-branch title-branch-static" title={view.tooltip}>
          <Codicon name="git-branch" size={14} />
          <span>{view.label}</span>
        </span>
      )}
    </div>
  );
}

function SwitchableBranch({ agentId, workspaceId, label, tooltip }: { agentId: string | null; workspaceId: string | null; label: string; tooltip: string }) {
  const [git, setGit] = useState<BranchesResult | null>(null);
  return (
    <BranchChip
      workspaceId={workspaceId}
      git={git}
      label={label}
      variant="title"
      tooltip={tooltip}
      placement="below"
      onGit={(next) => {
        setGit(next);
        if (agentId) void refreshGit(agentId);
        else if (workspaceId && next.current !== git?.current) announceWorkspaceChanged([workspaceId]);
      }}
    />
  );
}
