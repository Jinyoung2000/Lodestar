import { parseDockWidth } from "./focusLayout";
import { isLayoutMode, isPinnedTab, parseRect, sameRect, separatesPinned, sideKeyOf, type FloatRect, type LayoutMode } from "./floatLayout";
import type { Pane } from "./store";

export type SessionLayout = {
  layoutMode: LayoutMode;
  floatCollapsed: boolean;
  floatRect: FloatRect | null;
  sidebarOpen: boolean;
  rightOpen: boolean;
  bottomOpen: boolean;
  sideTabKey: string;
  focusSideOpen: boolean;
  chatDockOpen: boolean;
  chatDockWidth: number | null;
};

export type SessionLayouts = Record<string, SessionLayout>;

export function sliceOf(s: SessionLayout): SessionLayout {
  return { layoutMode: s.layoutMode, floatCollapsed: s.floatCollapsed, floatRect: s.floatRect, sidebarOpen: s.sidebarOpen, rightOpen: s.rightOpen, bottomOpen: s.bottomOpen, sideTabKey: s.sideTabKey, focusSideOpen: s.focusSideOpen, chatDockOpen: s.chatDockOpen, chatDockWidth: s.chatDockWidth };
}

export function sameLayout(a: SessionLayout, b: SessionLayout): boolean {
  return a.layoutMode === b.layoutMode && a.floatCollapsed === b.floatCollapsed && sameRect(a.floatRect, b.floatRect) && a.sidebarOpen === b.sidebarOpen && a.rightOpen === b.rightOpen && a.bottomOpen === b.bottomOpen && a.sideTabKey === b.sideTabKey && a.focusSideOpen === b.focusSideOpen && a.chatDockOpen === b.chatDockOpen && a.chatDockWidth === b.chatDockWidth;
}

export function layoutKeyOf(s: { centerView: string; panes: readonly Pane[]; activePaneId: string }): string | null {
  if (s.centerView !== "sessions") return null;
  const pane = s.panes.find((p) => p.id === s.activePaneId);
  return pane?.kind === "agent" ? pane.agentId : null;
}

export type SwitchInput = {
  enabled: boolean;
  prevKey: string | null;
  prev: SessionLayout;
  key: string | null;
  current: SessionLayout;
  layouts: SessionLayouts;
};

export type SwitchResult = {
  layouts: SessionLayouts;
  apply: SessionLayout | null;
};

export function planSwitch(input: SwitchInput): SwitchResult {
  const { layouts, prevKey, key } = input;
  if (!input.enabled) return { layouts: Object.keys(layouts).length === 0 ? layouts : {}, apply: null };
  let next = layouts;
  const remember = (id: string, layout: SessionLayout) => {
    const known = next[id];
    if (!known || !sameLayout(known, layout)) next = { ...next, [id]: sliceOf(layout) };
  };
  if (prevKey !== key) {
    if (prevKey !== null) remember(prevKey, input.prev);
    if (key !== null) {
      const known = next[key];
      if (known) return { layouts: next, apply: known };
      remember(key, input.current);
    }
    return { layouts: next, apply: null };
  }
  if (key !== null) remember(key, input.current);
  return { layouts: next, apply: null };
}

export function layoutPatch(saved: SessionLayout, now: { activeTabKey: string | null; tabKeys: readonly string[]; hasCard: boolean }) {
  const sideTabKey = sideKeyOf(saved.sideTabKey, now.hasCard);
  const patch: Partial<SessionLayout> & { activeTabKey?: string } = { ...sliceOf(saved), sideTabKey };
  if (!separatesPinned({ layoutMode: saved.layoutMode, tabKeys: now.tabKeys }) && isPinnedTab(now.activeTabKey) && now.activeTabKey !== sideTabKey) patch.activeTabKey = sideTabKey;
  return patch;
}

export function pruneSessionLayouts(layouts: SessionLayouts, alive: ReadonlySet<string>): SessionLayouts {
  const ids = Object.keys(layouts);
  if (ids.every((id) => alive.has(id))) return layouts;
  return Object.fromEntries(ids.filter((id) => alive.has(id)).map((id) => [id, layouts[id]]));
}

export function dropSessionLayout(layouts: SessionLayouts, id: string): SessionLayouts {
  if (!(id in layouts)) return layouts;
  const { [id]: _gone, ...rest } = layouts;
  return rest;
}

export function sanitizeSessionLayouts(value: unknown): SessionLayouts {
  const out: SessionLayouts = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [id, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (!isLayoutMode(e.layoutMode)) continue;
    out[id] = {
      layoutMode: e.layoutMode,
      floatCollapsed: e.floatCollapsed === true,
      floatRect: parseRect(e.floatRect),
      sidebarOpen: e.sidebarOpen !== false,
      rightOpen: e.rightOpen === true,
      bottomOpen: e.bottomOpen === true,
      sideTabKey: typeof e.sideTabKey === "string" ? e.sideTabKey : "changes",
      focusSideOpen: e.focusSideOpen !== false,
      chatDockOpen: e.chatDockOpen !== false,
      chatDockWidth: parseDockWidth(e.chatDockWidth),
    };
  }
  return out;
}
