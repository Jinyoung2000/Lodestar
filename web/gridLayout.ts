
export type GridRow = { id: string; ids: string[] };

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

function seedWeight(weights: Record<string, number>, rowIds: string[], id: string) {
  const known = rowIds.filter((x) => x !== id && weights[x] != null).map((x) => weights[x]);
  if (known.length === rowIds.length - 1 && known.length > 0) weights[id] = known.reduce((a, b) => a + b, 0) / known.length;
}

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
  return { ...grid, rows, rowWeights: null };
}

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

export function step(grid: Grid, id: string, delta: 1 | -1, wrap = false): string | null {
  const order = paneOrder(grid);
  const i = order.indexOf(id);
  if (i < 0) return null;
  if (wrap) return order.length < 2 ? null : order[(i + delta + order.length) % order.length];
  return order[i + delta] ?? null;
}

export type PlaceSide = "left" | "right" | "top" | "bottom";

export type PlaceSizes = { cols?: Record<string, number>; rows?: Record<string, number> };

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

export function withoutPane(grid: Grid, id: string): Grid {
  return reconcileGrid(grid, paneOrder(grid).filter((x) => x !== id), null);
}
