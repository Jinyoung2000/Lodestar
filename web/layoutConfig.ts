export type SideBarPosition = "left" | "right";
export type PanelAlignment = "left" | "right" | "center" | "justify";

export const SIDE_BAR_POSITIONS: readonly SideBarPosition[] = ["left", "right"];
export const PANEL_ALIGNMENTS: readonly PanelAlignment[] = ["left", "right", "center", "justify"];

export type LayoutConfig = {
  sideBar: SideBarPosition;
  panelAlignment: PanelAlignment;
  activityBar: boolean;
};

export const DEFAULT_LAYOUT_CONFIG: LayoutConfig = { sideBar: "left", panelAlignment: "center", activityBar: true };

export const isSideBarPosition = (value: unknown): value is SideBarPosition => value === "left" || value === "right";
export const isPanelAlignment = (value: unknown): value is PanelAlignment => value === "left" || value === "right" || value === "center" || value === "justify";

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

export type GridPlan = {
  primaryColumn: number;
  primaryResizerColumn: number;
  secondaryColumn: number;
  secondaryResizerColumn: number;
  primaryRows: string;
  secondaryRows: string;
  panelColumns: string;
  primaryDirection: 1 | -1;
  secondaryDirection: 1 | -1;
};

export function gridPlan(config: Pick<LayoutConfig, "sideBar" | "panelAlignment">): GridPlan {
  const primaryLeft = config.sideBar === "left";
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
