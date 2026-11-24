import { useEffect, useRef, useState } from "react";
import type { QuickEntryNative } from "./quickEntryNative";
import type { ElementInfo, Feedback } from "../shared/protocol";
import { failureNoticeHidden, rememberFailureNotices } from "./feedbackNoticeMemory";
import { canRetryChecks } from "../shared/feedbackRetry";
import { canRunAgain } from "../shared/feedbackResume";
import { describeScreen } from "../shared/feedbackScreen";
import { sessionPanelShown } from "./centerPanels";
import { attachElement, labelPlacement, openFlow, pressEscape, removeElement, togglePicking, type Box, type FeedbackFlow } from "./feedbackFlow";
import { Close, Codicon, FeedbackIcon, Pick, Send } from "./icons";
import { reloadWindow } from "./reload";
import { rpc } from "./rpc";
import { S } from "./strings";
import { flash, getState, openAgent, openImprovements, setState, useStore, type FeedbackDraft, type FeedbackTarget } from "./store";
import { Button } from "./ui/button";
import { retryFeedbackChecks, retryLabel, runFeedbackAgain } from "./FeedbackRetry";
import { tidyFeedback } from "./feedbackActions";
import { canTidy } from "./improvementRows";
import { NoticeCard } from "./NoticeCard";
import { defaultHideMs, type NoticeAction, type NoticeSeverity } from "./notices";
import { hint } from "./hint";
import { Checkbox } from "./ui/checkbox";
import { issueTitleFrom, LODESTAR_REPOSITORY, newIssueUrl } from "../shared/release";

import type { DeviceRequest } from "./browserDevices";
import type { NativeNotification } from "./notifications";
import { useCommandKey } from "./commandKeys";

export type BrowserPick =
  | { kind: "element"; url: string; title: string; tag: string; selector: string; html: string; text: string; png: string | null }
  | { kind: "area"; url: string; title: string; png: string | null }
  | { kind: "comments"; count: number };

export type BrowserComment = { url: string; title: string; tag: string; selector: string; html: string; text: string; png: string | null; comment: string; number: number };

export type BrowserNative = {
  browserPick?: (id: number, mode: "element" | "comment" | "area", options?: { image?: boolean }) => Promise<BrowserPick | null>;
  onBrowserComment?: (listener: (payload: { id: number; item: BrowserComment }) => void) => () => void;
  browserConsole?: (id: number) => Promise<{ url: string; title: string; text: string }>;
  browserTool?: (id: number, tool: string, args: Record<string, unknown>) => Promise<{ text?: string; image?: string }>;
  onBrowserPermission?: (listener: (payload: { requestId: string; origin: string; category: string }) => void) => () => void;
  browserPermissionAnswer?: (requestId: string, answer: "allow" | "deny" | null) => Promise<void>;
  browserPermissionsGet?: (url: string) => Promise<{ origin: string; items: { category: string; decision: "allow" | "deny" | null; state: "allow" | "deny" | "ask" }[] }>;
  browserPermissionsSet?: (url: string, changes: { category: string; state: "allow" | "deny" | null }[]) => Promise<void>;
  onBrowserDialog?: (listener: (payload: { id: number; dialog: { type: string; message: string; defaultPrompt: string } | null }) => void) => () => void;
  browserDialogAnswer?: (id: number, accept: boolean, text?: string) => Promise<void>;
  onBrowserCommentRemoved?: (listener: (payload: { id: number; number: number }) => void) => () => void;
  browserCaptureFull?: (id: number) => Promise<{ png: string; url: string; title: string } | null>;
  onBrowserFileChanged?: (listener: (payload: { id: number }) => void) => () => void;
  browserWatchFile?: (id: number, enabled: boolean) => Promise<void>;
  onBrowserDevice?: (listener: (request: DeviceRequest) => void) => () => void;
  browserDeviceAnswer?: (requestId: string, deviceId: string | null) => Promise<void>;
};

declare global {
  interface Window {
    agentNavNative?: {
      captureElement: (rect: { x: number; y: number; width: number; height: number }) => Promise<string | null>;
      notify?: (payload: NativeNotification) => Promise<boolean>;
      clearNotification?: (agentId: string) => Promise<void>;
      setBadgeCount?: (count: number) => Promise<void>;
      browserPickCancel?: (id: number) => Promise<void>;
      browserCapture?: (id: number) => Promise<{ png: string; url: string; title: string } | null>;
      browserClearStorage?: (partition?: string) => Promise<void>;
      browserEmulate?: (id: number, params: { width: number; height: number; dpr: number; mobile?: boolean; userAgent?: string | null } | null) => Promise<void>;
      readsWindowAfterDaemonRestart?: boolean;
      pathForFile?: (file: File) => string;
      reloadWindow?: () => Promise<void>;
      restartDaemon?: () => Promise<boolean | "deferred">;
      daemonState?: () => Promise<{ state: "running" | "restarting" | "stopped"; attempt: number; maxAttempts: number }>;
      onDaemonState?: (listener: (state: { state: "running" | "restarting" | "stopped"; attempt: number; maxAttempts: number }) => void) => () => void;
      pickFolder?: () => Promise<string | null>;
      windowZoom?: (action: "in" | "out" | "reset") => Promise<number>;
      newWindow?: () => Promise<void>;
      openRemoteWindow?: (remote: string) => Promise<void>;
      closeWindow?: () => Promise<void>;
      setOpenAgents?: (agentIds: string[], layoutMode: "chat" | "editor") => Promise<void>;
      openNotificationSession?: (agentId: string) => Promise<void>;
      windowIds?: () => Promise<string[]>;
      onWindowsChanged?: (listener: (ids: string[]) => void) => () => void;
    } & BrowserNative & QuickEntryNative;
  }
}

const UI_ATTR = "data-feedback-ui";
const STYLE_PROPS = ["display", "gap", "padding", "margin", "font-size", "font-weight", "line-height", "color", "background-color", "border-radius", "border"];

let opening = false;

export function toggleFeedback() {
  if (getState().feedbackMode !== "off") {
    cancelFeedback();
    return;
  }
  void openFeedback();
}

export function cancelFeedback() {
  setState({ feedbackMode: "off", feedbackPicking: false, feedbackTarget: null, feedbackDraft: null });
}

export function escapeFeedback() {
  const next = pressEscape(currentFlow());
  if (next.mode === "off") cancelFeedback();
  else applyFlow(next);
}

function currentFlow(): FeedbackFlow {
  const s = getState();
  return { mode: s.feedbackMode, picking: s.feedbackPicking, attached: s.feedbackTarget !== null };
}

function applyFlow(flow: FeedbackFlow) {
  setState({ feedbackMode: flow.mode, feedbackPicking: flow.picking });
}

async function openFeedback() {
  if (opening) return;
  opening = true;
  try {
    const s = getState();
    const screen = describeScreen({
      centerView: s.centerView,
      overlay: s.overlay,
      panes: s.panes,
      activePaneId: s.activePaneId,
      agents: s.agents,
      layoutMode: s.layoutMode,
      sidebarOpen: s.sidebarOpen,
      rightOpen: sessionPanelShown(s.centerView, s.rightOpen),
      bottomOpen: s.bottomOpen,
      bottomTab: s.bottomTab,
      activeTabKey: s.activeTabKey,
      tabs: s.tabs,
      theme: s.settings?.theme ?? "dark",
      width: window.innerWidth,
      height: window.innerHeight,
    });
    const shot = await captureWindow();
    if (getState().feedbackMode !== "off") return;
    const flow = openFlow();
    setState({ feedbackMode: flow.mode, feedbackPicking: flow.picking, feedbackTarget: null, feedbackDraft: { text: "", shot, shotOn: shot !== null, screen }, overlay: null });
  } finally {
    opening = false;
  }
}

const THUMB_WIDTH = 240; // lint-tokens: allow 말풍선 칩 썸네일의 원본 폭(픽셀 수)

const CAPTURE_TIMEOUT_MS = 1500; // lint-tokens: allow 요소 캡처를 기다리는 한도(ms)
const FRAME_WAIT_MS = 200; // lint-tokens: allow 가려진 창에서 rAF 가 멈춰도 넘어가는 한도(ms)

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function nextFrames() {
  return Promise.race([new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))), sleep(FRAME_WAIT_MS)]);
}

const CAPTURE_TRIES = 3; // lint-tokens: allow 재시도 횟수
const CAPTURE_RETRY_MS = 150; // lint-tokens: allow 재시도 간격(ms)

async function captureWithRetry(capture: (rect: { x: number; y: number; width: number; height: number }) => Promise<string | null>) {
  for (let attempt = 0; attempt < CAPTURE_TRIES; attempt++) {
    try {
      const result = await Promise.race([capture({ x: 0, y: 0, width: window.innerWidth, height: window.innerHeight }), sleep(CAPTURE_TIMEOUT_MS).then(() => "timeout" as const)]);
      if (result === "timeout") return null;
      if (result) return result;
    } catch {
    }
    await sleep(CAPTURE_RETRY_MS);
  }
  return null;
}

async function captureWindow(): Promise<{ png: string; thumb: string } | null> {
  const native = window.agentNavNative;
  if (!native) return null;
  try {
    const png = await captureWithRetry(native.captureElement);
    if (!png) return null;
    const image = new Image();
    image.src = `data:image/png;base64,${png}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = THUMB_WIDTH;
    canvas.height = Math.max(1, Math.round((image.height * THUMB_WIDTH) / image.width));
    canvas.getContext("2d")?.drawImage(image, 0, 0, canvas.width, canvas.height);
    return { png, thumb: canvas.toDataURL("image/jpeg", 0.7) };
  } catch {
    return null;
  }
}

function componentOf(el: Element) {
  for (let node: Element | null = el; node; node = node.parentElement) {
    const source = node.getAttribute("data-source");
    const name = node.getAttribute("data-component");
    if (name && source && !source.startsWith("web/ui/")) return name;
  }
  return null;
}

function sourcesOf(el: Element) {
  const sources: string[] = [];
  for (let node: Element | null = el; node && sources.length < 3; node = node.parentElement) {
    const source = node.getAttribute("data-source");
    if (source && !source.startsWith("web/ui/") && !sources.includes(source)) sources.push(source);
  }
  return sources;
}

function domPathOf(el: Element) {
  const parts: string[] = [];
  for (let node: Element | null = el; node && node.id !== "root" && parts.length < 8; node = node.parentElement) {
    const classes = [...node.classList].slice(0, 2).map((c) => `.${c}`).join("");
    const name = node.getAttribute("data-component");
    parts.unshift(`${node.tagName.toLowerCase()}${classes}${name ? `(${name})` : ""}`);
  }
  return parts.join(" > ");
}

export function describeElement(el: Element): { info: ElementInfo; rect: { x: number; y: number; width: number; height: number } } {
  const box = el.getBoundingClientRect();
  const computed = getComputedStyle(el);
  const styles: Record<string, string> = {};
  for (const prop of STYLE_PROPS) styles[prop] = computed.getPropertyValue(prop);
  const info: ElementInfo = {
    component: componentOf(el),
    sources: sourcesOf(el),
    tag: el.tagName.toLowerCase(),
    domPath: domPathOf(el),
    width: Math.round(box.width),
    height: Math.round(box.height),
    text: (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 80),
    styles,
  };
  return { info, rect: { x: box.x, y: box.y, width: box.width, height: box.height } };
}

function targetAt(x: number, y: number) {
  const el = document.elementFromPoint(x, y);
  if (!el || el.closest(`[${UI_ATTR}]`) || el === document.documentElement || el === document.body) return null;
  return el;
}

const LABEL_HEIGHT = 18; // lint-tokens: allow 이름표 한 줄 높이(--leading-code-sm)와 같은 값. 입력 창 피하기 계산용
const LABEL_CHAR_WIDTH = 8; // lint-tokens: allow 이름표 글자 한 칸 폭(12px 고정폭 7.2 에 여유). 입력 창 피하기 계산용
const LABEL_PADDING = 12; // lint-tokens: allow 이름표 좌우 안쪽 여백 합(--space-1_5 두 개)

type Hover = { rect: Box; label: string };

const DRAG_THRESHOLD = 4; // lint-tokens: allow 클릭과 드래그를 가르는 이동 거리(px)
const MIN_REGION = 8; // lint-tokens: allow 영역으로 인정하는 최소 가로 세로(px)

function boxBetween(a: { x: number; y: number }, b: { x: number; y: number }): Box {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
}

function selectionSize({ width, height }: Pick<Box, "width" | "height">) {
  return `${Math.round(width)}×${Math.round(height)}`;
}

function clampBox(box: Box): Box {
  const x = Math.max(0, box.x);
  const y = Math.max(0, box.y);
  return { x, y, width: Math.min(window.innerWidth, box.x + box.width) - x, height: Math.min(window.innerHeight, box.y + box.height) - y };
}

function describeRegion(box: Box): ElementInfo {
  let el: Element | null = targetAt(box.x + box.width / 2, box.y + box.height / 2);
  while (el && el.parentElement) {
    const outer = el.getBoundingClientRect();
    if (outer.left <= box.x && outer.top <= box.y && outer.right >= box.x + box.width && outer.bottom >= box.y + box.height) break;
    el = el.parentElement;
  }
  const { info } = describeElement(el ?? document.body);
  return { ...info, kind: "region", width: Math.round(box.width), height: Math.round(box.height), text: `Region dragged at (${Math.round(box.x)}, ${Math.round(box.y)}), inside ${info.component ?? info.tag}. ${info.text}`.slice(0, 160) };
}

export function FeedbackLayer() {
  const mode = useStore((s) => s.feedbackMode);
  const picking = useStore((s) => s.feedbackPicking);
  const target = useStore((s) => s.feedbackTarget);
  const draft = useStore((s) => s.feedbackDraft);
  const [hover, setHover] = useState<Hover | null>(null);
  const [drag, setDrag] = useState<Box | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [composeBox, setComposeBox] = useState<Box | null>(null);
  const active = mode === "compose" && picking;

  useEffect(() => {
    if (!active) {
      setHover(null);
      setDrag(null);
      return;
    }
    let last: { x: number; y: number } | null = null;
    let selecting = false;
    let down: { x: number; y: number } | null = null;
    let dragging = false;
    let dragEnded = false;
    const hoverAt = (x: number, y: number) => {
      const el = targetAt(x, y);
      if (!el) {
        setHover(null);
        return;
      }
      const { info, rect } = describeElement(el);
      setHover({ rect, label: `${info.component ?? info.tag} ${info.width}×${info.height}` });
    };
    const onMove = (event: MouseEvent) => {
      last = { x: event.clientX, y: event.clientY };
      if (!dragging) hoverAt(event.clientX, event.clientY);
    };
    const onDragMove = (event: MouseEvent) => {
      if (!down) return;
      if (!dragging && Math.hypot(event.clientX - down.x, event.clientY - down.y) >= DRAG_THRESHOLD) dragging = true;
      if (!dragging) return;
      setHover(null);
      setDrag(boxBetween(down, { x: event.clientX, y: event.clientY }));
    };
    const onDown = (event: MouseEvent) => {
      if (event.button !== 0 || selecting || inFeedbackUi(event)) return;
      down = { x: event.clientX, y: event.clientY };
      dragging = false;
    };
    const onUp = (event: MouseEvent) => {
      const start = down;
      down = null;
      if (!start || !dragging) return;
      dragging = false;
      setDrag(null);
      const box = clampBox(boxBetween(start, { x: event.clientX, y: event.clientY }));
      dragEnded = true;
      setTimeout(() => (dragEnded = false), 0);
      if (box.width < MIN_REGION || box.height < MIN_REGION || selecting) return;
      void attach(describeRegion(box), box);
    };
    const onScroll = () => {
      if (last) hoverAt(last.x, last.y);
    };
    const inFeedbackUi = (event: Event) => event.target instanceof Element && event.target.closest(`[${UI_ATTR}]`) !== null;
    const swallow = (event: Event) => {
      if (inFeedbackUi(event)) return;
      event.preventDefault();
      event.stopPropagation();
    };
    const onClick = (event: MouseEvent) => {
      if (inFeedbackUi(event)) return;
      swallow(event);
      if (dragEnded) return;
      const el = targetAt(event.clientX, event.clientY);
      if (!el || selecting) return;
      const { info, rect } = describeElement(el);
      void attach(info, rect);
    };
    const attach = async (info: ElementInfo, rect: Box) => {
      selecting = true;
      setCapturing(true);
      await nextFrames();
      let screenshot: string | null = null;
      let screenshotNote: string | null = null;
      if (window.agentNavNative) {
        try {
          screenshot = await Promise.race([window.agentNavNative.captureElement(rect), sleep(CAPTURE_TIMEOUT_MS).then(() => null)]);
          if (!screenshot) screenshotNote = "capture returned an empty image";
        } catch (error) {
          screenshotNote = (error as Error).message;
        }
      } else screenshotNote = "not running in the desktop app";
      setCapturing(false);
      selecting = false;
      const next = attachElement(currentFlow());
      if (!next.attached) return;
      setState({ feedbackMode: next.mode, feedbackPicking: next.picking, feedbackTarget: { info, rect, screenshot, screenshotNote } });
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      escapeFeedback();
    };
    window.addEventListener("mousemove", onMove, true);
    window.addEventListener("pointermove", onDragMove, true);
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("scroll", onScroll, true);
    for (const type of ["mousedown", "mouseup", "pointerdown", "pointerup", "contextmenu", "dblclick"]) window.addEventListener(type, swallow, true);
    window.addEventListener("click", onClick, true);
    window.addEventListener("keydown", onKey, true);
    document.body.dataset.feedbackPick = "1";
    return () => {
      window.removeEventListener("mousemove", onMove, true);
      window.removeEventListener("pointermove", onDragMove, true);
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("scroll", onScroll, true);
      for (const type of ["mousedown", "mouseup", "pointerdown", "pointerup", "contextmenu", "dblclick"]) window.removeEventListener(type, swallow, true);
      window.removeEventListener("click", onClick, true);
      window.removeEventListener("keydown", onKey, true);
      delete document.body.dataset.feedbackPick;
    };
  }, [active]);

  useEffect(() => {
    const el = mode === "compose" ? document.querySelector(".feedback-compose") : null;
    if (!el) {
      setComposeBox(null);
      return;
    }
    const measure = () => {
      const box = el.getBoundingClientRect();
      setComposeBox({ x: box.x, y: box.y, width: box.width, height: box.height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [mode, draft !== null]);

  if (mode === "off") return null;
  const targetName = target?.info.kind === "region" ? S.feedbackRegion : target?.info.component ?? target?.info.tag;
  const shown = picking ? hover : target ? { rect: target.rect, label: `${targetName} ${selectionSize(target.info)}` } : null;
  const place = shown ? labelPlacement(shown.rect, composeBox, LABEL_HEIGHT, shown.label.length * LABEL_CHAR_WIDTH + LABEL_PADDING) : null;
  return (
    <>
      {drag && !capturing && (
        <>
          <div {...{ [UI_ATTR]: "" }} className="feedback-outline feedback-region" style={{ left: drag.x, top: drag.y, width: drag.width, height: drag.height }} />
          <div {...{ [UI_ATTR]: "" }} className="feedback-label" style={{ left: drag.x, top: drag.y + drag.height }} data-below>
            {S.feedbackRegion} {selectionSize(drag)}
          </div>
        </>
      )}
      {!drag && shown && place && !capturing && (
        <>
          <div {...{ [UI_ATTR]: "" }} className="feedback-outline" style={{ left: shown.rect.x, top: shown.rect.y, width: shown.rect.width, height: shown.rect.height }} />
          <div {...{ [UI_ATTR]: "" }} className="feedback-label" style={{ left: shown.rect.x, top: place.top }} data-below={place.below || undefined}>
            {shown.label}
          </div>
        </>
      )}
      {draft && <FeedbackCompose target={target} draft={draft} picking={picking} capturing={capturing} />}
    </>
  );
}

function FeedbackCompose({ target, draft, picking, capturing }: { target: FeedbackTarget | null; draft: FeedbackDraft; picking: boolean; capturing: boolean }) {
  const [text, setText] = useState(draft.text);
  const [sending, setSending] = useState(false);
  const [reporting, setReporting] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!reporting) ref.current?.focus();
  }, [target, reporting]);
  const withShot = draft.shot !== null && draft.shotOn;

  const send = async () => {
    const value = text.trim();
    if (!value || sending) return;
    setSending(true);
    const ready = await rpc.call("feedback.sourceReady", {}).then(
      (result) => result.ready,
      () => true,
    );
    if (!ready) {
      setSending(false);
      startReport();
      return;
    }
    try {
      await rpc.call("feedback.create", {
        text: value,
        element: target?.info ?? null,
        screenshot: target?.screenshot ?? null,
        screenshotNote: target?.screenshotNote ?? null,
        screen: draft.screen,
        windowScreenshot: withShot ? draft.shot!.png : null,
        thumb: withShot ? draft.shot!.thumb : null,
      });
      cancelFeedback();
      hint(S.feedbackSent, undefined, { check: true });
    } catch (error) {
      setSending(false);
      flash(S.feedbackCreateFailed((error as Error).message));
    }
  };
  const togglePick = () => {
    applyFlow(togglePicking(currentFlow()));
    setState({ feedbackDraft: { ...draft, text } });
    ref.current?.focus();
  };
  const setShotOn = (shotOn: boolean) => {
    setState({ feedbackDraft: { ...draft, text, shotOn } });
    ref.current?.focus();
  };
  const removeAttached = () => {
    applyFlow(removeElement(currentFlow()));
    setState({ feedbackTarget: null, feedbackDraft: { ...draft, text } });
    ref.current?.focus();
  };

  const startReport = () => {
    setState({ feedbackPicking: false, feedbackDraft: { ...draft, text } });
    setReporting(true);
  };

  if (reporting)
    return (
      <div {...{ [UI_ATTR]: "" }} className="feedback-compose" role="dialog" aria-label={S.feedbackReportLabel} data-report="">
        <FeedbackReport text={text.trim()} target={target} draft={draft} onBack={() => setReporting(false)} />
      </div>
    );

  return (
    <div {...{ [UI_ATTR]: "" }} className="feedback-compose" role="dialog" aria-label={S.feedback} data-capturing={capturing || undefined}>
      {(withShot || target) && (
        <div className="feedback-attachments">
          {withShot && (
            <span className="feedback-attach" data-kind="screenshot">
              <img className="feedback-attach-thumb" src={draft.shot!.thumb} alt="" />
              <span>{S.feedbackScreenshot}</span>
              <button type="button" className="attachment-remove" aria-label={S.feedbackRemoveScreenshot} onClick={() => setShotOn(false)}>
                <Close size={12} />
              </button>
            </span>
          )}
          {target && <FeedbackSelectionAttachment target={target} onRemove={removeAttached} />}
        </div>
      )}
      <textarea
        ref={ref}
        className="feedback-input"
        aria-label={S.feedbackInputLabel}
        placeholder={S.feedbackPlaceholder}
        rows={2}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void send();
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            escapeFeedback();
          }
        }}
      />
      {target && !target.screenshot && <div className="feedback-note xs">{window.agentNavNative ? S.feedbackCaptureFailed : S.feedbackScreenshotMissing}</div>}
      <div className="feedback-compose-bar">
        <Button size="sm" variant={picking ? "ghost-on" : "ghost"} aria-pressed={picking} title={picking ? S.feedbackPick : S.feedbackSelectScreenTitle} onClick={togglePick}>
          <Pick size={14} />
          {S.feedbackSelectScreen}
        </Button>
        {draft.shot && !draft.shotOn && (
          <Button size="sm" title={S.feedbackScreenshotTitle} onClick={() => setShotOn(true)}>
            <Codicon name="device-camera" size={14} />
            {S.feedbackScreenshot}
          </Button>
        )}
        <span className="feedback-footer xs faint">{S.feedbackFooter}</span>
        <Button size="sm" disabled={!text.trim() || sending} onClick={startReport}>
          <Codicon name="github" size={14} />
          {S.feedbackReport}
        </Button>
        <Button variant="primary" size="icon" aria-label={S.feedbackSend} title={S.feedbackSendKey} disabled={!text.trim() || sending} onClick={() => void send()}>
          <Send size={14} />
        </Button>
      </div>
    </div>
  );
}

function FeedbackSelectionAttachment({ target, onRemove }: { target: FeedbackTarget; onRemove: () => void }) {
  const { info, screenshot } = target;
  const isRegion = info.kind === "region";
  return (
    <span className="feedback-attach" data-kind={isRegion ? "region" : "element"}>
      {isRegion && screenshot ? (
        <img className="feedback-attach-thumb" src={`data:image/png;base64,${screenshot}`} alt="" />
      ) : (
        <Codicon name={isRegion ? "device-camera" : "symbol-class"} size={12} />
      )}
      <span>{isRegion ? (screenshot ? S.feedbackRegionScreenshot : S.feedbackRegion) : S.feedbackElement}</span>
      {!isRegion && <span className="mono feedback-attach-where">{info.component ?? info.tag}</span>}
      <span className="mono faint feedback-attach-name">{selectionSize(info)}</span>
      {!isRegion && info.sources[0] && <span className="mono faint feedback-attach-where">{info.sources[0]}</span>}
      <button type="button" className="attachment-remove" aria-label={isRegion ? S.feedbackRemoveRegion : S.feedbackRemoveElement} onClick={onRemove}>
        <Close size={12} />
      </button>
    </span>
  );
}

function FeedbackReport({ text, target, draft, onBack }: { text: string; target: FeedbackTarget | null; draft: FeedbackDraft; onBack: () => void }) {
  const release = useStore((s) => s.release);
  const [title, setTitle] = useState(() => issueTitleFrom(text));
  const [withShot, setWithShot] = useState(false);
  const [copied, setCopied] = useState(false);
  const [withPaths, setWithPaths] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    titleRef.current?.focus();
    void rpc.call("release.get", {}).then((next) => setState({ release: next }), () => undefined);
  }, []);
  const isRegion = target?.info.kind === "region";
  const shot = draft.shot && draft.shotOn
    ? { ...draft.shot, label: S.feedbackScreenshot }
    : target?.screenshot
      ? { png: target.screenshot, thumb: `data:image/png;base64,${target.screenshot}`, label: isRegion ? S.feedbackRegionScreenshot : S.feedbackElementScreenshot }
      : null;
  const element = target ? `${isRegion ? S.feedbackRegion : target.info.component ?? target.info.tag} ${selectionSize(target.info)}` : null;
  const versions = release ? S.feedbackReportVersionLine(release.installed, release.macos) : null;

  const toggleShot = (on: boolean) => {
    setWithShot(on);
    setCopied(false);
    if (!on || !shot) return;
    const png = fetch(`data:image/png;base64,${shot.png}`).then((res) => res.blob());
    navigator.clipboard.write([new ClipboardItem({ "image/png": png })]).then(
      () => setCopied(true),
      () => {
        setWithShot(false);
        flash(S.copyFailed, "error");
      },
    );
  };
  const open = () => {
    if (!title.trim()) return;
    const lines = [versions ? `Versions: ${versions}` : null];
    if (withPaths && target) {
      lines.push(isRegion ? `${element}` : `Element: ${element}`);
      if (target.info.sources.length) lines.push(`Files: ${target.info.sources.join(", ")}`);
    }
    const footer = lines.some(Boolean) ? `\n\n${lines.filter(Boolean).join("\n")}` : "";
    window.open(newIssueUrl(title, text, footer), "_blank", "noopener");
    cancelFeedback();
  };

  return (
    <div
      className="feedback-report"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onBack();
        }
      }}
    >
      <div className="feedback-report-head">
        <Codicon name="github" size={14} />
        <span className="feedback-report-heading">{S.feedbackReportHeading}</span>
        <span className="feedback-report-repo mono">{LODESTAR_REPOSITORY}</span>
      </div>
      <div className="feedback-report-grid">
        <label className="feedback-report-label" htmlFor="feedback-report-title" data-field="title">
          {S.feedbackReportTitle}
        </label>
        <input
          ref={titleRef}
          id="feedback-report-title"
          className="input feedback-report-title"
          value={title}
          spellCheck={false}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              open();
            }
          }}
        />
        <span className="feedback-report-label" data-field="body">
          {S.feedbackReportBody}
        </span>
        <div className="feedback-report-body">{text}</div>
        {versions && (
          <>
            <span className="feedback-report-label">{S.feedbackReportVersions}</span>
            <div className="feedback-report-value">{versions}</div>
          </>
        )}
        {(shot || target) && (
          <>
            <span className="feedback-report-label" data-field="include">
              {S.feedbackReportInclude}
            </span>
            <div className="feedback-report-include">
              {shot && (
                <label className="feedback-report-option">
                  <Checkbox checked={withShot} onCheckedChange={(v) => toggleShot(v === true)} data-option="screenshot" />
                  <img className="feedback-attach-thumb" src={shot.thumb} alt="" />
                  <span>{shot.label}</span>
                  {withShot && copied && <span className="feedback-report-hint">{S.feedbackReportCopied}</span>}
                </label>
              )}
              {target && (
                <label className="feedback-report-option">
                  <Checkbox checked={withPaths} onCheckedChange={(v) => setWithPaths(v === true)} data-option="paths" />
                  <span>{isRegion ? S.feedbackReportRegionPaths : S.feedbackReportPaths}</span>
                  <span className="feedback-report-path mono">
                    {element}
                    {target.info.sources[0] ? ` ${target.info.sources[0]}` : ""}
                  </span>
                </label>
              )}
              <div className="feedback-report-note">{S.feedbackReportIncludeNote}</div>
            </div>
          </>
        )}
      </div>
      <div className="feedback-compose-bar">
        <Button size="sm" onClick={onBack}>
          {S.feedbackReportBack}
        </Button>
        <span className="feedback-report-gap" />
        <Button variant="primary" size="sm" disabled={!title.trim()} onClick={open}>
          {S.feedbackReportOpen}
          <Codicon name="link-external" size={14} />
        </Button>
      </div>
    </div>
  );
}

export function FeedbackButton() {
  const mode = useStore((s) => s.feedbackMode);
  const feedbackKey = useCommandKey("feedback");
  const unseen = useStore((s) => Object.values(s.feedbacks).some((f) => !f.seen && f.status !== "running" && f.status !== "checking" && f.status !== "fixing"));
  return (
    <Button
      {...{ [UI_ATTR]: "" }}
      size="icon"
      className="feedback-button"
      variant={mode === "off" ? "ghost" : "ghost-on"}
      aria-label={S.feedback}
      title={S.feedbackKey(feedbackKey)}
      onClick={toggleFeedback}
      onContextMenu={(event) => {
        event.preventDefault();
        openImprovements();
      }}
    >
      <FeedbackIcon />
      {unseen && <span className="notify-dot" data-testid="feedback-dot" />}
    </Button>
  );
}

export function FeedbackNotices() {
  const feedbacks = useStore((s) => s.feedbacks);
  const [busy, setBusy] = useState<string | null>(null);
  const items = Object.values(feedbacks)
    .filter((f) => ((f.status !== "running" && f.status !== "checking" && f.status !== "fixing") || f.retrying) && !f.seen)
    .filter((f) => f.status !== "reverted" || f.restartPending)
    .filter((f) => f.status !== "failed" || f.retrying || !failureNoticeHidden(f))
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  const shownFailures = items.filter((f) => f.status === "failed" && !f.retrying);
  const shownKey = shownFailures.map((f) => `${f.id}:${f.updatedAt}`).join("|");
  useEffect(() => {
    rememberFailureNotices(shownFailures);
  }, [shownKey]);
  if (!items.length) return null;

  const dismiss = (f: Feedback) => void rpc.call("feedback.markSeen", { id: f.id });
  const revert = async (f: Feedback) => {
    setBusy(f.id);
    try {
      await rpc.call("feedback.revert", { id: f.id });
      flash(S.feedbackReverted);
    } catch (error) {
      flash(S.feedbackRevertFailed((error as Error).message.split("\n")[0]));
    } finally {
      setBusy(null);
    }
  };
  const restart = async (f: Feedback) => {
    try {
      await rpc.call("feedback.restart", { id: f.id });
    } catch (error) {
      flash(S.feedbackRestartFailed((error as Error).message));
    }
  };
  const noticeActions = (f: Feedback): NoticeAction[] => {
    const actions: NoticeAction[] = [];
    if (f.status === "applied" && !f.needsRestart) actions.push({ label: S.feedbackReload, run: () => void reloadWindow(), primary: true, keepOpen: true });
    if (f.status === "applied") actions.push({ label: S.feedbackRevert, run: () => void revert(f), keepOpen: true, disabled: busy === f.id });
    if ((f.status === "awaitingRestart" || f.restartPending) && !f.restartRequested) actions.push({ label: S.feedbackRestart, run: () => void restart(f), primary: true, keepOpen: true });
    if (f.retrying) actions.push({ label: S.feedbackRetrying, run: () => undefined, keepOpen: true, disabled: true });
    if (canRetryChecks(f)) actions.push({ label: retryLabel(f), run: () => void retryFeedbackChecks(f), primary: true, keepOpen: true });
    if (canTidy(f)) actions.push({ label: S.feedbackResolve, run: () => void tidyFeedback(f, "resolve"), keepOpen: true });
    if (canRunAgain(f)) actions.push({ label: S.feedbackRunAgain, run: () => void runFeedbackAgain(f), primary: !canRetryChecks(f), keepOpen: true });
    if (f.status === "needsInput")
      actions.push({
        label: S.feedbackOpen,
        run: () => {
          openAgent(f.agentId);
          dismiss(f);
        },
        primary: true,
        keepOpen: true,
      });
    if (f.status === "failed")
      actions.push({
        label: S.feedbackOpen,
        run: () => {
          openAgent(f.agentId);
          dismiss(f);
        },
        keepOpen: true,
      });
    return actions;
  };
  const groups: NoticeGroup[] = [];
  for (const f of items) {
    const severity = f.status === "failed" ? "error" : f.status === "applied" || f.status === "noChanges" || f.status === "needsInput" || f.status === "blocked" || f.retrying ? "info" : "warning";
    const message = noticeText(f);
    const actions = noticeActions(f);
    const same = actions.length === 0 ? groups.find((g) => g.actions.length === 0 && g.severity === severity && g.message === message) : undefined;
    if (same) same.items.push(f);
    else groups.push({ key: f.id, items: [f], severity, message, actions, retrying: f.retrying === true });
  }
  return (
    <>
      {groups.map((group) => (
        <FeedbackNoticeCard key={group.key} group={group} onDismiss={dismiss} />
      ))}
    </>
  );
}

type NoticeGroup = { key: string; items: Feedback[]; severity: NoticeSeverity; message: string; actions: NoticeAction[]; retrying?: boolean };

function FeedbackNoticeCard({ group, onDismiss }: { group: NoticeGroup; onDismiss: (f: Feedback) => void }) {
  const [held, setHeld] = useState(false);
  const latest = useRef({ group, onDismiss });
  latest.current = { group, onDismiss };
  const hideMs = group.retrying ? null : defaultHideMs(group.severity, group.actions.length);
  useEffect(() => {
    if (hideMs === null || held) return;
    const timer = setTimeout(() => latest.current.group.items.forEach(latest.current.onDismiss), hideMs);
    return () => clearTimeout(timer);
  }, [hideMs, held]);
  const first = group.items[0];
  return (
    <NoticeCard
      severity={group.severity}
      message={group.message}
      actions={group.actions}
      onClose={() => group.items.forEach(onDismiss)}
      onHold={hideMs === null ? undefined : setHeld}
      data={{ "data-feedback-id": first.id, "data-status": first.status, "data-count": String(group.items.length) }}
    />
  );
}

function questionPreview(question: string) {
  const line = question.replace(/\s+/g, " ").trim();
  return line.length > 160 ? `${line.slice(0, 159).trimEnd()}…` : line;
}

function noticeText(f: Feedback) {
  if (f.retrying) return S.feedbackRetryingNotice(f.summary ?? f.text);
  if (f.status === "applied") return S.feedbackApplied(f.summary ?? f.text);
  if (f.status === "failed") return S.feedbackFailed((f.failure ?? "").split("\n")[0].replace(/^Not applied:\s*/, ""));
  if (f.status === "noChanges") return S.feedbackNoChanges;
  if (f.status === "blocked") return (f.failure ?? "").split("\n")[0] || S.feedbackBlocked[f.blocked?.reason ?? "environment"];
  if (f.status === "needsInput") return S.feedbackNeedsInput(questionPreview(f.question ?? f.summary ?? ""));
  if (f.status === "awaitingRestart") return f.restartRequested ? S.feedbackRestartWaiting : S.feedbackRestartNeeded;
  return f.restartRequested ? S.feedbackRestartWaiting : S.feedbackRestartPending;
}
