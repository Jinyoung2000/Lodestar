import type { McpStatus } from "./protocol";

// claude.ai 커넥터는 앱 안에서 인증할 수 없고 claude.ai 의 커넥터 설정에서만 인증된다.
// SDK 는 이름이 아니라 source 를 믿으라고 하므로 source 로 보고, source 를 모르는 옛 CLI 를 위해 이름의 접두사를 보조로 쓴다.
export function isClaudeAiServer(server: Pick<McpStatus, "name" | "source">) {
  return server.source === "claudeai" || server.name.startsWith("claude.ai ");
}

export const CLAUDE_AI_CONNECTORS_URL = "https://claude.ai/settings/connectors";

// Inbox 가 Slack MCP 연결 실패를 알아보는 오류 문구의 앞부분 (server/strings.ts 가 같은 값으로 문장을 만든다).
export const SLACK_NOT_CONNECTED_PREFIX = "Slack MCP is not connected";
// Inbox 가 읽는 서버. ~/.claude.json 의 mcpServers.slack 이다.
export const SLACK_SERVER_NAME = "slack";
