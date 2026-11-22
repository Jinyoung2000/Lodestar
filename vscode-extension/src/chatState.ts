
export const OPEN_IN_VALUES = ["sidebar", "editor"] as const;
export type OpenIn = (typeof OPEN_IN_VALUES)[number];
export const DEFAULT_OPEN_IN: OpenIn = "sidebar";

export function normalizeOpenIn(value: unknown): OpenIn {
  return OPEN_IN_VALUES.find((v) => v === value) ?? DEFAULT_OPEN_IN;
}

export const MAX_FRAMES = 6;

export type Frame = { key: string; agentId: string | null; workspaceId: string | null; src: string };

export function activeFrame(frames: Frame[]): Frame | null {
  return frames.at(-1) ?? null;
}

const sameTarget = (a: Frame, b: Frame) => (a.agentId ? a.agentId === b.agentId : !b.agentId && a.workspaceId === b.workspaceId);

export function showFrame(frames: Frame[], next: Frame, max = MAX_FRAMES): { frames: Frame[]; dropped: Frame[] } {
  const existing = frames.find((f) => sameTarget(f, next));
  const kept = [...frames.filter((f) => f !== existing), existing ?? next];
  const dropped = kept.slice(0, Math.max(0, kept.length - max));
  return { frames: kept.slice(dropped.length), dropped };
}

export function bindFrame(frames: Frame[], key: string, agentId: string, src: string): { frames: Frame[]; dropped: Frame[] } {
  const target = frames.find((f) => f.key === key);
  if (!target || target.agentId === agentId) return { frames, dropped: [] };
  const dropped = frames.filter((f) => f !== target && f.agentId === agentId);
  const bound: Frame = { key, agentId, workspaceId: null, src };
  const next = frames.filter((f) => !dropped.includes(f)).map((f) => (f === target ? bound : f));
  if (dropped.includes(frames.at(-1) as Frame)) next.push(...next.splice(next.indexOf(bound), 1));
  return { frames: next, dropped };
}

export function dropFrame(frames: Frame[], key: string): Frame[] {
  return frames.filter((f) => f.key !== key);
}

export function dropMissing(frames: Frame[], exists: (agentId: string) => boolean): { frames: Frame[]; dropped: Frame[] } {
  const dropped = frames.filter((f) => f.agentId !== null && !exists(f.agentId));
  return { frames: frames.filter((f) => !dropped.includes(f)), dropped };
}

export function frameTitle(frame: Frame | null, titleOf: (agentId: string) => string | undefined): string | undefined {
  if (!frame) return undefined;
  return frame.agentId ? titleOf(frame.agentId) ?? "Lodestar" : "New Session";
}

export type AttachSurface = "panel" | "sidebar";

export function pickAttachTarget(input: { openIn: OpenIn; panelFocused: boolean; panelsOpen: boolean; sidebarHasSession: boolean }): AttachSurface | null {
  if (input.panelFocused) return "panel";
  const order: AttachSurface[] = input.openIn === "editor" ? ["panel", "sidebar"] : ["sidebar", "panel"];
  return order.find((s) => (s === "panel" ? input.panelsOpen : input.sidebarHasSession)) ?? null;
}
