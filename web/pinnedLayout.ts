import type { EditorLayout } from "./editorGroups";

// Chat 중심에서 에디터 탭이 열려 있을 때 오른쪽 패널을 나누는 고정 칸(Changes, Files)의 폭 계산. DOM 과 store 를 모르고 값만 받아서 단위 시험이 그대로 가져다 쓴다. 시험: test/pinnedlayout.test.ts

// 고정 칸 최소 폭(--size-pinned-min)과 에디터가 지켜야 하는 최소 폭(--size-pinned-editor-min). CSS 와 같은 값이다.
export const PINNED_MIN = 200;
// 480 은 코드 한 줄이 80자쯤 읽히는 폭이다. 이보다 좁으면 참조 peek 같은 편집기 안 위젯도 쓸 수 없다.
export const PINNED_EDITOR_MIN = 480;
// 고정 칸 기본 폭(--size-panel-narrow)
export const PINNED_DEFAULT = 300;
// 칸과 에디터 사이 경계선
const BORDER = 1;
// 고정 칸 기본 폭과 에디터 최소 폭을 둘 다 담는 패널 폭. 이보다 좁게 저장된 패널은 에디터 탭이 처음 열릴 때 이 폭으로 넓힌다.
export const PINNED_FIT = PINNED_DEFAULT + BORDER + PINNED_EDITOR_MIN;

export type PinnedSide = "left" | "right";

export const isPinnedSide = (value: unknown): value is PinnedSide => value === "left" || value === "right";

// side: 에디터 옆에 나란히. collapsed: 접어서 에디터가 패널 전체를 쓴다. overlay: 패널이 좁아 둘을 다 못 담아 에디터 위에 서랍으로 뜬다.
export type PinnedPresentation = "side" | "collapsed" | "overlay";

// 패널 폭(panel)에서 고정 칸이 가질 수 있는 폭의 범위. 에디터가 PINNED_EDITOR_MIN 아래로 줄지 않게 max 가 정해진다.
export function pinnedRange(panel: number): { min: number; max: number } {
  return { min: PINNED_MIN, max: Math.max(PINNED_MIN, panel - BORDER - PINNED_EDITOR_MIN) };
}

// 패널이 둘을 다 담을 만큼 넓은지. 모르면(폭 0) 넓다고 본다 — 첫 그림에서 서랍이 번쩍이지 않게.
export const fitsBoth = (panel: number): boolean => panel <= 0 || panel >= PINNED_MIN + BORDER + PINNED_EDITOR_MIN;

export function presentationOf(panel: number, collapsed: boolean): PinnedPresentation {
  if (!fitsBoth(panel)) return "overlay";
  return collapsed ? "collapsed" : "side";
}

// 실제로 그릴 고정 칸 폭. 저장한 폭(없으면 기본)을 범위 안으로 맞춘다. 서랍일 때는 패널 폭을 넘지 않는다.
export function pinnedWidth(panel: number, saved: number | null): number {
  const want = saved ?? PINNED_DEFAULT;
  if (!fitsBoth(panel)) return Math.max(0, Math.min(want, panel));
  const { min, max } = pinnedRange(panel);
  return Math.round(Math.min(Math.max(want, min), max));
}

// 저장해 둔 값이 쓸 만한 폭인지. 아니면 null(기본 폭).
export function parsePinnedWidth(raw: unknown): number | null {
  const n = typeof raw === "string" ? Number(raw) : raw;
  return typeof n === "number" && Number.isFinite(n) && n >= PINNED_MIN && n <= 4000 ? Math.round(n) : null;
}

// 접기 단추가 하는 일: 서랍이면 열고 닫기, 나란히 있으면 접고 펴기.
export function nextPinnedState(presentation: PinnedPresentation, collapsed: boolean, drawerOpen: boolean): { collapsed: boolean; drawerOpen: boolean } {
  if (presentation === "overlay") return { collapsed, drawerOpen: !drawerOpen };
  return { collapsed: !collapsed, drawerOpen: false };
}

// 고정 칸이 지금 화면에 보이는지
export const pinnedShown = (presentation: PinnedPresentation, drawerOpen: boolean): boolean => presentation === "side" || (presentation === "overlay" && drawerOpen);

// 서랍이 에디터 위에 뜰 때 서랍 옆으로 다른 에디터 그룹의 얇은 조각(줄 번호만 보이는 정도)이 남으면 어색해서, 그 조각 이하만 남는 그룹은 서랍이 가린다.
export const DRAWER_SLIVER = 48;

// groups 는 패널 왼쪽 끝을 0 으로 잰 에디터 그룹의 가로 범위. right 서랍은 [panel-width, panel], left 서랍은 [0, width] 를 덮는다.
// 서랍 밖에 남는 그룹 폭이 0 보다 크고 DRAWER_SLIVER 보다 작으면 그 그룹 가장자리까지 서랍을 넓힌 폭을 돌려준다. 아니면 그대로.
export function snapDrawerWidth(panel: number, width: number, side: PinnedSide, groups: readonly { left: number; right: number }[]): number {
  let snapped = width;
  for (const group of groups) {
    if (side === "right") {
      const edge = panel - width;
      const visible = edge - group.left;
      if (group.right > edge && visible > 0 && visible < DRAWER_SLIVER) snapped = Math.max(snapped, panel - group.left);
    } else {
      const visible = group.right - width;
      if (group.left < width && visible > 0 && visible < DRAWER_SLIVER) snapped = Math.max(snapped, group.right);
    }
  }
  return Math.min(snapped, panel);
}

// 고정 칸과 맞닿은 맨 위 에디터 그룹. 패널 단추(최대화, 고정 칸 펴기)는 이 그룹의 탭줄 끝에 둔다.
// right 면 맨 위 줄의 가장 오른쪽 그룹, left 면 맨 위 줄의 가장 왼쪽 그룹이다. 위아래로 나뉜 곳은 위쪽을 따른다.
export function edgeGroupOf(layout: EditorLayout, side: PinnedSide): string {
  if (layout.type === "group") return layout.id;
  const child = layout.dir === "row" && side === "right" ? layout.children[layout.children.length - 1] : layout.children[0];
  return edgeGroupOf(child, side);
}
