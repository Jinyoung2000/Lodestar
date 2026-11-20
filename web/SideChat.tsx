import DOMPurify from "dompurify";
import { parseMarkdown } from "./markdownParse";
import { openLinkOutside } from "./fileRefs";
import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { FLOAT_EDGES, moveRect, resizeRect, type FloatEdge, type FloatRect } from "./floatLayout";
import { sideChatModel, useDefaults } from "./defaults";
import { ArrowUpCompact, Close, ModelIcon, Stop } from "./icons";
import { ModelMenu } from "./Pickers";
import { rpc } from "./rpc";
import { flash, openAgent, setState, useStore, type SideState } from "./store";
import { Button } from "./ui/button";
import { modelName } from "./timelineModel";
import { S } from "./strings";

// 창을 끌어 옮길 때 제목줄 아래로만 움직이게 하는 한계값은 디자인 토큰(CSS 변수)에서 읽는다.
function cssNumber(name: string, fallback: number) {
  const value = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name));
  return Number.isFinite(value) ? value : fallback;
}

// /btw 곁다리 대화. 메인 세션의 대화를 알고 답하지만 메인 기록은 바꾸지 않는다.
export function SideChat({ side }: { side: SideState }) {
  const agent = useStore((s) => s.agents.find((a) => a.id === side.agentId));
  const meta = useStore((s) => s.meta);
  const [text, setText] = useState("");
  const [modelOpen, setModelOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const modelChipRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const defaults = useDefaults();
  const model = sideChatModel(side.model, agent?.model, defaults);
  const run = side.run;
  const busy = run?.status === "running";
  const asideRef = useRef<HTMLElement>(null);
  // 기본은 오른쪽 아래. 에디터나 떠 있는 대화 창을 가리면 머리를 끌어 옮기고 가장자리를 끌어 크기를 바꾼다(저장하지 않고, 머리를 두 번 누르면 제자리와 기본 크기로).
  const [moved, setMoved] = useState<FloatRect | null>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, [side.id]);
  // B2: 대화에서 고른 글을 질문으로 채워 연다. 보내지는 않는다.
  const draftNonce = side.draft?.nonce;
  useEffect(() => {
    if (draftNonce === undefined) return;
    setText(side.draft?.text ?? "");
    textareaRef.current?.focus();
  }, [draftNonce]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [run]);

  const ask = (question: string) => {
    const q = question.trim();
    if (!q || busy) return;
    setText("");
    rpc.call("side.ask", { id: side.id, agentId: side.agentId, model, question: q }).catch((e: Error) => flash(e.message));
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

  // 머리를 끌면 옮기고, 가장자리와 모서리를 끌면 크기를 바꾼다(떠 있는 대화 창과 같은 손잡이).
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
        <Button size="icon" aria-label={S.close} title={S.closeEsc} onClick={() => setState({ side: null })}>
          <Close />
        </Button>
      </div>
      <div className="side-messages" ref={listRef} onClick={openLinkOutside}>
        {!run && <div className="empty-hint">{S.sideChatEmpty}</div>}
        {run?.messages.map((m, i) =>
          m.role === "user" ? (
            <div key={i} className="side-user">
              {m.text}
            </div>
          ) : (
            <div key={i} className={`markdown side-assistant ${busy && i === run.messages.length - 1 ? "streaming" : ""}`} dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(parseMarkdown(m.text || (busy ? "…" : ""))) }} />
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
              <span className="chip-label model-label">{modelName(model, models)}</span>
            </button>
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
    </aside>
  );
}
