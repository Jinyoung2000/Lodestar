// 가운데 화면(세션, 보드, 멘션, PR)과 세션 오른쪽 패널의 관계. store 없이 시험할 수 있게 순수 함수로 뒀다. 시험: test/splitpanels.test.ts

export type CenterViewName = "sessions" | "board" | "inbox" | "pr" | "improvements" | "notion" | "notes" | "skills";

// 세션 오른쪽 패널(Changes, Files, 에디터 탭)은 세션 화면 것이다. 보드와 멘션과 PR 화면은 열림 여부와 상관없이 이 패널을 보이지 않는다.
export const sessionPanelShown = (centerView: CenterViewName, rightOpen: boolean): boolean => centerView === "sessions" && rightOpen;

// 오른쪽 패널을 여닫는 단축키, 명령, 제목줄 버튼은 세션 화면에서만 뜻이 있다.
export const sessionPanelToggleable = (centerView: CenterViewName): boolean => centerView === "sessions";

// 카드는 세션 화면에서는 오른쪽 패널의 Card 탭으로, 보드 화면에서는 보드 자기 상세 칸으로 연다. 멘션과 PR 화면에서 카드를 열라는 요청은 보드로 보낸다.
export const cardOpensInSessionPanel = (centerView: CenterViewName): boolean => centerView === "sessions";

// 예전 버전이 저장한 "inbox" 탭 키는 더 이상 탭이 아니다. 다시 읽어 복원한 값에서 걸러내 Changes 로 바꾼다.
const RETIRED_TAB_KEYS: readonly string[] = ["inbox"];
export const isRetiredTabKey = (key: unknown): boolean => typeof key === "string" && RETIRED_TAB_KEYS.includes(key);

export function sanitizeRestoredTabs(restored: { activeTabKey?: unknown; sideTabKey?: unknown; groupActive?: unknown } | null | undefined): { activeTabKey: string | null; sideTabKey: string; groupActive: Record<string, string | null> } {
  const key = (value: unknown, fallback: string) => (typeof value === "string" && !isRetiredTabKey(value) ? value : fallback);
  const saved = restored?.groupActive && typeof restored.groupActive === "object" ? (restored.groupActive as Record<string, unknown>) : {};
  const groupActive: Record<string, string | null> = {};
  for (const [group, value] of Object.entries(saved)) if (value === null || (typeof value === "string" && !isRetiredTabKey(value))) groupActive[group] = value;
  return { activeTabKey: restored?.activeTabKey === null ? null : key(restored?.activeTabKey, "changes"), sideTabKey: key(restored?.sideTabKey, "changes"), groupActive };
}

// 목록 옆 상세 칸(멘션, 보드 카드)의 폭 한계. 상세는 min 아래로 줄지 않고, 목록은 listMin 아래로 줄지 않는다. 창이 둘을 못 담을 만큼 좁으면 상세가 min 을 지키고 목록이 줄어든다.
export function detailWidthLimits(container: number, min: number, listMin: number): { min: number; max: number } {
  return { min, max: Math.max(min, container - listMin) };
}
