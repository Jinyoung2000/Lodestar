// MCP 재연결과 상태 변환의 단독 시험 (데몬과 CLI 없이, 가짜 Query 로).
// 실행: npm test
import type { McpServerStatus } from "@anthropic-ai/claude-agent-sdk";
import { isClaudeAiServer } from "../shared/mcp";
import { errorText, reconnectInSessions, settleMcp, toMcpStatus, type McpControl } from "../server/mcp";

const cases: { name: string; run: () => Promise<string> }[] = [];
const test = (name: string, run: () => Promise<string>) => cases.push({ name, run });
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
  return detail;
};

type Fake = McpControl & { calls: string[] };
// statuses: 호출 순서대로 돌려줄 목록. 마지막 것이 계속 반복된다.
function fake(statuses: McpServerStatus[][], reconnect: (name: string) => Promise<void> = async () => {}): Fake {
  const calls: string[] = [];
  let i = 0;
  return {
    calls,
    mcpServerStatus: async () => statuses[Math.min(i++, statuses.length - 1)],
    reconnectMcpServer: async (name) => {
      calls.push(`reconnect:${name}`);
      await reconnect(name);
    },
    toggleMcpServer: async (name, enabled) => void calls.push(`toggle:${name}:${enabled}`),
  };
}
const server = (name: string, status: McpServerStatus["status"], extra: Partial<McpServerStatus> = {}): McpServerStatus => ({ name, status, ...extra });

test("toMcpStatus keeps status, source, error and tool count", async () => {
  const [a, b, c] = toMcpStatus([
    server("superset", "connected", { source: "user", tools: [{ name: "x" }, { name: "y" }] }),
    server("broken", "failed", { scope: "project", error: "spawn ENOENT" }),
    server("claude.ai Sentry", "needs-auth", { source: "claudeai" }),
  ]);
  expect(a.source === "user" && a.toolCount === 2 && a.error === null, JSON.stringify(a));
  expect(b.source === "project" && b.error === "spawn ENOENT" && b.toolCount === null, JSON.stringify(b));
  return expect(c.status === "needs-auth" && c.source === "claudeai", JSON.stringify(c));
});
test("errorText drops the Error prefix and never returns an empty string", async () => {
  expect(errorText(new Error("Server status: needs-auth")) === "Server status: needs-auth", "prefix");
  expect(errorText("Error: boom") === "boom", "string");
  return expect(errorText(new Error("")) === "Unknown error", "empty");
});
test("claude.ai connectors are told apart by source, then by name prefix", async () => {
  expect(isClaudeAiServer({ name: "anything", source: "claudeai" }), "source");
  expect(isClaudeAiServer({ name: "claude.ai Linear", source: null }), "name prefix, no source");
  expect(!isClaudeAiServer({ name: "slack", source: "user" }), "local server");
  return "ok";
});
test("settleMcp polls until nothing is pending, then stops", async () => {
  const q = fake([[server("a", "pending")], [server("a", "pending")], [server("a", "connected")]]);
  const list = await settleMcp(q, 1000, 5);
  return expect(list[0].status === "connected", list[0].status);
});
test("settleMcp gives up after the time limit and reports pending", async () => {
  const q = fake([[server("a", "pending")]]);
  const list = await settleMcp(q, 30, 10);
  return expect(list[0].status === "pending", list[0].status);
});
test("reconnectInSessions only reconnects sessions where the server is not connected", async () => {
  const healthy = fake([[server("slack", "connected")]]);
  const broken = fake([[server("slack", "failed")]]);
  const needsAuth = fake([[server("slack", "needs-auth")]]);
  const disabled = fake([[server("slack", "disabled")]]);
  const without = fake([[server("other", "connected")]]);
  const result = await reconnectInSessions([healthy, broken, needsAuth, disabled, without], "slack");
  expect(healthy.calls.length === 0 && disabled.calls.length === 0 && without.calls.length === 0, "untouched sessions were called");
  expect(broken.calls[0] === "reconnect:slack" && needsAuth.calls[0] === "reconnect:slack", "broken sessions were not reconnected");
  return expect(result.reconnected === 2 && result.skipped === 3 && result.failed === 0, JSON.stringify(result));
});
test("reconnectInSessions counts a session that throws as failed and still finishes the others", async () => {
  const bad = fake([[server("slack", "failed")]], async () => {
    throw new Error("Server status: needs-auth");
  });
  const good = fake([[server("slack", "failed")]]);
  const closed: McpControl = { ...fake([[]]), mcpServerStatus: () => Promise.reject(new Error("closed")) };
  const result = await reconnectInSessions([bad, good, closed], "slack");
  return expect(result.reconnected === 1 && result.failed === 2, JSON.stringify(result));
});

let failed = 0;
for (const c of cases) {
  try {
    console.log(`PASS ${c.name}: ${await c.run()}`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${c.name}: ${(error as Error).message}`);
  }
}
console.log(`${cases.length - failed}/${cases.length} passed`);
process.exit(failed ? 1 : 0);
