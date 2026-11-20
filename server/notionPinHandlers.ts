import type { ServerEvent } from "../shared/protocol";
import type { NotionPinStore } from "./notionPins";
import type { HandlersFor, MethodsIn } from "./rpcHandlers";

export type NotionPinHandlerDeps = { notionPins: NotionPinStore; broadcast: (event: ServerEvent) => void };

export function notionPinHandlers(deps: NotionPinHandlerDeps): HandlersFor<MethodsIn<"notion.pins">> {
  const { notionPins, broadcast } = deps;
  return {
    // NOTION: 사이드바 고정 페이지. 바뀔 때마다 목록 전체를 모든 화면에 보낸다.
    "notion.pins.list": () => notionPins.list(),
    "notion.pins.add": (params) => {
      const result = notionPins.add(params);
      if (result.added) broadcast({ type: "notionPins", pins: notionPins.list() });
      return result;
    },
    "notion.pins.update": ({ id, patch }) => {
      const pin = notionPins.update(String(id), patch);
      broadcast({ type: "notionPins", pins: notionPins.list() });
      return pin;
    },
    "notion.pins.remove": ({ id }) => {
      notionPins.remove(String(id));
      broadcast({ type: "notionPins", pins: notionPins.list() });
      return null;
    },
    "notion.pins.move": ({ id, index }) => {
      const pins = notionPins.move(String(id), index);
      broadcast({ type: "notionPins", pins });
      return pins;
    },
  };
}
