import { readFileSync } from "node:fs";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { allToolsExcept, NOTION_SERVER } from "../shared/notionMcp";
import { claudeBin, claudeEnv, mcpServerConfig } from "./claude";
import { HOME } from "./store";
import { spawnInGroup } from "./processGroups";
import { toolResultText } from "./notionResult";

// 데몬이 Notion MCP 를 부르는 일회성 CLI 세션 (server/inbox.ts 의 runSlackSession 과 같은 방식).
//  - Notion 서버 하나만 연결하고(strictMcpConfig), 내장 도구는 없다(tools: []). 사용자 설정과 훅은 읽지 않는다(settingSources: []).
//  - 허용 도구는 호출자가 지정한 하나뿐이다. PreToolUse 훅이 그 외 도구를 거절하고, 허용한 도구의 입력은 모델이 만든 값이 아니라 호출자가 넘긴 값으로 통째로 바꾼다(updatedInput).
//    그래서 쓰기 도구도 "승인한 내용 그대로" 한 번만 나간다. 모델은 도구를 부르기만 한다.
//  - persistSession: false. 페이지 내용이 ~/.claude/projects 에 남지 않게 한다.

export const NOTION_SESSION_MODEL = "haiku";

export type NotionToolName = "notion-fetch" | "notion-update-page" | "notion-create-pages";

export type NotionCallResult = { name: string; input: Record<string, unknown>; text: string; isError: boolean };
export type NotionSessionOutcome = { call: NotionCallResult | null; calls: number; costUsd: number | null; turns: number | null };

// 시험 인스턴스는 AGENT_NAV_NOTION_MCP 에 가짜 서버 설정(JSON 파일)을 가리키면 실제 Notion 대신 그것을 쓴다.
export function notionServerConfig(env: NodeJS.ProcessEnv = process.env): Record<string, unknown> | null {
  const override = env.AGENT_NAV_NOTION_MCP;
  if (override) {
    try {
      return JSON.parse(readFileSync(override, "utf8")) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  return mcpServerConfig("notion");
}

export const notionOverridden = (env: NodeJS.ProcessEnv = process.env) => !!env.AGENT_NAV_NOTION_MCP;

export class NotionNotConnected extends Error {}

export async function runNotionSession(tool: NotionToolName, input: Record<string, unknown>, server: Record<string, unknown> | null = notionServerConfig()): Promise<NotionSessionOutcome> {
  if (!server) throw new NotionNotConnected("The Notion MCP server is not configured in ~/.claude.json (mcpServers.notion). Connect it in Claude Code first.");
  const full = `mcp__${NOTION_SERVER}__${tool}`;
  const q = query({
    prompt: `Call the ${full} tool exactly once with an empty object as arguments (the arguments are filled in for you). Then reply with the single word DONE.`,
    options: {
      cwd: HOME,
      env: claudeEnv(),
      model: NOTION_SESSION_MODEL,
      maxTurns: 4,
      tools: [],
      allowedTools: [full],
      // 다른 Notion 도구의 정의가 모델 입력에 실리면 호출 한 번이 몇 배로 비싸진다(fetch 한 번 $0.021). 알려진 나머지를 도구 목록에서 뺀다.
      disallowedTools: allToolsExcept(NOTION_SERVER, tool),
      permissionMode: "dontAsk",
      settingSources: [],
      strictMcpConfig: true,
      mcpServers: { [NOTION_SERVER]: server as never },
      systemPrompt: "You run one tool call for a local app. Call the one named tool once, with any arguments. Do not call any other tool. After the result arrives, reply with the single word DONE.",
      persistSession: false,
      includePartialMessages: false,
      pathToClaudeCodeExecutable: claudeBin(),
      spawnClaudeCodeProcess: spawnInGroup,
      hooks: {
        PreToolUse: [
          {
            timeout: 300,
            hooks: [
              async (hook) => {
                const name = hook.hook_event_name === "PreToolUse" ? hook.tool_name : "";
                if (name === full) return { hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "allow" as const, updatedInput: input } };
                return { hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "deny" as const, permissionDecisionReason: "Not allowed in a Notion session" } };
              },
            ],
          },
        ],
      },
    },
  });
  const uses = new Map<string, { name: string; input: Record<string, unknown> }>();
  let call: NotionCallResult | null = null;
  let calls = 0;
  let costUsd: number | null = null;
  let turns: number | null = null;
  try {
    for await (const message of q) {
      if (message.type === "system" && message.subtype === "init") {
        const notion = (message.mcp_servers ?? []).find((s) => s.name === NOTION_SERVER);
        if (!notion || notion.status !== "connected") throw new NotionNotConnected(`Notion MCP is not connected (status: ${notion?.status ?? "missing"}). Reconnect it in Claude Code with /mcp.`);
      } else if (message.type === "assistant") {
        for (const block of message.message.content) if (block.type === "tool_use") uses.set(block.id, { name: block.name, input: (block.input ?? {}) as Record<string, unknown> });
      } else if (message.type === "user") {
        const content = (message.message as { content?: unknown }).content;
        if (!Array.isArray(content)) continue;
        for (const block of content as { type: string; tool_use_id?: string; content?: unknown; is_error?: boolean }[]) {
          if (block.type !== "tool_result" || !block.tool_use_id) continue;
          const use = uses.get(block.tool_use_id);
          if (use?.name !== full) continue;
          calls++;
          call ??= { name: use.name, input, text: toolResultText(block.content), isError: !!block.is_error };
        }
      } else if (message.type === "result") {
        costUsd = message.total_cost_usd ?? null;
        turns = message.num_turns ?? null;
      }
    }
  } finally {
    q.close();
  }
  return { call, calls, costUsd, turns };
}
