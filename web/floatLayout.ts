// 배치 모드(Chat 중심, Editor 중심)와 떠 있는 에이전트 창의 순수 로직. DOM 과 store 를 모르고 값만 받아서 단위 시험이 그대로 가져다 쓴다.

export type LayoutMode = "chat" | "editor";

export const LAYOUT_MODES: readonly LayoutMode[] = ["chat", "editor"];

export const isLayoutMode = (value: unknown): value is LayoutMode => value === "chat" || value === "editor";

// --- 시작 모드 ---

export type StartingModeInput = {
  // 창을 다시 읽기 전에 sessionStorage 에 맡긴 모드(⌘R, 피드백 반영). 같은 실행이므로 가장 먼저 따른다.
  restored: LayoutMode | null;
  // Settings 의 Default Layout. 고른 적이 없으면 null
  defaultLayout: LayoutMode | null;
  // Settings 의 Remember last layout
  remember: boolean;
  // 쓰는 중 마지막으로 바꾼 값(localStorage)
  last: LayoutMode | null;
};

// 앱을 열 때의 모드. Settings 기본값이 우선이고, "Remember last layout" 이 켜져 있을 때만 마지막 값이 이긴다.
export function startingMode(input: StartingModeInput): LayoutMode {
  if (input.restored) return input.restored;
  if (input.remember && input.last) return input.last;
  return input.defaultLayout ?? "chat";
}

// --- 떠 있는 창의 자리와 크기 ---

export type FloatRect = { x: number; y: number; w: number; h: number };
// top 은 제목줄 높이. 떠 있는 창은 제목줄 아래에서만 움직인다.
export type Viewport = { width: number; height: number; top: number };
export type FloatLimits = { minW: number; minH: number; margin: number };
export type FloatEdge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

export const FLOAT_EDGES: readonly FloatEdge[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max));

// 창 크기가 바뀌었을 때의 보정: 크기를 [최소, 화면] 안으로, 그다음 위치를 화면 안으로. 화면이 최소 크기보다 작으면 화면에 맞춘다.
export function clampRect(rect: FloatRect, vp: Viewport, limits: FloatLimits): FloatRect {
  const availH = Math.max(0, vp.height - vp.top);
  const w = Math.round(clamp(rect.w, Math.min(limits.minW, vp.width), vp.width));
  const h = Math.round(clamp(rect.h, Math.min(limits.minH, availH), availH));
  return {
    w,
    h,
    x: Math.round(clamp(rect.x, 0, vp.width - w)),
    y: Math.round(clamp(rect.y, vp.top, vp.height - h)),
  };
}

// 기본 자리: 오른쪽 아래, 가장자리에서 margin 만큼 띄운다.
export function defaultRect(size: { w: number; h: number }, vp: Viewport, limits: FloatLimits): FloatRect {
  return clampRect({ w: size.w, h: size.h, x: vp.width - size.w - limits.margin, y: vp.height - size.h - limits.margin }, vp, limits);
}

export function moveRect(start: FloatRect, dx: number, dy: number, vp: Viewport, limits: FloatLimits): FloatRect {
  return clampRect({ ...start, x: start.x + dx, y: start.y + dy }, vp, limits);
}

// 가장자리나 모서리를 dx, dy 만큼 끌어 크기를 바꾼다. 반대쪽 가장자리는 그대로 두고, 최소 크기와 화면 경계를 넘지 않는다.
export function resizeRect(start: FloatRect, edge: FloatEdge, dx: number, dy: number, vp: Viewport, limits: FloatLimits): FloatRect {
  let left = start.x;
  let right = start.x + start.w;
  let top = start.y;
  let bottom = start.y + start.h;
  if (edge.includes("e")) right = clamp(right + dx, left + limits.minW, vp.width);
  if (edge.includes("w")) left = clamp(left + dx, 0, right - limits.minW);
  if (edge.includes("s")) bottom = clamp(bottom + dy, top + limits.minH, vp.height);
  if (edge.includes("n")) top = clamp(top + dy, vp.top, bottom - limits.minH);
  return clampRect({ x: left, y: top, w: right - left, h: bottom - top }, vp, limits);
}

// localStorage 에서 읽은 값이 쓸 만한 자리인지. 아니면 null(기본 자리).
export function parseRect(raw: unknown): FloatRect | null {
  if (!raw || typeof raw !== "object") return null;
  const { x, y, w, h } = raw as Record<string, unknown>;
  const ok = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
  if (!ok(x) || !ok(y) || !ok(w) || !ok(h) || w <= 0 || h <= 0) return null;
  return { x, y, w, h };
}

export const sameRect = (a: FloatRect | null, b: FloatRect | null) => (a === b) || (!!a && !!b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h);

// 알약은 창의 오른쪽 아래 모서리에 붙는다. 창 오른쪽, 아래 가장자리에서 화면 가장자리까지의 거리.
export function pillAnchor(rect: FloatRect, vp: Viewport): { right: number; bottom: number } {
  return { right: Math.max(0, vp.width - (rect.x + rect.w)), bottom: Math.max(0, vp.height - (rect.y + rect.h)) };
}

// --- 오른쪽 고정 탭과 가운데 에디터 탭의 분리 ---

export const PINNED_TAB_KEYS: readonly string[] = ["changes", "files", "scm", "search", "card"];
export const isPinnedTab = (key: string | null | undefined): boolean => key != null && PINNED_TAB_KEYS.includes(key);

// 탭 상태 중 모드 전환이 건드리는 부분만. 탭 키와 main 그룹 소속은 호출하는 쪽이 평평한 목록으로 준다.
export type TabSlice = {
  layoutMode: LayoutMode;
  activeTabKey: string | null;
  // Editor 중심에서 오른쪽 패널이 보이는 고정 탭
  sideTabKey: string;
  // main 그룹에서 마지막으로 활성이었던 에디터 탭
  mainEditorKey: string | null;
  groupActive: Record<string, string | null>;
  // 지금 있는 모든 에디터 탭(고정 탭 제외)과 그중 main 그룹의 것
  tabKeys: readonly string[];
  mainKeys: readonly string[];
};

export const MAIN = "main";

// 에디터와 고정 탭이 따로 보이는 상태(Editor 중심, 또는 Chat 중심에서 에디터 탭이 하나라도 열려 있을 때)를 가른다.
// 열린 에디터 탭이 없는 Chat 중심에서는 고정 탭이 오른쪽 패널을 다 쓰고 activeTabKey 가 그 탭이다.
export const separatesPinned = (slice: Pick<TabSlice, "layoutMode" | "tabKeys">): boolean => slice.layoutMode === "editor" || slice.tabKeys.length > 0;

// 에디터와 고정 탭이 따로 보이는 동안 activeTabKey 는 늘 에디터 탭이다. 고정 탭(changes, files, card)을 고르는 모든 길(openChanges, openCard, 탭 누르기)이
// activeTabKey 에 고정 키를 쓰므로, 그 값을 sideTabKey 로 옮기고 activeTabKey 는 에디터 탭으로 되돌린다. 호출처는 하나도 고치지 않는다.
// 그래서 저장(⌘S), 닫기(⌘W), 이동 같은 활성 탭 명령은 트리에 포커스가 있어도 보이는 에디터 탭에 걸린다.
// 열린 에디터 탭이 없는 Chat 중심에서는 activeTabKey 를 건드리지 않고 sideTabKey 와 mainEditorKey 만 따라 적는다.
export function normalizeTabs(prev: TabSlice, next: TabSlice): TabSlice {
  const out: TabSlice = { ...next };
  const modeChanged = prev.layoutMode !== next.layoutMode;
  const live = (key: string | null) => key !== null && !isPinnedTab(key) && next.tabKeys.includes(key);

  if (separatesPinned(next) && isPinnedTab(next.activeTabKey)) {
    // 고른 것이 아니라 닫혀서 밀려난 것이면(활성이던 에디터 탭이 사라졌다) 오른쪽 패널은 그대로 둔다. 열린 에디터 탭이 없는 채로 고정 탭을 누른 것(prev 가 null)은 고른 것이다.
    const pushedOut = prev.activeTabKey !== null && !isPinnedTab(prev.activeTabKey) && !next.tabKeys.includes(prev.activeTabKey);
    const chosen = modeChanged || !pushedOut;
    if (chosen) out.sideTabKey = next.activeTabKey!;
    out.activeTabKey = live(prev.activeTabKey) ? prev.activeTabKey : live(next.mainEditorKey) ? next.mainEditorKey : (next.mainKeys[next.mainKeys.length - 1] ?? null);
  } else if (isPinnedTab(next.activeTabKey) && next.activeTabKey !== prev.activeTabKey) {
    out.sideTabKey = next.activeTabKey!;
  }

  if (live(out.activeTabKey) && next.mainKeys.includes(out.activeTabKey!)) out.mainEditorKey = out.activeTabKey;
  else if (!live(out.mainEditorKey) || !next.mainKeys.includes(out.mainEditorKey!)) out.mainEditorKey = null;

  // 따로 보이는 동안 main 그룹에 기억된 고정 키는 가운데에 보일 수 없으니 에디터 탭으로 바꾸거나 지운다(그룹에 포커스를 돌릴 때 고정 탭이 되살아나지 않게).
  if (separatesPinned(next) && isPinnedTab(next.groupActive[MAIN])) {
    const { [MAIN]: _stale, ...rest } = next.groupActive;
    out.groupActive = live(out.mainEditorKey) ? { ...rest, [MAIN]: out.mainEditorKey } : rest;
  }
  return out;
}

// Editor 중심의 가운데 main 그룹이 보일 탭. 고정 키나 사라진 키가 오면 마지막 에디터 탭, 없으면 main 의 마지막 탭.
export function editorKeyOfMain(activeKey: string | null, mainEditorKey: string | null, mainKeys: readonly string[]): string | null {
  if (activeKey !== null && mainKeys.includes(activeKey)) return activeKey;
  if (mainEditorKey !== null && mainKeys.includes(mainEditorKey)) return mainEditorKey;
  return mainKeys[mainKeys.length - 1] ?? null;
}

// 오른쪽 패널이 보일 고정 탭. 카드가 없으면 Changes. 옛 "inbox" 같은 모르는 키도 Changes 로 떨어진다.
export function sideKeyOf(sideTabKey: string, hasCard: boolean): string {
  if (sideTabKey === "files" || sideTabKey === "scm" || sideTabKey === "search") return sideTabKey;
  if (sideTabKey === "card" && hasCard) return "card";
  return "changes";
}

// --- 떠 있는 창 머리의 세션 드롭다운 ---

export type SessionChoice = { id: string; title: string; workspaceId: string | null; done: boolean; feedback: boolean; updatedAt: number };

// 같은 작업 폴더의 세션을 먼저, 그 안에서 최근에 연 순서(최근 기록에 없는 세션은 갱신 시각 순으로 뒤에). 지금 세션과 완료한 세션, 피드백 세션은 뺀다.
export function floatSessionChoices(agents: readonly SessionChoice[], recentIds: readonly string[], currentId: string | null, currentWorkspace: string | null, topOf: (workspaceId: string | null) => string | null, limit = 8): SessionChoice[] {
  const rank = (id: string) => {
    const i = recentIds.indexOf(id);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  const pool = agents.filter((a) => a.id !== currentId && !a.done && !a.feedback);
  const same = (a: SessionChoice) => currentWorkspace !== null && topOf(a.workspaceId) === currentWorkspace;
  return pool
    .slice()
    .sort((a, b) => Number(same(b)) - Number(same(a)) || rank(a.id) - rank(b.id) || b.updatedAt - a.updatedAt)
    .slice(0, limit);
}
