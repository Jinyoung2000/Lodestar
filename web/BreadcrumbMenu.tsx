import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";
import { BC } from "./breadcrumbStrings";
import { fileItems, highlightParts, matchRowIndex, navigatePicker, pickerBodyHeight, pickerPlacement, symbolId, symbolItems, symbolTone, visibleRows, PICKER_ROW, type PickerIcon, type PickerNav, type PickerRow, type PickTarget } from "./breadcrumbModel";
import type { SymbolNode } from "./documentSymbols";
import { FileTypeIcon, FolderTypeIcon } from "./FileTypeIcon";
import { Codicon } from "./icons";
import { symbolIcon } from "./documentSymbols";
import { ensureFiles, useStore } from "./store";

export type MenuSource =
  | { kind: "files"; workspaceId: string; dir: string; current: string }
  | { kind: "symbols"; siblings: readonly SymbolNode[]; current: SymbolNode };

export type MenuClose = "escape" | "pick" | "outside" | "layout";

type Props = {
  source: MenuSource;
  anchor: HTMLElement;
  pointerX: number | null;
  name: string;
  onPick: (target: PickTarget, side: boolean) => void;
  onPreview: (target: PickTarget) => void;
  onClose: (why: MenuClose) => void;
  onMove: (step: -1 | 1) => void;
};

type Find = { open: boolean; query: string; filter: boolean };

const NAV_KEYS: Record<string, PickerNav> = { ArrowDown: "down", ArrowUp: "up", Home: "home", End: "end", ArrowRight: "right", ArrowLeft: "left", PageDown: "pageDown", PageUp: "pageUp" };

export function BreadcrumbMenu({ source, anchor, pointerX, name, onPick, onPreview, onClose, onMove }: Props) {
  const files = useStore((s) => (source.kind === "files" ? s.files[source.workspaceId] : undefined));
  const emptyDirs = useStore((s) => (source.kind === "files" ? s.emptyDirs[source.workspaceId] : undefined));
  const items = useMemo(() => (source.kind === "files" ? fileItems(files ?? [], emptyDirs ?? [], source.dir) : symbolItems(source.siblings)), [source, files, emptyDirs]);
  const [placement] = useState(() => pickerPlacement(anchor.getBoundingClientRect(), { width: window.innerWidth, height: window.innerHeight }, pointerX));
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [focusId, setFocusId] = useState<string | null>(source.kind === "files" ? source.current : symbolId(source.current));
  const [find, setFind] = useState<Find>({ open: false, query: "", filter: false });
  const rootRef = useRef<HTMLDivElement>(null);
  const rowsRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const rows = useMemo(() => visibleRows(items, expanded, find.query, find.filter), [items, expanded, find.query, find.filter]);
  const body = pickerBodyHeight(rows.length, placement.maxHeight);
  const focusIndex = rows.findIndex((row) => row.item.id === focusId);
  const focusedRow = rows[focusIndex];

  useLayoutEffect(() => {
    const index = rows.findIndex((row) => row.item.id === focusId);
    if (rowsRef.current && index >= 0) rowsRef.current.scrollTop = Math.max(0, index * PICKER_ROW - (body - PICKER_ROW) / 2);
    rootRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    const list = rowsRef.current;
    if (!list || focusIndex < 0) return;
    const top = focusIndex * PICKER_ROW;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (top + PICKER_ROW > list.scrollTop + list.clientHeight) list.scrollTop = top + PICKER_ROW - list.clientHeight;
  }, [focusIndex]);

  useEffect(() => {
    if (focusedRow) onPreview(focusedRow.item.target);
  }, [focusedRow?.item.id]);

  useEffect(() => {
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target)) onClose("outside");
    };
    const resize = () => onClose("layout");
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("resize", resize);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("resize", resize);
    };
  }, [onClose]);

  useEffect(() => {
    if (source.kind === "files") void ensureFiles(source.workspaceId);
  }, [source]);

  useEffect(() => {
    if (find.open) inputRef.current?.focus();
    else rootRef.current?.focus({ preventScroll: true });
  }, [find.open]);

  const toggle = (id: string) => {
    const next = new Set(expanded);
    if (!next.delete(id)) next.add(id);
    setExpanded(next);
  };

  const activate = (row: PickerRow, side: boolean) => {
    setFocusId(row.item.id);
    if (row.item.target.type === "folder") toggle(row.item.id);
    else onPick(row.item.target, side);
  };

  const setQuery = (query: string, filter = find.filter) => {
    setFind({ open: true, query, filter });
    const next = visibleRows(items, expanded, query, filter);
    if (!filter) {
      const hit = matchRowIndex(next, Math.max(0, next.findIndex((row) => row.item.id === focusId)), 0);
      if (hit >= 0) setFocusId(next[hit]!.item.id);
    } else if (!next.some((row) => row.item.id === focusId)) setFocusId(next[0]?.item.id ?? null);
  };

  const closeFind = () => setFind({ open: false, query: "", filter: find.filter });

  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    const inInput = event.target instanceof HTMLInputElement;
    if (event.altKey && (event.key === "ArrowRight" || event.key === "ArrowLeft")) {
      handled(event);
      onMove(event.key === "ArrowRight" ? 1 : -1);
      return;
    }
    if (event.key === "Escape") {
      handled(event);
      if (find.open) closeFind();
      else onClose("escape");
      return;
    }
    if (event.key === "Enter" || (event.key === " " && !inInput)) {
      if (!focusedRow) return;
      handled(event);
      if (event.key === " ") {
        if (focusedRow.item.hasChildren) toggle(focusedRow.item.id);
        return;
      }
      activate(focusedRow, event.metaKey);
      return;
    }
    const nav = NAV_KEYS[event.key];
    const matchStep = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (inInput && nav && event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "PageDown" && event.key !== "PageUp") return;
    if (nav) {
      handled(event);
      if (find.open && find.query && !find.filter && matchStep !== 0) {
        const hit = matchRowIndex(rows, focusIndex, matchStep === 1 ? 1 : -1);
        if (hit >= 0) setFocusId(rows[hit]!.item.id);
        return;
      }
      const next = navigatePicker(rows, focusId, nav, expanded, Math.max(1, Math.floor(body / PICKER_ROW)));
      setFocusId(next.focusId);
      if (next.expanded !== expanded) setExpanded(next.expanded);
      return;
    }
    if (inInput) {
      if (event.key === "Backspace" && find.query === "") closeFind();
      return;
    }
    if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      handled(event);
      setQuery(find.query + event.key);
    }
  };

  const onRowClick = (row: PickerRow, event: ReactMouseEvent) => activate(row, event.altKey);

  return createPortal(
    <div
      ref={rootRef}
      className="breadcrumb-picker"
      role="tree"
      tabIndex={-1}
      aria-label={BC.listAria(name)}
      data-testid="breadcrumb-picker"
      data-source={source.kind}
      style={{ left: placement.left, top: placement.top, width: placement.width }}
      onKeyDown={onKeyDown}
      onBlur={(event) => {
        if (!rootRef.current?.contains(event.relatedTarget as Node | null) && event.relatedTarget !== null) onClose("outside");
      }}
    >
      <div className="breadcrumb-picker-arrow" style={{ marginLeft: placement.arrowOffset }} />
      <div className="breadcrumb-picker-box">
        <div ref={rowsRef} className="breadcrumb-picker-rows" style={{ height: body }}>
          {rows.map((row) => (
            <PickerRowView key={row.item.id} row={row} focused={row.item.id === focusId} onClick={onRowClick} onTwistie={toggle} />
          ))}
          {rows.length === 0 && <div className="breadcrumb-picker-empty">{BC.empty}</div>}
        </div>
        {find.open && (
          <div className="breadcrumb-picker-find">
            <input ref={inputRef} className="breadcrumb-picker-find-input" value={find.query} placeholder={BC.findPlaceholder} aria-label={BC.findPlaceholder} spellCheck={false} onChange={(event) => setQuery(event.target.value)} />
            <button type="button" className="breadcrumb-picker-find-mode" aria-pressed={find.filter} title={find.filter ? BC.filterOnType : BC.highlightOnType} onClick={() => setQuery(find.query, !find.filter)}>
              <Codicon name="list-filter" size={14} />
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

function handled(event: ReactKeyboardEvent) {
  event.preventDefault();
  event.stopPropagation();
}

type RowProps = { row: PickerRow; focused: boolean; onClick: (row: PickerRow, event: ReactMouseEvent) => void; onTwistie: (id: string) => void };

function PickerRowView({ row, focused, onClick, onTwistie }: RowProps) {
  const { item } = row;
  return (
    <div
      role="treeitem"
      className="breadcrumb-row"
      aria-level={row.depth + 1}
      aria-expanded={item.hasChildren ? row.expanded : undefined}
      aria-selected={focused}
      data-id={item.id}
      data-kind={item.icon.kind}
      data-focused={focused || undefined}
      title={item.icon.kind === "folder" ? undefined : BC.openToSideTip}
      style={{ paddingLeft: `calc(var(--space-2) * ${row.depth})` }}
      onClick={(event) => onClick(row, event)}
    >
      <span
        className="breadcrumb-twistie"
        data-collapsed={item.hasChildren && !row.expanded ? "" : undefined}
        onClick={(event) => {
          if (!item.hasChildren) return;
          event.stopPropagation();
          onTwistie(item.id);
        }}
      >
        {item.hasChildren && <Codicon name="chevron-down" size={10} />}
      </span>
      <RowIcon icon={item.icon} />
      <span className="breadcrumb-row-label">
        {highlightParts(item.label, row.match).map((part, index) => (
          <span key={index} className={part.hit ? "breadcrumb-hit" : undefined}>
            {part.text}
          </span>
        ))}
      </span>
    </div>
  );
}

function RowIcon({ icon }: { icon: PickerIcon }) {
  if (icon.kind === "folder") return <FolderTypeIcon name={icon.name} />;
  if (icon.kind === "file") return <FileTypeIcon name={icon.name} />;
  return (
    <span className="breadcrumb-symbol" data-tone={symbolTone(icon.symbolKind)}>
      <Codicon name={symbolIcon(icon.symbolKind)} />
    </span>
  );
}
