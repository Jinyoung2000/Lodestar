import { PANE_MIN } from "./paneDrop";


const DIVIDER = 1; // 칸 사이 경계선 칸 폭(PaneGrid)
const SINGLE_PANE_MIN = 300;

// 칸 최소 폭. 열이 여러 개면 --size-chat-min(PANE_MIN), 열이 하나뿐이면 --size-chat-floor.
export function paneMin(singleColumn: boolean): number {
  return singleColumn ? SINGLE_PANE_MIN : PANE_MIN;
}

// 한 행에 칸이 cols 개일 때 그 행이 차지해야 하는 최소 폭.
export function rowMinWidth(cols: number, min = PANE_MIN): number {
  return cols <= 0 ? 0 : cols * min + (cols - 1) * DIVIDER;
}

// 칸 영역 전체의 최소 폭: 가장 칸이 많은 행 기준.
export function panesMinWidth(colsPerRow: number[], min = PANE_MIN): number {
  return colsPerRow.reduce((most, cols) => Math.max(most, rowMinWidth(cols, min)), 0);
}

// 칸 영역(region 폭)에 칸들의 최소 폭 합이 안 들어가 가로로 스크롤될 때, 한 화면에 온전히 들어가는 칸 수(fit)만큼으로 칸 폭을 키워 칸 영역을 꽉 채운다.
// 모든 칸이 같은 폭이면 스크롤 위치가 늘 칸 경계가 되어 왼쪽 가장자리에 잘린 칸이 생기지 않는다(잘리는 칸은 오른쪽 끝에만). 들어가면 최소 폭 그대로다.
export function stretchedMin(min: number, region: number, colsPerRow: number[]): number {
  if (region <= 0 || panesMinWidth(colsPerRow, min) <= region) return min;
  const fit = Math.max(1, Math.floor((region + DIVIDER) / (min + DIVIDER)));
  return Math.max(min, Math.floor((region - (fit - 1) * DIVIDER) / fit));
}

// 오른쪽 패널이 어떤 창 폭에서도 이 아래로는 줄지 않는다. 더 줄면 안의 에디터 그룹과 탭이 글자 단위로 쪼개진다(round-3 발견 2, 4 후속). --size-pinned-min 과 같은 값이다.
export const RIGHT_FLOOR = 200;

export type RightRangeInput = {
  center: number; // .center 폭
  sideChat: number; // /btw 곁다리 대화 폭(없으면 0)
  panesReserve: number; // 오른쪽 패널 너머로 칸 영역에 남겨야 하는 폭(넓힐 때의 하한)
  squeezeReserve: number; // 오른쪽 패널이 자기 최소(narrow)보다 줄어들 때 칸이 지켜야 하는 폭
  narrow: number; // 오른쪽 패널 최소 폭(--size-panel-narrow)
};

// 오른쪽 패널 폭의 범위. styles.css 의 `.right` min-width, max-width 와 같은 식이다.
// min: 창이 아주 좁으면 narrow 아래로도 줄어 칸 하나(squeezeReserve)를 지키되, RIGHT_FLOOR 아래로는 가지 않는다(그 경우 칸 영역이 스크롤된다).
// max: 칸들의 최소 폭 합(panesReserve)을 남기되, min 아래로는 내려가지 않는다(그 경우 칸 영역이 스크롤된다).
export function rightRange({ center, sideChat, panesReserve, squeezeReserve, narrow }: RightRangeInput): { min: number; max: number } {
  const free = center - sideChat;
  const min = Math.max(RIGHT_FLOOR, Math.min(narrow, free - squeezeReserve));
  const max = Math.max(min, free - panesReserve);
  return { min, max };
}

export type PanesFit = { panes: number; scrolls: boolean; each: number };

// 오른쪽 패널 폭을 알 때 칸 영역이 받는 폭과 스크롤 여부, 한 칸의 최소 보장 폭 확인용.
export function panesFit(center: number, sideChat: number, right: number, colsPerRow: number[], min = PANE_MIN): PanesFit {
  const panes = Math.max(0, center - sideChat - right);
  const need = panesMinWidth(colsPerRow, min);
  const most = colsPerRow.reduce((m, c) => Math.max(m, c), 0);
  const each = most ? (Math.max(panes, need) - (most - 1) * DIVIDER) / most : 0;
  return { panes, scrolls: need > panes, each };
}

// 사이드바 최대 폭. 창이 좁아도 칸 하나(floor)와, 열려 있으면 오른쪽 패널 최소 폭은 남긴다. 하한(min) 아래로는 내려가지 않는다.
export function sidebarMax(body: number, rightOpenMin: number, floor: number, hardMax: number, min: number): number {
  return Math.max(min, Math.min(hardMax, body - floor - rightOpenMin));
}
