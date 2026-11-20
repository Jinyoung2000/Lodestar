import type { McpServerStatus } from "@anthropic-ai/claude-agent-sdk";
import type { McpSessionResult, McpStatus } from "../shared/protocol";

// MCP 상태를 읽고 다시 연결하는 데 필요한 Query 의 부분만 본다 (시험에서 가짜로 바꿔 끼우기 위해).
export type McpControl = {
  mcpServerStatus(): Promise<McpServerStatus[]>;
  reconnectMcpServer(name: string): Promise<void>;
  toggleMcpServer(name: string, enabled: boolean): Promise<void>;
};

export function toMcpStatus(list: McpServerStatus[]): McpStatus[] {
  return list.map((m) => ({
    name: m.name,
    status: m.status,
    source: m.source ?? m.scope ?? null,
    error: m.error ?? null,
    toolCount: m.tools ? m.tools.length : null,
    ...(m.tools ? { tools: m.tools.map((t) => ({ name: t.name, description: t.description?.trim() || null })) } : {}),
  }));
}

// SDK 의 예외 문구는 "Error: Server status: needs-auth" 처럼 접두사가 붙어 온다. 화면에는 사유만 보인다.
export function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/^Error:\s*/, "") || "Unknown error";
}

// 초기화 직후나 재연결 직후에는 pending 이 섞여 있어서, 끝날 때까지 잠시 기다렸다 다시 읽는다.
export async function settleMcp(q: Pick<McpControl, "mcpServerStatus">, maxMs: number, pollMs = 1000): Promise<McpStatus[]> {
  const started = Date.now();
  let list = await q.mcpServerStatus();
  while (list.some((m) => m.status === "pending") && Date.now() - started < maxMs) {
    await new Promise((r) => setTimeout(r, pollMs));
    list = await q.mcpServerStatus();
  }
  return toMcpStatus(list);
}

// 지금 턴이 도는 세션의 CLI 프로세스에도 같은 재연결을 건다. 이미 연결돼 있거나 그 세션에 없는 서버는 건드리지 않는다
// (도구를 부르는 중인 연결을 끊지 않기 위해). 대기 중인 세션은 프로세스가 없어서 대상이 아니다.
export async function reconnectInSessions(queries: McpControl[], name: string): Promise<McpSessionResult> {
  const result: McpSessionResult = { reconnected: 0, failed: 0, skipped: 0 };
  await Promise.all(
    queries.map(async (q) => {
      try {
        const own = (await q.mcpServerStatus()).find((m) => m.name === name);
        if (!own || own.status === "connected" || own.status === "disabled") {
          result.skipped++;
          return;
        }
        await q.reconnectMcpServer(name);
        result.reconnected++;
      } catch {
        result.failed++;
      }
    }),
  );
  return result;
}
