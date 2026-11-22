import type { WebContents } from "electron";

export type DialogInfo = { type: string; message: string; defaultPrompt: string; url: string; leave?: boolean };
type Chooser = { backendNodeId: number | undefined; multiple: boolean };
type State = { pageEnabled: boolean; dialog: DialogInfo | null; chooser: Chooser | null; dragData: unknown; touch: boolean; touchKey: string };

const states = new Map<number, State>();
const dialogListeners = new Set<(id: number, dialog: DialogInfo | null) => void>();

export const onDialogChange = (listener: (id: number, dialog: DialogInfo | null) => void) => {
  dialogListeners.add(listener);
  return () => dialogListeners.delete(listener);
};

function stateOf(guest: WebContents): State {
  let state = states.get(guest.id);
  if (!state) {
    state = { pageEnabled: false, dialog: null, chooser: null, dragData: null, touch: false, touchKey: "" };
    states.set(guest.id, state);
    const current = state;
    guest.debugger.on("message", (_event, method, params: Record<string, unknown>) => {
      if (method === "Page.javascriptDialogOpening" && params.type === "beforeunload") return;
      if (method === "Page.javascriptDialogClosed" && current.dialog?.leave) return;
      if (method === "Page.javascriptDialogOpening") {
        current.dialog = { type: String(params.type), message: String(params.message ?? ""), defaultPrompt: String(params.defaultPrompt ?? ""), url: String(params.url ?? "") };
        for (const listener of dialogListeners) listener(guest.id, current.dialog);
      } else if (method === "Page.javascriptDialogClosed") {
        current.dialog = null;
        for (const listener of dialogListeners) listener(guest.id, null);
      } else if (method === "Page.fileChooserOpened") {
        current.chooser = { backendNodeId: typeof params.backendNodeId === "number" ? params.backendNodeId : undefined, multiple: params.mode === "selectMultiple" };
      } else if (method === "Input.dragIntercepted") current.dragData = params.data ?? null;
    });
    guest.debugger.on("detach", () => {
      states.delete(guest.id);
      for (const listener of dialogListeners) listener(guest.id, null);
    });
    guest.once("destroyed", () => states.delete(guest.id));
  }
  return state;
}

async function cdp<T = Record<string, unknown>>(guest: WebContents, method: string, params: Record<string, unknown> = {}): Promise<T> {
  if (!guest.debugger.isAttached()) guest.debugger.attach("1.3");
  stateOf(guest);
  return (await guest.debugger.sendCommand(method, params)) as T;
}

export const pendingDialog = (guest: WebContents) => states.get(guest.id)?.dialog ?? null;
export const pendingChooser = (guest: WebContents) => states.get(guest.id)?.chooser ?? null;

const leaving = new Map<number, { allowOnce: boolean }>();
const lastAction = new Map<number, () => void | Promise<void>>();

export function rememberAction(guest: WebContents, redo: () => void | Promise<void>) {
  lastAction.set(guest.id, redo);
}

export function bindBeforeUnload(guest: WebContents) {
  guest.on("will-prevent-unload", (event) => {
    const state = states.get(guest.id);
    const entry = leaving.get(guest.id);
    if (entry?.allowOnce) {
      entry.allowOnce = false;
      event.preventDefault();
      return;
    }
    if (!state?.pageEnabled || state.dialog) return;
    state.dialog = { type: "beforeunload", message: "This page is asking you to confirm that you want to leave. Information you've entered may not be saved.", defaultPrompt: "", url: guest.getURL(), leave: true };
    for (const listener of dialogListeners) listener(guest.id, state.dialog);
  });
  guest.once("destroyed", () => {
    leaving.delete(guest.id);
    lastAction.delete(guest.id);
  });
}

export async function watchDialogs(guest: WebContents) {
  const state = stateOf(guest);
  if (!guest.debugger.isAttached()) guest.debugger.attach("1.3");
  if (state.pageEnabled) return;
  await cdp(guest, "Page.enable");
  await cdp(guest, "Page.setInterceptFileChooserDialog", { enabled: true }).catch(() => undefined);
  state.pageEnabled = true;
}

export async function unwatchDialogs(guest: WebContents) {
  const state = states.get(guest.id);
  if (!state?.pageEnabled || guest.isDestroyed()) return;
  if (state.dialog) await cdp(guest, "Page.handleJavaScriptDialog", { accept: false }).catch(() => undefined);
  await cdp(guest, "Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => undefined);
  await cdp(guest, "Page.disable").catch(() => undefined);
  state.pageEnabled = false;
  state.chooser = null;
}

async function answerLeaving(guest: WebContents, accept: boolean, dialog: DialogInfo): Promise<DialogInfo> {
  const state = states.get(guest.id);
  if (state) state.dialog = null;
  for (const listener of dialogListeners) listener(guest.id, null);
  if (!accept) return dialog;
  leaving.set(guest.id, { allowOnce: true });
  const redo = lastAction.get(guest.id);
  if (redo) await redo();
  else guest.reload();
  return dialog;
}

export async function answerDialog(guest: WebContents, accept: boolean, promptText?: string): Promise<DialogInfo> {
  const dialog = pendingDialog(guest);
  if (!dialog) throw new Error("There is no open dialog on this page.");
  if (dialog.leave) return answerLeaving(guest, accept, dialog);
  await cdp(guest, "Page.handleJavaScriptDialog", { accept, ...(promptText !== undefined ? { promptText } : {}) });
  return dialog;
}

export async function answerChooser(guest: WebContents, files: string[]) {
  const chooser = pendingChooser(guest);
  if (!chooser) throw new Error("There is no open file chooser on this page.");
  const state = stateOf(guest);
  state.chooser = null;
  if (chooser.backendNodeId === undefined) throw new Error("The file chooser did not say which input it belongs to.");
  await cdp(guest, "DOM.setFileInputFiles", { files, backendNodeId: chooser.backendNodeId });
}

export const dialogSummary = (dialog: DialogInfo) => `${dialog.type === "alert" ? "An" : "A"} ${dialog.type} dialog is open on the page: ${JSON.stringify(dialog.message.slice(0, 300))}${dialog.type === "prompt" ? ` (default ${JSON.stringify(dialog.defaultPrompt.slice(0, 100))})` : ""}. Use handle_dialog to ${dialog.type === "alert" ? "dismiss" : "accept or dismiss"} it.`;

export async function applyTouch(guest: WebContents, emulating: boolean, mobile: boolean) {
  const state = stateOf(guest);
  const wanted = emulating && mobile;
  const key = `${emulating}:${mobile}`;
  if (state.touchKey === key || (!emulating && !state.touchKey)) return;
  state.touchKey = emulating ? key : "";
  await cdp(guest, "Emulation.setTouchEmulationEnabled", { enabled: wanted, maxTouchPoints: wanted ? 5 : 1 });
  await cdp(guest, "Emulation.setEmulatedMedia", { features: emulating ? [{ name: "pointer", value: wanted ? "coarse" : "fine" }] : [] });
  await cdp(guest, "Emulation.setEmitTouchEventsForMouse", { enabled: wanted, configuration: "mobile" });
  state.touch = wanted;
}

type Point = { x: number; y: number };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function dragBetween(guest: WebContents, from: Point, to: Point) {
  const state = stateOf(guest);
  state.dragData = null;
  await cdp(guest, "Input.setInterceptDrags", { enabled: true });
  try {
    const mouse = (type: string, p: Point, extra: Record<string, unknown> = {}) => cdp(guest, "Input.dispatchMouseEvent", { type, x: p.x, y: p.y, button: "left", ...extra });
    await mouse("mouseMoved", from, { button: "none" });
    await mouse("mousePressed", from, { buttons: 1, clickCount: 1 });
    const steps = 8;
    for (let i = 1; i <= steps; i++) {
      await mouse("mouseMoved", { x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps }, { buttons: 1 });
      if (i === 1) await sleep(30);
    }
    await sleep(30);
    const data = state.dragData;
    if (data) {
      for (const type of ["dragEnter", "dragOver", "drop"]) await cdp(guest, "Input.dispatchDragEvent", { type, x: to.x, y: to.y, data });
      await mouse("mouseReleased", to, { buttons: 0, clickCount: 1 });
    } else await mouse("mouseReleased", to, { buttons: 0, clickCount: 1 });
    return data !== null;
  } finally {
    await cdp(guest, "Input.setInterceptDrags", { enabled: false }).catch(() => undefined);
  }
}

const MAX_FULL_HEIGHT = 16_384;

export async function fullPageScreenshot(guest: WebContents): Promise<string> {
  const metrics = await cdp<{ cssContentSize?: { width: number; height: number }; contentSize: { width: number; height: number } }>(guest, "Page.getLayoutMetrics");
  const size = metrics.cssContentSize ?? metrics.contentSize;
  const shot = await cdp<{ data: string }>(guest, "Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: true,
    clip: { x: 0, y: 0, width: Math.ceil(size.width), height: Math.min(MAX_FULL_HEIGHT, Math.ceil(size.height)), scale: 1 },
  });
  return shot.data;
}
