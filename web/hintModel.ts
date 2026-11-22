
export type HintRect = { left: number; top: number; right: number; bottom: number };
export type HintSize = { width: number; height: number };
export type HintSide = "above" | "below";
export type Placement = { left: number; top: number; side: HintSide };

export const HINT_MIN_MS = 2_500;
export const HINT_MAX_MS = 6_000;
const SHORT_TEXT = 40;
const READ_MS_PER_CHAR = 60;

export function hintDuration(text: string) {
  const extra = Math.max(0, text.length - SHORT_TEXT) * READ_MS_PER_CHAR;
  return Math.min(HINT_MAX_MS, HINT_MIN_MS + extra);
}

export const POINTER_FRESH_MS = 1_500;

export type AnchorInput = {
  explicit: { kind: "editor" } | { kind: "rect"; rect: HintRect } | null;
  focusInEditor: boolean;
  pointer: { rect: HintRect; at: number } | null;
  now: number;
  focused: HintRect | null;
};

export type ChosenAnchor = { kind: "explicit-editor" } | { kind: "focused-editor" } | { kind: "rect"; rect: HintRect; from: "explicit" | "pointer" | "focus" } | { kind: "window" };

export function chooseAnchor(input: AnchorInput): ChosenAnchor {
  if (input.explicit?.kind === "editor") return { kind: "explicit-editor" };
  if (input.explicit?.kind === "rect") return { kind: "rect", rect: input.explicit.rect, from: "explicit" };
  if (input.focusInEditor) return { kind: "focused-editor" };
  if (input.pointer && input.now - input.pointer.at <= POINTER_FRESH_MS && hasArea(input.pointer.rect)) return { kind: "rect", rect: input.pointer.rect, from: "pointer" };
  if (input.focused && hasArea(input.focused)) return { kind: "rect", rect: input.focused, from: "focus" };
  return { kind: "window" };
}

export function hasArea(rect: HintRect) {
  return rect.right - rect.left > 0 && rect.bottom - rect.top > 0;
}

export function windowPoint(viewport: HintSize, lift: number): HintRect {
  const x = viewport.width / 2;
  const y = viewport.height - lift;
  return { left: x, right: x, top: y, bottom: y };
}

export function placeBubble(anchor: HintRect, size: HintSize, viewport: HintSize, gap: number, margin: number): Placement {
  const center = (anchor.left + anchor.right) / 2;
  const left = Math.max(margin, Math.min(center - size.width / 2, viewport.width - margin - size.width));
  const aboveTop = anchor.top - gap - size.height;
  if (aboveTop >= margin) return { left, top: aboveTop, side: "above" };
  const belowTop = anchor.bottom + gap;
  const fitsBelow = belowTop + size.height <= viewport.height - margin;
  return { left, top: fitsBelow ? belowTop : Math.max(margin, aboveTop), side: fitsBelow ? "below" : "above" };
}

const MODIFIER_KEYS = new Set(["Meta", "Control", "Shift", "Alt", "AltGraph", "CapsLock", "Fn"]);

export function dismissesOnKey(key: string) {
  return !MODIFIER_KEYS.has(key);
}
