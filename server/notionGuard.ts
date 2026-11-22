import { BLOCKED_NOTION_WRITE_MESSAGE, isBlockedNotionWrite } from "../shared/notionMcp";

export type GuardOutput = Record<string, never> | { hookSpecificOutput: { hookEventName: "PreToolUse"; permissionDecision: "deny"; permissionDecisionReason: string } };

export function notionWriteGuard(input: { hook_event_name?: string; tool_name?: unknown }, options: { allowDirect?: boolean } = {}): GuardOutput {
  try {
    const name = input.hook_event_name === "PreToolUse" && typeof input.tool_name === "string" ? input.tool_name : "";
    if (!isBlockedNotionWrite(name) || options.allowDirect === true) return {};
  } catch {
  }
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: BLOCKED_NOTION_WRITE_MESSAGE } };
}
