import { activeAgentOf } from "./activeAgentOf";
import { ApprovalCard } from "./Approval";
import { approvalTabKey } from "./editApprovalFile";
import { fileTabKey, useStore } from "./store";
import type { PermissionItem } from "./timelineModel";

export function EditorApproval({ workspaceId, path }: { workspaceId: string; path: string }) {
  const agent = useStore((s) => activeAgentOf(s.panes, s.activePaneId, s.agents));
  const item = useStore((s) => (agent ? s.timelines[agent.id]?.find((i): i is PermissionItem => i.kind === "permission" && i.status === "pending") : undefined));
  if (!agent || !item || approvalTabKey(item, agent.workspaceId) !== fileTabKey(workspaceId, path)) return null;
  return (
    <div className="editor-approval">
      <ApprovalCard key={item.id} agentId={agent.id} item={item} />
    </div>
  );
}
