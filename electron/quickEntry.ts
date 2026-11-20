import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { app, BrowserWindow, screen } from "electron";
import { afterNew, afterSend, barFromChat, blurAction, fitChatBounds, growFromBar, miniUrl, modeFor, parseMiniSaved, sameRect, serializeMiniSaved, type MiniMode, type MiniSaved, type Size } from "../shared/miniChat";
import { clampQuickHeight, pickWorkArea, quickEntryBounds, quickInputPolicy, type Rect } from "../shared/quickEntry";

// 미니 채팅 패널(옛 전역 빠른 입력창). 별도 BrowserWindow(frameless, 투명) 하나가 두 모양을 오간다. 막대일 때만 항상 위와 모든 Space, 대화일 때는 보통 창(chatChrome).
// launcher: ?view=quick 입력 막대(web/QuickEntry.tsx). chat: ?embed=session&agent=<id>&mini=1 대화 패널(web/EmbedSession.tsx 의 단일 세션 화면). 같은 창에서 주소만 바꾼다.
// 한 번 만들면 숨겨 두고 다시 쓴다: 대화와 쓰던 글이 페이지에 남고 두 번째부터는 바로 뜬다.
// 2026-11-05 까지는 macOS type "panel"(NSPanel)이라 앱을 활성화하지 않고 키를 받았지만, panel 은 만들 때 정해져 모든 Space 에 뜨고 창 목록(알트탭, Mission Control)에서 빠진다.
// 대화 패널을 보통 창으로 다루려고 panel 을 뺐다. 그래서 막대를 띄우면 Lodestar 가 활성 앱이 된다. 포커스와 활성화는 시험 인스턴스에서 확인할 수 없다.

const TOP_RATIO = 0.18;
// 막 뜬 직후 이 시간 안의 blur 는 포커스가 자리 잡는 흔들림으로 보고 무시한다.
const SHOWN_GUARD_MS = 250;
// ⌥C 로 대화에서 새 막대로 바꿀 때 막대 페이지를 기다리는 상한
const LAUNCHER_SHOW_TIMEOUT_MS = 1500;
// 끌거나 크기를 바꾸는 동안 이벤트가 쏟아지니 멈춘 뒤에 한 번 적는다.
const SAVE_DELAY_MS = 300;

export type QuickEntrySizes = { cardWidth: number; pad: number; minCard: number; maxCard: number };
// 대화 패널의 기본 크기와 최소 크기(카드 기준 CSS px)와 shadow 여백. 창 크기는 여기에 여백을 더하고 확대 배율을 곱한다.
export type ChatSizes = { width: number; height: number; minWidth: number; minHeight: number; pad: number };

export type QuickEntryOptions = {
  urlBase: string;
  preload: string;
  sizes: QuickEntrySizes;
  chat: ChatSizes;
  // 마지막 대화 세션과 패널 자리를 적는 파일
  savedFile: string;
  // Settings 의 Hide on outside click 이 꺼져 있으면 true(고정이 기본)
  initialPinned: boolean;
  // 지금 확대 배율. 앱 창의 값(없으면 저장한 값)을 준다. 이 창은 아직 페이지를 읽기 전에 크기를 정하므로 자기 webContents 의 배율을 믿지 않는다.
  zoomFactor: () => number;
  // 시험 인스턴스: 창을 앞으로 가져오거나 포커스를 주지 않고(showInactive), blur 로 닫지 않는다.
  inactive: boolean;
  // 시험 인스턴스: 화면에 나타나지 않게 투명하고 마우스가 통과한다.
  invisible: boolean;
  theme: () => "dark" | "light";
  colors: (theme: "dark" | "light") => { background: string; foreground: string; border: string };
  log: (message: string) => void;
  strings: { daemonDown: string };
  // 다른 앱 위에서 열었던 창을 사용자가 닫을 때 포커스를 그 앱에 돌려준다. hideWindow 는 이 창을 숨기는 일이고, 부르는 순서는 받는 쪽이 정한다.
  yieldFocus: (hideWindow: () => void) => void;
};

export class QuickEntryWindow {
  private win: BrowserWindow | null = null;
  private shownAt = 0;
  private loadFailed = false;
  private saved: MiniSaved;
  private pinnedNow: boolean;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  // 다른 앱을 쓰던 중에 이 창으로 들어왔는지. 그렇다면 닫을 때 Lodestar 메인 창이 앞으로 나오지 않고 쓰던 앱으로 돌아간다(dismiss).
  private fromOutside = false;

  constructor(private readonly options: QuickEntryOptions) {
    this.saved = loadSaved(options.savedFile);
    this.pinnedNow = options.initialPinned;
    // 이 창을 쓰다가 Lodestar 의 다른 창을 눌렀으면 닫아도 Lodestar 에 머문다.
    app.on("browser-window-focus", (_event, focused) => {
      if (focused !== this.win) this.fromOutside = false;
    });
    // 다른 앱에 있다가 떠 있던 이 창을 눌러 들어왔으면 닫을 때 그 앱으로 돌아간다.
    app.on("did-become-active", () =>
      setImmediate(() => {
        if (this.win && !this.win.isDestroyed() && this.win.isFocused()) this.fromOutside = true;
      }),
    );
  }

  // 마지막으로 페이지가 잰 카드 높이(CSS px). 배율이 바뀐 뒤 다시 띄울 때 창 높이를 새로 계산하는 데 쓴다.
  private cardHeight: number | null = null;

  // 이 창은 메인 창과 같은 주소를 열어서 Chromium 이 확대 배율(같은 origin 끼리 공유)을 같이 적용한다.
  // 토큰 크기와 페이지가 재는 높이는 CSS px 라, 창 크기(DIP)로 쓰려면 배율을 곱해야 한다. 안 곱하면 1.2배로 그려진 카드가 1배 창에서 잘린다.
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

  // 묶인 미니 대화의 세션. 없으면 입력 막대다. 알림 라우팅이 읽는다.
  get agentId() {
    return this.saved.agentId;
  }

  get mode(): MiniMode {
    return modeFor(this.saved.agentId);
  }

  get pinned() {
    return this.pinnedNow;
  }

  // 대화 화면이 알려 준 핀 상태(Settings 의 Hide on outside click 의 반대)
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

  get bounds(): Rect | null {
    return this.win && !this.win.isDestroyed() ? this.win.getBounds() : null;
  }

  get resizable() {
    return !!this.win && !this.win.isDestroyed() && this.win.isResizable();
  }

  // 전역 단축키. 숨겨져 있으면 늘 새 대화(입력 막대)로 연다. 이어 갈 대화는 막대의 Continue a session 목록에서 고른다(2026-10-22 사용자: "기본은 새 창, 지금은 무조건 이어서 함").
  // 알림을 눌러 미니 대화로 가는 길(show)은 묶인 대화를 그대로 연다.
  // 떠 있지만 다른 창 뒤에 가려진 대화 패널(바깥 클릭으로 숨지 않는다)은 숨기지 않고 앞으로 가져온다. 앞에 있을 때 한 번 더 누르면 닫는다.
  // 전에는 가려진 패널을 숨겨서 첫 ⌥C 는 아무 일도 없어 보였고 두 번째에 대화가 새 막대로 바뀌었다.
  toggle() {
    const shownWin = this.win;
    if (shownWin && this.visible && !shownWin.isFocused() && !this.options.inactive) {
      this.fromOutside = !BrowserWindow.getAllWindows().some((other) => other !== shownWin && !other.isDestroyed() && other.isFocused());
      shownWin.show();
      shownWin.focus();
      shownWin.webContents.send("agent-nav:quick-entry-show");
      return;
    }
    if (this.visible) return this.dismiss();
    if (this.mode !== "chat") return this.show();
    const win = this.ensureWindow();
    this.startNew();
    // 막대 페이지가 다 읽힌 뒤에 보여서 옛 대화 화면이 잠깐 비치지 않게 한다. 읽기가 늦거나 실패해도 띄운다.
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
    // 보이기 전에 본다: Lodestar 창에 포커스가 없으면 다른 앱을 쓰던 중이다.
    if (!win.isVisible()) this.fromOutside = !BrowserWindow.getAllWindows().some((other) => other !== win && !other.isDestroyed() && other.isFocused());
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

  // 사용자가 직접 닫았다(단축키, Esc, 닫기 단추, 보내고 숨기기). 그냥 숨기면 Lodestar 가 활성 앱으로 남아 메인 창이 앞으로 나온다.
  // 다른 앱 위에서 연 창이면 포커스를 그 앱에 돌려준다. 메인 창을 쓰다 연 창이면 메인 창에 머문다.
  dismiss() {
    const win = this.win;
    if (!win || win.isDestroyed() || !win.isVisible()) return;
    if (this.fromOutside && !this.options.inactive && win.isFocused()) this.options.yieldFocus(() => this.hide());
    else this.hide();
  }

  destroy() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }

  // 런처에서 보냈다. Enter 면 이 자리에서 대화로 커지고, ⌘Enter(stay)면 대화를 묶어 두고 숨긴다.
  finishSend(agentId: string, stay: boolean) {
    const outcome = afterSend(agentId, stay);
    this.bind(outcome.state.agentId);
    const win = this.ensureWindow();
    this.growTo(win, win.getBounds());
    this.load(win);
    if (outcome.hide) this.dismiss();
  }

  // 대화 머리의 세션 바꾸기. 패널은 그 자리에 두고 화면만 바꾼다.
  switchTo(agentId: string) {
    this.bind(agentId);
    this.load(this.ensureWindow());
  }

  // 새 미니 대화: 묶인 세션을 풀고 입력 막대로. 막대는 대화 패널의 윗변 가운데에 선다.
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

  // 페이지가 잰 카드 높이(바깥 여백 제외)로 창 높이를 맞춘다. 윗변은 그대로 두고 아래로만 자란다. 대화 패널은 사용자가 정한 크기가 우선이라 무시한다.
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

  // blur 로 숨길지 판단해 숨긴다. asIfActive 는 시험용: 포커스를 가질 수 없는 시험 인스턴스에서 같은 판정을 강제로 돌린다.
  // 대화 패널은 따로 떠 있는 창이라 바깥(배경화면 등)을 눌러도 숨기지 않는다(늘 핀). 다시 눌러 포커스하고 가장자리를 끌어 크기를 바꾼다.
  // 숨기기는 ⌥C, Esc, 닫기 단추다(2026-11-04 사용자: 배경화면을 누르면 창이 사라짐, 별도 창처럼 다루고 싶다).
  handleBlur(asIfActive = false): "hide" | "keep" {
    const action = blurAction({ mode: this.mode, pinned: true, inactive: asIfActive ? false : this.options.inactive, sinceShownMs: Date.now() - this.shownAt, guardMs: SHOWN_GUARD_MS });
    if (action === "hide") this.hide();
    return action;
  }

  // 시험용: 지금 저장 파일에 적힌 값을 다시 읽어 본다.
  readSaved(): MiniSaved {
    return loadSaved(this.options.savedFile);
  }

  // 시험용: 끌기와 크기 조절은 OS 가 하는 일이라, 같은 이벤트 경로(move, resize → 저장)를 setBounds 로 태운다.
  setBoundsForTest(bounds: Rect) {
    this.win?.setBounds(bounds);
  }

  // 대화 세션을 묶고 파일에 적는다.
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

  // 대화 패널의 자리를 적는다. 끌거나 늘리는 이벤트가 멈춘 뒤 한 번.
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

  // 대화 패널로 커진다: 저장한 자리가 있으면 거기(화면 안으로 보정), 없으면 지금 막대의 윗변 가운데에서 아래로.
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
      // 숨겨 둔 사이 화면이 바뀌었거나 배율이 달라졌을 수 있다. 저장한 자리를 지금 화면 안으로 다시 보정한다.
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
    // 숨겨 둔 사이 배율이 바뀌었을 수 있어, 아는 카드 높이가 있으면 지금 배율로 다시 계산한다.
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
    // 창 높이와 Space 소속은 모양마다 chatChrome 이 정한다(보이기 전 place, 대화로 커질 때 growTo, 새 막대로 돌아갈 때 startNew).
    if (options.invisible) {
      win.setOpacity(0);
      win.setIgnoreMouseEvents(true);
    }
    // 바깥 클릭(포커스를 잃음)으로 닫는다. 막 뜬 직후의 포커스 흔들림, 핀을 꽂은 대화, 포커스가 없는 시험 인스턴스는 닫지 않는다(shared/miniChat.ts blurAction).
    win.on("blur", () => {
      this.handleBlur();
    });
    // 페이지가 같은 origin 의 앱 창과 같은 배율로 그려지게 맞춘다(창 크기 계산이 쓰는 배율과 같아야 잘리지 않는다).
    win.webContents.on("dom-ready", () => {
      const factor = this.zoom;
      if (Math.abs(win.webContents.getZoomFactor() - factor) > 0.001) win.webContents.setZoomFactor(factor);
    });
    win.on("move", () => this.scheduleSave());
    win.on("resize", () => this.scheduleSave());
    win.on("closed", () => {
      if (this.win === win) this.win = null;
    });
    // 앱 메뉴 가속키(⌘N, ⌘R 등)는 포커스된 창이 아니라 메인 창에 명령을 보낸다. 창 안의 편집 키만 통과시킨다.
    win.webContents.on("before-input-event", (event, input) => {
      if (input.type !== "keyDown") return;
      // 안내 페이지에는 Esc 를 받을 코드가 없어서 메인이 닫는다.
      if (this.loadFailed && input.key === "Escape") this.dismiss();
      const verdict = quickInputPolicy({ key: input.key, code: input.code, meta: input.meta, control: input.control, alt: input.alt, shift: input.shift });
      if (verdict === "allow") return;
      event.preventDefault();
      if (verdict === "hide") this.dismiss();
      // 메뉴 가속키와 같은 키라 막은 뒤, 메인 창(electron/main.ts forwardKey)과 같은 모양으로 이 창의 페이지에 넘긴다.
      if (verdict === "forward") {
        const detail = { code: input.code, key: input.key, metaKey: input.meta, ctrlKey: input.control, altKey: input.alt, shiftKey: input.shift };
        void win.webContents.executeJavaScript(`window.dispatchEvent(new CustomEvent("agent-nav:key", { detail: ${JSON.stringify(detail)} }))`).catch(() => undefined);
      }
    });
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    // origin 으로 비교한다: 앞부분 비교는 http://127.0.0.1:7788@evil.example/ 도 통과시켜 바깥 페이지가 preload 를 받는다.
    win.webContents.on("will-navigate", (event, url) => {
      if (!sameOrigin(url, options.urlBase)) event.preventDefault();
    });
    // 데몬이 꺼져 있으면 페이지를 받을 수 없다. 그때는 안내만 있는 정적 페이지를 보이고, 다음에 열 때 다시 읽어 본다.
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

  // 데몬에 닿지 못했을 때 입력창 자리에 뜨는 안내. 이 페이지에는 preload 의 IPC 가 닿지 않는다(메인이 데몬 주소의 페이지만 믿는다). 닫기는 Esc(메인이 처리)와 바깥 클릭이다.
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

// 대화 패널은 카드가 창을 꽉 채우고(web/miniChat.css), shadow 는 macOS 창 shadow 로 그린다. 투명 여백에 CSS shadow 를 두면 보이는 카드 바깥의 창 가장자리에서
// 크기 조절과 클릭이 잡혀, 눈에 보이는 테두리와 실제 창이 어긋났다(2026-10-21 사용자). 입력 막대는 예전처럼 여백 안의 CSS shadow 를 쓴다.
// 입력 막대는 Spotlight 처럼 지금 Space 의 모든 창 위(전체 화면 앱 위 포함)에 뜬다. 대화 패널은 보통 창이다: 다른 앱을 누르면 그 뒤로 가고, 지금 Space 에 붙고,
// 알트탭과 ⌘` 와 Mission Control 에 창으로 잡힌다(2026-11-05 사용자: 상단에 고정하지 말고 창 단위로 묶이게). skipTransformProcessType 은 Dock 아이콘과 메인 창이 깜빡이는 걸 막는다.
function chatChrome(win: BrowserWindow, chat: boolean) {
  win.setHasShadow(chat);
  if (chat && process.platform === "darwin") win.invalidateShadow();
  win.setAlwaysOnTop(!chat, "pop-up-menu");
  if (process.platform === "darwin") win.setVisibleOnAllWorkspaces(!chat, { visibleOnFullScreen: !chat, skipTransformProcessType: true });
}
