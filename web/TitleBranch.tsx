import { useState } from "react";
import type { Agent, BranchesResult, GitInfo } from "../shared/protocol";
import { Codicon } from "./icons";
import { BranchChip } from "./NewSession";
import { refreshGit } from "./store";
import { titleBranchOf } from "./titleBranchRule";

// 제목줄 가운데, Command Center 오른쪽의 브랜치 칩. 포커스된 세션의 지금 브랜치를 보인다(규칙은 web/titleBranchRule.ts).
// 칸은 보일 게 없어도 같은 폭으로 남겨 Command Center 가 세션을 바꿀 때 움직이지 않게 한다.
export function TitleBranch({ agent, info, sessionsView }: { agent: Agent | null; info: GitInfo | undefined; sessionsView: boolean }) {
  const view = titleBranchOf({
    sessionsView,
    session: agent ? { cwd: agent.cwd, worktreeBranch: agent.worktree?.branch ?? null, inWorktree: agent.worktree !== null } : null,
    info,
  });
  return (
    <div className="title-branch-slot">
      {agent && view.kind !== "none" && view.switchable && <SwitchableBranch key={agent.id} agentId={agent.id} workspaceId={agent.workspaceId} label={view.label} tooltip={view.tooltip} />}
      {view.kind !== "none" && !view.switchable && (
        <span className="title-branch title-branch-static" title={view.tooltip}>
          <Codicon name="git-branch" size={14} />
          <span>{view.label}</span>
        </span>
      )}
    </div>
  );
}

// 눌러서 브랜치를 바꾸는 칩. 새 세션 화면과 같은 브랜치 목록(BranchChip)을 연다. worktree 세션은 브랜치가 세션에 묶여 있어 여기에 오지 않는다.
function SwitchableBranch({ agentId, workspaceId, label, tooltip }: { agentId: string; workspaceId: string | null; label: string; tooltip: string }) {
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
        void refreshGit(agentId);
      }}
    />
  );
}
