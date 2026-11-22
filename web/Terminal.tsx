import { FitAddon } from "@xterm/addon-fit";
import { LigaturesAddon } from "@xterm/addon-ligatures";
import { SearchAddon, type ISearchOptions } from "@xterm/addon-search";
import { Terminal, type ITheme } from "@xterm/xterm";
import { terminalKeySequence } from "./keymap";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";
import { subscribeEditorFont } from "./editorFont";
import { wsUrl } from "./rpc";
import { getState } from "./store";
import { S } from "./strings";
import { TerminalAsk } from "./TerminalAsk";
import { TerminalFind } from "./TerminalFind";
import { FOCUS_EVENT, isTerminalFocusWanted, markAskHandleFocused, registerAskHandle, takeTerminalFocusWanted, type AskHandle } from "./terminalHandles";

function tokenValue(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
function tokenColor(name: string) {
  const probe = document.createElement("span");
  probe.style.color = `var(${name})`;
  probe.hidden = true;
  document.body.appendChild(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color;
}
// lint-tokens: allow xterm takes literal ANSI colors
const LIGHT_ANSI: ITheme = { black: "#000000", red: "#cd3131", green: "#00bc00", yellow: "#949800", blue: "#0451a5", magenta: "#bc05bc", cyan: "#0598bc", white: "#555555", brightBlack: "#666666", brightRed: "#cd3131", brightGreen: "#14ce14", brightYellow: "#b5ba00", brightBlue: "#0451a5", brightMagenta: "#bc05bc", brightCyan: "#0598bc", brightWhite: "#a5a5a5" };

function rgbaOf(css: string) {
  const [r = 0, g = 0, b = 0, a = 1] = (css.match(/[\d.]+/g) ?? []).map(Number);
  return { r, g, b, a };
}

function solidTokenColor(name: string) {
  const top = rgbaOf(tokenColor(name));
  const base = rgbaOf(tokenColor("--pane-bg"));
  const mix = (over: number, under: number) => Math.round(under + (over - under) * top.a).toString(16).padStart(2, "0");
  return `#${mix(top.r, base.r)}${mix(top.g, base.g)}${mix(top.b, base.b)}`;
}

function findOptions(): ISearchOptions {
  const match = solidTokenColor("--find-match-bg");
  const current = solidTokenColor("--find-match-current-bg");
  return { decorations: { matchBackground: match, matchOverviewRuler: match, activeMatchBackground: current, activeMatchColorOverviewRuler: current } };
}

function themeFor(finding: boolean): ITheme {
  return finding ? { ...terminalTheme(), selectionInactiveBackground: solidTokenColor("--find-match-current-bg") } : terminalTheme();
}

function terminalTheme(): ITheme {
  return {
    ...(document.documentElement.dataset.theme === "light" ? LIGHT_ANSI : {}),
    background: tokenColor("--pane-bg"),
    foreground: tokenValue("--fg"),
    cursor: tokenValue("--fg"),
    selectionBackground: tokenValue("--surface-selected"),
    scrollbarSliderBackground: tokenValue("--scrollbar-slider"),
    scrollbarSliderHoverBackground: tokenValue("--scrollbar-slider-hover"),
    scrollbarSliderActiveBackground: tokenValue("--scrollbar-slider-active"),
    overviewRulerBorder: tokenColor("--pane-bg"),
  };
}

function terminalFont() {
  const settings = getState().settings;
  if (settings?.editorFontTerminal) return { fontFamily: settings.editorFontFamily, fontSize: settings.editorFontSize, lineHeightPx: settings.editorLineHeight };
  return { fontFamily: tokenValue("--font-mono"), fontSize: parseFloat(tokenValue("--text-code-sm")), lineHeightPx: null };
}

function applyTerminalFont(term: Terminal, host: HTMLElement, fit: FitAddon) {
  const { fontFamily, fontSize, lineHeightPx } = terminalFont();
  term.options.fontFamily = fontFamily;
  term.options.fontSize = fontSize;
  term.options.lineHeight = lineHeightPx == null ? 1.2 : 1;
  const refit = () => {
    if (host.clientWidth > 0 && host.clientHeight > 0) fit.fit();
  };
  refit();
  if (lineHeightPx == null) return;
  requestAnimationFrame(() => {
    const natural = host.querySelector<HTMLElement>(".xterm-rows > div")?.getBoundingClientRect().height;
    if (natural) term.options.lineHeight = lineHeightPx / natural;
    refit();
  });
}

let ligatureWarned = false;
function syncLigatures(term: Terminal, current: LigaturesAddon | null) {
  const settings = getState().settings;
  const want = Boolean(settings?.editorLigatures && settings.editorFontTerminal);
  if (want && !current) {
    try {
      const addon = new LigaturesAddon({ fontFeatureSettings: '"calt" 1, "liga" 1' });
      term.loadAddon(addon);
      return addon;
    } catch (error) {
      if (!ligatureWarned) console.warn("[agent-nav] terminal ligatures unavailable, using plain rendering:", error);
      ligatureWarned = true;
      return null;
    }
  }
  if (!want && current) {
    current.dispose();
    term.refresh(0, term.rows - 1);
    return null;
  }
  return current;
}

export function TerminalView({ scopeKey, params, active, onExit }: { scopeKey: string; params: Record<string, string>; active: boolean; onExit: () => void }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const [find, setFind] = useState<{ initial: string } | null>(null);
  const findingRef = useRef(false);
  const termRef = useRef<Terminal | null>(null);
  const ptyIdRef = useRef("");
  const [ask, setAsk] = useState<{ selection: string | null } | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new Terminal({
      cursorBlink: true,
      theme: terminalTheme(),
      overviewRuler: { width: parseFloat(tokenValue("--size-scrollbar")) },
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    const search = new SearchAddon();
    term.loadAddon(search);
    searchRef.current = search;
    term.open(host);
    applyTerminalFont(term, host, fit);
    let ligatures = syncLigatures(term, null);
    fitRef.current = fit;

    termRef.current = term;
    ptyIdRef.current = crypto.randomUUID();
    const socket = new WebSocket(wsUrl("/ws/pty", { ...params, cols: String(term.cols), rows: String(term.rows), ptyId: ptyIdRef.current }));
    socket.onmessage = (event) => term.write(String(event.data));
    socket.onclose = (event) => {
      if (event.reason === "shell exited") onExitRef.current();
      else term.write(`\r\n${S.terminalClosed(event.reason || null)}\r\n`);
    };
    term.attachCustomKeyEventHandler((event) => {
      if (event.ctrlKey && event.key === "Tab") return false;
      const data = event.type === "keydown" ? terminalKeySequence(event, term.hasSelection()) : null;
      if (data === null) return true;
      event.preventDefault();
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ t: "d", d: data }));
      return false;
    });
    const onData = term.onData((data) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ t: "d", d: data }));
    });
    const onResize = term.onResize(({ cols, rows }) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ t: "r", cols, rows }));
    });
    const observer = new ResizeObserver(() => {
      if (host.clientWidth > 0 && host.clientHeight > 0) fit.fit();
    });
    observer.observe(host);
    const themeObserver = new MutationObserver(() => {
      term.options.theme = themeFor(findingRef.current);
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-style", "data-black"] });

    const offFont = subscribeEditorFont(() => {
      applyTerminalFont(term, host, fit);
      ligatures = syncLigatures(term, ligatures);
    });

    const takeFocus = () => {
      if (!isTerminalFocusWanted() || !activeRef.current || host.clientWidth === 0) return;
      takeTerminalFocusWanted();
      term.focus();
    };
    let zoomTimers: ReturnType<typeof setTimeout>[] = [];
    const onWindowResize = () => {
      zoomTimers.forEach(clearTimeout);
      zoomTimers = [150, 700].map((ms) => setTimeout(() => applyTerminalFont(term, host, fit), ms));
    };
    window.addEventListener("resize", onWindowResize);
    window.addEventListener(FOCUS_EVENT, takeFocus);
    takeFocus();

    const handle: AskHandle = {
      pane: () => paneRef.current,
      open: () => {
        const input = paneRef.current?.querySelector<HTMLTextAreaElement>(".termask textarea");
        if (input) input.focus();
        else setAsk({ selection: term.getSelection() || null });
      },
      clear: () => {
        term.clear();
        term.focus();
      },
      find: () => {
        const input = paneRef.current?.querySelector<HTMLInputElement>(".terminal-find input");
        if (input) {
          input.focus();
          input.select();
        } else {
          findingRef.current = true;
          term.options.theme = themeFor(true);
          setFind({ initial: term.getSelection().split("\n")[0] ?? "" });
        }
      },
    };
    const unregisterAsk = registerAskHandle(handle);
    const markFocused = () => markAskHandleFocused(handle);
    host.addEventListener("focusin", markFocused);

    return () => {
      unregisterAsk();
      host.removeEventListener("focusin", markFocused);
      termRef.current = null;
      searchRef.current = null;
      window.removeEventListener(FOCUS_EVENT, takeFocus);
      window.removeEventListener("resize", onWindowResize);
      zoomTimers.forEach(clearTimeout);
      offFont();
      ligatures?.dispose();
      observer.disconnect();
      themeObserver.disconnect();
      onData.dispose();
      onResize.dispose();
      socket.close();
      term.dispose();
    };
  }, [scopeKey]);

  useEffect(() => {
    if (active) setTimeout(() => fitRef.current?.fit(), 0);
  }, [active]);

  return (
    <div className="terminal-pane" ref={paneRef} style={{ display: active ? "flex" : "none" }}>
      <div className="terminal-host" ref={hostRef} />
      {find && searchRef.current && (
        <TerminalFind
          search={searchRef.current}
          initial={find.initial}
          options={findOptions}
          onClose={() => {
            findingRef.current = false;
            setFind(null);
            if (!termRef.current) return;
            termRef.current.options.theme = themeFor(false);
            termRef.current.focus();
          }}
        />
      )}
      {ask && termRef.current && (
        <TerminalAsk
          term={termRef.current}
          ptyId={ptyIdRef.current}
          selection={ask.selection}
          onClose={() => {
            setAsk(null);
            setTimeout(() => termRef.current?.focus(), 0);
          }}
        />
      )}
    </div>
  );
}
