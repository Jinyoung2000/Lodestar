export type CursorStyle = "line" | "block" | "underline" | "line-thin" | "block-outline" | "underline-thin";
export type CursorBlinking = "blink" | "smooth" | "phase" | "expand" | "solid";

// 화면 배율에 맞춰 CSS 크기를 장치 픽셀로 내림하되 한 장치 픽셀보다 작아지지 않게 한다(번들 computeScreenAwareSize).
export function screenAwareSize(pixelRatio: number, cssPixels: number): number {
  return Math.max(1, Math.floor(pixelRatio * cssPixels)) / pixelRatio;
}

export type LinePieceInput = { style: "line" | "line-thin"; widthSetting: number; charWidth: number; pixelRatio: number; left: number };

// 세로선 커서의 폭과 왼쪽 위치. 설정 0 이면 2px, 글자 폭보다 넓게는 못 한다. 폭이 2 이상이면 글자 경계에서 1px 왼쪽으로 당긴다.
export function linePiece({ style, widthSetting, charWidth, pixelRatio, left }: LinePieceInput): { left: number; width: number } {
  const capped = Math.min(widthSetting, charWidth);
  const width = style === "line" ? screenAwareSize(pixelRatio, capped > 0 ? capped : 2) : screenAwareSize(pixelRatio, 1);
  const shift = width >= 2 && left >= 1 ? 1 : 0;
  return { left: left - shift, width };
}

// 블록, 밑줄 커서의 폭: 그 자리 글자의 폭. 탭이거나 너무 좁으면(줄 끝) 글자 평균 폭.
export function blockWidth(char: string, measured: number | null, charWidth: number): number {
  if (char === "\t" || measured === null || measured < 1) return charWidth;
  return measured;
}

// 깜빡임 방식. 읽기 전용 에디터는 늘 solid.
export function effectiveBlinking(blinking: CursorBlinking, readOnly: boolean): CursorBlinking {
  return readOnly ? "solid" : blinking;
}

// 커서가 바뀐 뒤 깜빡이기 시작하기까지 고정으로 보이는 시간(번들 BLINK_INTERVAL)
export const CURSOR_BLINK_INTERVAL_MS = 500;
