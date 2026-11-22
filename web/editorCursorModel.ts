export type CursorStyle = "line" | "block" | "underline" | "line-thin" | "block-outline" | "underline-thin";
export type CursorBlinking = "blink" | "smooth" | "phase" | "expand" | "solid";

export function screenAwareSize(pixelRatio: number, cssPixels: number): number {
  return Math.max(1, Math.floor(pixelRatio * cssPixels)) / pixelRatio;
}

export type LinePieceInput = { style: "line" | "line-thin"; widthSetting: number; charWidth: number; pixelRatio: number; left: number };

export function linePiece({ style, widthSetting, charWidth, pixelRatio, left }: LinePieceInput): { left: number; width: number } {
  const capped = Math.min(widthSetting, charWidth);
  const width = style === "line" ? screenAwareSize(pixelRatio, capped > 0 ? capped : 2) : screenAwareSize(pixelRatio, 1);
  const shift = width >= 2 && left >= 1 ? 1 : 0;
  return { left: left - shift, width };
}

export function blockWidth(char: string, measured: number | null, charWidth: number): number {
  if (char === "\t" || measured === null || measured < 1) return charWidth;
  return measured;
}

export function effectiveBlinking(blinking: CursorBlinking, readOnly: boolean): CursorBlinking {
  return readOnly ? "solid" : blinking;
}

