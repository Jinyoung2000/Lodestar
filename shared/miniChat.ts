
export type Rect = { x: number; y: number; width: number; height: number };

export type MiniMode = "launcher" | "chat";

export type MiniState = { mode: MiniMode; agentId: string | null };

export const MINI_INITIAL: MiniState = { mode: "launcher", agentId: null };

export const modeFor = (agentId: string | null): MiniMode => (agentId ? "chat" : "launcher");

export function stateFor(agentId: string | null): MiniState {
  return { mode: modeFor(agentId), agentId };
}

export function miniUrl(base: string, agentId: string | null, theme?: "dark" | "light"): string {
  const suffix = theme ? `&theme=${theme}` : "";
  if (!agentId) return `${base}/?view=quick${suffix}`;
  return `${base}/?embed=session&agent=${encodeURIComponent(agentId)}&mini=1${suffix}`;
}

export type SendOutcome = { state: MiniState; hide: boolean };

export function afterSend(agentId: string, stay: boolean): SendOutcome {
  return { state: stateFor(agentId), hide: stay };
}

export const afterNew = (): MiniState => MINI_INITIAL;

export type BlurInput = {
  mode: MiniMode;
  pinned: boolean;
  inactive: boolean;
  sinceShownMs: number;
  guardMs: number;
};

export function blurAction(input: BlurInput): "hide" | "keep" {
  if (input.inactive) return "keep";
  if (input.sinceShownMs <= input.guardMs) return "keep";
  if (input.mode === "chat" && input.pinned) return "keep";
  return "hide";
}

export const pinnedFromSetting = (hideOnBlur: boolean | undefined): boolean => hideOnBlur !== true;

export type NotifyInput = { agentId: string; miniAgentId: string | null; miniVisible: boolean };

export function notificationTarget(input: NotifyInput): "suppress" | "mini" | "default" {
  if (!input.miniAgentId || input.agentId !== input.miniAgentId) return "default";
  return input.miniVisible ? "suppress" : "mini";
}

export type MiniSaved = { bounds: Rect | null; agentId: string | null };

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function parseMiniSaved(raw: string | null): MiniSaved {
  try {
    const value = JSON.parse(raw ?? "null") as { bounds?: Partial<Rect> | null; agentId?: unknown } | null;
    const b = value?.bounds;
    const bounds = b && num(b.x) && num(b.y) && num(b.width) && num(b.height) && b.width >= 1 && b.height >= 1 ? { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) } : null;
    return { bounds, agentId: typeof value?.agentId === "string" && value.agentId !== "" ? value.agentId : null };
  } catch {
    return { bounds: null, agentId: null };
  }
}

export const serializeMiniSaved = (saved: MiniSaved): string => JSON.stringify({ bounds: saved.bounds, agentId: saved.agentId });

export type Size = { width: number; height: number };

function overlap(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

export function fitChatBounds(saved: Rect, areas: readonly Rect[], fallback: Rect, min: Size): Rect {
  const best = areas.reduce<{ area: Rect; score: number } | null>((acc, area) => {
    const score = overlap(saved, area);
    return !acc || score > acc.score ? { area, score } : acc;
  }, null);
  const area = best && best.score > 0 ? best.area : fallback;
  const width = Math.min(Math.max(saved.width, Math.min(min.width, area.width)), area.width);
  const height = Math.min(Math.max(saved.height, Math.min(min.height, area.height)), area.height);
  const x = Math.max(area.x, Math.min(saved.x, area.x + area.width - width));
  const y = Math.max(area.y, Math.min(saved.y, area.y + area.height - height));
  return { x, y, width, height };
}

export function growFromBar(bar: Rect, size: Size, area: Rect): Rect {
  const width = Math.min(size.width, area.width);
  const height = Math.min(size.height, area.height);
  const x = Math.max(area.x, Math.min(Math.round(bar.x + bar.width / 2 - width / 2), area.x + area.width - width));
  const y = Math.max(area.y, Math.min(bar.y, area.y + area.height - height));
  return { x, y, width, height };
}

export function barFromChat(chat: Rect, size: Size, area: Rect): Rect {
  const width = Math.min(size.width, area.width);
  const height = Math.min(size.height, area.height);
  const x = Math.max(area.x, Math.min(Math.round(chat.x + chat.width / 2 - width / 2), area.x + area.width - width));
  const y = Math.max(area.y, Math.min(chat.y, area.y + area.height - height));
  return { x, y, width, height };
}

export const sameRect = (a: Rect | null, b: Rect | null): boolean => !!a && !!b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
