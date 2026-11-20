import type { Agent } from "../shared/protocol";
import { rpc } from "./rpc";
import { addAttachment, findAttachedDuplicate, flash, getState, removeAttachment, startDraft, updateAttachment, type Attachment } from "./store";
import { S } from "./strings";
import { hint } from "./hint";

// HANDOFF: 세션의 `...` 메뉴, 대화 칸 머리 메뉴, 명령 팔레트가 같이 쓰는 시작점.
export const canHandOff = (agent: Agent | null | undefined): agent is Agent => !!agent?.sessionId;

// 새 세션 화면을 연다: 원 세션과 같은 폴더(없으면 퀵 챗), 원 세션의 모델, effort, 권한으로 시작하고, 입력창에 인계 문서 칩이 `생성 중` 으로 붙는다.
// 문서는 서버가 원 세션 기록을 읽기 전용 쿼리로 요약해 만든다. 다 되면 칩이 `ready` 가 되고, 실패하면 칩을 치우고 이유를 알린다. 보내는 것은 사용자가 위치와 글을 정한 뒤다.
export function startHandoff(agentId: string, where: "active" | "new" = "active") {
  const agent = getState().agents.find((a) => a.id === agentId);
  if (!canHandOff(agent)) {
    hint(S.handoffNoSession);
    return;
  }
  const paneId = startDraft(agent.workspaceId, where, {
    handoff: { agentId: agent.id },
    preset: { model: agent.model, effort: agent.effort, permission: agent.permissionMode },
  });
  const chip: Omit<Attachment, "id"> = { workspaceId: agent.workspaceId, path: agent.id, startLine: null, endLine: null, text: null, handoff: { sourceId: agent.id, title: agent.title, status: "generating", id: null } };
  // 이 입력창에 같은 세션의 인계 칩이 이미 있으면 기존 칩만 강조하고 문서를 다시 만들지 않는다.
  const attached = findAttachedDuplicate(paneId, chip);
  const chipId = addAttachment(paneId, chip);
  if (attached) return;
  void rpc
    .call("handoff.create", { agentId: agent.id })
    .then((doc) => updateAttachment(paneId, chipId, { text: doc.text, handoff: { sourceId: agent.id, title: agent.title, status: "ready", id: doc.id } }))
    .catch((error: Error) => {
      removeAttachment(paneId, chipId);
      flash(S.handoffFailed(error.message));
    });
}
