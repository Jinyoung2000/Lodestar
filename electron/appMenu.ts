import { Menu, type MenuItemConstructorOptions } from "electron";
import { bindingsFor, browserStrokes, CHORD_TIMEOUT_MS, chordFollowersOf, interceptStrokes, keyupAwareStrokes, menuAccelerator, strokeOfAccelerator, type Binding } from "../web/keymap";
import { sanitizeKeymapOverrides } from "../shared/keymapOverrides";
import type { CommandKeys } from "../shared/protocol";
import { S } from "../web/strings";

export type KeymapState = { preset: "vscode" | "webstorm"; overrides: CommandKeys; overridesKey: string; bindings: Binding[]; intercept: ReadonlySet<string>; guest: ReadonlySet<string> };

export function keymapStateOf(saved: Record<string, unknown>): KeymapState {
  const preset = saved.keymapPreset === "webstorm" ? "webstorm" : "vscode";
  const overrides = sanitizeKeymapOverrides(saved.keymapOverrides)[preset] ?? {};
  const bindings = bindingsFor(preset, overrides);
  const intercept = interceptStrokes(bindings);
  return { preset, overrides, overridesKey: JSON.stringify(overrides), bindings, intercept, guest: new Set([...intercept, ...browserStrokes(bindings), ...keyupAwareStrokes(bindings)]) };
}

export const keymapKey = (state: KeymapState) => `${state.preset} ${state.overridesKey}`;

export type AppMenuActions = { send: (command: string) => void; openNewWindow: () => void; closeCurrentWindow: () => void; reloadCurrentWindow: () => void };

export function buildAppMenu(keymapState: KeymapState, boardMenuShown: boolean, actions: AppMenuActions): Electron.Menu {
  const { send } = actions;
  const accel = (command: string, literal?: string, registered = true): Pick<MenuItemConstructorOptions, "accelerator" | "registerAccelerator"> => {
    if (keymapState.preset === "vscode" && !Object.hasOwn(keymapState.overrides, command)) return { ...(literal ? { accelerator: literal } : {}), ...(literal && !registered ? { registerAccelerator: false } : {}) };
    const accelerator = menuAccelerator(keymapState.bindings, command);
    return { ...(accelerator ? { accelerator } : {}), registerAccelerator: false };
  };
  const template: MenuItemConstructorOptions[] = [
    {
      label: "Lodestar",
      submenu: [{ role: "about" }, { type: "separator" }, { label: S.menu.settings, ...accel("openSettings", "Cmd+,"), click: () => send("openSettings") }, { type: "separator" }, { role: "hide" }, { role: "hideOthers" }, { type: "separator" }, { role: "quit" }],
    },
    {
      label: S.menu.file,
      submenu: [
        { label: S.menu.newWindow, ...accel("newWindow", "Shift+Cmd+N", false), click: () => void actions.openNewWindow() },
        { label: S.menu.closeWindow, ...accel("closeWindow", "Shift+Cmd+W", false), click: () => actions.closeCurrentWindow() },
      ],
    },
    {
      label: S.menu.session,
      submenu: [
        { label: S.menu.newSession, ...accel("newSession", "Cmd+N"), click: () => send("newSession") },
        { label: S.menu.searchSessions, ...accel("sessions", "Ctrl+Alt+R"), click: () => send("sessions") },
        { label: S.menu.model, ...accel("models", "Shift+Cmd+M"), click: () => send("models") },
        { label: S.menu.effort, ...accel("cycleEffort", "Shift+Cmd+I"), click: () => send("cycleEffort") },
        { label: S.menu.splitChat, ...accel("split", "Cmd+\\"), click: () => send("split") },
        { label: S.menu.splitChatDown, click: () => send("splitDown") },
        { label: S.menu.reopenClosedChat, ...accel("reopenClosed", "Shift+Cmd+T"), click: () => send("reopenClosed") },
        { label: S.menu.closeAllChats, click: () => send("closeAllChats") },
        { label: S.menu.previousSession, ...accel("sessionPrev"), click: () => send("sessionPrev") },
        { label: S.menu.nextSession, ...accel("sessionNext"), click: () => send("sessionNext") },
        { label: S.menu.sideChat, ...accel("btw", "Shift+Cmd+B"), click: () => send("btw") },
        ...(boardMenuShown ? [{ label: S.menu.board, click: () => send("board") }] : []),
        { label: S.menu.feedback, click: () => send("feedback") },
      ],
    },
    {
      label: S.menu.edit,
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
        { type: "separator" },
        { label: S.menu.attach, ...accel("attach", "Alt+H"), click: () => send("attach") },
        { label: S.menu.askAboutSelection, ...accel("quickAsk", "Cmd+I"), click: () => send("quickAsk") },
      ],
    },
    {
      label: S.menu.code,
      submenu: [
        { label: S.menu.openFile, ...accel("quickOpen", "Cmd+P", false), click: () => send("quickOpen") },
        { label: S.menu.gotoLine, ...accel("gotoLine", "Ctrl+G", false), click: () => send("gotoLine") },
        { label: S.menu.gotoSymbol, ...accel("gotoSymbol", "Shift+Cmd+O"), click: () => send("gotoSymbol") },
        { label: S.menu.searchSymbols, ...accel("symbols", "Cmd+T"), click: () => send("symbols") },
        { label: S.menu.closeFocused, ...accel("close", "Cmd+W"), click: () => send("close") },
      ],
    },
    {
      label: S.menu.view,
      submenu: [
        { label: S.menu.zoomIn, ...accel("zoomIn", "Cmd+="), click: () => send("zoomIn") },
        { label: S.menu.zoomOut, ...accel("zoomOut", "Cmd+-"), click: () => send("zoomOut") },
        { label: S.menu.zoomReset, ...accel("zoomReset", "Cmd+0"), click: () => send("zoomReset") },
      ],
    },
    {
      label: S.menu.window,
      role: "windowMenu",
      submenu: [
        { label: S.menu.sidebar, ...accel("toggleSidebar", "Cmd+B"), click: () => send("toggleSidebar") },
        { label: S.menu.bottomPanel, ...accel("toggleBottom", "Cmd+J"), click: () => send("toggleBottom") },
        { label: S.menu.rightPanel, ...accel("toggleRight", "Alt+Cmd+B"), click: () => send("toggleRight") },
        { type: "separator" },
        { label: S.menu.toggleLayout, ...accel("toggleLayout", "Ctrl+Alt+L"), click: () => send("toggleLayout") },
        { label: S.menu.toggleFloat, ...accel("toggleFloat", "Ctrl+Cmd+J"), click: () => send("toggleFloat") },
        { label: S.menu.focusSession, ...accel("focusSession", "Ctrl+Cmd+I"), click: () => send("focusSession") },
        { type: "separator" },
        { role: "minimize" },
        { role: "zoom" },
      ],
    },
    {
      label: S.menu.developer,
      submenu: [
        { label: S.menu.reloadWindow, ...accel("reloadWindow", "Cmd+R"), click: () => actions.reloadCurrentWindow() },
        { label: S.menu.restartDaemon, click: () => send("restartDaemon") },
        { type: "separator" },
        { role: "toggleDevTools", label: S.menu.toggleDevTools },
      ],
    },
  ];
  return Menu.buildFromTemplate(template);
}

export function registeredMenuStrokes(menu: Electron.Menu): ReadonlySet<string> {
  const strokes = new Set<string>();
  const visit = (items: Electron.MenuItem[]) => {
    for (const item of items) {
      if (item.submenu) visit(item.submenu.items);
      const accelerator = item.accelerator;
      const stroke = item.registerAccelerator !== false && accelerator ? strokeOfAccelerator(accelerator) : null;
      if (stroke) strokes.add(stroke);
    }
  };
  visit(menu.items);
  return strokes;
}

const chordStarts = new WeakMap<Electron.WebContents, { prefix: string; at: number }>();

export function completesChord(source: Electron.WebContents, stroke: string, bindings: readonly Binding[], menuStrokes: ReadonlySet<string>) {
  const started = chordStarts.get(source);
  chordStarts.delete(source);
  if (bindings.some((b) => b.keys.length === 2 && b.keys[0] === stroke)) chordStarts.set(source, { prefix: stroke, at: Date.now() });
  return !!started && Date.now() - started.at <= CHORD_TIMEOUT_MS && chordFollowersOf(bindings, started.prefix, menuStrokes).has(stroke);
}
