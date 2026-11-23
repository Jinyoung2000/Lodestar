import type { AutomationService } from "./automations";
import type { HandlersFor, MethodsIn } from "./rpcHandlers";

export function automationHandlers(automations: AutomationService): HandlersFor<MethodsIn<"automations">> {
  return {
    "automations.list": () => automations.state(),
    "automations.create": (params) => automations.create(params),
    "automations.update": ({ id, patch }) => automations.update(String(id), patch),
    "automations.delete": ({ id }) => {
      automations.delete(String(id));
      return null;
    },
    "automations.setEnabled": ({ id, enabled }) => automations.setEnabled(String(id), enabled),
    "automations.runNow": ({ id }) => automations.runNow(String(id)),
    "automations.runs": ({ automationId }) => automations.runsOf(String(automationId)),
  };
}
