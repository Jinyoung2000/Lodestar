import { Fragment, useLayoutEffect, useRef, useState } from "react";
import { PaneView } from "./AgentView";
import type { GridRow } from "./gridLayout";
import { DOCK_DEFAULT } from "./focusLayout";
import { PANE_MIN, ROW_MIN } from "./paneDrop";
import { paneMin, panesMinWidth, stretchedMin } from "./paneFit";
import { SessionDragOverlay } from "./SessionDragOverlay";
import { getState, setGridWeights, useStore, type Pane } from "./store";
import { S } from "./strings";

export function PaneGrid({ hidden }: { hidden: boolean }) {
  const panes = useStore((s) => s.panes);
  const grid = useStore((s) => s.grid);
  const gridRef = useRef<HTMLDivElement>(null);
  const editorLayout = useStore((s) => s.layoutMode === "editor");
  const dock = useStore((s) => s.layoutMode === "editor" && s.chatDock === "docked");
  const dockOpen = useStore((s) => s.chatDockOpen);
  const dockWidth = useStore((s) => s.chatDockWidth);
  const sized = grid.rowWeights && grid.rowWeights.length === grid.rows.length ? grid.rowWeights : null;
  const rows = grid.rows.map((_, i) => `${i > 0 ? "1px " : ""}minmax(0, ${sized?.[i] ?? 1}fr)`).join(" ");
  const region = useElementWidth(gridRef);
  const colsPerRow = grid.rows.map((r) => r.ids.length);
  const min = stretchedMin(paneMin(grid.rows.every((r) => r.ids.length <= 1)), region, colsPerRow);
  const columns = editorLayout ? undefined : `minmax(${panesMinWidth(colsPerRow, min)}px, 1fr)`;
  const activePaneId = useStore((s) => s.activePaneId);
  useLayoutEffect(() => {
    if (editorLayout) return;
    revealPane(gridRef.current, activePaneId);
  }, [activePaneId, grid.rows, editorLayout, min, region]);
  return (
    <>
      <div className="panes" ref={gridRef} data-layout={editorLayout ? "editor" : undefined} data-dock={dock || undefined} style={{ gridTemplateRows: rows, gridTemplateColumns: columns, display: hidden || (dock && !dockOpen) ? "none" : undefined, ...(dock ? { "--dock-w": `${dockWidth ?? DOCK_DEFAULT}px` } : {}) }}>
        {grid.rows.map((row, r) => (
          <Fragment key={row.id}>
            {r > 0 && <PaneRowDivider grid={gridRef} index={r - 1} />}
            <PaneRow row={row} panes={panes} min={editorLayout ? 0 : min} />
          </Fragment>
        ))}
      </div>
      <SessionDragOverlay />
    </>
  );
}

function PaneRow({ row, panes, min }: { row: GridRow; panes: Pane[]; min: number }) {
  const weights = useStore((s) => s.grid.colWeights);
  const rowRef = useRef<HTMLDivElement>(null);
  const known = row.ids.every((id) => weights[id] != null);
  const columns = row.ids.map((id, i) => `${i > 0 ? "1px " : ""}minmax(${min}px, ${known ? weights[id] : 1}fr)`).join(" ");
  return (
    <div className="pane-row" ref={rowRef} data-row-id={row.id} style={{ gridTemplateColumns: columns }}>
      {row.ids.map((id, i) => {
        const pane = panes.find((p) => p.id === id);
        return (
          <Fragment key={id}>
            {i > 0 && <PaneDivider row={rowRef} ids={row.ids} index={i - 1} />}
            {pane && (
              <div className="pane-cell" data-pane-id={id}>
                <PaneView pane={pane} />
              </div>
            )}
          </Fragment>
        );
      })}
    </div>
  );
}

function useElementWidth(ref: React.RefObject<HTMLDivElement | null>) {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setWidth(element.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

function revealPane(grid: HTMLDivElement | null, paneId: string) {
  const pane = grid?.querySelector<HTMLElement>(`[data-pane-id="${paneId}"] > .pane`);
  if (!grid || !pane) return;
  const view = grid.getBoundingClientRect();
  const box = pane.getBoundingClientRect();
  if (box.left >= view.left - 0.5 && box.right <= view.right + 0.5) return;
  const max = grid.scrollWidth - grid.clientWidth;
  const edges = Array.from(new Set(Array.from(grid.querySelectorAll<HTMLElement>(".pane")).map((p) => Math.round(p.getBoundingClientRect().left - view.left + grid.scrollLeft)))).sort((a, b) => a - b);
  const left = Math.round(box.left - view.left + grid.scrollLeft);
  if (box.left < view.left) {
    grid.scrollLeft = Math.min(left, max);
    return;
  }
  const needed = box.right - view.right + grid.scrollLeft;
  const target = edges.find((edge) => edge >= needed - 0.5 && edge <= Math.min(left, max) + 0.5) ?? Math.max(...edges.filter((edge) => edge <= max + 0.5), 0);
  grid.scrollLeft = Math.min(target, max);
}

function PaneDivider({ row, ids, index }: { row: React.RefObject<HTMLDivElement | null>; ids: string[]; index: number }) {
  const [active, setActive] = useState(false);
  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const cells = row.current ? Array.from(row.current.querySelectorAll<HTMLElement>(":scope > .pane-cell > .pane")) : [];
    if (cells.length < 2 || cells.length !== ids.length || event.button !== 0) return;
    const widths = cells.map((cell) => cell.getBoundingClientRect().width);
    const pair = widths[index] + widths[index + 1];
    const startX = event.clientX;
    const startLeft = widths[index];
    if (pair < PANE_MIN * 2) return;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
    }
    setActive(true);
    const move = (e: PointerEvent) => {
      const left = Math.min(Math.max(startLeft + (e.clientX - startX), PANE_MIN), pair - PANE_MIN);
      const next = widths.slice();
      next[index] = left;
      next[index + 1] = pair - left;
      setGridWeights({ cols: { ...getState().grid.colWeights, ...Object.fromEntries(ids.map((id, i) => [id, next[i]])) } });
    };
    const up = () => {
      setActive(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const reset = () => setGridWeights({ cols: Object.fromEntries(Object.entries(getState().grid.colWeights).filter(([id]) => !ids.includes(id))) });
  return <div className="resizer" role="separator" aria-label={S.resizePanes} aria-orientation="vertical" data-axis="x" data-active={active || undefined} onPointerDown={onPointerDown} onDoubleClick={reset} />;
}

function PaneRowDivider({ grid, index }: { grid: React.RefObject<HTMLDivElement | null>; index: number }) {
  const [active, setActive] = useState(false);
  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const rows = grid.current ? Array.from(grid.current.querySelectorAll<HTMLElement>(":scope > .pane-row")) : [];
    if (rows.length < 2 || event.button !== 0) return;
    const heights = rows.map((row) => row.getBoundingClientRect().height);
    const pair = heights[index] + heights[index + 1];
    const startY = event.clientY;
    const startTop = heights[index];
    if (pair < ROW_MIN * 2) return;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
    }
    setActive(true);
    const move = (e: PointerEvent) => {
      const top = Math.min(Math.max(startTop + (e.clientY - startY), ROW_MIN), pair - ROW_MIN);
      const next = heights.slice();
      next[index] = top;
      next[index + 1] = pair - top;
      setGridWeights({ rows: next });
    };
    const up = () => {
      setActive(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return <div className="resizer" role="separator" aria-label={S.resizePanes} aria-orientation="horizontal" data-axis="y" data-active={active || undefined} onPointerDown={onPointerDown} onDoubleClick={() => setGridWeights({ rows: null })} />;
}
