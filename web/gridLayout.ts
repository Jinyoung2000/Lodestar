// 세션 격자의 행과 열 구조. store 의 panes(칸 목록)는 평평한 채로 두고, 이 구조가 칸 id 를 행 단위로 배치한다.
// 순수 함수만 둔다(DOM, store 를 가져오지 않음). 칸이 늘고 줄어도 reconcileGrid 가 구조를 칸 목록에 맞춘다.

export type GridRow = { id: string; ids: string[] };

// colWeights: 칸 id 별 폭 비율(행 안에서만 의미). rowWeights: 행 순서대로의 높이 비율. 없으면 같은 크기.
export type Grid = { rows: GridRow[]; colWeights: Record<string, number>; rowWeights: number[] | null };

let rowSeq = 0;
const newRowId = () => `row-${++rowSeq}`;

export function gridOf(ids: string[]): Grid {
  return { rows: ids.length ? [{ id: newRowId(), ids }] : [], colWeights: {}, rowWeights: null };
}

export const paneOrder = (grid: Grid): string[] => grid.rows.flatMap((r) => r.ids);

export function locate(grid: Grid, id: string): { row: number; col: number } | null {
  for (let row = 0; row < grid.rows.length; row++) {
    const col = grid.rows[row].ids.indexOf(id);
    if (col >= 0) return { row, col };
  }
  return null;
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((id) => b.includes(id));

// panes 가 바뀌었을 때 구조를 맞춘다. 없어진 칸은 빼고(빈 행은 지우며 행 비율도 같이 뺌), 새 칸은 anchor 칸 오른쪽에 넣는다.
// 이미 맞으면 같은 객체를 돌려줘서 호출하는 쪽이 변경 여부를 참조 비교로 안다.
export function reconcileGrid(grid: Grid, paneIds: string[], anchorId: string | null): Grid {
  if (sameSet(paneOrder(grid), paneIds)) return grid;
  const alive = new Set(paneIds);
  const keptRows: { row: GridRow; weight: number | null }[] = [];
  grid.rows.forEach((row, i) => {
    const ids = row.ids.filter((id) => alive.has(id));
    if (ids.length) keptRows.push({ row: { id: row.id, ids }, weight: grid.rowWeights?.[i] ?? null });
  });
  let rows = keptRows.map((k) => k.row);
  let rowWeights = grid.rowWeights ? keptRows.map((k) => k.weight ?? 1) : null;
  const known = new Set(rows.flatMap((r) => r.ids));
  const fresh = paneIds.filter((id) => !known.has(id));
  const colWeights = Object.fromEntries(Object.entries(grid.colWeights).filter(([id]) => alive.has(id)));
  for (const id of fresh) {
    if (!rows.length) {
      rows = [{ id: newRowId(), ids: [id] }];
      rowWeights = null;
      continue;
    }
    const at = (anchorId && locate({ ...grid, rows }, anchorId)) || { row: rows.length - 1, col: rows[rows.length - 1].ids.length - 1 };
    rows = rows.map((r, i) => (i === at.row ? { ...r, ids: [...r.ids.slice(0, at.col + 1), id, ...r.ids.slice(at.col + 1)] } : r));
    seedWeight(colWeights, rows[at.row].ids, id);
  }
  return { rows, colWeights, rowWeights };
}

// 새 칸은 이미 폭이 정해진 칸들의 평균 폭으로 들어온다. 정해진 폭이 하나도 없으면 같은 폭(비율 없음)을 유지한다.
function seedWeight(weights: Record<string, number>, rowIds: string[], id: string) {
  const known = rowIds.filter((x) => x !== id && weights[x] != null).map((x) => weights[x]);
  if (known.length === rowIds.length - 1 && known.length > 0) weights[id] = known.reduce((a, b) => a + b, 0) / known.length;
}

// 활성 칸이 속한 행 아래에 id 하나짜리 새 행을 끼운다(⌘K ⌘\). 칸 목록에는 호출하는 쪽이 id 를 이미 더했다.
export function splitDown(grid: Grid, anchorId: string, id: string): Grid {
  const at = locate(grid, anchorId);
  const index = at ? at.row + 1 : grid.rows.length;
  const rows = [...grid.rows.slice(0, index), { id: newRowId(), ids: [id] }, ...grid.rows.slice(index)];
  let rowWeights: number[] | null = null;
  if (grid.rowWeights) {
    const mean = grid.rowWeights.reduce((a, b) => a + b, 0) / Math.max(1, grid.rowWeights.length);
    rowWeights = [...grid.rowWeights.slice(0, index), mean, ...grid.rowWeights.slice(index)];
  }
  return { ...grid, rows, rowWeights };
}

// 칸을 위(-1) 또는 아래(+1) 행으로 옮긴다. 그 방향에 행이 있으면 그 행의 끝에 붙고, 없으면 새 행을 만든다(원래 행에 다른 칸이 있을 때만).
// 원래 행이 비면 그 행은 닫힌다. 옮겼으면 새 격자, 못 옮기면 null.
export function moveToRow(grid: Grid, id: string, delta: 1 | -1): Grid | null {
  const at = locate(grid, id);
  if (!at) return null;
  const lone = grid.rows[at.row].ids.length === 1;
  const targetIndex = at.row + delta;
  const exists = targetIndex >= 0 && targetIndex < grid.rows.length;
  if (!exists && lone) return null;
  const withoutSource = grid.rows.map((r, i) => (i === at.row ? { ...r, ids: r.ids.filter((x) => x !== id) } : r));
  let rows: GridRow[];
  if (exists) rows = withoutSource.map((r, i) => (i === targetIndex ? { ...r, ids: [...r.ids, id] } : r));
  else {
    const fresh = { id: newRowId(), ids: [id] };
    rows = delta === 1 ? [...withoutSource.slice(0, at.row + 1), fresh, ...withoutSource.slice(at.row + 1)] : [...withoutSource.slice(0, at.row), fresh, ...withoutSource.slice(at.row)];
  }
  rows = rows.filter((r) => r.ids.length > 0);
  // 행 수나 순서가 바뀌었으니 높이 비율은 같은 높이로 되돌린다
  return { ...grid, rows, rowWeights: null };
}

// 두 칸의 자리를 바꾼다. 폭 비율은 자리에 붙어 있으므로 같이 바꾼다.
export function swapPanes(grid: Grid, a: string, b: string): Grid {
  const rows = grid.rows.map((r) => ({ ...r, ids: r.ids.map((id) => (id === a ? b : id === b ? a : id)) }));
  const colWeights = { ...grid.colWeights };
  const [wa, wb] = [grid.colWeights[a], grid.colWeights[b]];
  if (wa === undefined) delete colWeights[b];
  else colWeights[b] = wa;
  if (wb === undefined) delete colWeights[a];
  else colWeights[a] = wb;
  return { ...grid, rows, colWeights };
}

export type Direction = "left" | "right" | "up" | "down";

// 구조상 이웃. 위, 아래는 같은 열 번호(없으면 그 행의 끝)로 가고, 화면 위치로 더 정확히 고르고 싶으면 호출하는 쪽이 centers 를 준다.
export function neighbor(grid: Grid, id: string, direction: Direction, centers?: Record<string, number>): string | null {
  const at = locate(grid, id);
  if (!at) return null;
  if (direction === "left") return grid.rows[at.row].ids[at.col - 1] ?? null;
  if (direction === "right") return grid.rows[at.row].ids[at.col + 1] ?? null;
  const target = grid.rows[at.row + (direction === "up" ? -1 : 1)];
  if (!target) return null;
  if (centers && centers[id] != null) {
    const x = centers[id];
    return target.ids.reduce((best, cur) => (centers[cur] != null && (centers[best] == null || Math.abs(centers[cur] - x) < Math.abs(centers[best] - x)) ? cur : best), target.ids[0]);
  }
  return target.ids[Math.min(at.col, target.ids.length - 1)];
}

// 이전, 다음 칸(왼쪽 위에서 오른쪽 아래로 읽는 순서). 끝에서는 멈춘다. wrap 이면 끝에서 반대쪽 끝으로 이어진다.
export function step(grid: Grid, id: string, delta: 1 | -1, wrap = false): string | null {
  const order = paneOrder(grid);
  const i = order.indexOf(id);
  if (i < 0) return null;
  if (wrap) return order.length < 2 ? null : order[(i + delta + order.length) % order.length];
  return order[i + delta] ?? null;
}

// SESSIONDRAG: 사이드바 세션 행을 칸 가장자리에 놓아 새 칸을 만드는 배치. 위/왼쪽까지 네 방향을 한 함수가 맡는다.
export type PlaceSide = "left" | "right" | "top" | "bottom";

// sizes 는 놓는 순간 DOM 에서 잰 px. cols 는 칸 id 별 폭, rows 는 행 id 별 높이다. 있으면 anchor 칸(행)을 정확히 반으로 가르고, 없으면 기존 규칙(평균 폭, 평균 높이)을 따른다.
export type PlaceSizes = { cols?: Record<string, number>; rows?: Record<string, number> };

// id 칸을 anchorId 칸의 side 쪽에 새로 끼운다. id 는 grid 에 아직 없어야 한다(옮기는 칸은 호출하는 쪽이 withoutPane 으로 먼저 뺀다).
// left, right 는 anchor 가 속한 행 안의 새 열, bottom 은 기존 splitDown 과 같은 새 행, top 은 anchor 행 위의 새 행이다. 행 안을 위아래로 나눌 수는 없어서 top, bottom 은 행 전체 폭을 쓴다.
export function placeBeside(grid: Grid, id: string, anchorId: string, side: PlaceSide, sizes?: PlaceSizes): Grid {
  const at = locate(grid, anchorId);
  if (!at) return grid;
  if (side === "left" || side === "right") {
    const col = side === "left" ? at.col : at.col + 1;
    const rows = grid.rows.map((r, i) => (i === at.row ? { ...r, ids: [...r.ids.slice(0, col), id, ...r.ids.slice(col)] } : r));
    const ids = rows[at.row].ids;
    const colWeights = { ...grid.colWeights };
    const cols = sizes?.cols;
    if (cols && ids.every((x) => x === id || cols[x] != null)) {
      for (const x of ids) colWeights[x] = x === id ? cols[anchorId] / 2 : x === anchorId ? cols[anchorId] / 2 : cols[x];
    } else seedWeight(colWeights, ids, id);
    return { ...grid, rows, colWeights };
  }
  const heights = sizes?.rows;
  if (side === "bottom" && !heights) return splitDown(grid, anchorId, id);
  const index = side === "bottom" ? at.row + 1 : at.row;
  const fresh: GridRow = { id: newRowId(), ids: [id] };
  const rows = [...grid.rows.slice(0, index), fresh, ...grid.rows.slice(index)];
  let rowWeights: number[] | null = null;
  const anchorRow = grid.rows[at.row].id;
  if (heights && grid.rows.every((r) => heights[r.id] != null)) {
    rowWeights = rows.map((r) => (r === fresh || r.id === anchorRow ? heights[anchorRow] / 2 : heights[r.id]));
  } else if (grid.rowWeights) {
    const mean = grid.rowWeights.reduce((a, b) => a + b, 0) / Math.max(1, grid.rowWeights.length);
    rowWeights = [...grid.rowWeights.slice(0, index), mean, ...grid.rowWeights.slice(index)];
  }
  return { ...grid, rows, rowWeights };
}

// 칸 하나를 구조에서 뺀다(빈 행은 닫히고 그 행의 높이 비율도 같이 빠진다). 칸 목록(panes)은 그대로 둔다.
export function withoutPane(grid: Grid, id: string): Grid {
  return reconcileGrid(grid, paneOrder(grid).filter((x) => x !== id), null);
}
