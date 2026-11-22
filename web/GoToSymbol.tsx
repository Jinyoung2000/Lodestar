import { EditorView } from "@codemirror/view";
import { useEffect, useMemo, useRef, useState } from "react";
import { fetchDocumentSymbolsOrNull, symbolIcon, type SymbolNode } from "./documentSymbols";
import { clearRangeHighlight, showRangeHighlight } from "./editorRangeHighlight";
import { focusLater } from "./GoToLine";
import { buildSymbolPicks, NO_EDITOR_MESSAGE, NO_PROVIDER_MESSAGE, splitMatches, symbolList, symbolTone, type SymbolRow } from "./goToSymbolModel";
import { Codicon } from "./icons";
import { viewFor } from "./lsp";
import { Palette } from "./Palette";
import { setState } from "./store";
import "./quickGoto.css";

export function GoToSymbol({ tabKey }: { tabKey: string | null }) {
  const view = tabKey ? viewFor(tabKey) : null;
  const [value, setValue] = useState("@");
  const [index, setIndex] = useState<number | null>(null);
  const [tree, setTree] = useState<SymbolNode[] | null | undefined>(undefined);
  const startScroll = useRef(view?.scrollDOM.scrollTop ?? 0);
  const cursor = useRef(view?.state.selection.main.head ?? null);

  useEffect(() => {
    if (!view) return;
    let live = true;
    void fetchDocumentSymbolsOrNull(view).then((result) => live && setTree(result));
    return () => {
      live = false;
    };
  }, [view]);

  const picks = useMemo(() => (tree ? buildSymbolPicks(symbolList(tree), value, cursor.current) : null), [tree, value]);
  const entries = useMemo(() => (picks ? entriesOf(picks.rows) : []), [picks]);
  const cursorRow = picks?.active != null ? picks.rows[picks.active] : null;
  const firstActive = cursorRow?.type === "symbol" ? Math.max(0, entries.findIndex((entry) => entry.row.index === cursorRow.index)) : 0;
  const active = Math.min(index ?? firstActive, Math.max(entries.length - 1, 0));
  const current = entries[active]?.row ?? null;

  useEffect(() => {
    if (!view || !current) return;
    showRangeHighlight(view, current.node.from, current.node.to);
    view.dispatch({ effects: EditorView.scrollIntoView(current.node.nameFrom, { y: "center" }) });
  }, [view, current]);
  useEffect(() => (view ? () => clearRangeHighlight(view) : undefined), [view]);
  useEffect(() => {
    document.querySelector("[data-goto-symbol][data-active]")?.scrollIntoView({ block: "nearest" });
  }, [active, entries]);

  const accept = (row: SymbolRow | null) => {
    if (!view || !row || row.type !== "symbol") return;
    clearRangeHighlight(view);
    view.dispatch({ selection: { anchor: row.node.nameFrom }, effects: EditorView.scrollIntoView(row.node.nameFrom, { y: "center" }), userEvent: "select" });
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

  const message = !view ? NO_EDITOR_MESSAGE : tree === null ? NO_PROVIDER_MESSAGE : tree && picks ? picks.empty : null;
  return (
    <Palette
      quickpick
      dialogClassName="quickopen-dialog"
      label="Go to Symbol in Editor"
      placeholder="Type the name of a symbol to go to."
      query={value}
      onQuery={(next) => {
        if (!next.startsWith("@")) {
          setState({ overlay: { kind: "quickOpen" }, quickOpenQuery: next });
          return;
        }
        setValue(next);
        setIndex(null);
      }}
      onClose={cancel}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return;
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          const step = e.key === "ArrowDown" ? 1 : -1;
          setIndex(entries.length ? (active + step + entries.length) % entries.length : 0);
        } else if (e.key === "PageDown" || e.key === "PageUp") {
          e.preventDefault();
          setIndex(Math.max(0, Math.min(entries.length - 1, active + (e.key === "PageDown" ? 8 : -8))));
        } else if (e.key === "Enter") {
          e.preventDefault();
          accept(current);
        }
      }}
      footer={null}
      listboxId="goto-symbol-list"
      activeOptionId={entries.length ? `goto-symbol-${active}` : undefined}
    >
      <div className="quickopen-list" role="listbox" id="goto-symbol-list" aria-label="Go to Symbol in Editor" onMouseDown={(e) => e.preventDefault()}>
        {entries.map((entry, i) => (
          <SymbolOption key={entry.row.index} entry={entry} id={`goto-symbol-${i}`} active={i === active} onChoose={accept} />
        ))}
        {message && <div className="goto-message">{message}</div>}
      </div>
    </Palette>
  );
}

type Entry = { row: Extract<SymbolRow, { type: "symbol" }>; group: string | null; separated: boolean };

function entriesOf(rows: readonly SymbolRow[]): Entry[] {
  const entries: Entry[] = [];
  let group: string | null = null;
  let seenGroup = false;
  for (const row of rows) {
    if (row.type === "separator") {
      group = row.label;
      continue;
    }
    entries.push({ row, group, separated: group !== null && seenGroup });
    if (group !== null) seenGroup = true;
    group = null;
  }
  return entries;
}

function SymbolOption({ entry, id, active, onChoose }: { entry: Entry; id: string; active: boolean; onChoose: (row: SymbolRow) => void }) {
  const { row } = entry;
  return (
    <div role="option" id={id} aria-selected={active} className="quickopen-row" data-goto-symbol={row.node.name} data-active={active || undefined} data-separated={entry.separated || undefined} onClick={() => onChoose(row)}>
      <span className="goto-symbol-icon" data-tone={symbolTone(row.node.kind)}>
        <Codicon name={symbolIcon(row.node.kind)} />
      </span>
      <span className="quickopen-name">
        <Highlighted text={row.node.name} ranges={row.labelMatch} />
      </span>
      {row.container && (
        <span className="quickopen-dir">
          <Highlighted text={row.container} ranges={row.containerMatch} />
        </span>
      )}
      {entry.group && <span className="quickpick-section quickopen-group">{entry.group}</span>}
    </div>
  );
}

function Highlighted({ text, ranges }: { text: string; ranges: { start: number; end: number }[] }) {
  return (
    <>
      {splitMatches(text, ranges).map((part, i) => (part.hit ? <span key={i} className="quickopen-hit">{part.text}</span> : part.text))}
    </>
  );
}
