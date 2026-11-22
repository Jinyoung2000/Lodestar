import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { app, BrowserWindow, screen } from "electron";
import { afterNew, afterSend, barFromChat, blurAction, fitChatBounds, growFromBar, miniUrl, modeFor, parseMiniSaved, sameRect, serializeMiniSaved, type MiniMode, type MiniSaved, type Size } from "../shared/miniChat";
import { clampQuickHeight, pickWorkArea, quickEntryBounds, quickInputPolicy, type Rect } from "../shared/quickEntry";

const TOP_RATIO = 0.18;
const SHOWN_GUARD_MS = 250;
const LAUNCHER_SHOW_TIMEOUT_MS = 1500;
const SAVE_DELAY_MS = 300;

export type QuickEntrySizes = { cardWidth: number; pad: number; minCard: number; maxCard: number };
export type ChatSizes = { width: number; height: number; minWidth: number; minHeight: number; pad: number };

export type QuickEntryOptions = {
  urlBase: string;
  preload: string;
  sizes: QuickEntrySizes;
  chat: ChatSizes;
  savedFile: string;
  initialPinned: boolean;
  zoomFactor: () => number;
  inactive: boolean;
  invisible: boolean;
  theme: () => "dark" | "light";
  colors: (theme: "dark" | "light") => { background: string; foreground: string; border: string };
  log: (message: string) => void;
  strings: { daemonDown: string };
  yieldFocus: (hideWindow: () => void) => void;
};

export class QuickEntryWindow {
  private win: BrowserWindow | null = null;
  private shownAt = 0;
  private loadFailed = false;
  private saved: MiniSaved;
  private pinnedNow: boolean;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private fromOutside = false;

  constructor(private readonly options: QuickEntryOptions) {
    this.saved = loadSaved(options.savedFile);
    this.pinnedNow = options.initialPinned;
    app.on("browser-window-focus", (_event, focused) => {
      if (focused !== this.win) this.fromOutside = false;
    });
    app.on("did-become-active", () =>
      setImmediate(() => {
        if (this.win && !this.win.isDestroyed() && this.win.isFocused()) this.fromOutside = true;
      }),
    );
  }

  private cardHeight: number | null = null;

  private get zoom() {
    const factor = this.options.zoomFactor();
    return Number.isFinite(factor) && factor > 0 ? factor : 1;
  }

  private get pad() {
    return this.options.sizes.pad * this.zoom;
  }

  private get windowWidth() {
    return Math.round((this.options.sizes.cardWidth + this.options.sizes.pad * 2) * this.zoom);
  }

  private get limits() {
    const { minCard, maxCard, pad } = this.options.sizes;
    return { min: Math.round((minCard + pad * 2) * this.zoom), max: Math.round((maxCard + pad * 2) * this.zoom) };
  }

  private get chatSize(): Size {
    const { width, height, pad } = this.options.chat;
    return { width: Math.round((width + pad * 2) * this.zoom), height: Math.round((height + pad * 2) * this.zoom) };
  }

  private get chatMin(): Size {
    const { minWidth, minHeight, pad } = this.options.chat;
    return { width: Math.round((minWidth + pad * 2) * this.zoom), height: Math.round((minHeight + pad * 2) * this.zoom) };
  }

  private heightFor(cardHeight: number) {
    return (cardHeight + this.options.sizes.pad * 2) * this.zoom;
  }

  get agentId() {
    return this.saved.agentId;
  }

  get mode(): MiniMode {
    return modeFor(this.saved.agentId);
  }

  get pinned() {
    return this.pinnedNow;
  }

  setPinned(pinned: boolean) {
    this.pinnedNow = pinned;
  }

  get savedBounds(): Rect | null {
    return this.saved.bounds;
  }

  get webContents() {
    return this.win && !this.win.isDestroyed() ? this.win.webContents : null;
  }

  get visible() {
    return !!this.win && !this.win.isDestroyed() && this.win.isVisible();
  }

  private get settling() {
    return Date.now() - this.shownAt < SHOWN_GUARD_MS;
  }

  get bounds(): Rect | null {
    return this.win && !this.win.isDestroyed() ? this.win.getBounds() : null;
  }

  get resizable() {
    return !!this.win && !this.win.isDestroyed() && this.win.isResizable();
  }

  toggle() {
    const shownWin = this.win;
    if (shownWin && this.visible && !shownWin.isFocused() && !this.settling && !this.options.inactive) {
      this.fromOutside = !otherWindowFocused(shownWin);
      shownWin.show();
      shownWin.focus();
      shownWin.webContents.send("agent-nav:quick-entry-show");
      return;
    }
    if (this.visible) return this.dismiss();
    if (this.mode !== "chat") return this.show();
    const win = this.ensureWindow();
    this.startNew();
    let shown = false;
    const showOnce = () => {
      if (shown) return;
      shown = true;
      clearTimeout(fallback);
      this.show();
    };
    const fallback = setTimeout(showOnce, LAUNCHER_SHOW_TIMEOUT_MS);
    win.webContents.once("did-finish-load", showOnce);
  }

  show() {
    const win = this.ensureWindow();
    if (!win.isVisible()) this.fromOutside = !otherWindowFocused(win);
    if (this.loadFailed) {
      this.loadFailed = false;
      this.load(win);
    }
    this.place(win);
    this.shownAt = Date.now();
    if (this.options.inactive) win.showInactive();
    else {
      win.show();
      win.focus();
    }
    win.webContents.send("agent-nav:quick-entry-show");
  }

  hide() {
    if (this.win && !this.win.isDestroyed() && this.win.isVisible()) this.win.hide();
  }

  dismiss() {
    const win = this.win;
    if (!win || win.isDestroyed() || !win.isVisible()) return;
    if (this.fromOutside && !this.options.inactive && !otherWindowFocused(win)) this.options.yieldFocus(() => this.hide());
    else this.hide();
  }

  destroy() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }

  finishSend(agentId: string, stay: boolean) {
    const outcome = afterSend(agentId, stay);
    this.bind(outcome.state.agentId);
    const win = this.ensureWindow();
    this.growTo(win, win.getBounds());
    this.load(win);
    if (outcome.hide) this.dismiss();
  }

  switchTo(agentId: string) {
    this.bind(agentId);
    this.load(this.ensureWindow());
  }

  startNew() {
    const win = this.ensureWindow();
    const chat = win.getBounds();
    this.bind(afterNew().agentId);
    win.setResizable(false);
    win.setMinimumSize(0, 0);
    chatChrome(win, false);
    const area = screen.getDisplayMatching(chat).workArea;
    const height = clampQuickHeight(this.heightFor(this.cardHeight ?? this.options.sizes.minCard), this.limits, area);
    win.setBounds(barFromChat(chat, { width: this.windowWidth, height }, area));
    this.load(win);
  }

  resize(cardHeight: number) {
    const win = this.win;
    if (!win || win.isDestroyed()) return;
    this.cardHeight = cardHeight;
    if (this.mode === "chat") return;
    const current = win.getBounds();
    const area = screen.getDisplayMatching(current).workArea;
    const height = clampQuickHeight(this.heightFor(cardHeight), this.limits, area);
    const width = Math.min(this.windowWidth, area.width);
    if (height === current.height && width === current.width) return;
    win.setBounds(quickEntryBounds(area, { width: this.windowWidth, height }, { topRatio: TOP_RATIO, pad: this.pad }));
  }

  handleBlur(asIfActive = false): "hide" | "keep" {
    const action = blurAction({ mode: this.mode, pinned: true, inactive: asIfActive ? false : this.options.inactive, sinceShownMs: Date.now() - this.shownAt, guardMs: SHOWN_GUARD_MS });
    if (action === "hide") this.hide();
    return action;
  }

  readSaved(): MiniSaved {
    return loadSaved(this.options.savedFile);
  }

  setBoundsForTest(bounds: Rect) {
    this.win?.setBounds(bounds);
  }

  private bind(agentId: string | null) {
    this.saved = { ...this.saved, agentId };
    this.persist();
  }

  private persist() {
    try {
      mkdirSync(dirname(this.options.savedFile), { recursive: true });
      writeFileSync(this.options.savedFile, serializeMiniSaved(this.saved));
    } catch (error) {
      this.options.log(`[electron] mini chat: could not save (${(error as Error).message})`);
    }
  }

  private scheduleSave() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      const win = this.win;
      if (!win || win.isDestroyed() || this.mode !== "chat") return;
      const bounds = win.getBounds();
      if (sameRect(bounds, this.saved.bounds)) return;
      this.saved = { ...this.saved, bounds };
      this.persist();
    }, SAVE_DELAY_MS);
  }

  private growTo(win: BrowserWindow, bar: Rect) {
    const area = screen.getDisplayMatching(bar).workArea;
    const savedBounds = this.saved.bounds;
    const bounds = savedBounds ? fitChatBounds(savedBounds, screen.getAllDisplays().map((d) => d.workArea), area, this.chatMin) : growFromBar(bar, this.chatSize, area);
    win.setResizable(true);
    win.setMinimumSize(this.chatMin.width, this.chatMin.height);
    win.setBounds(bounds);
    chatChrome(win, true);
    this.saved = { ...this.saved, bounds };
    this.persist();
  }

  private place(win: BrowserWindow) {
    const areas = screen.getAllDisplays().map((d) => d.workArea);
    const area = pickWorkArea(areas, screen.getCursorScreenPoint()) ?? screen.getPrimaryDisplay().workArea;
    if (this.mode === "chat") {
      const bar = quickEntryBounds(area, { width: this.windowWidth, height: this.limits.min }, { topRatio: TOP_RATIO, pad: this.pad });
      const bounds = this.saved.bounds ? fitChatBounds(this.saved.bounds, areas, area, this.chatMin) : growFromBar(bar, this.chatSize, area);
      win.setResizable(true);
      win.setMinimumSize(this.chatMin.width, this.chatMin.height);
      win.setBounds(bounds);
      chatChrome(win, true);
      return;
    }
    win.setResizable(false);
    win.setMinimumSize(0, 0);
    chatChrome(win, false);
    const height = this.cardHeight === null ? Math.max(win.getBounds().height, this.limits.min) : clampQuickHeight(this.heightFor(this.cardHeight), this.limits, area);
    win.setBounds(quickEntryBounds(area, { width: this.windowWidth, height }, { topRatio: TOP_RATIO, pad: this.pad }));
  }

  private ensureWindow(): BrowserWindow {
    if (this.win && !this.win.isDestroyed()) return this.win;
    const { options } = this;
    const win = new BrowserWindow({
      width: this.windowWidth,
      height: this.limits.min,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      hasShadow: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      acceptFirstMouse: true,
      title: "Lodestar Mini Chat",
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: options.preload },
    });
    this.win = win;
    if (options.invisible) {
      win.setOpacity(0);
      win.setIgnoreMouseEvents(true);
    }
    win.on("blur", () => {
      this.handleBlur();
    });
    win.webContents.on("dom-ready", () => {
      const factor = this.zoom;
      if (Math.abs(win.webContents.getZoomFactor() - factor) > 0.001) win.webContents.setZoomFactor(factor);
    });
    win.on("move", () => this.scheduleSave());
    win.on("resize", () => this.scheduleSave());
    win.on("closed", () => {
      if (this.win === win) this.win = null;
    });
    win.webContents.on("before-input-event", (event, input) => {
      if (input.type !== "keyDown") return;
      if (this.loadFailed && input.key === "Escape") this.dismiss();
      const verdict = quickInputPolicy({ key: input.key, code: input.code, meta: input.meta, control: input.control, alt: input.alt, shift: input.shift });
      if (verdict === "allow") return;
      event.preventDefault();
      if (verdict === "hide") this.dismiss();
      if (verdict === "forward") {
        const detail = { code: input.code, key: input.key, metaKey: input.meta, ctrlKey: input.control, altKey: input.alt, shiftKey: input.shift };
        void win.webContents.executeJavaScript(`window.dispatchEvent(new CustomEvent("agent-nav:key", { detail: ${JSON.stringify(detail)} }))`).catch(() => undefined);
      }
    });
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event, url) => {
      if (!sameOrigin(url, options.urlBase)) event.preventDefault();
    });
    win.webContents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
      if (!isMainFrame || code === -3 || !url.startsWith(options.urlBase)) return;
      options.log(`[electron] quick entry: load failed code=${code} ${description}`);
      this.loadFailed = true;
      void win.loadURL(this.fallbackUrl());
    });
    this.load(win);
    return win;
  }

  private load(win: BrowserWindow) {
    void win.loadURL(miniUrl(this.options.urlBase, this.saved.agentId, this.options.theme())).catch(() => undefined);
  }

  private fallbackUrl() {
    const { options } = this;
    const c = options.colors(options.theme());
    const pad = options.sizes.pad;
    const html = `<!doctype html><meta charset="utf-8"><body style="margin:0;padding:${pad}px;font:13px -apple-system,system-ui,sans-serif"><div style="max-width:${options.sizes.cardWidth}px;margin:0 auto;box-sizing:border-box;padding:16px 20px;border-radius:28px;background:${c.background};color:${c.foreground};border:1px solid ${c.border}">${options.strings.daemonDown}</div>`;
    return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
  }
}

function sameOrigin(url: string, base: string): boolean {
  try {
    return new URL(url).origin === new URL(base).origin;
  } catch {
    return false;
  }
}

function loadSaved(file: string): MiniSaved {
  try {
    return parseMiniSaved(readFileSync(file, "utf8"));
  } catch {
    return parseMiniSaved(null);
  }
}

function chatChrome(win: BrowserWindow, chat: boolean) {
  win.setHasShadow(chat);
  if (chat && process.platform === "darwin") win.invalidateShadow();
  win.setAlwaysOnTop(!chat, "pop-up-menu");
  if (process.platform === "darwin") win.setVisibleOnAllWorkspaces(!chat, { visibleOnFullScreen: !chat, skipTransformProcessType: true });
}

function otherWindowFocused(win: BrowserWindow) {
  return BrowserWindow.getAllWindows().some((other) => other !== win && !other.isDestroyed() && other.isFocused());
}
