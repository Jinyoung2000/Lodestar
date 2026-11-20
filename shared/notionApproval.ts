// Notion 쓰기를 카드 승인으로 받을지, 바로 반영할지 정하는 판정. 데몬(승인 카드, 직접 쓰기 훅)과 시험이 같이 쓴다.
// 권한 모드가 Bypass Permissions 이고 설정이 "apply" 일 때만 바로 반영한다. 그 밖(모드 Ask Before Edits, Edit Automatically, Plan, Auto, 설정 "ask", 모르는 값)은 전부 카드다.

export type NotionBypassWrites = "apply" | "ask";
export const NOTION_BYPASS_WRITES: readonly NotionBypassWrites[] = ["apply", "ask"];
export const DEFAULT_NOTION_BYPASS_WRITES: NotionBypassWrites = "apply";

export type NotionWriteGate = "apply" | "ask";

export function notionWriteGate(mode: unknown, setting: unknown): NotionWriteGate {
  return mode === "bypassPermissions" && setting === "apply" ? "apply" : "ask";
}
