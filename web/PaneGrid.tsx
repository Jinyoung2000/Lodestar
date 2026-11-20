import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import { PaneView } from "./AgentView";
import type { GridRow } from "./gridLayout";
import { DOCK_DEFAULT } from "./focusLayout";
import { PANE_MIN, ROW_MIN } from "./paneDrop";
import { paneMin, panesMinWidth, stretchedMin } from "./paneFit";
import { SessionDragOverlay } from "./SessionDragOverlay";
import { getState, setGridWeights, useStore, type Pane } from "./store";
import { S } from "./strings";

// 가운데 세션 격자. state.grid 의 행마다 열을 늘어놓고, 행 사이와 열 사이에 1px 경계(잡기 영역은 4px)를 둔다.
// 칸 폭과 행 높이는 fr 비율이라 창 크기가 바뀌어도 비율이 유지된다.
export function PaneGrid({ hidden }: { hidden: boolean }) {
  const panes = useStore((s) => s.panes);
  const grid = useStore((s) => s.grid);
  const gridRef = useRef<HTMLDivElement>(null);
  // Editor 배치에서는 격자가 자리를 차지하지 않고(폭 0), 활성 칸 하나만 CSS 로 떠 있는 창이 된다. 나머지 칸은 숨겨 둔 채 마운트되어 있다가 Chat 배치로 돌아오면 그대로 보인다.
  const editorLayout = useStore((s) => s.layoutMode === "editor");
  // Chat in editor layout 이 Docked 이면 격자가 가운데 영역의 맨 오른쪽에서 폭을 갖고(styles: focusLayout.css) 활성 칸만 그 안을 채운다. 패널을 닫으면 숨기기만 한다.
  const dock = useStore((s) => s.layoutMode === "editor" && s.chatDock === "docked");
  const dockOpen = useStore((s) => s.chatDockOpen);
  const dockWidth = useStore((s) => s.chatDockWidth);
  const sized = grid.rowWeights && grid.rowWeights.length === grid.rows.length ? grid.rowWeights : null;
  const rows = grid.rows.map((_, i) => `${i > 0 ? "1px " : ""}minmax(0, ${sized?.[i] ?? 1}fr)`).join(" ");
  // 칸은 최소 폭(paneMin: 열이 여럿이면 PANE_MIN, 하나뿐이면 300) 아래로 줄지 않는다. 열 하나짜리 트랙을 가장 칸 많은 행의 최소 폭 이상으로 두면 모자랄 때 .panes 가 가로로 스크롤된다. Editor 배치는 격자가 접혀 있어 해당 없다.
  // 스크롤이 생길 때는 한 화면에 온전히 들어가는 칸 수만큼 칸 폭을 키워 칸 영역을 채운다(stretchedMin). 스크롤 위치가 늘 칸 경계가 된다.
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
  // 칸 사이에 1px 칸(경계선 자리)을 끼워 그 안에 잡기 영역을 둔다.
  const columns = row.ids.map((id, i) => `${i > 0 ? "1px " : ""}minmax(${min}px, ${known ? weights[id] : 1}fr)`).join(" ");
  return (
    <div className="pane-row" ref={rowRef} data-row-id={row.id} style={{ gridTemplateColumns: columns }}>
      {row.ids.map((id, i) => {
        const pane = panes.find((p) => p.id === id);
        return (
          <Fragment key={id}>
            {i > 0 && <PaneDivider row={rowRef} ids={row.ids} index={i - 1} />}
            {/* display: contents 라서 자리는 .pane 이 차지한다. 키 처리와 칸 이동이 칸 id 로 DOM 을 찾는 표식이다. */}
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

// 칸 영역 폭을 지켜본다. 숨겨져 있으면(display: none) 0 이다.
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

// 스크롤되는 격자에서 칸이 새로 생기거나 활성 칸이 바뀌면 그 칸이 보이게 가로 스크롤을 옮긴다. 옮긴 위치는 늘 칸의 왼쪽 경계다(scroll-snap 과 같다).
// 칸이 왼쪽으로 벗어났으면 그 칸의 왼쪽 경계로, 오른쪽으로 벗어났으면 그 칸이 온전히 보이는 가장 작은 경계로 간다. 스크롤 끝보다 먼 경계는 없으니 끝 이내의 가장 가까운 경계가 된다.
// scrollIntoView 는 overflow: hidden 인 바깥 요소까지 스크롤시킬 수 있어 쓰지 않는다.
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

// 칸 사이 경계. 끄는 동안 왼쪽 칸과 오른쪽 칸만 서로 폭을 주고받고(다른 칸은 그대로), 각 칸은 PANE_MIN 아래로 줄지 않는다.
// 더블클릭은 이 행의 모든 칸을 같은 폭으로 되돌린다. 폭은 끌기 시작 시점의 실제 DOM 폭 기준 px 를 그대로 비율 값으로 저장한다.
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
      // 합성 PointerEvent(검증 창구)는 활성 포인터가 아니라 캡처가 거절된다. window 리스너로 끝까지 따라가므로 없어도 된다.
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

// 행 사이 경계. 끄는 동안 위 행과 아래 행만 높이를 주고받고, 각 행은 ROW_MIN 아래로 줄지 않는다. 더블클릭은 모든 행을 같은 높이로 되돌린다.
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
      // 합성 PointerEvent(검증 창구)는 활성 포인터가 아니라 캡처가 거절된다.
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
