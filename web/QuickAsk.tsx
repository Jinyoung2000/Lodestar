import { EditorView } from "@codemirror/view";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowUpCompact, ChevronDown, ChevronUp, Close, DotSpinner, ModelIcon, Stop } from "./icons";
import { openFileRef, type FileRef } from "./fileRefs";
import { viewFor } from "./lsp";
import { ModelMenu } from "./Pickers";
import { quickAnchorField, setQuickAnchor, subscribeQuickAnchor } from "./quickAnchor";
import { rpc } from "./rpc";
import { getState, openAgent, setState, useStore, type QuickState } from "./store";
import { Markdown } from "./Timeline";
import { modelName } from "./timelineModel";
import { effortName } from "./Composer";
import { useDefaults } from "./defaults";
import { shownEffort } from "./effortLevels";
import { Button } from "./ui/button";
import { S } from "./strings";

const GAP = 8; // lint-tokens: allow 선택 영역과 창 사이 간격(space-2)
const MARGIN = 12; // lint-tokens: allow 창 가장자리 여백(space-3)
const PREFERRED_HEIGHT = 340; // lint-tokens: allow 아래에 놓기 위해 필요한 높이. 이보다 모자라고 위가 더 넓으면 위에 둔다
const MIN_WIDTH = 320; // lint-tokens: allow 크기를 줄일 때 최소 폭(모델 선택, 닫기 단추가 한 줄에 들어간다)
const MIN_HEIGHT = 240; // lint-tokens: allow 크기를 줄일 때 최소 높이(헤더, 질문, 답 한 줄, 입력)
const SIZE_KEY = "agent-nav:quick-size";

type Size = { width: number; height: number };
type Mode = "shown" | "above" | "below" | "away";
type Edge = "e" | "s" | "se";

export function QuickAsk({ quick }: { quick: QuickState }) {
  const meta = useStore((s) => s.meta);
  const settings = useStore((s) => s.settings);
  const defaults = useDefaults();
  const activeTabKey = useStore((s) => s.activeTabKey);
  const tabOpen = useStore((s) => s.tabs.some((t) => t.key === quick.tabKey));
  const [question, setQuestion] = useState("");
  const [model, setModel] = useState<string | null>(null);
  const [size, setSize] = useState<Size | null>(loadSize);
  const [mode, setMode] = useState<Mode>("shown");
  const [chip, setChip] = useState<{ top?: number; bottom?: number; right: number } | null>(null);
  const [lines, setLines] = useState({ start: quick.startLine, end: quick.endLine });
  const [modelOpen, setModelOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const answerRef = useRef<HTMLDivElement>(null);
  const windowRef = useRef<HTMLDivElement>(null);
  const modelChipRef = useRef<HTMLButtonElement>(null);
  const chosenModel = model ?? settings?.quickModel ?? "haiku";
  const run = quick.run;

  const place = usePlacement(quick, windowRef, { setMode, setChip, setLines }, activeTabKey);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);
  useEffect(() => {
    const el = answerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [run?.answer]);
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [question]);
  useEffect(() => {
    if (!tabOpen) close();
  }, [tabOpen]);

  const close = () => {
    if (run?.status === "running") void rpc.call("quick.cancel", { id: run.id });
    setState({ quick: null });
  };
  const ask = () => {
    const text = question.trim();
    if (!text || run?.status === "running") return;
    const id = `quick-${Date.now()}`;
    setState({
      quick: {
        ...quick,
        run: { id, workspaceId: quick.workspaceId, model: chosenModel, question: text, context: contextOf(quick, lines), answer: "", status: "running", sessionId: null },
      },
    });
    void rpc.call("quick.ask", { id, workspaceId: quick.workspaceId, model: chosenModel, question: text, context: contextOf(quick, lines) });
  };
  const adopt = async () => {
    if (!run) return;
    const agent = await rpc.call("quick.adopt", { id: run.id });
    setState({ quick: null });
    openAgent(agent.id);
  };
  const changeModel = (value: string) => {
    setModel(value);
    void rpc.call("settings.set", { quickModel: value });
  };

  const models = meta?.models ?? [];
  const range = lines.start === lines.end ? `${lines.start}` : `${lines.start}-${lines.end}`;
  const running = run?.status === "running";
  const sendState = running ? "stop" : question.trim() ? "ready" : "empty";
  const modelLabel = modelName(chosenModel, models);
  return (
    <>
      <div
        className="quick composer-box"
        role="dialog"
        aria-label={S.quickAsk}
        ref={windowRef}
        data-busy={running || undefined}
        data-sized={size ? "" : undefined}
        style={size ? { width: size.width, height: size.height } : undefined}
      >
        {running && <span className="progress-line" aria-hidden="true" />}
        <div className="attachments quick-top" onPointerDown={place.startDrag} onPointerMove={place.moveDrag} onPointerUp={place.endDrag} onPointerCancel={place.endDrag}>
          <span className="attachment mono quick-file">
            {quick.path.slice(quick.path.lastIndexOf("/") + 1)}:{range}
          </span>
          <Button size="icon" className="quick-close" aria-label={S.close} title={S.closeEsc} onClick={close}>
            <Close />
          </Button>
        </div>
        {(run || size) && (
          <div
            className="quick-answer"
            ref={answerRef}
            onClick={(event) => {
              const anchor = (event.target as HTMLElement).closest<HTMLElement>("[data-file]");
              if (!anchor) return;
              event.preventDefault();
              void openFileRef(quick.workspaceId, JSON.parse(anchor.dataset.file!) as FileRef, {}, event.altKey);
            }}
          >
            {run && (
              <div className="row-user">
                <Markdown className="row-user-text" text={run.question} breaks linkify={false} />
              </div>
            )}
            {run?.answer && <Markdown className={running ? "row-assistant streaming" : "row-assistant"} text={run.answer} workspaceId={quick.workspaceId} />}
            {running && !run.answer && (
              <div className="quick-waiting" role="status">
                <DotSpinner state="running" size={12} />
                <span className="shimmer-text">{S.quickAskWaiting}</span>
              </div>
            )}
            {run?.status === "error" && <div className="row-error">{run.answer}</div>}
          </div>
        )}
        <textarea
          ref={textareaRef}
          className="textarea"
          aria-label={S.question}
          rows={1}
          placeholder={S.quickAskPlaceholder}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              ask();
            }
          }}
        />
        <div className="composer-tools">
          <button ref={modelChipRef} type="button" className="chip" data-chip="model" aria-label={S.quickAskModel} title={S.quickAskModel} onClick={() => setModelOpen((open) => !open)}>
            <ModelIcon />
            <span className="chip-label model-label">{modelLabel}</span>
            <span className="chip-label">{effortName(shownEffort(chosenModel, null, defaults.effort))}</span>
          </button>
          <span className="spacer" />
          {run && !running && run.sessionId && (
            <button type="button" className="chip" data-chip onClick={() => void adopt()}>
              {S.quickAskContinue}
            </button>
          )}
          <button
            type="button"
            className="composer-send"
            data-state={sendState}
            aria-label={running ? S.stop : S.ask}
            title={running ? S.stop : S.sendTitle}
            disabled={sendState === "empty"}
            onClick={() => {
              if (running && run) void rpc.call("quick.cancel", { id: run.id });
              else ask();
            }}
          >
            {running ? <Stop size={16} /> : <ArrowUpCompact size={16} />}
          </button>
        </div>
        {(["e", "s", "se"] as const).map((edge) => (
          <div key={edge} className="quick-resize" data-edge={edge} aria-hidden="true" onPointerDown={place.startResize(edge)} onPointerMove={place.moveResize} onPointerUp={(e) => place.endResize(e, setSize)} onPointerCancel={(e) => place.endResize(e, setSize)} />
        ))}
      </div>
      {modelOpen && <ModelMenu anchor={modelChipRef.current} current={chosenModel} onClose={() => { setModelOpen(false); textareaRef.current?.focus(); }} onChoose={(value) => changeModel(value)} />}
      {(mode === "above" || mode === "below") && chip && (
        <ChipPortal mode={mode} box={chip} onClick={place.reveal} />
      )}
    </>
  );
}

function ChipPortal({ mode, box, onClick }: { mode: "above" | "below"; box: { top?: number; bottom?: number; right: number }; onClick: () => void }) {
  return createPortal(
    <button type="button" className="quick-chip" data-edge={mode} style={box} onClick={onClick}>
      {mode === "above" ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      {S.quickAsk}
    </button>,
    document.body,
  );
}

type Setters = { setMode: (mode: Mode) => void; setChip: (chip: { top?: number; bottom?: number; right: number } | null) => void; setLines: (update: (prev: { start: number; end: number }) => { start: number; end: number }) => void };

type Placement = {
  startDrag: (e: React.PointerEvent) => void;
  moveDrag: (e: React.PointerEvent) => void;
  endDrag: (e: React.PointerEvent) => void;
  startResize: (edge: Edge) => (e: React.PointerEvent) => void;
  moveResize: (e: React.PointerEvent) => void;
  endResize: (e: React.PointerEvent, commit: (size: Size) => void) => void;
  reveal: () => void;
};

function usePlacement(quick: QuickState, windowRef: React.RefObject<HTMLDivElement | null>, { setMode, setChip, setLines }: Setters, activeTabKey: string | null): Placement {
  const quickRef = useRef(quick);
  quickRef.current = quick;
  const relRef = useRef(quick.rel);
  const anchorRef = useRef({ x: 0, top: 0 });
  const bound = useRef<{ view: EditorView; off: () => void } | null>(null);
  const frame = useRef(0);
  const modeRef = useRef<Mode>("shown");
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const resize = useRef<{ edge: Edge; x: number; y: number; width: number; height: number; left: number; top: number } | null>(null);

  const apply = (next: Mode) => {
    if (modeRef.current !== next) {
      modeRef.current = next;
      setMode(next);
    }
  };

  const reposition = () => {
    const el = windowRef.current;
    const q = quickRef.current;
    if (!el) return;
    const view = viewFor(q.tabKey);
    bind(view);
    if (!view || view.dom.offsetParent === null) {
      el.style.visibility = "hidden";
      apply("away");
      return;
    }
    const anchor = view.state.field(quickAnchorField, false) ?? { from: q.from, to: q.to };
    const from = Math.min(anchor.from, view.state.doc.length);
    const to = Math.min(anchor.to, view.state.doc.length);
    const doc = view.state.doc;
    const start = doc.lineAt(from).number;
    const endLine = doc.lineAt(to);
    const end = to === endLine.from && endLine.number > start ? endLine.number - 1 : endLine.number;
    setLines((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
    const scroller = view.scrollDOM.getBoundingClientRect();
    const fromBlock = view.lineBlockAt(from);
    const top = view.documentTop + fromBlock.top;
    const toBottom = view.documentTop + view.lineBlockAt(to).bottom;
    const outside: Mode | null = top + fromBlock.height < scroller.top ? "above" : top > scroller.bottom ? "below" : null;
    if (outside) {
      el.style.visibility = "hidden";
      apply(outside);
      setChip(outside === "above" ? { top: scroller.top + GAP, right: window.innerWidth - scroller.right + MARGIN } : { bottom: window.innerHeight - scroller.bottom + GAP, right: window.innerWidth - scroller.right + MARGIN });
      return;
    }
    const x = view.coordsAtPos(from)?.left ?? view.contentDOM.getBoundingClientRect().left;
    anchorRef.current = { x, top };
    const width = el.offsetWidth;
    const height = el.offsetHeight;
    if (!relRef.current) {
      relRef.current = firstRel(top, toBottom, height);
      setState((s) => (s.quick ? { quick: { ...s.quick, rel: relRef.current } } : {}));
    }
    const rel = relRef.current;
    el.style.left = `${clamp(x + rel.dx, MARGIN, window.innerWidth - width - MARGIN)}px`;
    el.style.top = `${clamp(top + rel.dy, MARGIN, window.innerHeight - height - MARGIN)}px`;
    el.style.visibility = "";
    apply("shown");
  };

  const schedule = () => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(reposition);
  };

  const bind = (view: EditorView | null) => {
    if (bound.current?.view === view) return;
    bound.current?.off();
    bound.current = null;
    if (!view) return;
    const scroller = view.scrollDOM;
    scroller.addEventListener("scroll", schedule, { passive: true });
    const unsubscribe = subscribeQuickAnchor(view, schedule);
    const observer = new ResizeObserver(schedule);
    observer.observe(view.dom);
    bound.current = {
      view,
      off: () => {
        scroller.removeEventListener("scroll", schedule);
        unsubscribe();
        observer.disconnect();
      },
    };
  };

  useLayoutEffect(() => {
    reposition();
    window.addEventListener("resize", schedule);
    const sizeObserver = new ResizeObserver(schedule);
    if (windowRef.current) sizeObserver.observe(windowRef.current);
    return () => {
      window.removeEventListener("resize", schedule);
      sizeObserver.disconnect();
      cancelAnimationFrame(frame.current);
      const view = bound.current?.view;
      bound.current?.off();
      bound.current = null;
      if (view && !getState().quick && viewFor(quickRef.current.tabKey) === view) view.dispatch({ effects: setQuickAnchor.of(null) });
    };
  }, []);
  useLayoutEffect(schedule, [activeTabKey, quick.tabKey]);

  const startDrag = (e: React.PointerEvent) => {
    const el = windowRef.current;
    if (e.button !== 0 || !el || (e.target as HTMLElement).closest("button, [role='combobox']")) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const rect = el.getBoundingClientRect();
    drag.current = { x: e.clientX, y: e.clientY, left: rect.left, top: rect.top };
    el.dataset.dragging = "";
  };
  const moveDrag = (e: React.PointerEvent) => {
    const el = windowRef.current;
    const start = drag.current;
    if (!el || !start) return;
    const left = clamp(start.left + e.clientX - start.x, MARGIN, window.innerWidth - el.offsetWidth - MARGIN);
    const top = clamp(start.top + e.clientY - start.y, MARGIN, window.innerHeight - el.offsetHeight - MARGIN);
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    relRef.current = { dx: left - anchorRef.current.x, dy: top - anchorRef.current.top };
  };
  const endDrag = (e: React.PointerEvent) => {
    if (!drag.current) return;
    drag.current = null;
    delete windowRef.current?.dataset.dragging;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    setState((s) => (s.quick ? { quick: { ...s.quick, rel: relRef.current } } : {}));
  };

  const startResize = (edge: Edge) => (e: React.PointerEvent) => {
    const el = windowRef.current;
    if (e.button !== 0 || !el) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const rect = el.getBoundingClientRect();
    resize.current = { edge, x: e.clientX, y: e.clientY, width: rect.width, height: rect.height, left: rect.left, top: rect.top };
    el.dataset.resizing = "";
    el.dataset.sized = "";
  };
  const moveResize = (e: React.PointerEvent) => {
    const el = windowRef.current;
    const start = resize.current;
    if (!el || !start) return;
    if (start.edge !== "s") el.style.width = `${clamp(start.width + e.clientX - start.x, MIN_WIDTH, window.innerWidth - MARGIN - start.left)}px`;
    if (start.edge !== "e") el.style.height = `${clamp(start.height + e.clientY - start.y, MIN_HEIGHT, window.innerHeight - MARGIN - start.top)}px`;
  };
  const endResize = (e: React.PointerEvent, commit: (size: Size) => void) => {
    const el = windowRef.current;
    if (!resize.current || !el) return;
    resize.current = null;
    delete el.dataset.resizing;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    const next = { width: el.offsetWidth, height: el.offsetHeight };
    saveSize(next);
    commit(next);
  };

  const reveal = () => {
    const view = viewFor(quickRef.current.tabKey);
    if (!view) return;
    const anchor = view.state.field(quickAnchorField, false);
    view.dispatch({ effects: EditorView.scrollIntoView(anchor?.from ?? quickRef.current.from, { y: "center" }) });
  };

  const firstRel = (top: number, toBottom: number, height: number) => {
    const below = window.innerHeight - toBottom - GAP - MARGIN;
    const above = top - GAP - MARGIN;
    return below >= PREFERRED_HEIGHT || below >= above ? { dx: 0, dy: toBottom - top + GAP } : { dx: 0, dy: -(height + GAP) };
  };

  return { startDrag, moveDrag, endDrag, startResize, moveResize, endResize, reveal };
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(value, Math.max(min, max)));
}

function loadSize(): Size | null {
  try {
    const raw = JSON.parse(localStorage.getItem(SIZE_KEY) ?? "null") as Partial<Size> | null;
    if (raw && typeof raw.width === "number" && typeof raw.height === "number" && raw.width >= MIN_WIDTH && raw.height >= MIN_HEIGHT) return { width: raw.width, height: raw.height };
  } catch {
  }
  return null;
}

function saveSize(size: Size) {
  try {
    localStorage.setItem(SIZE_KEY, JSON.stringify(size));
  } catch {
  }
}

function contextOf(quick: QuickState, lines: { start: number; end: number }) {
  return { path: quick.path, startLine: lines.start, endLine: lines.end, text: quick.text };
}
