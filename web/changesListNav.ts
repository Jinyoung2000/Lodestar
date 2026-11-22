export type NavRow = { depth: number; folder: boolean; expanded: boolean };

export type NavAction = { type: "focus"; index: number } | { type: "toggle" } | null;

export const PAGE_ROWS = 10;

export function listNav(key: string, rows: readonly NavRow[], at: number, page = PAGE_ROWS): NavAction {
  if (rows.length === 0) return null;
  const last = rows.length - 1;
  const go = (index: number): NavAction => ({ type: "focus", index: Math.min(Math.max(index, 0), last) });
  switch (key) {
    case "ArrowDown":
      return go(at === -1 ? 0 : at + 1);
    case "ArrowUp":
      return go(at === -1 ? last : at - 1);
    case "Home":
      return go(0);
    case "End":
      return go(last);
    case "PageDown":
      return go(at === -1 ? 0 : at + page);
    case "PageUp":
      return go(at === -1 ? last : at - page);
  }
  const row = rows[at];
  if (!row) return null;
  if (key === "ArrowRight") {
    if (!row.folder) return null;
    if (!row.expanded) return { type: "toggle" };
    return rows[at + 1] && rows[at + 1].depth > row.depth ? go(at + 1) : null;
  }
  if (key === "ArrowLeft") {
    if (row.folder && row.expanded) return { type: "toggle" };
    const parent = parentOf(rows, at);
    return parent === -1 ? null : go(parent);
  }
  return null;
}

export function parentOf(rows: readonly NavRow[], at: number): number {
  for (let i = at - 1; i >= 0; i--) if (rows[i].depth < rows[at].depth) return i;
  return -1;
}
