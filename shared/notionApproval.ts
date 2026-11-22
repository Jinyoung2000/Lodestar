
export type NotionBypassWrites = "apply" | "ask";
export const NOTION_BYPASS_WRITES: readonly NotionBypassWrites[] = ["apply", "ask"];
export const DEFAULT_NOTION_BYPASS_WRITES: NotionBypassWrites = "apply";

export type NotionWriteGate = "apply" | "ask";

export function notionWriteGate(mode: unknown, setting: unknown): NotionWriteGate {
  return mode === "bypassPermissions" && setting === "apply" ? "apply" : "ask";
}
