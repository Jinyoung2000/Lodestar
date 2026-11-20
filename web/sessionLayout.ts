import { parseDockWidth } from "./focusLayout";
import { isLayoutMode, isPinnedTab, parseRect, sameRect, separatesPinned, sideKeyOf, type FloatRect, type LayoutMode } from "./floatLayout";
import type { Pane } from "./store";

// 세션마다 화면 배치를 기억했다가 그 세션으로 돌아오면 되살린다. store 를 모르는 순수 로직이라 단위 시험이 그대로 부른다(test/sessionlayout.test.ts).
// 기억하는 값은 "코드를 더 보는 세션"과 "대화를 더 하는 세션"을 가르는 열 개뿐이다. 에디터 그룹과 탭, 패널 크기(사이드바 폭, 아래 패널 높이)는 전역이다.
// 포커스 모드(Editor 중심)의 왼쪽 사이드바 열림과 고른 뷰(sideTabKey), 오른쪽 대화 패널의 열림과 폭도 세션마다 기억한다.

export type SessionLayout = {
  layoutMode: LayoutMode;
  floatCollapsed: boolean;
  floatRect: FloatRect | null;
  sidebarOpen: boolean;
  rightOpen: boolean;
  bottomOpen: boolean;
  // 오른쪽 패널(Chat 중심) 또는 왼쪽 사이드바(Editor 중심)가 보이는 고정 탭(changes, files, scm, card)
  sideTabKey: string;
  // 포커스 모드: 왼쪽 Primary Side Bar 열림, 오른쪽 대화 패널 열림과 폭(null 이면 기본 폭)
  focusSideOpen: boolean;
  chatDockOpen: boolean;
  chatDockWidth: number | null;
};

export type SessionLayouts = Record<string, SessionLayout>;

export function sliceOf(s: SessionLayout): SessionLayout {
  return { layoutMode: s.layoutMode, floatCollapsed: s.floatCollapsed, floatRect: s.floatRect, sidebarOpen: s.sidebarOpen, rightOpen: s.rightOpen, bottomOpen: s.bottomOpen, sideTabKey: s.sideTabKey, focusSideOpen: s.focusSideOpen, chatDockOpen: s.chatDockOpen, chatDockWidth: s.chatDockWidth };
}

export function sameLayout(a: SessionLayout, b: SessionLayout): boolean {
  return a.layoutMode === b.layoutMode && a.floatCollapsed === b.floatCollapsed && sameRect(a.floatRect, b.floatRect) && a.sidebarOpen === b.sidebarOpen && a.rightOpen === b.rightOpen && a.bottomOpen === b.bottomOpen && a.sideTabKey === b.sideTabKey && a.focusSideOpen === b.focusSideOpen && a.chatDockOpen === b.chatDockOpen && a.chatDockWidth === b.chatDockWidth;
}

// 지금 화면 배치가 속한 세션 id. 세션이 아닌 화면(Board, Mentions, Improvements, PR)과 새 세션 화면은 null 이라 기억하지도 되살리지도 않는다.
// 격자에서는 활성 칸의 세션이고, 같은 세션이 두 칸에 있어도 활성 칸의 것 하나다.
export function layoutKeyOf(s: { centerView: string; panes: readonly Pane[]; activePaneId: string }): string | null {
  if (s.centerView !== "sessions") return null;
  const pane = s.panes.find((p) => p.id === s.activePaneId);
  return pane?.kind === "agent" ? pane.agentId : null;
}

export type SwitchInput = {
  enabled: boolean;
  // 갱신 전 화면의 세션과 그때 배치, 갱신 뒤의 세션과 배치(패치가 적용된 값)
  prevKey: string | null;
  prev: SessionLayout;
  key: string | null;
  current: SessionLayout;
  layouts: SessionLayouts;
};

export type SwitchResult = {
  layouts: SessionLayouts;
  // 새로 보이는 세션이 기억해 둔 배치. 없으면 지금 화면 배치를 그대로 쓴다.
  apply: SessionLayout | null;
};

// 상태가 바뀔 때마다 한 번 부른다.
// 1. 기능이 꺼져 있으면 기억을 비운다(전역 배치 하나로 돌아간다).
// 2. 같은 세션을 보는 동안 배치가 바뀌면 그 세션의 기억을 갱신한다.
// 3. 세션이 바뀌면 떠나는 세션의 마지막 배치(갱신 전 값)를 남기고, 도착한 세션에 기억이 있으면 apply 로 돌려준다. 처음 보는 세션은 지금 배치를 이어받아 기억한다.
export function planSwitch(input: SwitchInput): SwitchResult {
  const { layouts, prevKey, key } = input;
  if (!input.enabled) return { layouts: Object.keys(layouts).length === 0 ? layouts : {}, apply: null };
  let next = layouts;
  const remember = (id: string, layout: SessionLayout) => {
    const known = next[id];
    if (!known || !sameLayout(known, layout)) next = { ...next, [id]: sliceOf(layout) };
  };
  if (prevKey !== key) {
    if (prevKey !== null) remember(prevKey, input.prev);
    if (key !== null) {
      const known = next[key];
      if (known) return { layouts: next, apply: known };
      remember(key, input.current);
    }
    return { layouts: next, apply: null };
  }
  if (key !== null) remember(key, input.current);
  return { layouts: next, apply: null };
}

// 되살릴 배치를 상태 패치로 바꾼다. 오른쪽 패널이 고정 탭을 가운데에 쓰는 상태(에디터 탭이 없는 Chat 중심)에서는 activeTabKey 가 곧 그 탭이라 같이 맞춘다.
// 그 밖의 경우 activeTabKey 는 에디터 탭이므로 건드리지 않는다.
export function layoutPatch(saved: SessionLayout, now: { activeTabKey: string | null; tabKeys: readonly string[]; hasCard: boolean }) {
  const sideTabKey = sideKeyOf(saved.sideTabKey, now.hasCard);
  const patch: Partial<SessionLayout> & { activeTabKey?: string } = { ...sliceOf(saved), sideTabKey };
  if (!separatesPinned({ layoutMode: saved.layoutMode, tabKeys: now.tabKeys }) && isPinnedTab(now.activeTabKey) && now.activeTabKey !== sideTabKey) patch.activeTabKey = sideTabKey;
  return patch;
}

// 지워진 세션의 기억을 뺀다. 같은 객체를 돌려주면 바뀐 것이 없다.
export function pruneSessionLayouts(layouts: SessionLayouts, alive: ReadonlySet<string>): SessionLayouts {
  const ids = Object.keys(layouts);
  if (ids.every((id) => alive.has(id))) return layouts;
  return Object.fromEntries(ids.filter((id) => alive.has(id)).map((id) => [id, layouts[id]]));
}

// 한 세션의 기억을 지운다(세션 삭제)
export function dropSessionLayout(layouts: SessionLayouts, id: string): SessionLayouts {
  if (!(id in layouts)) return layouts;
  const { [id]: _gone, ...rest } = layouts;
  return rest;
}

// 저장본에서 읽은 값을 거른다. 모양이 깨진 항목은 버리고 모르는 고정 탭 키는 changes 로 돌린다.
export function sanitizeSessionLayouts(value: unknown): SessionLayouts {
  const out: SessionLayouts = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [id, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (!isLayoutMode(e.layoutMode)) continue;
    out[id] = {
      layoutMode: e.layoutMode,
      floatCollapsed: e.floatCollapsed === true,
      floatRect: parseRect(e.floatRect),
      sidebarOpen: e.sidebarOpen !== false,
      rightOpen: e.rightOpen === true,
      bottomOpen: e.bottomOpen === true,
      sideTabKey: typeof e.sideTabKey === "string" ? e.sideTabKey : "changes",
      focusSideOpen: e.focusSideOpen !== false,
      chatDockOpen: e.chatDockOpen !== false,
      chatDockWidth: parseDockWidth(e.chatDockWidth),
    };
  }
  return out;
}
