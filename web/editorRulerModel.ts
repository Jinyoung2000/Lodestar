import { SearchCursor } from "@codemirror/search";
import type { EditorState } from "@codemirror/state";

export type RulerLane = 1 | 2 | 4 | 7;
export const LANE_LEFT = 1;
export const LANE_CENTER = 2;
export const LANE_RIGHT = 4;
export const LANE_FULL = 7;

export type RulerLanes = { x: number[]; w: number[] };

export function rulerLanes(canvasWidth: number): RulerLanes {
  const inner = canvasWidth - 1;
  const left = Math.floor(inner / 3);
  const right = Math.floor(inner / 3);
  const center = inner - left - right;
  const c = 1;
  const l = c + left;
  const u = c + left + center;
  return { x: [0, c, l, c, u, c, l, c], w: [0, left, center, left + center, right, left + center + right, center + right, left + center + right] };
}

export type RulerZone = { lane: RulerLane; top: number; bottom: number; color: string; z: number };
export type RulerRect = { color: string; x: number; y: number; w: number; h: number };

export const MIN_ZONE_CSS_PX = 6;
export const CURSOR_CSS_PX = 2;

export function layoutZones(zones: readonly RulerZone[], metrics: { scrollHeight: number; canvasHeight: number; dpr: number; lanes: RulerLanes }): RulerRect[] {
  const { scrollHeight, canvasHeight, dpr, lanes } = metrics;
  if (scrollHeight <= 0 || canvasHeight <= 0) return [];
  const ratio = canvasHeight / scrollHeight;
  const minHeight = (MIN_ZONE_CSS_PX * dpr) | 0;
  const half = (minHeight / 2) | 0;
  const groups = new Map<string, RulerZone[]>();
  for (const zone of zones) {
    const key = `${zone.z}\u0000${zone.color}`;
    const list = groups.get(key);
    if (list) list.push(zone);
    else groups.set(key, [zone]);
  }
  const ordered = [...groups.values()].sort((a, b) => a[0]!.z - b[0]!.z || (a[0]!.color < b[0]!.color ? -1 : a[0]!.color > b[0]!.color ? 1 : 0));
  const rects: RulerRect[] = [];
  for (const group of ordered) {
    group.sort((a, b) => a.lane - b.lane || a.top - b.top);
    const color = group[0]!.color;
    let lane = 0;
    let start = 0;
    let end = 0;
    group.forEach((zone, index) => {
      let y1 = (zone.top * ratio) | 0;
      let y2 = (zone.bottom * ratio) | 0;
      if (y2 - y1 < minHeight) {
        let middle = ((y1 + y2) / 2) | 0;
        if (middle < half) middle = half;
        else if (middle + half > canvasHeight) middle = canvasHeight - half;
        y1 = middle - half;
        y2 = middle + half;
      }
      if (y1 > end + 1 || zone.lane !== lane) {
        if (index !== 0) rects.push({ color, x: lanes.x[lane]!, y: start, w: lanes.w[lane]!, h: end - start });
        lane = zone.lane;
        start = y1;
        end = y2;
      } else if (y2 > end) end = y2;
    });
    rects.push({ color, x: lanes.x[lane]!, y: start, w: lanes.w[lane]!, h: end - start });
  }
  return rects;
}

export function layoutCursors(cursors: readonly { top: number; color: string }[], metrics: { scrollHeight: number; canvasHeight: number; dpr: number; lanes: RulerLanes }): RulerRect[] {
  const { scrollHeight, canvasHeight, dpr, lanes } = metrics;
  if (scrollHeight <= 0 || canvasHeight <= 0) return [];
  const ratio = canvasHeight / scrollHeight;
  const height = (CURSOR_CSS_PX * dpr) | 0;
  const half = (height / 2) | 0;
  const rects: RulerRect[] = [];
  let start = -100;
  let end = -100;
  let color: string | null = null;
  cursors.forEach((cursor, index) => {
    let y = (cursor.top * ratio) | 0;
    if (y < half) y = half;
    else if (y + half > canvasHeight) y = canvasHeight - half;
    const y1 = y - half;
    const y2 = y1 + height;
    if (y1 > end + 1 || cursor.color !== color) {
      if (index !== 0 && color) rects.push({ color, x: lanes.x[LANE_FULL]!, y: start, w: lanes.w[LANE_FULL]!, h: end - start });
      start = y1;
      end = y2;
    } else if (y2 > end) end = y2;
    color = cursor.color;
  });
  if (color) rects.push({ color, x: lanes.x[LANE_FULL]!, y: start, w: lanes.w[LANE_FULL]!, h: end - start });
  return rects;
}

export const MIN_SLIDER = 20;

export type SliderMetrics = { needed: boolean; size: number; position: number; ratio: number; track: number };

export function sliderMetrics(input: { visible: number; scrollSize: number; scrollPosition: number; oppositeSize: number }): SliderMetrics {
  const { visible, scrollSize, scrollPosition, oppositeSize } = input;
  const track = Math.max(0, Math.round(visible) - Math.round(oppositeSize));
  if (!(scrollSize > 0 && scrollSize > visible)) return { needed: false, size: track, position: 0, ratio: 0, track };
  const size = Math.round(Math.max(MIN_SLIDER, Math.floor((visible * track) / scrollSize)));
  const ratio = (track - size) / (scrollSize - visible);
  return { needed: true, size, position: Math.round(scrollPosition * ratio), ratio, track };
}

export function scrollFromOffset(metrics: SliderMetrics, offset: number): number {
  if (!metrics.needed || metrics.ratio === 0) return 0;
  return Math.round((offset - metrics.size / 2) / metrics.ratio);
}

export function scrollFromDelta(metrics: SliderMetrics, startScroll: number, delta: number): number {
  if (!metrics.needed || metrics.ratio === 0) return startScroll;
  return Math.round(startScroll + delta / metrics.ratio);
}

export function overSlider(metrics: SliderMetrics, offset: number): boolean {
  return metrics.needed && offset >= metrics.position && offset <= metrics.position + metrics.size;
}

export const SELECTION_MATCH_MAX_LENGTH = 200;
export const SELECTION_MATCH_LIMIT = 2000;
const SELECTION_SCAN_MAX_CHARS = 4_000_000;

export function selectionMatches(state: EditorState, limit = SELECTION_MATCH_LIMIT): { from: number; to: number }[] {
  const selection = state.selection;
  if (selection.ranges.length > 1) return [];
  const range = selection.main;
  const length = range.to - range.from;
  if (range.empty || length < 1 || length > SELECTION_MATCH_MAX_LENGTH || state.doc.length > SELECTION_SCAN_MAX_CHARS) return [];
  const query = state.sliceDoc(range.from, range.to);
  if (!query) return [];
  const found: { from: number; to: number }[] = [];
  const cursor = new SearchCursor(state.doc, query);
  while (!cursor.next().done) {
    const { from, to } = cursor.value;
    if (from >= range.to || to <= range.from) found.push({ from, to });
    if (found.length >= limit) break;
  }
  return found;
}

export type DiagnosticSeverity = "error" | "warning" | "info" | "hint";
export const SEVERITY_Z: Record<Exclude<DiagnosticSeverity, "hint">, number> = { info: 10, warning: 20, error: 30 };
