import type { Agent } from "../shared/protocol";
import { rpc } from "./rpc";
import { addAttachment, findAttachedDuplicate, flash, getState, removeAttachment, startDraft, updateAttachment, type Attachment } from "./store";
import { S } from "./strings";
import { hint } from "./hint";

export const canHandOff = (agent: Agent | null | undefined): agent is Agent => !!agent?.sessionId;

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
