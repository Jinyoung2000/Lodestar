import { PANE_MIN } from "./paneDrop";


const DIVIDER = 1;
const SINGLE_PANE_MIN = 300;

export function paneMin(singleColumn: boolean): number {
  return singleColumn ? SINGLE_PANE_MIN : PANE_MIN;
}

export function rowMinWidth(cols: number, min = PANE_MIN): number {
  return cols <= 0 ? 0 : cols * min + (cols - 1) * DIVIDER;
}

export function panesMinWidth(colsPerRow: number[], min = PANE_MIN): number {
  return colsPerRow.reduce((most, cols) => Math.max(most, rowMinWidth(cols, min)), 0);
}

export function stretchedMin(min: number, region: number, colsPerRow: number[]): number {
  if (region <= 0 || panesMinWidth(colsPerRow, min) <= region) return min;
  const fit = Math.max(1, Math.floor((region + DIVIDER) / (min + DIVIDER)));
  return Math.max(min, Math.floor((region - (fit - 1) * DIVIDER) / fit));
}

export const RIGHT_FLOOR = 200;

export type RightRangeInput = {
  center: number;
  sideChat: number;
  panesReserve: number;
  squeezeReserve: number;
  narrow: number;
};

export function rightRange({ center, sideChat, panesReserve, squeezeReserve, narrow }: RightRangeInput): { min: number; max: number } {
  const free = center - sideChat;
  const min = Math.max(RIGHT_FLOOR, Math.min(narrow, free - squeezeReserve));
  const max = Math.max(min, free - panesReserve);
  return { min, max };
}

export type PanesFit = { panes: number; scrolls: boolean; each: number };

export function panesFit(center: number, sideChat: number, right: number, colsPerRow: number[], min = PANE_MIN): PanesFit {
  const panes = Math.max(0, center - sideChat - right);
  const need = panesMinWidth(colsPerRow, min);
  const most = colsPerRow.reduce((m, c) => Math.max(m, c), 0);
  const each = most ? (Math.max(panes, need) - (most - 1) * DIVIDER) / most : 0;
  return { panes, scrolls: need > panes, each };
}

export function sidebarMax(body: number, rightOpenMin: number, floor: number, hardMax: number, min: number): number {
  return Math.max(min, Math.min(hardMax, body - floor - rightOpenMin));
}
