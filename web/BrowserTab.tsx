import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode, type RefObject } from "react";
import { confirmAction } from "./ConfirmDialog";
import { BROWSER_PARTITION, filePathOf, isOwnOrigin, resolveAddress } from "./browserUrl";
import { flipFavorite, recordTitle, recordVisit, useFavorites } from "./browserHistory";
import { registerGuest } from "./browserHost";
import { isNotionUrl } from "../shared/notionLink";
import { attachNotionPage } from "./notionAttach";
import { registerTabReader } from "./notionPage";
import { N } from "./notionStrings";
import { togglePinOfTab, usableTitle, usePinFor } from "./notionStore";
import { addAreaScreenshot, addConsoleLogs, addElementToChat, addFullPageScreenshot, addScreenshotToChat, commentOnElements, toggleShare } from "./browserShare";
import { clampZoom, DEFAULT_EMULATION, DEVICE_PRESETS, emulatedFrame, parseDimension, percentToZoom, readFrameLocation, resizedDimension, SASH_ROOM, SCALE_CHOICES, scaleLabel, zoomFactor, type Emulation } from "./browserView";
import { Back, Codicon, Forward, More, Refresh } from "./icons";
import { rpc } from "./rpc";
import { IN_ELECTRON } from "./shortcuts";
import { flash, openBrowser, setState, updateBrowserTab, useStore, type BrowserAction, type BrowserTab } from "./store";
import { S } from "./strings";
import { Button } from "./ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "./ui/dropdown-menu";
import type { BrowserSearchEngine } from "../shared/protocol";
import type { WebviewElement } from "./webview";
import type { EffectiveStorage } from "./browserUrl";
import { hint } from "./hint";

export function BrowserTabView({ tab, active }: { tab: BrowserTab; active: boolean }) {
  const engineRef = useRef<Engine>(NO_ENGINE);
  const settings = useStore((s) => s.settings);
  const defaultZoom = settings?.browserPageZoom == null ? 0 : percentToZoom(settings.browserPageZoom);
  const [zoom, setZoom] = useState(defaultZoom);
  const [findOpen, setFindOpen] = useState(false);
  const [emulation, setEmulation] = useState<Emulation | null>(null);
  // 요소 선택 모드(Add Element, Comment on Elements, Area Screenshot) 중 어느 것이 켜져 있는가
  const [picking, setPicking] = useState<PickKind | null>(null);
  const favorites = useFavorites();
  const request = useStore((s) => s.browserAction);
  const handled = useRef(0);
  const favorited = tab.url !== "" && favorites.some((f) => f.url === tab.url);
  const notionPin = usePinFor(tab.url);
  const isNotion = isNotionUrl(tab.url);
  const sharedWith = tab.sharedWith ?? null;
  const engine: BrowserSearchEngine = settings?.browserSearchEngine ?? "bing";
  // Refresh Automatically: 이 탭의 선택이 있으면 그것, 없으면 설정 Auto Reload On File Change(기본 켬). file: 주소일 때만 뜻이 있다.
  const isFile = filePathOf(tab.url) !== null;
  const autoReload = isFile && (tab.autoReload ?? settings?.browserAutoReload ?? true);

  useEffect(() => {
    if (tab.url) recordVisit(tab.url, tab.title);
  }, [tab.url]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (tab.url && tab.title) recordTitle(tab.url, tab.title);
  }, [tab.title]); // eslint-disable-line react-hooks/exhaustive-deps

  // 요소 선택 계열은 한 번에 하나만 켠다. 켜진 모드의 단추를 다시 누르면(또는 다른 모드를 누르면) 지금 것을 취소한다.
  const startPick = async (kind: PickKind) => {
    const id = engineRef.current.webContentsId();
    if (picking) {
      if (id !== null) void window.agentNavNative?.browserPickCancel?.(id);
      if (picking === kind) return;
    }
    setPicking(kind);
    hint(kind === "comment" ? S.browserPickingComment : kind === "area" ? S.browserPickingArea : S.browserPicking);
    try {
      if (kind === "comment") await commentOnElements(id, tab.url);
      else if (kind === "area") await addAreaScreenshot(id, tab.url);
      else await addElementToChat(id, tab.url);
    } finally {
      setPicking((current) => (current === kind ? null : current));
    }
  };
  const addElement = () => void startPick("element");
  const screenshot = () => void addScreenshotToChat({ webContentsId: engineRef.current.webContentsId(), url: tab.url, title: tab.title });
  const share = () => void toggleShare(tab.key, sharedWith);
  const toggleFavorite = () => flipFavorite(tab.url, tab.title);
  const applyPreset = (name: string) => {
    const preset = DEVICE_PRESETS.find((p) => p.name === name);
    if (preset) setEmulation((e) => ({ ...(e ?? DEFAULT_EMULATION), width: preset.width, height: preset.height, dpr: preset.dpr, mobile: preset.mobile, userAgent: preset.userAgent }));
  };

  // 메뉴, 단축키, 팔레트, History 선택창이 store 의 browserAction 으로 보낸 요청을 이 탭이 처리한다.
  useEffect(() => {
    if (!request || request.key !== tab.key || request.nonce === handled.current) return;
    handled.current = request.nonce;
    const run: Record<BrowserAction, () => void> = {
      navigate: () => request.url && engineRef.current.navigate(request.url),
      reload: () => engineRef.current.reload(),
      zoomIn: () => setZoom((z) => clampZoom(z + 1)),
      zoomOut: () => setZoom((z) => clampZoom(z - 1)),
      zoomReset: () => setZoom(defaultZoom),
      find: () => (IN_ELECTRON ? setFindOpen(true) : hint(S.browserWebOnly)),
      favorite: toggleFavorite,
      addElement,
      commentElements: () => void startPick("comment"),
      consoleLogs: () => void addConsoleLogs(engineRef.current.webContentsId(), tab.url),
      areaScreenshot: () => void startPick("area"),
      share,
      screenshot,
      applyPreset: () => request.value && applyPreset(request.value),
      setUserAgent: () => setEmulation((e) => ({ ...(e ?? DEFAULT_EMULATION), userAgent: request.value ?? "" })),
    };
    run[request.action]();
  }); // eslint-disable-line react-hooks/exhaustive-deps

  const actions: BarActions = {
    notion: isNotion ? { pinned: notionPin !== null, onPin: () => void togglePinOfTab(tab), onAddPage: () => void attachNotionPage({ url: tab.url, title: usableTitle(tab.title, tab.url) ?? undefined, tabKey: tab.key }) } : null,
    favorited,
    picking,
    sharedWith,
    isFile,
    autoReload,
    scope: tab.scope ?? "global",
    onToggleAutoReload: () => updateBrowserTab(tab.key, { autoReload: !autoReload }),
    userTools: settings?.browserUserTools ?? false,
    onFullPageScreenshot: () => void addFullPageScreenshot(engineRef.current.webContentsId(), tab.url),
    emulationOn: emulation !== null,
    engine,
    onNewTab: () => openBrowser(),
    onZoom: (delta) => setZoom((z) => (delta === 0 ? defaultZoom : clampZoom(z + delta))),
    onFind: () => (IN_ELECTRON ? setFindOpen(true) : hint(S.browserWebOnly)),
    onEmulation: () => setEmulation((e) => (e ? null : { ...DEFAULT_EMULATION })),
    onHistory: () => setState({ overlay: { kind: "browserHistory", tabKey: tab.key } }),
    onFavorite: toggleFavorite,
    onPermissions: () => setState({ overlay: { kind: "sitePermissions", url: tab.url } }),
    onClearStorage: () => void clearStorage(tab.partition),
    onSettings: () => setState({ overlay: { kind: "status", section: "browser" } }),
    onShare: share,
    onAddElement: addElement,
    onComment: () => void startPick("comment"),
    onConsoleLogs: () => void addConsoleLogs(engineRef.current.webContentsId(), tab.url),
    onScreenshot: screenshot,
    onAreaScreenshot: () => void startPick("area"),
  };
  const shared: Shared = { tab, active, engineRef, zoom, emulation, setEmulation, findOpen, setFindOpen, actions, autoReload };

  return (
    <div className="browser-tab" hidden={!active}>
      {IN_ELECTRON ? <WebviewBrowser {...shared} /> : <FrameBrowser {...shared} />}
    </div>
  );
}

// 새 창 요청이 메인 프로세스의 setWindowOpenHandler(electron/main.ts)까지 가게 한다. 이 속성이 없으면 <webview> 가 요청을 핸들러에 보이기 전에 막는다. 핸들러가 앱 안 창은 로그인 창 외에 만들지 않는다.
// React 의 타입은 이 속성을 boolean 으로 보지만 DOM 에는 문자열이 있어야 붙어서 펼침 속성으로 넘긴다.
const ALLOW_POPUPS: object = { allowpopups: "true" };

type PickKind = "element" | "comment" | "area";

async function clearStorage(partition: string | undefined) {
  if (!(await confirmAction(S.browserClearConfirm, S.browserClearButton, S.browserClearDetail))) return;
  try {
    await window.agentNavNative?.browserClearStorage?.(partition);
    flash(S.browserStorageCleared);
  } catch (error) {
    flash((error as Error).message);
  }
}

// 엔진이 탭에 알려 주는 손잡이. 엔진이 렌더될 때마다 자기 것으로 채운다.
type Engine = {
  navigate: (url: string) => void;
  webContentsId: () => number | null;
  find: (text: string, options: { matchCase: boolean; forward: boolean; next: boolean }) => void;
  stopFind: () => void;
  reload: () => void;
};
const NO_ENGINE: Engine = { navigate: () => undefined, webContentsId: () => null, find: () => undefined, stopFind: () => undefined, reload: () => undefined };

type BarActions = {
  // NOTION: 지금 페이지가 Notion 이면 고정(Pin to Sidebar)과 본문 첨부(Add Page to Chat) 동작. 아니면 null.
  notion: { pinned: boolean; onPin: () => void; onAddPage: () => void } | null;
  // file: 주소를 보여 주는 탭인가, Refresh Automatically 가 켜져 있는가(켜면 파일이 바뀔 때 다시 읽는다)
  isFile: boolean;
  autoReload: boolean;
  // 이 탭의 저장 범위(Clear Storage 메뉴 이름이 따른다)
  scope: EffectiveStorage;
  onToggleAutoReload: () => void;
  // 설정 Experimental User Tools 가 켜졌는가(Add Full Page Screenshot to Chat 이 보인다)
  userTools: boolean;
  onFullPageScreenshot: () => void;
  favorited: boolean;
  picking: PickKind | null;
  // 이 탭을 공유한 세션 id. null 이면 공유 안 함.
  sharedWith: string | null;
  engine: BrowserSearchEngine;
  emulationOn: boolean;
  onNewTab: () => void;
  onZoom: (delta: number) => void;
  onFind: () => void;
  onEmulation: () => void;
  onHistory: () => void;
  onFavorite: () => void;
  onPermissions: () => void;
  onClearStorage: () => void;
  onSettings: () => void;
  onShare: () => void;
  onAddElement: () => void;
  onComment: () => void;
  onConsoleLogs: () => void;
  onScreenshot: () => void;
  onAreaScreenshot: () => void;
};

type Shared = {
  tab: BrowserTab;
  active: boolean;
  engineRef: RefObject<Engine>;
  zoom: number;
  emulation: Emulation | null;
  setEmulation: (value: Emulation | null) => void;
  findOpen: boolean;
  setFindOpen: (open: boolean) => void;
  actions: BarActions;
  autoReload: boolean;
};

type NavState = { back: boolean; forward: boolean };

const FIND_RETRY_MS = 300;

function WebviewBrowser({ tab, active, engineRef, zoom, emulation, setEmulation, findOpen, setFindOpen, actions, autoReload }: Shared) {
  const viewRef = useRef<WebviewElement | null>(null);
  const ready = useRef(false);
  const zoomRef = useRef(zoom);
  const inputRef = useRef<HTMLInputElement>(null);
  const [startUrl, setStartUrl] = useState(tab.url);
  const [address, setAddress] = useState(tab.url);
  const [nav, setNav] = useState<NavState>({ back: false, forward: false });
  const [notice, setNotice] = useState<string | null>(null);
  const [found, setFound] = useState<{ index: number; total: number } | null>(null);
  // 새 글로 처음 하는 찾기(findNext 없음)는 Chromium 이 결과 알림을 안 줄 때가 있다(창이 비활성일 때 확인). 알림이 없으면 findNext 로 한 번 더 요청한다.
  const foundSeq = useRef(0);
  const started = startUrl !== "";
  const [dialog, setDialog] = useState<{ type: string; message: string; defaultPrompt: string } | null>(null);
  const pendingReload = useRef(false);
  const activeRef = useRef(active);
  activeRef.current = active;
  zoomRef.current = zoom;

  useFocusOnOpen(inputRef, active, tab.url === "");

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const sync = () => {
      if (ready.current) setNav({ back: view.canGoBack(), forward: view.canGoForward() });
    };
    const onNavigate = (event: Event) => {
      const detail = event as Event & { url: string; isMainFrame?: boolean };
      if (detail.isMainFrame === false) return;
      setAddress(detail.url);
      setNotice(null);
      updateBrowserTab(tab.key, { url: detail.url });
      sync();
    };
    const onReady = () => {
      ready.current = true;
      view.setZoomLevel(zoomRef.current);
      sync();
      watchRef.current();
    };
    const onTitle = (event: Event) => updateBrowserTab(tab.key, { title: (event as Event & { title: string }).title });
    // -3 은 다른 이동이 앞선 취소(ERR_ABORTED)라 오류로 안 친다
    const onFail = (event: Event) => {
      const detail = event as Event & { errorCode: number; errorDescription: string; isMainFrame: boolean };
      if (detail.isMainFrame && detail.errorCode !== -3) setNotice(S.browserLoadFailed(detail.errorDescription));
    };
    const onFound = (event: Event) => {
      foundSeq.current++;
      const result = (event as Event & { result: { activeMatchOrdinal: number; matches: number; finalUpdate: boolean } }).result;
      if (result.finalUpdate || result.matches > 0) setFound({ index: result.activeMatchOrdinal, total: result.matches });
    };
    view.addEventListener("dom-ready", onReady);
    view.addEventListener("did-navigate", onNavigate);
    view.addEventListener("did-navigate-in-page", onNavigate);
    view.addEventListener("page-title-updated", onTitle);
    view.addEventListener("did-fail-load", onFail);
    view.addEventListener("found-in-page", onFound);
    return () => {
      ready.current = false;
      view.removeEventListener("dom-ready", onReady);
      view.removeEventListener("did-navigate", onNavigate);
      view.removeEventListener("did-navigate-in-page", onNavigate);
      view.removeEventListener("page-title-updated", onTitle);
      view.removeEventListener("did-fail-load", onFail);
      view.removeEventListener("found-in-page", onFound);
    };
  }, [started, tab.key]);

  useEffect(() => {
    if (viewRef.current && ready.current) viewRef.current.setZoomLevel(zoom);
  }, [zoom]);

  // Auto Reload On File Change: file: 주소를 보여 주는 동안 메인이 그 파일을 지켜보고, 바뀌면 알린다. 보이지 않는 탭은 보일 때 다시 읽는다.
  const watchRef = useRef<() => void>(() => undefined);
  watchRef.current = () => {
    const id = webContentsId();
    if (id !== null) void window.agentNavNative?.browserWatchFile?.(id, autoReload).catch(() => undefined);
  };
  useEffect(() => watchRef.current(), [autoReload, tab.url, started]);
  useEffect(() => {
    return window.agentNavNative?.onBrowserFileChanged?.(({ id }) => {
      if (id !== webContentsId()) return;
      if (activeRef.current) viewRef.current?.reload();
      else pendingReload.current = true;
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (active && pendingReload.current) {
      pendingReload.current = false;
      viewRef.current?.reload();
    }
  }, [active]);

  // 공유 중인 탭의 페이지가 대화상자(alert, confirm, prompt, beforeunload)를 띄우면 사용자도 여기서 답할 수 있다(에이전트는 handle_dialog 로 답한다).
  useEffect(() => {
    return window.agentNavNative?.onBrowserDialog?.(({ id, dialog: next }) => {
      if (id === webContentsId()) setDialog(next);
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const go = (input: string) => {
    const target = checkAddress(input, actions.engine);
    if (!target.ok) {
      setNotice(target.reason);
      return;
    }
    setNotice(null);
    setAddress(target.url);
    updateBrowserTab(tab.key, { url: target.url });
    const view = viewRef.current;
    if (!view) setStartUrl(target.url);
    else if (ready.current) void view.loadURL(target.url).catch(() => undefined);
    else view.setAttribute("src", target.url);
  };
  const run = (action: (view: WebviewElement) => void) => {
    if (viewRef.current && ready.current) action(viewRef.current);
  };
  const webContentsId = () => {
    try {
      return viewRef.current && ready.current ? viewRef.current.getWebContentsId() : null;
    } catch {
      return null;
    }
  };

  // 에이전트의 도구가 이 탭의 webContents 를 찾을 수 있게 알려 둔다(공유된 탭만 쓰인다).
  useEffect(() => registerGuest(tab.key, () => engineRef.current.webContentsId()), [tab.key, engineRef]);
  // Add Page to Chat 이 이 탭의 페이지 본문을 읽을 수 있게 알려 둔다(Notion 페이지에서만 쓰인다).
  useEffect(() => registerTabReader(tab.key, async (code) => (viewRef.current && ready.current ? viewRef.current.executeJavaScript(code) : Promise.reject(new Error("not ready")))), [tab.key]);

  useEffect(() => {
    engineRef.current = {
      navigate: go,
      webContentsId,
      reload: () => run((v) => v.reload()),
      find: (text, options) =>
        run((v) => {
          if (!text) return;
          const request = { matchCase: options.matchCase, forward: options.forward, findNext: options.next };
          const seq = foundSeq.current;
          v.findInPage(text, request);
          window.setTimeout(() => {
            if (foundSeq.current === seq) v.findInPage(text, { ...request, findNext: true });
          }, FIND_RETRY_MS);
        }),
      stopFind: () => run((v) => v.stopFindInPage("clearSelection")),
    };
  });

  // 기기 에뮬레이션의 DPR 과 화면 크기를 guest 에 적용한다. 크기가 auto 면 이 칸을 채우는 크기(emuSize)를 쓴다.
  const [emuSize, setEmuSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const id = webContentsId();
    const native = window.agentNavNative?.browserEmulate;
    if (id === null || !native) return;
    const width = emulation ? emulation.width || emuSize.width : 0;
    const height = emulation ? emulation.height || emuSize.height : 0;
    void native(id, emulation && width >= 1 && height >= 1 ? { width, height, dpr: emulation.dpr, mobile: emulation.mobile, userAgent: emulation.userAgent || null } : null).catch(() => undefined);
  }, [emulation, emuSize.width, emuSize.height, started]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <BrowserBar
        inputRef={inputRef}
        address={address}
        committed={tab.url}
        onAddress={setAddress}
        onSubmit={go}
        canBack={nav.back}
        canForward={nav.forward}
        onBack={() => run((v) => v.goBack())}
        onForward={() => run((v) => v.goForward())}
        onReload={(hard) => run((v) => (hard ? v.reloadIgnoringCache() : v.reload()))}
        onDevTools={() => run((v) => v.openDevTools())}
        url={tab.url}
        actions={actions}
        native
      />
      {emulation && <EmulationBar emulation={emulation} onChange={setEmulation} tabKey={tab.key} native available={emuSize} />}
      {dialog && <PageDialogBar dialog={dialog} onAnswer={(accept, text) => void window.agentNavNative?.browserDialogAnswer?.(webContentsId() ?? -1, accept, text)} />}
      {findOpen && (
        <FindBar
          found={found}
          onFind={(text, options) => engineRef.current.find(text, options)}
          onClose={() => {
            engineRef.current.stopFind();
            setFound(null);
            setFindOpen(false);
          }}
        />
      )}
      {notice && <div className="browser-notice">{notice}</div>}
      <Stage emulation={emulation} onSize={setEmuSize} onResize={(next) => emulation && setEmulation({ ...emulation, ...next })} shared={actions.sharedWith !== null}>
        {started ? <webview ref={viewRef as RefObject<HTMLElement>} className="browser-view" src={startUrl} partition={tab.partition ?? BROWSER_PARTITION} webpreferences="contextIsolation=yes, nodeIntegration=no, sandbox=yes" {...ALLOW_POPUPS} /> : <BrowserEmpty />}
      </Stage>
    </>
  );
}

type FrameCheck = { state: "checking" } | { state: "ok" } | { state: "blocked"; message: string };

function FrameBrowser({ tab, active, engineRef, zoom, emulation, setEmulation, actions }: Shared) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [history, setHistory] = useState<{ urls: string[]; index: number }>({ urls: tab.url ? [tab.url] : [], index: 0 });
  const [address, setAddress] = useState(tab.url);
  const [notice, setNotice] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);
  const [check, setCheck] = useState<FrameCheck>({ state: "checking" });
  // 프레임 안 페이지의 주소를 읽을 수 있었는지. 같은 출처일 때만 읽히므로 보통은 false 이고, 그때는 한계를 안내 문구로 남긴다.
  const [followed, setFollowed] = useState<boolean | null>(null);
  const [emuSize, setEmuSize] = useState({ width: 0, height: 0 });
  const current = history.urls[history.index] ?? "";

  useFocusOnOpen(inputRef, active, tab.url === "");

  // 주소가 바뀌면 데몬이 응답 머리를 받아 iframe 으로 열 수 있는지 본다. 막히면 빈 프레임 대신 이유를 보인다.
  useEffect(() => {
    if (!current) return;
    let cancelled = false;
    setCheck({ state: "checking" });
    setFollowed(null);
    void checkFrame(current).then((result) => {
      if (!cancelled) setCheck(result);
    });
    return () => {
      cancelled = true;
    };
  }, [current, reloads]);

  const go = (input: string) => {
    const target = checkAddress(input, actions.engine);
    if (!target.ok) {
      setNotice(target.reason);
      return;
    }
    if (target.url.startsWith("file:")) {
      setNotice(S.browserFileDesktopOnly);
      return;
    }
    setNotice(null);
    setAddress(target.url);
    updateBrowserTab(tab.key, { url: target.url, title: new URL(target.url).host });
    setHistory((h) => {
      const urls = [...h.urls.slice(0, h.index + 1), target.url];
      return { urls, index: urls.length - 1 };
    });
  };
  const step = (delta: number) => {
    const index = history.index + delta;
    const url = history.urls[index];
    if (url === undefined) return;
    setHistory({ ...history, index });
    setAddress(url);
    updateBrowserTab(tab.key, { url, title: new URL(url).host });
  };
  // 프레임이 다 뜨면 안의 주소와 제목을 읽어 본다. 같은 출처면 링크를 따라간 주소로 주소창과 탭 제목을 맞추고, 아니면 읽을 수 없다.
  const onFrameLoad = (frame: HTMLIFrameElement) => {
    const location = readFrameLocation(frame.contentWindow);
    setFollowed(location !== null);
    if (!location) return;
    setAddress(location.url);
    updateBrowserTab(tab.key, { url: location.url, title: location.title || new URL(location.url).host });
  };

  useEffect(() => {
    engineRef.current = { ...NO_ENGINE, navigate: go, reload: () => setReloads((n) => n + 1) };
  });

  const factor = zoomFactor(zoom);
  return (
    <>
      <BrowserBar
        inputRef={inputRef}
        address={address}
        committed={current}
        onAddress={setAddress}
        onSubmit={go}
        canBack={history.index > 0}
        canForward={history.index < history.urls.length - 1}
        onBack={() => step(-1)}
        onForward={() => step(1)}
        onReload={() => setReloads((n) => n + 1)}
        onDevTools={null}
        url={current}
        actions={actions}
        native={false}
      />
      {emulation && <EmulationBar emulation={emulation} onChange={setEmulation} tabKey={tab.key} native={false} available={emuSize} />}
      {notice && <div className="browser-notice">{notice}</div>}
      {current && check.state === "ok" && followed === false && <div className="browser-notice">{S.browserFrameLimits}</div>}
      <Stage emulation={emulation} onSize={setEmuSize} onResize={(next) => emulation && setEmulation({ ...emulation, ...next })} shared={false}>
        {!current && <BrowserEmpty />}
        {current && check.state === "checking" && <div className="browser-empty">{S.browserChecking}</div>}
        {current && check.state === "blocked" && <BrowserBlocked message={check.message} url={current} />}
        {current && check.state === "ok" && (
          <div className="browser-frame-zoom" style={{ width: `${100 / factor}%`, height: `${100 / factor}%`, transform: `scale(${factor})` }}>
            <iframe key={`${current}|${reloads}`} className="browser-view" src={current} title={S.browserTabTitle} referrerPolicy="no-referrer" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals" onLoad={(e) => onFrameLoad(e.currentTarget)} />
          </div>
        )}
      </Stage>
    </>
  );
}

function Stage({ emulation, onSize, onResize, shared, children }: { emulation: Emulation | null; onSize: (size: { width: number; height: number }) => void; onResize: (next: { width?: number; height?: number }) => void; shared: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState({ width: 0, height: 0 });
  const [dragging, setDragging] = useState<"x" | "y" | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => {
      const next = { width: el.clientWidth, height: el.clientHeight };
      setAvailable((prev) => (prev.width === next.width && prev.height === next.height ? prev : next));
      onSize(next);
    };
    read();
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const frame = emulation ? emulatedFrame(emulation, available) : null;
  // 손잡이를 끌기 시작한 때의 틀 크기와 배율을 기억해 두고, 움직인 만큼 크기 칸(CSS px)으로 바꾼다.
  const startDrag = (axis: "x" | "y") => (event: PointerEvent<HTMLDivElement>) => {
    if (!frame || event.button !== 0) return;
    event.preventDefault();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // 캡처가 안 돼도(합성 이벤트 등) window 에서 이어서 받는다
    }
    const start = { x: event.clientX, y: event.clientY, container: (axis === "x" ? frame.width : frame.height) * frame.scale, scale: frame.scale, pane: (axis === "x" ? available.width : available.height) - SASH_ROOM };
    setDragging(axis);
    const move = (e: globalThis.PointerEvent) => {
      const value = resizedDimension({ container: start.container, scale: start.scale, pane: start.pane }, axis === "x" ? e.clientX - start.x : e.clientY - start.y);
      onResize(axis === "x" ? { width: value } : { height: value });
    };
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      setDragging(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };
  return (
    <div className="browser-stage" ref={ref} data-emulated={emulation ? "" : undefined} data-shared={shared || undefined} data-dragging={dragging ?? undefined}>
      <div className="browser-emu" style={frame ? { width: frame.width * frame.scale, height: frame.height * frame.scale } : undefined}>
        <div className="browser-emu-inner" style={frame ? { width: frame.width, height: frame.height, transform: `scale(${frame.scale})`, transformOrigin: "0 0" } : undefined}>
          {children}
        </div>
        {emulation && (
          <>
            <div className="browser-sash" data-axis="x" role="separator" aria-orientation="vertical" aria-label={S.emuResizeWidth} title={S.emuResizeHint} onPointerDown={startDrag("x")} onDoubleClick={() => onResize({ width: 0 })} />
            <div className="browser-sash" data-axis="y" role="separator" aria-orientation="horizontal" aria-label={S.emuResizeHeight} title={S.emuResizeHint} onPointerDown={startDrag("y")} onDoubleClick={() => onResize({ height: 0 })} />
          </>
        )}
      </div>
    </div>
  );
}

// 페이지가 띄운 대화상자(alert, confirm, prompt, beforeunload)를 사용자가 직접 답하는 줄
function PageDialogBar({ dialog, onAnswer }: { dialog: { type: string; message: string; defaultPrompt: string }; onAnswer: (accept: boolean, text?: string) => void }) {
  const [text, setText] = useState(dialog.defaultPrompt);
  return (
    <div className="browser-dialog" role="alertdialog" aria-label={S.pageDialogTitle(dialog.type)}>
      <span className="browser-dialog-text">{dialog.message || S.pageDialogTitle(dialog.type)}</span>
      {dialog.type === "prompt" && <input className="input" aria-label={S.pageDialogTitle(dialog.type)} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && onAnswer(true, text)} />}
      {dialog.type !== "alert" && (
        <Button size="sm" variant="secondary" onClick={() => onAnswer(false)}>
          {S.pageDialogCancel}
        </Button>
      )}
      <Button size="sm" variant="primary" onClick={() => onAnswer(true, dialog.type === "prompt" ? text : undefined)}>
        {S.pageDialogOk}
      </Button>
    </div>
  );
}

type BarProps = {
  inputRef: RefObject<HTMLInputElement | null>;
  address: string;
  committed: string;
  url: string;
  onAddress: (value: string) => void;
  onSubmit: (value: string) => void;
  canBack: boolean;
  canForward: boolean;
  onBack: () => void;
  onForward: () => void;
  onReload: (hard: boolean) => void;
  onDevTools: (() => void) | null;
  actions: BarActions;
  // 앱(webview)이면 true. 요소 선택, 스크린샷, 찾기, 저장소 지우기는 앱에서만 된다.
  native: boolean;
};

function BrowserBar({ inputRef, address, committed, url, onAddress, onSubmit, canBack, canForward, onBack, onForward, onReload, onDevTools, actions, native }: BarProps) {
  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter") onSubmit(address);
    if (event.key === "Escape") {
      onAddress(committed);
      event.currentTarget.blur();
    }
  };
  return (
    <div className="browser-navbar">
      <div className="browser-nav-buttons">
        <Button size="icon" aria-label={S.browserBack} title={S.browserBack} disabled={!canBack} onClick={onBack}>
          <Back />
        </Button>
        <Button size="icon" aria-label={S.browserForward} title={S.browserForward} disabled={!canForward} onClick={onForward}>
          <Forward />
        </Button>
        <Button size="icon" aria-label={S.browserReload} title={actions.autoReload ? S.browserReloadAuto : S.browserReload} disabled={!url} onClick={(e) => onReload(e.altKey)}>
          {actions.autoReload ? <Codicon name="sync" /> : <Refresh />}
        </Button>
        {actions.isFile && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon" className="browser-reload-more" aria-label={S.browserReloadMore} title={S.browserReloadMore}>
                <Codicon name="chevron-down" size={12} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <MenuRow label={S.browserRefreshAutomatically} checked={actions.autoReload} onSelect={actions.onToggleAutoReload} />
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      <div className="browser-url">
        <input ref={inputRef} className="browser-url-input" aria-label={S.browserUrlPlaceholder} placeholder={actions.engine === "none" ? S.browserUrlOnlyPlaceholder : S.browserUrlPlaceholder} spellCheck={false} value={address} onChange={(e) => onAddress(e.target.value)} onFocus={(e) => e.currentTarget.select()} onKeyDown={onKey} />
        {actions.notion && (
          <button type="button" className="browser-url-button" data-on={actions.notion.pinned || undefined} aria-label={actions.notion.pinned ? N.unpinFromSidebar : N.pinToSidebar} title={actions.notion.pinned ? N.unpinFromSidebar : N.pinToSidebar} onClick={actions.notion.onPin}>
            <Codicon name={actions.notion.pinned ? "pinned" : "pin"} size={14} />
          </button>
        )}
        {actions.favorited && (
          <button type="button" className="browser-url-button" data-on aria-label={S.browserRemoveFavorite} title={S.browserRemoveFavorite} onClick={actions.onFavorite}>
            <Codicon name="star-full" size={14} />
          </button>
        )}
        {actions.sharedWith ? (
          <button type="button" className="browser-share-pill" aria-label={S.stopSharingWithAgent} title={S.stopSharingWithAgent} data-shared onClick={actions.onShare}>
            {S.sharingWithAgent}
            <Codicon name="multiple-windows" size={14} />
          </button>
        ) : (
          <button type="button" className="browser-url-button" aria-label={S.shareWithAgent} title={S.shareWithAgent} disabled={!url || !native} onClick={actions.onShare}>
            <Codicon name="multiple-windows" size={14} />
          </button>
        )}
      </div>
      <div className="browser-actions">
        {actions.notion && (
          <Button size="icon" className="browser-extra" aria-label={N.addPageToChat} title={native ? N.addPageToChatNotion : S.browserDesktopOnly} disabled={!native} onClick={actions.notion.onAddPage}>
            <Codicon name="new-file" />
          </Button>
        )}
        <div className="browser-extra browser-add-element">
          <Button size="icon" variant={actions.picking === "element" ? "ghost-on" : "ghost"} aria-label={S.addElementToChat} aria-pressed={actions.picking === "element"} title={native ? S.addElementKey : S.browserDesktopOnly} disabled={!native || !url} onClick={actions.onAddElement}>
            <Codicon name="inspect" />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon" className="browser-add-chevron" aria-label={S.addToChat} title={S.addToChat} disabled={!url}>
                <Codicon name="chevron-down" size={12} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <MenuRow label={actions.picking === "element" ? S.stopElementSelection : S.addElementToChat} hint="⇧⌘C" disabled={!native} onSelect={actions.onAddElement} />
              <MenuRow label={actions.picking === "comment" ? S.stopElementSelection : S.addCommentOnElements} hint={S.addCommentKey} disabled={!native} onSelect={actions.onComment} />
              <DropdownMenuSeparator />
              {actions.notion && <MenuRow label={N.addPageToChat} disabled={!native} onSelect={actions.notion.onAddPage} />}
              <MenuRow label={S.addConsoleLogsToChat} disabled={!native} onSelect={actions.onConsoleLogs} />
              <DropdownMenuSeparator />
              <MenuRow label={S.addScreenshotToChat} disabled={!native} onSelect={actions.onScreenshot} />
              <MenuRow label={actions.picking === "area" ? S.stopElementSelection : S.addAreaScreenshotToChat} disabled={!native} onSelect={actions.onAreaScreenshot} />
              {actions.userTools && <MenuRow label={S.addFullPageScreenshotToChat} disabled={!native} onSelect={actions.onFullPageScreenshot} />}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        {onDevTools && (
          <Button size="icon" className="browser-extra" aria-label={S.browserDevTools} title={S.browserDevTools} disabled={!url} onClick={onDevTools}>
            <Codicon name="developer-tools" />
          </Button>
        )}
        <BrowserMenu url={url} actions={actions} native={native} />
      </div>
    </div>
  );
}

function BrowserMenu({ url, actions, native }: { url: string; actions: BarActions; native: boolean }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="icon" aria-label={S.browserMore} title={S.browserMore}>
          <More />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <MenuRow label={S.browserNewTab} hint="⌘T" onSelect={actions.onNewTab} />
        <DropdownMenuSeparator />
        <MenuRow label={S.browserZoomIn} hint="⌘=" onSelect={() => actions.onZoom(1)} />
        <MenuRow label={S.browserZoomOut} hint="⌘-" onSelect={() => actions.onZoom(-1)} />
        <MenuRow label={S.browserZoomReset} hint="⌘NumPad0" onSelect={() => actions.onZoom(0)} />
        <DropdownMenuSeparator />
        <MenuRow label={S.browserFind} hint="⌘F" disabled={!native || !url} onSelect={actions.onFind} />
        <MenuRow label={S.browserDeviceEmulation} onSelect={actions.onEmulation} checked={actions.emulationOn} />
        <MenuRow label={S.browserOpenExternal} disabled={!url} onSelect={() => window.open(url, "_blank", "noopener")} />
        <DropdownMenuSeparator />
        <MenuRow label={S.browserHistory} hint="⌘Y" onSelect={actions.onHistory} />
        <MenuRow label={actions.favorited ? S.browserRemoveFavorite : S.browserAddFavorite} hint="⌘D" disabled={!url} onSelect={actions.onFavorite} />
        {actions.notion && <MenuRow label={actions.notion.pinned ? N.unpinFromSidebar : N.pinToSidebar} onSelect={actions.notion.onPin} />}
        {actions.notion && <MenuRow label={N.addPageToChat} disabled={!native} onSelect={actions.notion.onAddPage} />}
        <MenuRow label={S.browserSitePermissions} disabled={!url} onSelect={actions.onPermissions} />
        <MenuRow label={S.browserClearStorageFor(actions.scope)} disabled={!native} onSelect={actions.onClearStorage} />
        <DropdownMenuSeparator />
        <MenuRow label={S.browserSettings} onSelect={actions.onSettings} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function MenuRow({ label, hint, disabled, checked, onSelect }: { label: string; hint?: string; disabled?: boolean; checked?: boolean; onSelect: () => void }) {
  return (
    <DropdownMenuItem disabled={disabled} onSelect={onSelect} data-checked={checked || undefined}>
      {label}
      {hint && <span className="faint xs menu-hint">{hint}</span>}
    </DropdownMenuItem>
  );
}

function EmulationBar({ emulation, onChange, tabKey, native, available }: { emulation: Emulation; onChange: (value: Emulation | null) => void; tabKey: string; native: boolean; available: { width: number; height: number } }) {
  const [text, setText] = useState({ width: emulation.width ? String(emulation.width) : "", height: emulation.height ? String(emulation.height) : "", dpr: emulation.dpr ? String(emulation.dpr) : "" });
  const [invalid, setInvalid] = useState(false);
  // 프리셋이나 초기화로 값이 바뀌면 입력칸도 맞춘다
  useEffect(() => {
    setText({ width: emulation.width ? String(emulation.width) : "", height: emulation.height ? String(emulation.height) : "", dpr: emulation.dpr ? String(emulation.dpr) : "" });
    setInvalid(false);
  }, [emulation.width, emulation.height, emulation.dpr]);
  const commit = (next: { width: string; height: string; dpr: string }) => {
    setText(next);
    const width = parseDimension(next.width);
    const height = parseDimension(next.height);
    const dpr = next.dpr.trim() === "" || next.dpr.trim().toLowerCase() === "auto" ? 0 : Number(next.dpr);
    const bad = width === null || height === null || !Number.isFinite(dpr) || dpr < 0 || dpr > 8;
    setInvalid(bad);
    if (!bad) onChange({ ...emulation, width, height, dpr });
  };
  const autoPercent = Math.round(emulatedFrame({ ...emulation, scale: "auto" }, available).scale * 100);
  return (
    <div className="browser-emulation" role="group" aria-label={S.browserDeviceEmulation}>
      <label>{S.emuDimensions}</label>
      <input className="emu-input" aria-label="Viewport width" placeholder={S.emuAuto} value={text.width} data-invalid={invalid || undefined} title={invalid ? S.emuBadSize : undefined} onChange={(e) => commit({ ...text, width: e.target.value })} />
      <Button size="icon" aria-label={S.emuSwap} title={S.emuSwap} onClick={() => commit({ ...text, width: text.height, height: text.width })}>
        <Codicon name="arrow-swap" />
      </Button>
      <input className="emu-input" aria-label="Viewport height" placeholder={S.emuAuto} value={text.height} data-invalid={invalid || undefined} title={invalid ? S.emuBadSize : undefined} onChange={(e) => commit({ ...text, height: e.target.value })} />
      <label>{S.emuDpr}</label>
      <input className="emu-input emu-dpr" aria-label="Device pixel ratio" placeholder={S.emuAuto} value={text.dpr} onChange={(e) => commit({ ...text, dpr: e.target.value })} />
      <label>{S.emuScale}</label>
      <select className="emu-select" aria-label={S.emuScale} value={String(emulation.scale)} onChange={(e) => onChange({ ...emulation, scale: e.target.value === "auto" ? "auto" : Number(e.target.value) })}>
        {SCALE_CHOICES.map((choice) => (
          <option key={String(choice)} value={String(choice)}>
            {scaleLabel(choice, autoPercent)}
          </option>
        ))}
      </select>
      <span className="spacer" />
      <Button size="icon" aria-label={S.emuPresets} title={S.emuPresets} onClick={() => setState({ overlay: { kind: "devicePresets", tabKey } })}>
        <Codicon name="library" />
      </Button>
      <Button size="icon" variant={emulation.userAgent ? "ghost-on" : "ghost"} aria-label={S.emuUserAgent} title={native ? S.emuUserAgent : S.emuDesktopOnly} disabled={!native} onClick={() => setState({ overlay: { kind: "userAgent", tabKey, value: emulation.userAgent } })}>
        <Codicon name="tag" />
      </Button>
      <Button size="icon" variant={emulation.mobile ? "ghost-on" : "ghost"} aria-label={S.emuMobile} aria-pressed={emulation.mobile} title={native ? S.emuMobile : S.emuDesktopOnly} disabled={!native} onClick={() => onChange({ ...emulation, mobile: !emulation.mobile })}>
        <Codicon name="device-mobile" />
      </Button>
      <Button size="icon" aria-label={S.emuReset} title={S.emuReset} onClick={() => onChange({ ...DEFAULT_EMULATION })}>
        <Codicon name="discard" />
      </Button>
      <Button size="icon" aria-label={S.emuClose} title={S.emuClose} onClick={() => onChange(null)}>
        <Codicon name="close" />
      </Button>
    </div>
  );
}

// 페이지 안 찾기(⌘F). 입력할 때마다 찾고 Enter 와 ⇧Enter 가 다음, 이전 일치다. Esc 로 닫는다.
function FindBar({ found, onFind, onClose }: { found: { index: number; total: number } | null; onFind: (text: string, options: { matchCase: boolean; forward: boolean; next: boolean }) => void; onClose: () => void }) {
  const [text, setText] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // 메뉴가 닫히며 포커스를 트리거로 되돌리므로 그 뒤에 입력줄로 옮긴다.
  useEffect(() => {
    const timer = window.setTimeout(() => inputRef.current?.focus(), 80);
    return () => window.clearTimeout(timer);
  }, []);
  const find = (query: string, options: { matchCase: boolean; forward: boolean; next: boolean }) => {
    if (query) onFind(query, options);
  };
  return (
    <div className="browser-find" role="search">
      <div className="browser-find-input">
        <input
          ref={inputRef}
          aria-label={S.findPlaceholder}
          placeholder={S.findPlaceholder}
          spellCheck={false}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            find(e.target.value, { matchCase, forward: true, next: false });
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === "Enter") find(text, { matchCase, forward: !e.shiftKey, next: true });
            if (e.key === "Escape") onClose();
          }}
        />
        <button
          type="button"
          className="search-toggle"
          aria-label={S.findMatchCase}
          aria-pressed={matchCase}
          title={S.findMatchCase}
          onClick={() => {
            setMatchCase(!matchCase);
            find(text, { matchCase: !matchCase, forward: true, next: false });
          }}
        >
          Aa
        </button>
      </div>
      <span className="browser-find-count" role="status">
        {text && (found && found.total > 0 ? S.findCount(found.index, found.total) : S.findNoResults)}
      </span>
      <Button size="icon" aria-label={S.findPrevious} title={S.findPrevious} disabled={!found || found.total === 0} onClick={() => find(text, { matchCase, forward: false, next: true })}>
        <Codicon name="arrow-up" />
      </Button>
      <Button size="icon" aria-label={S.findNext} title={S.findNext} disabled={!found || found.total === 0} onClick={() => find(text, { matchCase, forward: true, next: true })}>
        <Codicon name="arrow-down" />
      </Button>
      <Button size="icon" aria-label={S.findClose} title={S.findClose} onClick={onClose}>
        <Codicon name="close" />
      </Button>
    </div>
  );
}

function BrowserEmpty() {
  return (
    <div className="browser-empty">
      <strong>{S.browserEmptyTitle}</strong>
      <span>{S.browserEmptyHint}</span>
      {!IN_ELECTRON && <span className="faint">{S.browserEmptyHintWeb}</span>}
    </div>
  );
}

function BrowserBlocked({ message, url }: { message: string; url: string }) {
  return (
    <div className="browser-empty">
      <span>{message}</span>
      <Button variant="secondary" size="sm" onClick={() => window.open(url, "_blank", "noopener")}>
        {S.browserOpenExternal}
      </Button>
    </div>
  );
}

function useFocusOnOpen(inputRef: RefObject<HTMLInputElement | null>, active: boolean, blank: boolean) {
  useEffect(() => {
    if (!active || !blank) return;
    const timer = window.setTimeout(() => inputRef.current?.focus(), 80);
    return () => window.clearTimeout(timer);
  }, [active, blank, inputRef]);
}

function checkAddress(input: string, engine: BrowserSearchEngine) {
  const target = resolveAddress(input, engine);
  if (target.ok && isOwnOrigin(target.url, window.location)) return { ok: false as const, reason: S.browserOwnOrigin };
  return target;
}

async function checkFrame(url: string): Promise<FrameCheck> {
  if (window.location.protocol === "https:" && url.startsWith("http:") && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(url)) return { state: "blocked", message: S.browserMixedContent };
  try {
    const probe = await rpc.call("browser.probe", { url });
    if (probe.ok) return { state: "ok" };
    // 연결이 안 되는 이유(서버가 안 떠 있음)도 프레임을 못 띄우는 이유다
    return { state: "blocked", message: probe.status === null ? (probe.reason ?? S.browserLoadFailed("unreachable")) : `${S.browserFrameBlocked(probe.reason ?? "")} ${S.browserFrameBlockedHint}` };
  } catch {
    return { state: "ok" };
  }
}
