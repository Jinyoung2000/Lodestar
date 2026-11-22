import type { WebContents } from "electron";
import { rememberAction } from "./guestDebugger";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SETTLE_MS = 400;
const LOAD_WAIT_MS = 8000;

const lastPoint = new Map<number, { x: number; y: number }>();
export type MouseKind = "move" | "down" | "up" | "click" | "wheel";

export function mouseEvent(guest: WebContents, kind: MouseKind, p: { x?: number; y?: number; button?: string; clickCount?: number; deltaX?: number; deltaY?: number }) {
  const zoom = guest.getZoomFactor();
  const prev = lastPoint.get(guest.id) ?? { x: 0, y: 0 };
  const x = Math.round((p.x ?? prev.x) * (p.x === undefined ? 1 : zoom));
  const y = Math.round((p.y ?? prev.y) * (p.y === undefined ? 1 : zoom));
  lastPoint.set(guest.id, { x, y });
  const button = p.button === "right" ? "right" : p.button === "middle" ? "middle" : "left";
  if (kind === "wheel") {
    guest.sendInputEvent({ type: "mouseWheel", x, y, deltaX: -(p.deltaX ?? 0), deltaY: -(p.deltaY ?? 0) });
    return;
  }
  guest.sendInputEvent({ type: "mouseMove", x, y });
  if (kind === "move") return;
  if (kind === "down") {
    guest.sendInputEvent({ type: "mouseDown", x, y, button, clickCount: 1 });
    return;
  }
  if (kind === "up") {
    guest.sendInputEvent({ type: "mouseUp", x, y, button, clickCount: 1 });
    return;
  }
  const count = Math.max(1, Math.min(3, p.clickCount ?? 1));
  rememberAction(guest, () => replayClick(guest, x, y, button, count));
  for (let click = 1; click <= count; click++) {
    guest.sendInputEvent({ type: "mouseDown", x, y, button, clickCount: click });
    guest.sendInputEvent({ type: "mouseUp", x, y, button, clickCount: click });
  }
}

function replayClick(guest: WebContents, x: number, y: number, button: "left" | "right" | "middle", count: number) {
  guest.sendInputEvent({ type: "mouseMove", x, y });
  for (let click = 1; click <= count; click++) {
    guest.sendInputEvent({ type: "mouseDown", x, y, button, clickCount: click });
    guest.sendInputEvent({ type: "mouseUp", x, y, button, clickCount: click });
  }
}

const KEY_ALIASES: Record<string, string> = { ArrowDown: "Down", ArrowUp: "Up", ArrowLeft: "Left", ArrowRight: "Right", Esc: "Escape", Return: "Enter", " ": "Space", PageDown: "PageDown", PageUp: "PageUp" };
const MODIFIERS: Record<string, "control" | "shift" | "alt" | "meta"> = { control: "control", ctrl: "control", shift: "shift", alt: "alt", option: "alt", meta: "meta", cmd: "meta", command: "meta", controlormeta: process.platform === "darwin" ? "meta" : "control" };

export function pressKey(guest: WebContents, spec: string, phase: "press" | "down" | "up" = "press") {
  const parts = spec.split("+").filter((part, i, all) => part !== "" || i === all.length - 1);
  const keyName = parts.pop() ?? "";
  const modifiers = parts.map((part) => MODIFIERS[part.toLowerCase()]).filter((m): m is NonNullable<typeof m> => !!m);
  if (parts.length !== modifiers.length || keyName === "") throw new Error(`Unknown key: ${spec}`);
  const keyCode = KEY_ALIASES[keyName] ?? keyName;
  if (phase === "press") rememberAction(guest, () => pressKey(guest, spec));
  const char = keyCode.length === 1 && !modifiers.some((m) => m === "control" || m === "meta");
  if (phase !== "up") {
    guest.sendInputEvent({ type: "keyDown", keyCode, modifiers });
    if (keyCode === "Enter") guest.sendInputEvent({ type: "char", keyCode: "\r", modifiers });
    else if (char) guest.sendInputEvent({ type: "char", keyCode, modifiers });
  }
  if (phase !== "down") guest.sendInputEvent({ type: "keyUp", keyCode, modifiers });
}

export async function settle(guest: WebContents) {
  await sleep(SETTLE_MS);
  if (!guest.isLoading()) return;
  await new Promise<void>((resolveWait) => {
    const done = () => {
      clearTimeout(timer);
      guest.removeListener("did-stop-loading", done);
      resolveWait();
    };
    const timer = setTimeout(done, LOAD_WAIT_MS);
    guest.once("did-stop-loading", done);
  });
}
