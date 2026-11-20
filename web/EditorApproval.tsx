import { activeAgentOf } from "./activeAgentOf";
import { ApprovalCard } from "./Approval";
import { approvalTabKey } from "./editApprovalFile";
import { fileTabKey, useStore } from "./store";
import type { PermissionItem } from "./timelineModel";

// 파일 탭 위에 붙는 편집 승인. 활성 칸 세션의 첫 대기 요청이 이 파일을 고치는 것이면 변경 미리보기와 허용 단추를 여기서 보인다.
// 파일은 그대로 열려 있어 import 와 참조를 따라가며 보고 답한다.
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
