import { MINIMAP_GLYPHS } from "./editorMinimapGlyphs";

// 줄 왼쪽의 빈 칸(장치 픽셀). 폭 계산과 그리기가 같은 값을 쓴다.
export const MINIMAP_PAD = 8;
// editor.minimap.maxColumn, scale 기본값
export const MINIMAP_MAX_COLUMN = 120;
export const MINIMAP_SCALE = 1;

export type MinimapLayout = {
  // 0 이면 그리지 않는다. 글자를 그리면 1, 색 막대로 그리면 2.
  renderMinimap: 0 | 1 | 2;
  minimapLeft: number;
  minimapWidth: number;
  minimapScale: 1 | 2;
  // 줄 하나의 장치 픽셀 높이(글자 2*scale, 막대 3*scale)
  minimapLineHeight: number;
  canvasInnerWidth: number;
  canvasInnerHeight: number;
  canvasOuterWidth: number;
  canvasOuterHeight: number;
};

export type MinimapLayoutInput = {
  // 에디터 전체 폭과 높이(CSS 픽셀). 폭은 세로 스크롤바를 포함한다.
  outerWidth: number;
  outerHeight: number;
  pixelRatio: number;
  // 줄번호 열과 거터를 뺀 폭
  remainingWidth: number;
  // 영문자 한 칸 폭(typicalHalfwidthCharacterWidth)
  charWidth: number;
  verticalScrollbarWidth: number;
  renderCharacters: boolean;
};

export function minimapLayout(input: MinimapLayoutInput): MinimapLayout {
  const { outerWidth, outerHeight, pixelRatio: dpr, remainingWidth, charWidth, verticalScrollbarWidth, renderCharacters } = input;
  const scale = (dpr >= 2 ? Math.round(MINIMAP_SCALE * 2) : MINIMAP_SCALE) as 1 | 2;
  const charRows = renderCharacters ? 2 : 3;
  const canvasInnerHeight = Math.floor(dpr * outerHeight);
  const canvasOuterHeight = canvasInnerHeight / dpr;
  const lineHeight = charRows * scale;
  const unit = scale / dpr;
  const maxWidth = Math.floor(MINIMAP_MAX_COLUMN * unit);
  const minimapWidth = Math.min(maxWidth, Math.max(0, Math.floor(((remainingWidth - verticalScrollbarWidth - 2) * unit) / (charWidth + unit))) + MINIMAP_PAD);
  const canvasInnerWidth = Math.floor(dpr * minimapWidth);
  return {
    renderMinimap: renderCharacters ? 1 : 2,
    minimapLeft: outerWidth - minimapWidth - verticalScrollbarWidth,
    minimapWidth,
    minimapScale: scale,
    minimapLineHeight: lineHeight,
    canvasInnerWidth,
    canvasInnerHeight,
    canvasOuterWidth: canvasInnerWidth / dpr,
    canvasOuterHeight,
  };
}

export function minimapUsable(layout: MinimapLayout): boolean {
  return layout.minimapWidth > MINIMAP_PAD && layout.canvasInnerWidth > MINIMAP_PAD && layout.canvasInnerHeight > 0;
}

// --- 보이는 줄 범위와 슬라이더 ---

export type RenderLayout = {
  scrollTop: number;
  scrollHeight: number;
  sliderNeeded: boolean;
  sliderRatio: number;
  sliderTop: number;
  sliderHeight: number;
  topPaddingLineCount: number;
  startLineNumber: number;
  endLineNumber: number;
};

export type RenderLayoutInput = {
  pixelRatio: number;
  minimapLineHeight: number;
  canvasInnerHeight: number;
  // 에디터 줄 높이(CSS 픽셀)와 에디터 보이는 높이
  lineHeight: number;
  editorHeight: number;
  scrollBeyondLastLine: boolean;
  // 화면 맨 위 줄과 맨 아래 줄(1부터), 맨 위 줄의 문서 안 세로 위치
  viewportStartLine: number;
  viewportEndLine: number;
  viewportStartLineTop: number;
  lineCount: number;
  scrollTop: number;
  scrollHeight: number;
};

// mUi.create 의 proportional 경로(paddingTop, paddingBottom 은 0). previous 는 직전에 그린 배치로, 스크롤 방향이 바뀌어도 범위가 흔들리지 않게 한다.
export function renderLayout(o: RenderLayoutInput, previous: RenderLayout | null): RenderLayout {
  const { pixelRatio: dpr, minimapLineHeight: g, lineHeight: v, editorHeight: n, lineCount: a, scrollTop: l, scrollHeight: u } = o;
  const f = Math.floor(o.canvasInnerHeight / g);
  const sliderHeight = Math.floor(((n / v) * g) / dpr);
  let bottomPadding = 0;
  if (o.scrollBeyondLastLine) bottomPadding = Math.max(bottomPadding, n / v - 1);
  let travel = bottomPadding > 0 ? ((a + bottomPadding - n / v - 1) * g) / dpr : Math.max(0, (a * g) / dpr - sliderHeight);
  travel = Math.min(n - sliderHeight, travel);
  const ratio = u - n === 0 ? 0 : travel / (u - n);
  const sliderTop = l * ratio;
  if (f >= a + bottomPadding) {
    return { scrollTop: l, scrollHeight: u, sliderNeeded: travel > 0, sliderRatio: ratio, sliderTop, sliderHeight, topPaddingLineCount: 0, startLineNumber: 1, endLineNumber: a };
  }
  const e = o.viewportStartLine;
  const anchor = e > 1 ? e : Math.max(1, l / v);
  let start = Math.max(1, Math.floor(anchor - (sliderTop * dpr) / g));
  let topPadding = 0;
  if (previous && previous.scrollHeight === u) {
    if (previous.scrollTop > l) {
      start = Math.min(start, previous.startLineNumber);
      topPadding = Math.max(topPadding, previous.topPaddingLineCount);
    }
    if (previous.scrollTop < l) {
      start = Math.max(start, previous.startLineNumber);
      topPadding = Math.min(topPadding, previous.topPaddingLineCount);
    }
  }
  const end = Math.min(a, start - topPadding + f - 1);
  const offsetInLine = (l - o.viewportStartLineTop) / v;
  const top = ((e - start + topPadding + offsetInLine) * g) / dpr;
  return { scrollTop: l, scrollHeight: u, sliderNeeded: true, sliderRatio: ratio, sliderTop: top, sliderHeight, topPaddingLineCount: topPadding, startLineNumber: start, endLineNumber: end };
}

export function yForLine(layout: RenderLayout, line: number, lineHeight: number): number {
  return (line - layout.startLineNumber + layout.topPaddingLineCount) * lineHeight;
}

// 슬라이더를 delta(CSS 픽셀)만큼 끌었을 때의 스크롤 위치
export function scrollTopFromSliderDelta(layout: RenderLayout, delta: number): number {
  if (layout.sliderRatio === 0) return layout.scrollTop;
  return Math.round(layout.scrollTop + delta / layout.sliderRatio);
}

// 미니맵 위 offsetY(CSS 픽셀)에 있는 줄. 눌러서 그 줄을 가운데로 보낼 때 쓴다.
export function lineAtOffset(layout: RenderLayout, o: { canvasInnerHeight: number; canvasOuterHeight: number; minimapLineHeight: number; lineCount: number }, offsetY: number): number {
  const inner = (o.canvasInnerHeight / o.canvasOuterHeight) * offsetY;
  const line = Math.floor(inner / o.minimapLineHeight) + layout.startLineNumber - layout.topPaddingLineCount;
  return Math.max(1, Math.min(line, o.lineCount));
}

// --- 글자 그리기 ---

export type Rgb = { r: number; g: number; b: number };
export type ImageLike = { data: Uint8ClampedArray; width: number; height: number };

// Tut.soften: 어두운 배경은 12/15, 밝은 배경은 50/60 배 한다(소수는 버림)
const soften = (table: Uint8ClampedArray, factor: number) => Uint8ClampedArray.from(table, (value) => Math.min(255, Math.max(0, (value * factor) | 0)));
const NORMAL = { 1: soften(MINIMAP_GLYPHS[1], 12 / 15), 2: soften(MINIMAP_GLYPHS[2], 12 / 15) };
const LIGHT = { 1: soften(MINIMAP_GLYPHS[1], 50 / 60), 2: soften(MINIMAP_GLYPHS[2], 50 / 60) };

// iKo: 도감 칸 번호. ASCII 밖의 글자는 (코드 - 32 + 96) % 96 으로 아무 칸에 섞고(scale 2 이하), 그보다 큰 scale 이면 마지막 칸(U+FFFD)
export function glyphIndex(code: number, scale: number): number {
  const index = code - 32;
  if (index < 0 || index > 96) return scale <= 2 ? (index + 96) % 96 : 95;
  return index;
}

// cy: 폭 2칸으로 세는 글자(한중일 문자, 전각 형태)
export function isFullWidthCode(code: number): boolean {
  return (code >= 11904 && code <= 55215) || (code >= 63744 && code <= 64255) || (code >= 65281 && code <= 65374) || (code >= 65504 && code <= 65510);
}

// 글자 한 칸(가로 scale, 세로 2*scale 장치 픽셀). oneRow 는 줄 높이가 1 일 때 윗줄만 그린다.
export function renderGlyph(img: ImageLike, x: number, y: number, code: number, fg: Rgb, fgAlpha: number, bg: Rgb, bgAlpha: number, scale: 1 | 2, bgIsLight: boolean, oneRow: boolean) {
  const cols = scale;
  const height = 2 * scale;
  const rows = oneRow ? 1 : height;
  if (x + cols > img.width || y + rows > img.height) return;
  const table = (bgIsLight ? LIGHT : NORMAL)[scale];
  let source = glyphIndex(code, scale) * cols * height;
  const stride = img.width * 4;
  const alpha = Math.max(fgAlpha, bgAlpha);
  let row = y * stride + x * 4;
  for (let r = 0; r < rows; r++) {
    let p = row;
    for (let c = 0; c < cols; c++) {
      const t = (table[source++]! / 255) * (fgAlpha / 255);
      img.data[p++] = bg.r + (fg.r - bg.r) * t;
      img.data[p++] = bg.g + (fg.g - bg.g) * t;
      img.data[p++] = bg.b + (fg.b - bg.b) * t;
      img.data[p++] = alpha;
    }
    row += stride;
  }
}

// 색 막대 모드(renderCharacters 끔): 글자 칸을 배경과 글자색의 절반 섞은 색으로 채운다
export function renderBlock(img: ImageLike, x: number, y: number, fg: Rgb, fgAlpha: number, bg: Rgb, bgAlpha: number, scale: 1 | 2, oneRow: boolean) {
  const cols = scale;
  const rows = oneRow ? 1 : 2 * scale;
  if (x + cols > img.width || y + rows > img.height) return;
  const mix = 0.5 * (fgAlpha / 255);
  const r = bg.r + (fg.r - bg.r) * mix;
  const g = bg.g + (fg.g - bg.g) * mix;
  const b = bg.b + (fg.b - bg.b) * mix;
  const alpha = Math.max(fgAlpha, bgAlpha);
  const stride = img.width * 4;
  let row = y * stride + x * 4;
  for (let rr = 0; rr < rows; rr++) {
    let p = row;
    for (let c = 0; c < cols; c++) {
      img.data[p++] = r;
      img.data[p++] = g;
      img.data[p++] = b;
      img.data[p++] = alpha;
    }
    row += stride;
  }
}

export type LineRun = { end: number; color: Rgb };

export type RenderLineInput = {
  mode: 1 | 2;
  scale: 1 | 2;
  bg: Rgb;
  bgAlpha: number;
  bgIsLight: boolean;
  fgAlpha: number;
  // 한 글자의 가로 장치 픽셀(1 * scale)
  charWidth: number;
  // 이 줄이 시작하는 y(장치 픽셀)
  y: number;
  tabSize: number;
  lineHeight: number;
  text: string;
  runs: readonly LineRun[];
};

// fUi._renderLine. 줄 안의 글자를 차례로 놓고 탭은 탭 정지점까지, 공백은 건너뛰고, 오른쪽 끝을 넘으면 멈춘다.
export function renderMinimapLine(img: ImageLike, p: RenderLineInput) {
  const limit = img.width - p.charWidth;
  const oneRow = p.lineHeight === 1;
  const glyphRows = (p.mode === 1 ? 2 : 3) * p.scale;
  const centering = p.lineHeight > glyphRows ? Math.floor((p.lineHeight - glyphRows) / 2) : 0;
  const y = p.y + centering;
  let x = MINIMAP_PAD;
  let index = 0;
  let tabAdjust = 0;
  for (const run of p.runs) {
    for (; index < run.end; index++) {
      if (x > limit) return;
      const code = p.text.charCodeAt(index);
      if (code === 9) {
        const stop = p.tabSize - ((index + tabAdjust) % p.tabSize);
        tabAdjust += stop - 1;
        x += stop * p.charWidth;
      } else if (code === 32) x += p.charWidth;
      else {
        const cells = isFullWidthCode(code) ? 2 : 1;
        for (let cell = 0; cell < cells; cell++) {
          if (p.mode === 2) renderBlock(img, x, y, run.color, p.fgAlpha, p.bg, p.bgAlpha, p.scale, oneRow);
          else renderGlyph(img, x, y, code, run.color, p.fgAlpha, p.bg, p.bgAlpha, p.scale, p.bgIsLight, oneRow);
          x += p.charWidth;
          if (x > limit) return;
        }
      }
    }
  }
}

// --- 장식(선택, 찾기, 진단)의 가로 위치 ---

// getXOffsetForPosition 의 줄별 표: offsets[column - 1] 이 column(1부터)의 x. 탭은 tabSize 칸, 전각은 2칸, 폭을 넘으면 폭에서 멈춘다.
export function lineOffsets(text: string, tabSize: number, charWidth: number, canvasWidth: number): number[] {
  const offsets = [MINIMAP_PAD];
  let x = MINIMAP_PAD;
  for (let i = 1; i < text.length + 1; i++) {
    const code = text.charCodeAt(i - 1);
    const advance = code === 9 ? tabSize * charWidth : isFullWidthCode(code) ? 2 * charWidth : charWidth;
    const next = x + advance;
    if (next >= canvasWidth) {
      offsets[i] = canvasWidth;
      break;
    }
    offsets[i] = next;
    x = next;
  }
  return offsets;
}

export function xForColumn(offsets: readonly number[], column: number, charWidth: number, canvasWidth: number): number {
  if (column === 1) return MINIMAP_PAD;
  if ((column - 1) * charWidth >= canvasWidth) return canvasWidth;
  return column - 1 < offsets.length ? offsets[column - 1]! : canvasWidth;
}

// --- 구문 색 구간 ---

export type Span = { from: number; to: number; cls: string };

// 위에서 아래로 정렬된 구문 구간(highlightTree 가 낸 순서)에서 한 줄의 색 구간을 만든다. cls "" 는 기본 글자색이고 구간들이 줄 끝(lineTo - lineFrom)까지 이어진다.
// 호출은 줄 번호 순서로 하며 cursor 가 구간 목록 위의 읽기 위치를 이어 간다.
export function lineRuns(spans: readonly Span[], cursor: { index: number }, lineFrom: number, lineTo: number): { end: number; cls: string }[] {
  const runs: { end: number; cls: string }[] = [];
  const length = lineTo - lineFrom;
  while (cursor.index < spans.length && spans[cursor.index]!.to <= lineFrom) cursor.index++;
  let position = 0;
  for (let i = cursor.index; i < spans.length && position < length; i++) {
    const span = spans[i]!;
    if (span.from >= lineTo) break;
    const from = Math.max(span.from - lineFrom, 0);
    const to = Math.min(span.to - lineFrom, length);
    if (to <= position) continue;
    if (from > position) runs.push({ end: from, cls: "" });
    runs.push({ end: to, cls: span.cls });
    position = to;
  }
  if (position < length || runs.length === 0) runs.push({ end: length, cls: "" });
  return runs;
}

export function backgroundIsLight(bg: Rgb): boolean {
  const channel = (value: number) => {
    const s = value / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(bg.r) + 0.7152 * channel(bg.g) + 0.0722 * channel(bg.b) >= 0.5;
}
