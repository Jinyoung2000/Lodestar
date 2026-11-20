import { BLOCKED_NOTION_WRITE_MESSAGE, isBlockedNotionWrite } from "../shared/notionMcp";

// 에이전트 세션의 PreToolUse 훅이 쓰는 판정. Notion 쓰기 도구(읽기 목록에 없는 Notion 도구)는 거절한다.
// 예외는 allowDirect 가 정확히 true 일 때뿐이다(Bypass Permissions 이고 설정이 "apply", 판정은 server/agents.ts 의 notionGate).
// 허용할 때는 빈 결과를 돌려 CLI 의 다음 판정에 맡긴다. 어떤 예외가 나도 쓰기 도구는 통과하지 않는다.
export type GuardOutput = Record<string, never> | { hookSpecificOutput: { hookEventName: "PreToolUse"; permissionDecision: "deny"; permissionDecisionReason: string } };

export function notionWriteGuard(input: { hook_event_name?: string; tool_name?: unknown }, options: { allowDirect?: boolean } = {}): GuardOutput {
  try {
    const name = input.hook_event_name === "PreToolUse" && typeof input.tool_name === "string" ? input.tool_name : "";
    if (!isBlockedNotionWrite(name) || options.allowDirect === true) return {};
  } catch {
    // 판정이 실패하면 거절한다
  }
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: BLOCKED_NOTION_WRITE_MESSAGE } };
}
