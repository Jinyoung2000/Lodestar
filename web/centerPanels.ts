
export type CenterViewName = "sessions" | "board" | "inbox" | "pr" | "improvements" | "notion" | "notes" | "skills";

export const sessionPanelShown = (centerView: CenterViewName, rightOpen: boolean): boolean => centerView === "sessions" && rightOpen;

export const sessionPanelToggleable = (centerView: CenterViewName): boolean => centerView === "sessions";

export const cardOpensInSessionPanel = (centerView: CenterViewName): boolean => centerView === "sessions";

const RETIRED_TAB_KEYS: readonly string[] = ["inbox"];
export const isRetiredTabKey = (key: unknown): boolean => typeof key === "string" && RETIRED_TAB_KEYS.includes(key);

export function sanitizeRestoredTabs(restored: { activeTabKey?: unknown; sideTabKey?: unknown; groupActive?: unknown } | null | undefined): { activeTabKey: string | null; sideTabKey: string; groupActive: Record<string, string | null> } {
  const key = (value: unknown, fallback: string) => (typeof value === "string" && !isRetiredTabKey(value) ? value : fallback);
  const saved = restored?.groupActive && typeof restored.groupActive === "object" ? (restored.groupActive as Record<string, unknown>) : {};
  const groupActive: Record<string, string | null> = {};
  for (const [group, value] of Object.entries(saved)) if (value === null || (typeof value === "string" && !isRetiredTabKey(value))) groupActive[group] = value;
  return { activeTabKey: restored?.activeTabKey === null ? null : key(restored?.activeTabKey, "changes"), sideTabKey: key(restored?.sideTabKey, "changes"), groupActive };
}

export function detailWidthLimits(container: number, min: number, listMin: number): { min: number; max: number } {
  return { min, max: Math.max(min, container - listMin) };
}
