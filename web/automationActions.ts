import type { Automation, AutomationInput } from "../shared/automations";
import { confirmDialog } from "./ConfirmDialog";
import { rpc } from "./rpc";
import { flash, getState, openAgent, setState } from "./store";
import { S } from "./strings";

const A = S.automation;
const fail = (error: unknown) => flash(A.failed(error instanceof Error ? error.message : String(error)));

export async function saveAutomation(id: string | null, input: AutomationInput): Promise<Automation> {
  return id ? rpc.call("automations.update", { id, patch: input }) : rpc.call("automations.create", input);
}

export function setAutomationEnabled(id: string, enabled: boolean) {
  void rpc.call("automations.setEnabled", { id, enabled }).catch(fail);
}

export function runAutomationNow(id: string) {
  void rpc.call("automations.runNow", { id }).catch(fail);
}

export async function deleteAutomation(automation: Automation) {
  const choice = await confirmDialog({ title: A.deleteTitle(automation.title), detail: A.deleteDetail, buttons: [A.cancel, A.deleteConfirm], severity: "warning", danger: [1] });
  if (choice !== 1) return;
  try {
    await rpc.call("automations.delete", { id: automation.id });
    if (getState().selectedAutomationId === automation.id) setState({ selectedAutomationId: null });
  } catch (error) {
    fail(error);
  }
}

export function openRunSession(agentId: string | null) {
  if (agentId && getState().agents.some((a) => a.id === agentId)) openAgent(agentId);
}
