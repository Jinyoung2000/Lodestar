import type { PermissionMode } from "./protocol";

export type CursorMode = "agent" | "plan" | "ask";

const TABLE: Record<PermissionMode, CursorMode> = {
  default: "agent",
  acceptEdits: "agent",
  plan: "plan",
  auto: "agent",
  bypassPermissions: "agent",
};

const EDIT_KINDS = new Set(["edit", "delete", "move"]);
const LOOK_KINDS = new Set(["read", "search", "fetch", "think"]);

export const cursorMode = (mode: PermissionMode): CursorMode => TABLE[mode];

export function cursorApproves(mode: PermissionMode, kind: string | undefined): boolean {
  if (mode === "bypassPermissions") return true;
  if (mode === "acceptEdits") return kind !== undefined && EDIT_KINDS.has(kind);
  if (mode === "auto") return kind !== undefined && (EDIT_KINDS.has(kind) || LOOK_KINDS.has(kind));
  return false;
}

export const CURSOR_MODE_NOTES: Record<PermissionMode, string> = {
  default: "Cursor mode agent. Asks before edits and commands, per your Cursor CLI permission settings.",
  acceptEdits: "Cursor mode agent. Lodestar approves file edits; commands and other requests ask.",
  plan: "Cursor mode plan. Read-only planning; no edits or commands.",
  auto: "Cursor mode agent. Lodestar approves file edits, reads and searches; commands and MCP tools ask.",
  bypassPermissions: "Cursor mode agent, and Lodestar approves every request without asking.",
};
