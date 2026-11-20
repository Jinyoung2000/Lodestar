// CSS 색 문자열을 숫자로 읽고 다시 캔버스용 문자열로 만든다. 토큰은 #rgb, #rrggbb, #rrggbbaa, rgb(), rgba() 로만 적힌다.
// 개요 눈금자와 미니맵이 같이 쓴다(둘 다 캔버스에 직접 칠해서 CSS 변수를 그대로 못 넘긴다).

export type Rgba = { r: number; g: number; b: number; a: number };

// a 는 0 에서 1
export function parseColor(input: string): Rgba | null {
  const text = input.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3,8})$/.exec(text);
  if (hex) {
    const digits = hex[1]!;
    if (digits.length === 3 || digits.length === 4) {
      const [r, g, b, a] = [...digits].map((d) => parseInt(d + d, 16));
      return { r: r!, g: g!, b: b!, a: a === undefined ? 1 : a / 255 };
    }
    if (digits.length === 6 || digits.length === 8) {
      return {
        r: parseInt(digits.slice(0, 2), 16),
        g: parseInt(digits.slice(2, 4), 16),
        b: parseInt(digits.slice(4, 6), 16),
        a: digits.length === 8 ? parseInt(digits.slice(6, 8), 16) / 255 : 1,
      };
    }
    return null;
  }
  const fn = /^rgba?\(([^)]+)\)$/.exec(text);
  if (fn) {
    const parts = fn[1]!.split(/[\s,/]+/).filter(Boolean).map((part) => (part.endsWith("%") ? parseFloat(part) / 100 : parseFloat(part)));
    if (parts.length < 3 || parts.some((n) => Number.isNaN(n))) return null;
    return { r: parts[0]!, g: parts[1]!, b: parts[2]!, a: parts[3] ?? 1 };
  }
  return null;
}

export function transparent(color: Rgba, factor: number): Rgba {
  return { ...color, a: color.a * factor };
}

export function isOpaque(color: Rgba): boolean {
  return color.a >= 1;
}

// 캔버스 fillStyle 용 문자열
export function toCanvasColor(color: Rgba): string {
  return `rgb(${Math.round(color.r)} ${Math.round(color.g)} ${Math.round(color.b)} / ${Math.round(color.a * 1000) / 1000})`; // lint-tokens: allow 캔버스 fillStyle 은 CSS 변수를 못 받아 숫자에서 문자열을 만든다
}

// bg 위에 color 를 얹은 불투명 색
export function blendOver(color: Rgba, bg: Rgba): Rgba {
  const a = color.a;
  return { r: bg.r + (color.r - bg.r) * a, g: bg.g + (color.g - bg.g) * a, b: bg.b + (color.b - bg.b) * a, a: 1 };
}
