
export type LayoutMode = "chat" | "editor";

export const isLayoutMode = (value: unknown): value is LayoutMode => value === "chat" || value === "editor";

export type StartingModeInput = {
  restored: LayoutMode | null;
  defaultLayout: LayoutMode | null;
  remember: boolean;
  last: LayoutMode | null;
};

export function startingMode(input: StartingModeInput): LayoutMode {
  if (input.restored) return input.restored;
  if (input.remember && input.last) return input.last;
  return input.defaultLayout ?? "chat";
}

export type FloatRect = { x: number; y: number; w: number; h: number };
export type Viewport = { width: number; height: number; top: number };
export type FloatLimits = { minW: number; minH: number; margin: number };
export type FloatEdge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

export const FLOAT_EDGES: readonly FloatEdge[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max));

export function clampRect(rect: FloatRect, vp: Viewport, limits: FloatLimits): FloatRect {
  const availH = Math.max(0, vp.height - vp.top);
  const w = Math.round(clamp(rect.w, Math.min(limits.minW, vp.width), vp.width));
  const h = Math.round(clamp(rect.h, Math.min(limits.minH, availH), availH));
  return {
    w,
    h,
    x: Math.round(clamp(rect.x, 0, vp.width - w)),
    y: Math.round(clamp(rect.y, vp.top, vp.height - h)),
  };
}

export function defaultRect(size: { w: number; h: number }, vp: Viewport, limits: FloatLimits): FloatRect {
  return clampRect({ w: size.w, h: size.h, x: vp.width - size.w - limits.margin, y: vp.height - size.h - limits.margin }, vp, limits);
}

export function moveRect(start: FloatRect, dx: number, dy: number, vp: Viewport, limits: FloatLimits): FloatRect {
  return clampRect({ ...start, x: start.x + dx, y: start.y + dy }, vp, limits);
}

export function resizeRect(start: FloatRect, edge: FloatEdge, dx: number, dy: number, vp: Viewport, limits: FloatLimits): FloatRect {
  let left = start.x;
  let right = start.x + start.w;
  let top = start.y;
  let bottom = start.y + start.h;
  if (edge.includes("e")) right = clamp(right + dx, left + limits.minW, vp.width);
  if (edge.includes("w")) left = clamp(left + dx, 0, right - limits.minW);
  if (edge.includes("s")) bottom = clamp(bottom + dy, top + limits.minH, vp.height);
  if (edge.includes("n")) top = clamp(top + dy, vp.top, bottom - limits.minH);
  return clampRect({ x: left, y: top, w: right - left, h: bottom - top }, vp, limits);
}

export function parseRect(raw: unknown): FloatRect | null {
  if (!raw || typeof raw !== "object") return null;
  const { x, y, w, h } = raw as Record<string, unknown>;
  const ok = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
  if (!ok(x) || !ok(y) || !ok(w) || !ok(h) || w <= 0 || h <= 0) return null;
  return { x, y, w, h };
}

export const sameRect = (a: FloatRect | null, b: FloatRect | null) => (a === b) || (!!a && !!b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h);

export function pillAnchor(rect: FloatRect, vp: Viewport): { right: number; bottom: number } {
  return { right: Math.max(0, vp.width - (rect.x + rect.w)), bottom: Math.max(0, vp.height - (rect.y + rect.h)) };
}

export const PINNED_TAB_KEYS: readonly string[] = ["changes", "files", "scm", "search", "card"];
export const isPinnedTab = (key: string | null | undefined): boolean => key != null && PINNED_TAB_KEYS.includes(key);

export type TabSlice = {
  layoutMode: LayoutMode;
  activeTabKey: string | null;
  sideTabKey: string;
  mainEditorKey: string | null;
  groupActive: Record<string, string | null>;
  tabKeys: readonly string[];
  mainKeys: readonly string[];
};

export const MAIN = "main";

export const separatesPinned = (slice: Pick<TabSlice, "layoutMode" | "tabKeys">): boolean => slice.layoutMode === "editor" || slice.tabKeys.length > 0;

export function normalizeTabs(prev: TabSlice, next: TabSlice): TabSlice {
  const out: TabSlice = { ...next };
  const modeChanged = prev.layoutMode !== next.layoutMode;
  const live = (key: string | null) => key !== null && !isPinnedTab(key) && next.tabKeys.includes(key);

  if (separatesPinned(next) && isPinnedTab(next.activeTabKey)) {
    const pushedOut = prev.activeTabKey !== null && !isPinnedTab(prev.activeTabKey) && !next.tabKeys.includes(prev.activeTabKey);
    const chosen = modeChanged || !pushedOut;
    if (chosen) out.sideTabKey = next.activeTabKey!;
    out.activeTabKey = live(prev.activeTabKey) ? prev.activeTabKey : live(next.mainEditorKey) ? next.mainEditorKey : (next.mainKeys[next.mainKeys.length - 1] ?? null);
  } else if (isPinnedTab(next.activeTabKey) && next.activeTabKey !== prev.activeTabKey) {
    out.sideTabKey = next.activeTabKey!;
  }

  if (live(out.activeTabKey) && next.mainKeys.includes(out.activeTabKey!)) out.mainEditorKey = out.activeTabKey;
  else if (!live(out.mainEditorKey) || !next.mainKeys.includes(out.mainEditorKey!)) out.mainEditorKey = null;

  if (separatesPinned(next) && isPinnedTab(next.groupActive[MAIN])) {
    const { [MAIN]: _stale, ...rest } = next.groupActive;
    out.groupActive = live(out.mainEditorKey) ? { ...rest, [MAIN]: out.mainEditorKey } : rest;
  }
  return out;
}

export function editorKeyOfMain(activeKey: string | null, mainEditorKey: string | null, mainKeys: readonly string[]): string | null {
  if (activeKey !== null && mainKeys.includes(activeKey)) return activeKey;
  if (mainEditorKey !== null && mainKeys.includes(mainEditorKey)) return mainEditorKey;
  return mainKeys[mainKeys.length - 1] ?? null;
}

export function sideKeyOf(sideTabKey: string, hasCard: boolean): string {
  if (sideTabKey === "files" || sideTabKey === "scm" || sideTabKey === "search") return sideTabKey;
  if (sideTabKey === "card" && hasCard) return "card";
  return "changes";
}

export type SessionChoice = { id: string; title: string; workspaceId: string | null; done: boolean; feedback: boolean; updatedAt: number };

export function floatSessionChoices(agents: readonly SessionChoice[], recentIds: readonly string[], currentId: string | null, currentWorkspace: string | null, topOf: (workspaceId: string | null) => string | null, limit = 8): SessionChoice[] {
  const rank = (id: string) => {
    const i = recentIds.indexOf(id);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  const pool = agents.filter((a) => a.id !== currentId && !a.done && !a.feedback);
  const same = (a: SessionChoice) => currentWorkspace !== null && topOf(a.workspaceId) === currentWorkspace;
  return pool
    .slice()
    .sort((a, b) => Number(same(b)) - Number(same(a)) || rank(a.id) - rank(b.id) || b.updatedAt - a.updatedAt)
    .slice(0, limit);
}
