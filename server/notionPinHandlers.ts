import type { ServerEvent } from "../shared/protocol";
import type { NotionPinStore } from "./notionPins";
import type { HandlersFor, MethodsIn } from "./rpcHandlers";

export type NotionPinHandlerDeps = { notionPins: NotionPinStore; broadcast: (event: ServerEvent) => void };

export function notionPinHandlers(deps: NotionPinHandlerDeps): HandlersFor<MethodsIn<"notion.pins">> {
  const { notionPins, broadcast } = deps;
  const publishPins = () => broadcast({ type: "notionPins", pins: notionPins.list() });
  return {
    "notion.pins.list": () => notionPins.list(),
    "notion.pins.add": (params) => {
      const result = notionPins.add(params);
      if (result.added) publishPins();
      return result;
    },
    "notion.pins.update": ({ id, patch }) => {
      const pin = notionPins.update(String(id), patch);
      publishPins();
      return pin;
    },
    "notion.pins.remove": ({ id }) => {
      notionPins.remove(String(id));
      publishPins();
      return null;
    },
    "notion.pins.move": ({ id, index }) => {
      const pins = notionPins.move(String(id), index);
      broadcast({ type: "notionPins", pins });
      return pins;
    },
  };
}
