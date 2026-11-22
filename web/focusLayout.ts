
export type ChatDock = "docked" | "floating";

export const isChatDock = (value: unknown): value is ChatDock => value === "docked" || value === "floating";

export const chatDockOf = (value: unknown): ChatDock => (value === "floating" ? "floating" : "docked");

export type FocusView = "files" | "changes" | "scm" | "search" | "card";

export const FOCUS_VIEWS: readonly FocusView[] = ["files", "changes", "scm", "search"];

export function pressActivity(open: boolean, current: string, pressed: string): { open: boolean; view: string } {
  if (open && current === pressed) return { open: false, view: current };
  return { open: true, view: pressed };
}

export function chatHiddenInEditor(s: { chatDock: ChatDock; floatCollapsed: boolean; chatDockOpen: boolean }): boolean {
  return s.chatDock === "floating" ? s.floatCollapsed : !s.chatDockOpen;
}

export const ACTIVITY_BAR = 48;
export const FOCUS_SIDE_DEFAULT = 300;
export const FOCUS_SIDE_MIN = 200;
export const FOCUS_SIDE_MAX = 600;
export const DOCK_DEFAULT = 420;
export const DOCK_MIN = 320;
export const EDITOR_MIN = 320;
const BORDER = 1;

const clamp = (value: number, min: number, max: number) => Math.round(Math.min(Math.max(value, min), Math.max(min, max)));

export function dockRange(center: number): { min: number; max: number } {
  return { min: DOCK_MIN, max: Math.max(DOCK_MIN, center - EDITOR_MIN - BORDER) };
}

export const DOCK_FIT_CHARS = 44;

export function dockFitWidth(charPx: number, padPx: number, center: number): number {
  const { min, max } = dockRange(center);
  return clamp(charPx * DOCK_FIT_CHARS + padPx + BORDER, min, max);
}

export function dockWidth(saved: number | null, center: number): number {
  const want = saved ?? DOCK_DEFAULT;
  if (center <= 0) return want;
  const { min, max } = dockRange(center);
  return clamp(want, min, max);
}

export function parseDockWidth(raw: unknown): number | null {
  const n = typeof raw === "string" ? Number(raw) : raw;
  return typeof n === "number" && Number.isFinite(n) && n >= DOCK_MIN && n <= 4000 ? Math.round(n) : null;
}

export function focusSideRange(body: number, dock: number): { min: number; max: number } {
  const free = body - ACTIVITY_BAR - BORDER - dock - EDITOR_MIN - (dock > 0 ? BORDER : 0);
  return { min: FOCUS_SIDE_MIN, max: Math.max(FOCUS_SIDE_MIN, Math.min(FOCUS_SIDE_MAX, free)) };
}

export function focusSideWidth(saved: number | null, body: number, dock: number): number {
  const want = saved ?? FOCUS_SIDE_DEFAULT;
  if (body <= 0) return want;
  const { min, max } = focusSideRange(body, dock);
  return clamp(want, min, max);
}

export function parseFocusSideWidth(raw: unknown): number | null {
  const n = typeof raw === "string" ? Number(raw) : raw;
  return typeof n === "number" && Number.isFinite(n) && n >= FOCUS_SIDE_MIN && n <= 4000 ? Math.round(n) : null;
}

export type FocusShown = { side: boolean; dock: boolean; floating: boolean };

export function focusShown(input: { editorLayout: boolean; sessionsView: boolean; chatDock: ChatDock; sideOpen: boolean; dockOpen: boolean }): FocusShown {
  if (!input.editorLayout || !input.sessionsView) return { side: false, dock: false, floating: false };
  return { side: input.sideOpen, dock: input.chatDock === "docked" && input.dockOpen, floating: input.chatDock === "floating" };
}
