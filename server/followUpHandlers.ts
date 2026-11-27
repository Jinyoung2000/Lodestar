import type { FollowUpsService } from "./followUps";
import type { HandlersFor, MethodsIn } from "./rpcHandlers";

export function followUpHandlers(followUps: FollowUpsService, send: (agentId: string, text: string) => Promise<unknown>): HandlersFor<MethodsIn<"followUps">> {
  return {
    "followUps.get": () => followUps.state(),
    "followUps.check": () => followUps.check(),
    "followUps.reply": ({ id, text }) => followUps.reply(id, text, send),
    "followUps.snooze": ({ id, choice }) => followUps.snooze(String(id), choice),
    "followUps.wake": ({ id }) => followUps.wake(String(id)),
    "followUps.dismiss": ({ id }) => followUps.dismiss(String(id)),
    "followUps.keepOpen": ({ agentId }) => followUps.keepOpen(String(agentId)),
  };
}
