import type { EffortLevel, PermissionDecision } from "../shared/protocol";
import { rpc } from "./rpc";
import { flash, getState, openAgent, setState } from "./store";
import { S } from "./strings";

const A = S.assistant;
const fail = (error: unknown) => flash(A.failed(error instanceof Error ? error.message : String(error)));

export async function sendToMate(text: string): Promise<boolean> {
  const agentId = getState().assistant?.agentId;
  const prompt = text.trim();
  if (!agentId || !prompt) return false;
  try {
    await rpc.call("agents.send", { agentId, prompt });
    return true;
  } catch (error) {
    fail(error);
    return false;
  }
}

export function checkInMate() {
  void rpc
    .call("assistant.checkIn", {})
    .then((assistant) => setState({ assistant }))
    .catch(fail);
}

export function stopMate(agentId: string) {
  void rpc.call("agents.interrupt", { agentId }).catch(fail);
}

export function setMateModel(agentId: string, model: string) {
  void rpc.call("agents.setModel", { agentId, model }).catch(fail);
}

export function setMateEffort(agentId: string, effort: EffortLevel) {
  void rpc.call("agents.setEffort", { agentId, effort }).catch(fail);
}

export function respondToMate(agentId: string, itemId: string, decision: PermissionDecision) {
  void rpc.call("agents.respondPermission", { agentId, itemId, decision }).catch(fail);
}

export function cancelMateReminder(id: string) {
  void rpc
    .call("assistant.cancelReminder", { id })
    .then((assistant) => setState({ assistant }))
    .catch(fail);
}

export function openMateSession() {
  const agentId = getState().assistant?.agentId;
  if (agentId && getState().agents.some((a) => a.id === agentId)) openAgent(agentId);
}

export async function readMateNotes(): Promise<string | null> {
  try {
    return (await rpc.call("assistant.readNotes", {})).text;
  } catch (error) {
    fail(error);
    return null;
  }
}

export async function writeMateNotes(text: string): Promise<boolean> {
  try {
    await rpc.call("assistant.writeNotes", { text });
    flash(A.notesSaved);
    return true;
  } catch (error) {
    fail(error);
    return false;
  }
}
