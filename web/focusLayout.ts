// 포커스 모드(Editor 중심 배치)의 순수 로직: 왼쪽 Activity Bar + Primary Side Bar, 가운데 에디터, 오른쪽에 도킹한 대화.
// DOM 과 store 를 모르고 값만 받아서 단위 시험이 그대로 가져다 쓴다. 시험: test/focuslayout.test.ts

// Settings 의 "Chat in editor layout". docked 는 오른쪽 고정 패널(기본), floating 은 떠 있는 창(web/FloatingAgent.tsx).
export type ChatDock = "docked" | "floating";

export const isChatDock = (value: unknown): value is ChatDock => value === "docked" || value === "floating";

export const chatDockOf = (value: unknown): ChatDock => (value === "floating" ? "floating" : "docked");

// Activity Bar 가 고르는 사이드바 뷰. 키는 sideTabKey 와 같다(web/floatLayout.ts sideKeyOf). card 는 열린 카드가 있을 때만 막대에 나온다.
export type FocusView = "files" | "changes" | "scm" | "search" | "card";

export const FOCUS_VIEWS: readonly FocusView[] = ["files", "changes", "scm", "search"];

export function pressActivity(open: boolean, current: string, pressed: string): { open: boolean; view: string } {
  if (open && current === pressed) return { open: false, view: current };
  return { open: true, view: pressed };
}

// Editor 배치에서 대화가 숨겨져 있는지. floating 은 알약으로 접힌 것, docked 는 오른쪽 패널을 닫은 것이다.
export function chatHiddenInEditor(s: { chatDock: ChatDock; floatCollapsed: boolean; chatDockOpen: boolean }): boolean {
  return s.chatDock === "floating" ? s.floatCollapsed : !s.chatDockOpen;
}

// --- 치수 (CSS 토큰 --size-activity-bar, --size-focus-side, --size-float-width, --size-float-min-width 와 같은 값) ---

export const ACTIVITY_BAR = 48;
export const FOCUS_SIDE_DEFAULT = 300;
export const FOCUS_SIDE_MIN = 200;
export const FOCUS_SIDE_MAX = 600;
export const DOCK_DEFAULT = 420;
export const DOCK_MIN = 320;
// 가운데 에디터가 지켜야 하는 최소 폭. 사이드바와 대화 패널이 이 아래로 에디터를 누르지 못한다.
export const EDITOR_MIN = 320;
// 경계선 하나의 폭
const BORDER = 1;

const clamp = (value: number, min: number, max: number) => Math.round(Math.min(Math.max(value, min), Math.max(min, max)));

// 대화 패널 폭의 범위. center 는 가운데 영역(.center) 폭이고 에디터가 EDITOR_MIN 아래로 줄지 않는 선이 최대다.
export function dockRange(center: number): { min: number; max: number } {
  return { min: DOCK_MIN, max: Math.max(DOCK_MIN, center - EDITOR_MIN - BORDER) };
}

// 경계선 더블클릭으로 맞추는 "글자에 맞는 최소 폭". 대화 본문 한 줄에 이 글자 수가 들어가는 폭이다.
export const DOCK_FIT_CHARS = 44;

// charPx 는 본문 글자('0') 한 칸의 폭, padPx 는 대화 열의 좌우 안쪽 여백 합이다. 범위(dockRange)를 벗어나지 않는다.
export function dockFitWidth(charPx: number, padPx: number, center: number): number {
  const { min, max } = dockRange(center);
  return clamp(charPx * DOCK_FIT_CHARS + padPx + BORDER, min, max);
}

// 실제로 그릴 대화 패널 폭. 저장한 폭(없으면 기본)을 범위 안으로 맞춘다. 가운데 폭을 모르면(0) 저장한 값을 그대로 쓴다.
export function dockWidth(saved: number | null, center: number): number {
  const want = saved ?? DOCK_DEFAULT;
  if (center <= 0) return want;
  const { min, max } = dockRange(center);
  return clamp(want, min, max);
}

// 저장해 둔 값이 쓸 만한 폭인지. 아니면 null(기본 폭).
export function parseDockWidth(raw: unknown): number | null {
  const n = typeof raw === "string" ? Number(raw) : raw;
  return typeof n === "number" && Number.isFinite(n) && n >= DOCK_MIN && n <= 4000 ? Math.round(n) : null;
}

// 사이드바 폭의 범위. body 는 .body 폭, dock 은 지금 그려지는 대화 패널 폭(접혔거나 떠 있으면 0)이다.
export function focusSideRange(body: number, dock: number): { min: number; max: number } {
  const free = body - ACTIVITY_BAR - BORDER - dock - EDITOR_MIN - (dock > 0 ? BORDER : 0);
  return { min: FOCUS_SIDE_MIN, max: Math.max(FOCUS_SIDE_MIN, Math.min(FOCUS_SIDE_MAX, free)) };
}

export function focusSideWidth(saved: number | null, body: number, dock: number): number {
  const want = saved ?? FOCUS_SIDE_DEFAULT;
  if (body <= 0) return want;
  const { min, max } = focusSideRange(body, dock);
  return clamp(want, min, max);
}

export function parseFocusSideWidth(raw: unknown): number | null {
  const n = typeof raw === "string" ? Number(raw) : raw;
  return typeof n === "number" && Number.isFinite(n) && n >= FOCUS_SIDE_MIN && n <= 4000 ? Math.round(n) : null;
}

// --- 무엇이 보이는가 ---

export type FocusShown = { side: boolean; dock: boolean; floating: boolean };

// 세션 화면이 아니면(Board, Mentions, PR 등) 세션 쪽 막대와 패널은 그리지 않고 숨긴다. 포커스 모드가 아니면 아무것도 없다.
// docked 이면 대화 패널(dock)이, floating 이면 떠 있는 창이 대화를 맡는다. 접힘 여부는 floating 쪽이 알약으로 따로 그린다.
export function focusShown(input: { editorLayout: boolean; sessionsView: boolean; chatDock: ChatDock; sideOpen: boolean; dockOpen: boolean }): FocusShown {
  if (!input.editorLayout || !input.sessionsView) return { side: false, dock: false, floating: false };
  return { side: input.sideOpen, dock: input.chatDock === "docked" && input.dockOpen, floating: input.chatDock === "floating" };
}
