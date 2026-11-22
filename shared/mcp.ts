import type { McpStatus } from "./protocol";

export function isClaudeAiServer(server: Pick<McpStatus, "name" | "source">) {
  return server.source === "claudeai" || server.name.startsWith("claude.ai ");
}

export const CLAUDE_AI_CONNECTORS_URL = "https://claude.ai/settings/connectors";

export const SLACK_NOT_CONNECTED_PREFIX = "Slack MCP is not connected";
export const SLACK_SERVER_NAME = "slack";
