// Notion MCP 도구 이름의 분류. 어떤 서버 이름으로 붙어도(설정의 notion, claude.ai 커넥터, 시험용 가짜) 같은 판정을 하도록 서버 이름이 아니라 도구 이름을 본다.
// 쓰기 판정은 "읽기 목록에 없으면 쓰기" 이다. Notion 이 새 도구를 더해도 승인 없이 열리지 않는다(fail closed).

// 데몬이 직접 띄우는 짧은 세션에서 Notion 서버에 붙이는 이름. 도구 전체 이름은 mcp__notion__<도구>.
export const NOTION_SERVER = "notion";
// 에이전트 세션에 붙는 in-process 서버. Notion 쓰기는 이 서버의 제안 도구만 거친다.
export const OWN_SERVER = "lodestar_notion";
export const OWN_PREFIX = `mcp__${OWN_SERVER}__`;

export const OWN_TOOLS = {
  updatePage: "notion_update_page",
  createPages: "notion_create_pages",
  boardAdd: "board_add_cards",
  startSession: "start_work_session",
} as const;

// 쓰기 제안 도구 두 개(승인 카드를 띄우는 도구). 보드 카드와 새 세션 도구는 Notion 을 바꾸지 않는다.
export const NOTION_PROPOSE_TOOLS: readonly string[] = [`${OWN_PREFIX}${OWN_TOOLS.updatePage}`, `${OWN_PREFIX}${OWN_TOOLS.createPages}`];

export const isNotionProposeTool = (name: string) => NOTION_PROPOSE_TOOLS.includes(name);

// Notion 에 아무것도 쓰지 않는 도구(2026-10 Notion MCP 도구 목록 기준). 이 밖의 Notion 도구는 모두 쓰기로 본다.
const READ_TOOLS = new Set([
  "fetch",
  "search",
  "query-data-sources",
  "query-multiple-data-sources",
  "query-meeting-notes",
  "query-sessions",
  "get-comments",
  "get-enabled-skills",
  "get-file-download-urls",
  "get-self",
  "get-teams",
  "get-tool-access",
  "get-users",
  "get-session-status",
  "get-async-task",
  "list-favorite-pages",
  "list-private-pages",
  "list-recent-pages",
  "list-shared-pages",
  "list-session-events",
  "memory-search",
  "read-session-event",
  "search-agents",
  "search-sessions",
  "download-attachment",
  "download-skill",
  "check-mcp-next-steps",
  "show-advanced-analysis-next-steps",
  "wait-session",
]);

export type McpName = { server: string; tool: string };

export function parseMcpName(full: string): McpName | null {
  const match = /^mcp__(.+?)__(.+)$/.exec(full);
  return match ? { server: match[1], tool: match[2] } : null;
}

// 도구 이름에서 "notion-" 접두사를 떼고 밑줄을 하이픈으로 맞춘다.
const base = (tool: string) => tool.toLowerCase().replace(/_/g, "-").replace(/^notion-/, "");

export type NotionToolClass = "own" | "read" | "write" | "other";

// own: 우리 in-process 서버, read: Notion 읽기, write: Notion 쓰기(막는다), other: Notion 과 상관없음.
export function classifyTool(full: string): NotionToolClass {
  const name = parseMcpName(full);
  if (!name) return "other";
  if (name.server === OWN_SERVER) return "own";
  const notion = /notion/i.test(name.server) || /^notion[-_]/i.test(name.tool);
  if (!notion) return "other";
  return READ_TOOLS.has(base(name.tool)) ? "read" : "write";
}

// 승인 없이 열려 있으면 안 되는 Notion 쓰기 도구인가(에이전트 세션의 PreToolUse 훅이 거절하는 대상).
export const isBlockedNotionWrite = (full: string) => classifyTool(full) === "write";

// 알려진 서버 이름들의 쓰기 도구를 도구 목록에서 미리 뺀다(모델이 시도하지 않게). 모르는 이름은 훅이 막는다.
const KNOWN_WRITE_TOOLS = [
  "create-attachment",
  "create-comment",
  "create-database",
  "create-file-upload",
  "create-folder",
  "create-pages",
  "create-view",
  "delete-comment",
  "delete-databases",
  "delete-pages",
  "duplicate-page",
  "move-pages",
  "restore-pages",
  "set-comment-reaction",
  "set-discussion-resolved",
  "update-comment",
  "update-data-source",
  "update-enabled-skills",
  "update-folder",
  "update-page",
  "update-view",
  "upload-skill",
  "convert-page-to-skill",
  "send-message-to-session",
  "spawn-session",
  "stop-session",
];

// 읽기 도구와 쓰기 도구를 합친 알려진 전체 이름(notion- 접두사 없이).
export const ALL_KNOWN_NOTION_TOOLS: readonly string[] = [...READ_TOOLS, ...KNOWN_WRITE_TOOLS];

// 데몬의 짧은 세션이 필요한 도구 하나만 모델에게 보이게 하려고, 나머지 알려진 도구를 서버 이름 기준으로 뺀다. 모델에게 가는 도구 정의가 줄어 호출 비용이 크게 준다.
export function allToolsExcept(server: string, tool: string): string[] {
  return ALL_KNOWN_NOTION_TOOLS.filter((t) => `notion-${t}` !== tool).map((t) => `mcp__${server}__notion-${t}`);
}

export function notionDisallowedTools(servers: readonly string[] = ["notion", "claude_ai_Notion", "claude.ai Notion"]): string[] {
  return servers.flatMap((server) => KNOWN_WRITE_TOOLS.map((tool) => `mcp__${server}__notion-${tool}`));
}

export const BLOCKED_NOTION_WRITE_MESSAGE = "Direct Notion writes are disabled in Lodestar. Use the notion_update_page or notion_create_pages tool from the lodestar_notion server instead. The user reviews the change as a diff and approves it before anything is sent to Notion.";
