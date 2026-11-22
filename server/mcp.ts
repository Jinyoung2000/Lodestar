import type { McpServerStatus } from "@anthropic-ai/claude-agent-sdk";
import type { McpSessionResult, McpStatus } from "../shared/protocol";

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

export function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/^Error:\s*/, "") || "Unknown error";
}

export async function settleMcp(q: Pick<McpControl, "mcpServerStatus">, maxMs: number, pollMs = 1000): Promise<McpStatus[]> {
  const started = Date.now();
  let list = await q.mcpServerStatus();
  while (list.some((m) => m.status === "pending") && Date.now() - started < maxMs) {
    await new Promise((r) => setTimeout(r, pollMs));
    list = await q.mcpServerStatus();
  }
  return toMcpStatus(list);
}

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
