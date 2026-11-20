import type { WebContents } from "electron";

// 공유된 <webview> 의 webContents.debugger 로만 하는 일: 대화상자(alert, confirm, prompt, beforeunload)와 파일 선택창 처리, 끌기, 터치 에뮬레이션, 전체 페이지 스크린샷.
// 디버거는 이 guest 의 것이고, 다른 탭이나 앱 창에는 닿지 않는다. 대화상자는 Page 도메인을 켠 동안(공유 중)에만 가로챈다. 안 가로채면 Electron 이 보통 대화상자를 띄운다.

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
      // beforeunload 는 Chromium 이 열었다가 Electron 이 바로 닫는다. 그 사이 will-prevent-unload 에서 만든 대화상자(leave)를 아래 bindBeforeUnload 가 따로 다룬다.
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

// beforeunload: Electron 은 페이지가 이동을 막으면(will-prevent-unload) 대화상자 없이 이동만 취소한다. 공유 중인 탭에서는 그 취소를 대화상자로 보여 주고,
// 수락(떠나기)이면 이동을 시작했던 마지막 동작(클릭, 키, 주소 이동)을 한 번 허용된 상태로 다시 한다. 닫기(머물기)면 그대로 둔다.
// 이동할 곳은 beforeunload 가 이동이 시작되기 전에 돌아서 이벤트로는 알 수 없어서, 마지막 동작을 기억해 두었다가 되풀이한다.
const leaving = new Map<number, { allowOnce: boolean }>();
const lastAction = new Map<number, () => void | Promise<void>>();

// 이동을 일으킬 수 있는 동작(클릭, 키, 주소 이동, 새로고침)을 기억한다. 입력 헬퍼들이 부른다.
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
    // 공유 중이 아니면 Electron 의 기본(이동 취소)을 그대로 둔다
    if (!state?.pageEnabled || state.dialog) return;
    state.dialog = { type: "beforeunload", message: "This page is asking you to confirm that you want to leave. Information you've entered may not be saved.", defaultPrompt: "", url: guest.getURL(), leave: true };
    for (const listener of dialogListeners) listener(guest.id, state.dialog);
  });
  guest.once("destroyed", () => {
    leaving.delete(guest.id);
    lastAction.delete(guest.id);
  });
}

// 대화상자와 파일 선택창을 가로채기 시작한다(공유 시작). 이미 열려 있던 것은 없다.
export async function watchDialogs(guest: WebContents) {
  const state = stateOf(guest);
  if (!guest.debugger.isAttached()) guest.debugger.attach("1.3");
  if (state.pageEnabled) return;
  await cdp(guest, "Page.enable");
  await cdp(guest, "Page.setInterceptFileChooserDialog", { enabled: true }).catch(() => undefined);
  state.pageEnabled = true;
}

// 공유가 끝나면 가로채기를 멈추고, 열려 있는 대화상자는 닫는다(그대로 두면 페이지가 멈춘다).
export async function unwatchDialogs(guest: WebContents) {
  const state = states.get(guest.id);
  if (!state?.pageEnabled || guest.isDestroyed()) return;
  if (state.dialog) await cdp(guest, "Page.handleJavaScriptDialog", { accept: false }).catch(() => undefined);
  await cdp(guest, "Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => undefined);
  await cdp(guest, "Page.disable").catch(() => undefined);
  state.pageEnabled = false;
  state.chooser = null;
}

// beforeunload 대화상자에 답한다. 떠나기면 이동을 일으킨 마지막 동작을 한 번 허용된 상태로 되풀이한다(기억한 동작이 없으면 새로고침).
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

// 파일 선택창에 파일을 고른다(빈 배열이면 아무것도 고르지 않는다).
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

// 한 요소를 다른 요소 위로 끌어 놓는다. 끌기 가로채기(HTML5 drag and drop)가 되면 drop 까지 보내고, 아니면 마우스로 끈 것으로 둔다. 좌표는 화면(CSS px, 쪽 확대 반영)이다.
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

// 스크롤 밖까지 포함한 전체 페이지를 PNG(base64)로. 너무 길면 위쪽만 담는다.
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
