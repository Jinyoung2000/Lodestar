import { EditorView } from "@codemirror/view";
import { useEffect, useMemo, useRef, useState } from "react";
import { clearRangeHighlight, showRangeHighlight } from "./editorRangeHighlight";
import { parseGoTo } from "./goToLineModel";
import { viewFor } from "./lsp";
import { Palette } from "./Palette";
import { setState } from "./store";
import "./quickGoto.css";

export function GoToLine({ tabKey }: { tabKey: string | null }) {
  const view = tabKey ? viewFor(tabKey) : null;
  const [value, setValue] = useState(":");
  const startScroll = useRef(view?.scrollDOM.scrollTop ?? 0);
  const parsed = useMemo(() => (view ? parseGoTo({ doc: view.state.doc, eolLength: view.state.lineBreak.length, tabSize: view.state.tabSize }, value) : null), [view, value]);
  const target = parsed?.target ?? null;
  const targetPos = target?.pos ?? null;

  useEffect(() => {
    if (!view || targetPos === null) return;
    const line = view.state.doc.lineAt(targetPos);
    showRangeHighlight(view, line.from, line.to);
    view.dispatch({ effects: EditorView.scrollIntoView(targetPos, { y: "center" }) });
  }, [view, targetPos]);
  useEffect(() => {
    if (view && targetPos === null) clearRangeHighlight(view);
  }, [view, targetPos]);
  useEffect(() => (view ? () => clearRangeHighlight(view) : undefined), [view]);

  const accept = () => {
    if (!view || !target) return;
    clearRangeHighlight(view);
    view.dispatch({ selection: { anchor: target.pos }, effects: EditorView.scrollIntoView(target.pos, { y: "center" }), userEvent: "select" });
    setState({ overlay: null });
    focusLater(view);
  };

  const cancel = () => {
    setState({ overlay: null });
    if (!view) return;
    clearRangeHighlight(view);
    view.scrollDOM.scrollTop = startScroll.current;
    focusLater(view);
  };

  const label = parsed?.label ?? "Open a text editor first to go to a line or an offset.";
  return (
    <Palette
      quickpick
      dialogClassName="quickopen-dialog"
      label="Go to Line/Column"
      placeholder="Go to line. Type a line number, optionally followed by colon and column number."
      query={value}
      onQuery={(next) => {
        if (!next.startsWith(":")) {
          setState({ overlay: { kind: "quickOpen" }, quickOpenQuery: next });
          return;
        }
        setValue(next);
      }}
      onClose={cancel}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.nativeEvent.isComposing) {
          e.preventDefault();
          accept();
        }
      }}
      footer={null}
      listboxId="goto-line-list"
      activeOptionId="goto-line-hint"
    >
      <div className="quickopen-list" role="listbox" id="goto-line-list" aria-label="Go to Line/Column" onMouseDown={(e) => e.preventDefault()}>
        <div role="option" id="goto-line-hint" aria-selected className="quickopen-row" data-goto-line-hint data-active onClick={accept}>
          <span className="goto-hint">{label}</span>
        </div>
      </div>
    </Palette>
  );
}

export function focusLater(view: EditorView) {
  requestAnimationFrame(() => requestAnimationFrame(() => view.dom.isConnected && view.focus()));
}
