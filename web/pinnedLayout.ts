import type { EditorLayout } from "./editorGroups";

export const PINNED_MIN = 200;
export const PINNED_EDITOR_MIN = 480;
export const PINNED_DEFAULT = 300;
const BORDER = 1;
export const PINNED_FIT = PINNED_DEFAULT + BORDER + PINNED_EDITOR_MIN;

export type PinnedSide = "left" | "right";

export const isPinnedSide = (value: unknown): value is PinnedSide => value === "left" || value === "right";

export type PinnedPresentation = "side" | "collapsed" | "overlay";

export function pinnedRange(panel: number): { min: number; max: number } {
  return { min: PINNED_MIN, max: Math.max(PINNED_MIN, panel - BORDER - PINNED_EDITOR_MIN) };
}

export const fitsBoth = (panel: number): boolean => panel <= 0 || panel >= PINNED_MIN + BORDER + PINNED_EDITOR_MIN;

export function presentationOf(panel: number, collapsed: boolean): PinnedPresentation {
  if (!fitsBoth(panel)) return "overlay";
  return collapsed ? "collapsed" : "side";
}

export function pinnedWidth(panel: number, saved: number | null): number {
  const want = saved ?? PINNED_DEFAULT;
  if (!fitsBoth(panel)) return Math.max(0, Math.min(want, panel));
  const { min, max } = pinnedRange(panel);
  return Math.round(Math.min(Math.max(want, min), max));
}

export function parsePinnedWidth(raw: unknown): number | null {
  const n = typeof raw === "string" ? Number(raw) : raw;
  return typeof n === "number" && Number.isFinite(n) && n >= PINNED_MIN && n <= 4000 ? Math.round(n) : null;
}

export function nextPinnedState(presentation: PinnedPresentation, collapsed: boolean, drawerOpen: boolean): { collapsed: boolean; drawerOpen: boolean } {
  if (presentation === "overlay") return { collapsed, drawerOpen: !drawerOpen };
  return { collapsed: !collapsed, drawerOpen: false };
}

export const pinnedShown = (presentation: PinnedPresentation, drawerOpen: boolean): boolean => presentation === "side" || (presentation === "overlay" && drawerOpen);

export const DRAWER_SLIVER = 48;

export function snapDrawerWidth(panel: number, width: number, side: PinnedSide, groups: readonly { left: number; right: number }[]): number {
  let snapped = width;
  for (const group of groups) {
    if (side === "right") {
      const edge = panel - width;
      const visible = edge - group.left;
      if (group.right > edge && visible > 0 && visible < DRAWER_SLIVER) snapped = Math.max(snapped, panel - group.left);
    } else {
      const visible = group.right - width;
      if (group.left < width && visible > 0 && visible < DRAWER_SLIVER) snapped = Math.max(snapped, group.right);
    }
  }
  return Math.min(snapped, panel);
}

export function edgeGroupOf(layout: EditorLayout, side: PinnedSide): string {
  if (layout.type === "group") return layout.id;
  const child = layout.dir === "row" && side === "right" ? layout.children[layout.children.length - 1] : layout.children[0];
  return edgeGroupOf(child, side);
}
