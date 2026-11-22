import { useEffect, useRef, useState } from "react";
import { Palette } from "./Palette";
import { prepareQuery, scoreFileItem } from "./quickOpenScore";
import { setState } from "./store";
import "./quickGoto.css";

export type PickItem = { id: string; label: string; description?: string; group?: string };
type Pending = { placeholder: string; items: PickItem[]; activeId?: string; resolve: (id: string | null) => void };
const pending = new Map<string, Pending>();

export function openEditorPick(options: { placeholder: string; items: PickItem[]; activeId?: string }): Promise<string | null> {
  const id = `pick-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  return new Promise((resolve) => {
    pending.set(id, { ...options, resolve });
    setState({ overlay: { kind: "editorPick", id } });
  });
}

export function EditorPickOverlay({ id }: { id: string }) {
  const entry = pending.get(id);
  const answered = useRef(false);
  const answer = (value: string | null) => {
    if (answered.current) return;
    answered.current = true;
    pending.delete(id);
    entry?.resolve(value);
    setState((s) => (s.overlay?.kind === "editorPick" && s.overlay.id === id ? { overlay: null } : {}));
  };
  useEffect(() => () => answer(null), []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!entry) return null;
  return <PickList placeholder={entry.placeholder} items={entry.items} activeId={entry.activeId} onChoose={answer} />;
}

function PickList({ placeholder, items, activeId, onChoose }: { placeholder: string; items: PickItem[]; activeId?: string; onChoose: (id: string | null) => void }) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState<number | null>(null);
  const filtered = query.trim() !== "";
  const rows = filtered ? filterPicks(items, query) : items;
  const start = Math.max(0, items.findIndex((item) => item.id === activeId));
  const active = Math.min(index ?? (filtered ? 0 : start), Math.max(rows.length - 1, 0));

  useEffect(() => {
    document.querySelector("[data-editor-pick][data-active]")?.scrollIntoView({ block: "nearest" });
  }, [active, rows.length]);

  return (
    <Palette
      quickpick
      dialogClassName="quickopen-dialog"
      count={filtered ? `${rows.length} Results` : null}
      label={placeholder}
      placeholder={placeholder}
      query={query}
      onQuery={(value) => {
        setQuery(value);
        setIndex(null);
      }}
      onClose={() => onChoose(null)}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return;
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          const step = e.key === "ArrowDown" ? 1 : -1;
          setIndex(rows.length ? (active + step + rows.length) % rows.length : 0);
        } else if (e.key === "Enter" && rows[active]) {
          e.preventDefault();
          onChoose(rows[active].id);
        }
      }}
      footer={null}
      listboxId="editor-pick-list"
      activeOptionId={rows.length ? `editor-pick-${active}` : undefined}
    >
      <div className="quickopen-list" role="listbox" id="editor-pick-list" aria-label={placeholder} onMouseDown={(e) => e.preventDefault()}>
        {rows.map((item, i) => (
          <div key={item.id} role="option" id={`editor-pick-${i}`} aria-selected={i === active} className="quickopen-row" data-editor-pick={item.id} data-active={i === active || undefined} data-separated={(!filtered && !!item.group && i > 0) || undefined} onClick={() => onChoose(item.id)}>
            <span className="quickopen-name">{item.label}</span>
            {item.description && <span className="quickopen-dir">{item.description}</span>}
            {!filtered && item.group && <span className="quickpick-section quickopen-group">{item.group}</span>}
          </div>
        ))}
        {rows.length === 0 && <div className="quickpick-empty">No matching results</div>}
      </div>
    </Palette>
  );
}

function filterPicks(items: readonly PickItem[], query: string): PickItem[] {
  const prepared = prepareQuery(query.trim());
  return items
    .map((item) => ({ item, score: Math.max(scoreFileItem({ label: item.label }, prepared, true).score, item.description ? scoreFileItem({ label: item.description }, prepared, true).score : 0) }))
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((hit) => hit.item);
}
