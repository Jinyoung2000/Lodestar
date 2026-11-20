import { ptyInfo } from "./pty";
import type { TermAskRunner } from "./termask";
import type { HandlersFor, MethodsIn } from "./rpcHandlers";

export type TerminalHandlerDeps = { termAsk: TermAskRunner };

export function terminalHandlers(deps: TerminalHandlerDeps): HandlersFor<MethodsIn<"termask"> | MethodsIn<"pty">> {
  const { termAsk } = deps;
  return {
    "termask.ask": ({ id, model, question, context }) => {
      termAsk.ask(id, model, question, context);
      return null;
    },
    "termask.cancel": ({ id }) => {
      termAsk.cancel(id);
      return null;
    },
    "pty.info": ({ ptyId }) => ptyInfo(ptyId),
  };
}
