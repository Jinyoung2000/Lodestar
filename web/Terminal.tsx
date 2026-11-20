import { FitAddon } from "@xterm/addon-fit";
import { LigaturesAddon } from "@xterm/addon-ligatures";
import { Terminal, type ITheme } from "@xterm/xterm";
import { terminalKeySequence } from "./keymap";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";
import { subscribeEditorFont } from "./editorFont";
import { wsUrl } from "./rpc";
import { getState } from "./store";
import { S } from "./strings";
import { TerminalAsk } from "./TerminalAsk";
import { FOCUS_EVENT, isTerminalFocusWanted, markAskHandleFocused, registerAskHandle, takeTerminalFocusWanted, type AskHandle } from "./terminalHandles";

// xterm 은 색을 CSS 변수로 못 받으므로, 토큰의 계산값을 읽어 넘긴다. 테마(data-theme)나 색 스타일(data-style)이 바뀌면 다시 읽는다.
function tokenValue(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
// 색 토큰을 브라우저가 계산한 rgb 로 읽는다. Black 테마(web/styles.css)의 바탕은 color-mix() 라 변수 문자열 그대로는 xterm 이 못 읽는다.
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
    // overviewRuler 폭을 주면 xterm 이 스크롤바 왼쪽에 경계선을 그린다. 배경색과 같게 두어 선이 보이지 않게 한다.
    overviewRulerBorder: tokenColor("--pane-bg"),
  };
}

// "Apply to terminal" 이 켜져 있으면 코드 글꼴 설정을, 아니면 디자인 시스템 토큰(code-sm)을 쓴다.
// xterm 의 lineHeight 는 px 가 아니라 글자 칸 높이의 배수라서, 설정의 줄 높이(px)는 applyTerminalFont 가 실제 행 높이를 재서 맞춘다.
function terminalFont() {
  const settings = getState().settings;
  if (settings?.editorFontTerminal) return { fontFamily: settings.editorFontFamily, fontSize: settings.editorFontSize, lineHeightPx: settings.editorLineHeight };
  return { fontFamily: tokenValue("--font-mono"), fontSize: parseFloat(tokenValue("--text-code-sm")), lineHeightPx: null };
}

// 글꼴 옵션을 넣고 칸 수를 다시 맞춘다. 줄 높이는 배수 1 로 한 번 그려 행 높이(자연 높이)를 잰 뒤 목표 px 에 맞는 배수로 바꾼다.
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

// Ligatures 와 Apply to terminal 이 둘 다 켜졌을 때만 합자 애드온을 단다. 끄면 애드온을 떼서 즉시 낱글자로 돌아간다.
// 애드온은 character joiner 로 합자 구간을 한 칸 묶음으로 그리게 하고(DOM 렌더러에서도 동작), 글꼴 파일은 queryLocalFonts(로컬 글꼴 접근) 로 읽는다.
// 접근이 거부되거나 지원되지 않으면 애드온이 내장 합자 목록으로 떨어지고, 애드온 자체를 못 쓰면 경고 한 줄만 남기고 기존 동작을 유지한다.
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

// 세션이나 워크스페이스 cwd 에서 뜨는 셸. 탭이 마운트될 때(사용자가 터미널을 열었을 때)만 데몬에 pty 를 요청한다.
// params 는 데몬이 cwd 를 고르는 값이다(agentId, workspaceId, 없으면 홈). scopeKey 는 마운트 단위를 가른다.
export function TerminalView({ scopeKey, params, active, onExit }: { scopeKey: string; params: Record<string, string>; active: boolean; onExit: () => void }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef<FitAddon | null>(null);
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
      // xterm 6 의 스크롤바 폭 옵션(기본 14px). 다른 곳과 같은 --size-scrollbar 로 맞춘다.
      overviewRuler: { width: parseFloat(tokenValue("--size-scrollbar")) },
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
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
      // CTRLTAB: ⌃Tab 은 세션 전환 창(web/sessionSwitcher.ts)의 키라 셸에 탭 문자로 보내지 않는다. 이벤트는 그대로 위로 올라가 단축키 표가 받는다.
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
      term.options.theme = terminalTheme();
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-style", "data-black"] });

    // 글꼴 설정이 바뀌면 옵션을 갱신하고 칸 수를 다시 맞춘다(보이지 않는 탭은 다시 보일 때 맞춘다).
    const offFont = subscribeEditorFont(() => {
      applyTerminalFont(term, host, fit);
      ligatures = syncLigatures(term, ligatures);
    });

    // 보이는 터미널만 포커스를 받는다.
    const takeFocus = () => {
      if (!isTerminalFocusWanted() || !activeRef.current || host.clientWidth === 0) return;
      takeTerminalFocusWanted();
      term.focus();
    };
    // 창 확대와 축소(⌘=, ⌘-)는 devicePixelRatio 를 바꿔 글자 칸 크기가 달라진다. 창 크기 이벤트가 오면 글꼴과 칸 수를 다시 맞춘다.
    // 배율이 화면에 반영되는 데 프레임이 걸려, 첫 측정이 전환 도중 값이면 줄 높이가 틀어진다. 한 번 더 맞춘다.
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
    };
    const unregisterAsk = registerAskHandle(handle);
    const markFocused = () => markAskHandleFocused(handle);
    host.addEventListener("focusin", markFocused);

    return () => {
      unregisterAsk();
      host.removeEventListener("focusin", markFocused);
      termRef.current = null;
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
