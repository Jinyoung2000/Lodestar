export type SideBarPosition = "left" | "right";
export type PanelAlignment = "left" | "right" | "center" | "justify";

// 순서는 Customize Layout 창의 항목 순서(Left, Right, Center, Justify)와 같다
export const SIDE_BAR_POSITIONS: readonly SideBarPosition[] = ["left", "right"];
export const PANEL_ALIGNMENTS: readonly PanelAlignment[] = ["left", "right", "center", "justify"];

export type LayoutConfig = {
  // Primary Side Bar 위치. Chat 중심에서는 앱 사이드바(세션 목록), Editor 중심에서는 Explorer 같은 왼쪽 사이드바다.
  sideBar: SideBarPosition;
  panelAlignment: PanelAlignment;
  // Activity Bar 보임. Editor 중심에만 있는 막대다(Chat 중심에는 없다).
  activityBar: boolean;
};

export const DEFAULT_LAYOUT_CONFIG: LayoutConfig = { sideBar: "left", panelAlignment: "center", activityBar: true };

export const isSideBarPosition = (value: unknown): value is SideBarPosition => value === "left" || value === "right";
export const isPanelAlignment = (value: unknown): value is PanelAlignment => value === "left" || value === "right" || value === "center" || value === "justify";

// 저장본(JSON 문자열이나 객체)을 읽는다. 깨진 필드는 그 필드만 기본값으로 돌린다.
export function parseLayoutConfig(raw: unknown): LayoutConfig {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return DEFAULT_LAYOUT_CONFIG;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return DEFAULT_LAYOUT_CONFIG;
  const v = value as Record<string, unknown>;
  return {
    sideBar: isSideBarPosition(v.sideBar) ? v.sideBar : DEFAULT_LAYOUT_CONFIG.sideBar,
    panelAlignment: isPanelAlignment(v.panelAlignment) ? v.panelAlignment : DEFAULT_LAYOUT_CONFIG.panelAlignment,
    activityBar: v.activityBar === false ? false : DEFAULT_LAYOUT_CONFIG.activityBar,
  };
}

export const isDefaultLayoutConfig = (c: LayoutConfig): boolean => c.sideBar === DEFAULT_LAYOUT_CONFIG.sideBar && c.panelAlignment === DEFAULT_LAYOUT_CONFIG.panelAlignment && c.activityBar === DEFAULT_LAYOUT_CONFIG.activityBar;

export const restoredLayoutConfig = (): LayoutConfig => DEFAULT_LAYOUT_CONFIG;

// --- 격자 배치 ---
// 작업 영역(.body)은 5열 3행 격자다.
//   열: 1 왼쪽 사이드바, 2 왼쪽 경계(끌개), 3 가운데(에디터나 대화), 4 오른쪽 경계(끌개), 5 오른쪽 사이드바
//   행: 1 본문, 2 Panel 경계(끌개), 3 Panel
// 왼쪽 열에 Primary 가 오면 오른쪽 열에는 Secondary(Editor 중심의 대화 패널, Chat 중심의 오른쪽 패널)가 오고, 위치가 right 이면 반대다.

export type GridPlan = {
  primaryColumn: number;
  primaryResizerColumn: number;
  secondaryColumn: number;
  secondaryResizerColumn: number;
  // grid-row 값. "1" 은 본문 행까지만(Panel 이 이 열 아래로 걸쳐 있다), "1 / 4" 는 Panel 행까지 내려간다.
  primaryRows: string;
  secondaryRows: string;
  // Panel 과 Panel 경계가 차지하는 grid-column 값
  panelColumns: string;
  // 끌개 방향(Resizer 의 direction): 1 은 오른쪽으로 끌면 커지는 왼쪽 열, -1 은 왼쪽으로 끌면 커지는 오른쪽 열
  primaryDirection: 1 | -1;
  secondaryDirection: 1 | -1;
};

export function gridPlan(config: Pick<LayoutConfig, "sideBar" | "panelAlignment">): GridPlan {
  const primaryLeft = config.sideBar === "left";
  // Panel 이 왼쪽 열 아래로 걸치는가, 오른쪽 열 아래로 걸치는가
  const underLeft = config.panelAlignment === "left" || config.panelAlignment === "justify";
  const underRight = config.panelAlignment === "right" || config.panelAlignment === "justify";
  const rows = (under: boolean) => (under ? "1" : "1 / 4");
  return {
    primaryColumn: primaryLeft ? 1 : 5,
    primaryResizerColumn: primaryLeft ? 2 : 4,
    secondaryColumn: primaryLeft ? 5 : 1,
    secondaryResizerColumn: primaryLeft ? 4 : 2,
    primaryRows: rows(primaryLeft ? underLeft : underRight),
    secondaryRows: rows(primaryLeft ? underRight : underLeft),
    panelColumns: `${underLeft ? 1 : 3} / ${underRight ? 6 : 4}`,
    primaryDirection: primaryLeft ? 1 : -1,
    secondaryDirection: primaryLeft ? -1 : 1,
  };
}

// .body 에 인라인으로 거는 CSS 변수. 규칙은 web/styles.css 의 `.body` 블록이 읽는다.
export function gridVars(config: Pick<LayoutConfig, "sideBar" | "panelAlignment">): Record<string, string> {
  const plan = gridPlan(config);
  return {
    "--grid-primary-col": String(plan.primaryColumn),
    "--grid-primary-resizer-col": String(plan.primaryResizerColumn),
    "--grid-secondary-col": String(plan.secondaryColumn),
    "--grid-secondary-resizer-col": String(plan.secondaryResizerColumn),
    "--grid-primary-rows": plan.primaryRows,
    "--grid-secondary-rows": plan.secondaryRows,
    "--grid-panel-cols": plan.panelColumns,
  };
}
