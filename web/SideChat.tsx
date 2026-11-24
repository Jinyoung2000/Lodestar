import type { SideRun } from "../shared/protocol";
import { openLinkOutside } from "./fileRefs";
import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { FLOAT_EDGES, moveRect, resizeRect, type FloatEdge, type FloatRect } from "./floatLayout";
import { sideChatEffort, sideChatModel, useDefaults } from "./defaults";
import { ArrowUpCompact, Close, Codicon, ModelIcon, Stop } from "./icons";
import { relativeTime } from "./sessionList";
import { followsBottom } from "./timelineScroll";
import { effortName, modelChip } from "./Composer";
import { supportedLevels } from "./effortLevels";
import { Popup } from "./Popup";
import { Markdown, StreamingMarkdown } from "./Timeline";
import { EffortMenu, ModelMenu } from "./Pickers";
import { rpc } from "./rpc";
import { flash, openAgent, setState, useStore, type SideState } from "./store";
import { Button } from "./ui/button";
import { S } from "./strings";

function cssNumber(name: string, fallback: number) {
  const value = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name));
  return Number.isFinite(value) ? value : fallback;
}

export function SideChat({ side }: { side: SideState }) {
  const agent = useStore((s) => s.agents.find((a) => a.id === side.agentId));
  const meta = useStore((s) => s.meta);
  const [text, setText] = useState("");
  const [modelOpen, setModelOpen] = useState(false);
  const [effortOpen, setEffortOpen] = useState(false);
  const [history, setHistory] = useState<SideRun[] | null>(null);
  const historyButtonRef = useRef<HTMLButtonElement>(null);
  const effortChipRef = useRef<HTMLButtonElement>(null);
  const followBottom = useRef(true);
  const lastScroll = useRef({ top: 0, height: 0 });
  const seenMessages = useRef(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const modelChipRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const defaults = useDefaults();
  const model = sideChatModel(side.model, agent?.model, defaults);
  const levels = supportedLevels(model);
  const effort = sideChatEffort(side.effort, agent?.effort, defaults, levels);
  const run = side.run;
  const busy = run?.status === "running";
  const asideRef = useRef<HTMLElement>(null);
  const [moved, setMoved] = useState<FloatRect | null>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, [side.id]);
  const draftNonce = side.draft?.nonce;
  useEffect(() => {
    if (draftNonce === undefined) return;
    setText(side.draft?.text ?? "");
    textareaRef.current?.focus();
  }, [draftNonce]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const el = listRef.current;
    const count = run?.messages.length ?? 0;
    if (count > seenMessages.current) followBottom.current = true;
    seenMessages.current = count;
    if (el && followBottom.current) el.scrollTop = el.scrollHeight;
  }, [run]);

  const ask = (question: string) => {
    const q = question.trim();
    if (!q || busy) return;
    setText("");
    rpc.call("side.ask", { id: side.id, agentId: side.agentId, model, effort, question: q }).catch((e: Error) => flash(e.message));
  };
  const toggleHistory = async () => {
    if (history) {
      setHistory(null);
      return;
    }
    const list = await rpc.call("side.list", { agentId: side.agentId }).catch((e: Error) => {
      flash(e.message);
      return null;
    });
    if (list) setHistory(list.filter((past) => past.id !== side.id));
  };
  const adopt = async () => {
    const created = await rpc.call("side.adopt", { id: side.id }).catch((e: Error) => {
      flash(e.message);
      return null;
    });
    if (!created) return;
    setState({ side: null });
    openAgent(created.id, "new");
  };

  const startGesture = (event: ReactPointerEvent<HTMLElement>, mode: "move" | FloatEdge) => {
    const el = asideRef.current;
    if (event.button !== 0 || !el || (event.target as HTMLElement).closest("button")) return;
    event.preventDefault();
    const box = el.getBoundingClientRect();
    const start: FloatRect = { x: box.left, y: box.top, w: box.width, h: box.height };
    const vp = { width: window.innerWidth, height: window.innerHeight, top: cssNumber("--size-titlebar", 35) };
    const limits = { minW: cssNumber("--size-float-min-width", 320), minH: cssNumber("--size-float-min-height", 240), margin: 0 };
    const x0 = event.clientX;
    const y0 = event.clientY;
    const move = (e: PointerEvent) => {
      const dx = e.clientX - x0;
      const dy = e.clientY - y0;
      setMoved(mode === "move" ? moveRect(start, dx, dy, vp, limits) : resizeRect(start, mode, dx, dy, vp, limits));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  if (!agent) return null;
  const movedStyle: CSSProperties | undefined = moved ? { left: moved.x, top: moved.y, width: moved.w, height: moved.h, right: "auto", bottom: "auto" } : undefined;
  const models = meta?.models ?? [];
  return (
    <aside ref={asideRef} className="side" aria-label={S.sideChat} style={movedStyle}>
      <div className="pane-header" data-side-bar onPointerDown={(e) => startGesture(e, "move")} onDoubleClick={(e) => !(e.target as HTMLElement).closest("button") && setMoved(null)}>
        <span className="agent-title">{S.sideChat}</span>
        <span className="muted small side-parent-title" title={agent.title}>
          {agent.title}
        </span>
        <span className="spacer" />
        <Button ref={historyButtonRef} size="icon" aria-label={S.sideChatHistory} title={S.sideChatHistory} aria-haspopup="listbox" aria-expanded={history !== null} onClick={() => void toggleHistory()}>
          <Codicon name="history" />
        </Button>
        <Button size="icon" aria-label={S.close} title={S.closeEsc} onClick={() => setState({ side: null })}>
          <Close />
        </Button>
      </div>
      <div
        className="side-messages"
        ref={listRef}
        onClick={openLinkOutside}
        onWheel={(e) => {
          if (e.deltaY < 0) followBottom.current = false;
        }}
        onScroll={(e) => {
          const el = e.currentTarget;
          const movedUp = el.scrollTop < lastScroll.current.top && el.scrollHeight >= lastScroll.current.height;
          lastScroll.current = { top: el.scrollTop, height: el.scrollHeight };
          followBottom.current = followsBottom(followBottom.current, el.scrollHeight - el.scrollTop - el.clientHeight, false, movedUp);
        }}
      >
        {!run && <div className="empty-hint">{S.sideChatEmpty}</div>}
        {run?.messages.map((m, i) =>
          m.role === "user" ? (
            <div key={i} className="side-user">
              {m.text}
            </div>
          ) : busy && i === run.messages.length - 1 ? (
            <StreamingMarkdown key={i} className="side-assistant" text={m.text || "…"} />
          ) : (
            <Markdown key={i} className="side-assistant" text={m.text} breaks media />
          ),
        )}
      </div>
      <div className="side-input">
        <div className="composer-box">
          <textarea
            ref={textareaRef}
            className="textarea"
            aria-label={S.sideChatQuestion}
            rows={2}
            placeholder={S.sideChatPlaceholder}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                ask(text);
              }
            }}
          />
          <div className="composer-tools">
            <button ref={modelChipRef} type="button" className="chip" data-chip="model" aria-label={S.sideChatModel} title={S.sideChatModel} onClick={() => setModelOpen((open) => !open)}>
              <ModelIcon />
              <span className="chip-label model-label">{modelChip(model, null, models).name}</span>
            </button>
            {levels.length > 0 && (
              <button ref={effortChipRef} type="button" className="chip" data-chip aria-haspopup="listbox" aria-expanded={effortOpen} aria-label={S.sideChatEffort} title={S.sideChatEffort} onClick={() => setEffortOpen((wasOpen) => !wasOpen)}>
                <span className="chip-label">{effortName(effort)}</span>
              </button>
            )}
            {run?.sessionId && !busy && (
              <button type="button" className="chip" data-chip onClick={() => void adopt()}>
                {S.sideChatKeep}
              </button>
            )}
            <span className="spacer" />
            <button
              type="button"
              className="composer-send"
              data-state={busy ? "stop" : text.trim() ? "ready" : "empty"}
              aria-label={busy ? S.stop : S.ask}
              disabled={!busy && !text.trim()}
              onClick={() => (busy ? void rpc.call("side.cancel", { id: side.id }) : ask(text))}
            >
              {busy ? <Stop size={16} /> : <ArrowUpCompact size={16} />}
            </button>
          </div>
        </div>
      </div>
      {FLOAT_EDGES.map((edge) => (
        <div key={edge} className="float-grip" data-edge={edge} aria-hidden="true" onPointerDown={(e) => startGesture(e, edge)} />
      ))}
      {modelOpen && (
        <ModelMenu
          anchor={modelChipRef.current}
          current={model}
          onClose={() => {
            setModelOpen(false);
            textareaRef.current?.focus();
          }}
          onChoose={(value) => setState((s) => (s.side ? { side: { ...s.side, model: value } } : {}))}
        />
      )}
      {history && (
        <HistoryMenu
          anchor={historyButtonRef.current}
          runs={history}
          onClose={() => setHistory(null)}
          onNew={() => setState((s) => (s.side ? { side: { id: `side-${Date.now()}`, agentId: s.side.agentId, run: null, model: s.side.model, effort: s.side.effort ?? null } } : {}))}
          onPick={(picked) => setState((s) => (s.side ? { side: { id: picked.id, agentId: picked.agentId, run: picked, model: picked.model, effort: picked.effort ?? null } } : {}))}
        />
      )}
      {effortOpen && (
        <EffortMenu
          anchor={effortChipRef.current}
          label={S.sideChatEffort}
          levels={levels}
          current={effort}
          onClose={() => {
            setEffortOpen(false);
            textareaRef.current?.focus();
          }}
          onChoose={(value) => setState((s) => (s.side ? { side: { ...s.side, effort: value } } : {}))}
        />
      )}
    </aside>
  );
}

function HistoryMenu({ anchor, runs, onNew, onPick, onClose }: { anchor: HTMLElement | null; runs: SideRun[]; onNew: () => void; onPick: (run: SideRun) => void; onClose: () => void }) {
  const [now] = useState(() => Date.now());
  const choose = (action: () => void) => {
    action();
    onClose();
  };
  return (
    <Popup anchor={anchor} placement="below" align="end" label={S.sideChatHistory} className="popup-model" onClose={onClose}>
      <div className="popup-list" role="listbox">
        <div className="popup-row" role="option" aria-selected={false} onClick={() => choose(onNew)}>
          <span className="popup-check">
            <Codicon name="add" size={12} />
          </span>
          <span className="popup-row-title">{S.sideChatNew}</span>
        </div>
        {runs.map((run) => (
          <div key={run.id} className="popup-row" role="option" aria-selected={false} title={run.messages[0]?.text} onClick={() => choose(() => onPick(run))}>
            <span className="popup-check" />
            <span className="popup-row-title">{run.messages[0]?.text.replace(/\s+/g, " ")}</span>
            {run.updatedAt && <span className="popup-row-key">{relativeTime(run.updatedAt, now)}</span>}
          </div>
        ))}
        {runs.length === 0 && <div className="popup-empty">{S.sideChatHistoryEmpty}</div>}
      </div>
    </Popup>
  );
}
