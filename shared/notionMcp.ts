
export const NOTION_SERVER = "notion";
export const OWN_SERVER = "lodestar_notion";
export const OWN_PREFIX = `mcp__${OWN_SERVER}__`;

export const OWN_TOOLS = {
  updatePage: "notion_update_page",
  createPages: "notion_create_pages",
  boardAdd: "board_add_cards",
  startSession: "start_work_session",
} as const;

export const NOTION_PROPOSE_TOOLS: readonly string[] = [`${OWN_PREFIX}${OWN_TOOLS.updatePage}`, `${OWN_PREFIX}${OWN_TOOLS.createPages}`];

export const isNotionProposeTool = (name: string) => NOTION_PROPOSE_TOOLS.includes(name);

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

const base = (tool: string) => tool.toLowerCase().replace(/_/g, "-").replace(/^notion-/, "");

export type NotionToolClass = "own" | "read" | "write" | "other";

export function classifyTool(full: string): NotionToolClass {
  const name = parseMcpName(full);
  if (!name) return "other";
  if (name.server === OWN_SERVER) return "own";
  const notion = /notion/i.test(name.server) || /^notion[-_]/i.test(name.tool);
  if (!notion) return "other";
  return READ_TOOLS.has(base(name.tool)) ? "read" : "write";
}

export const isBlockedNotionWrite = (full: string) => classifyTool(full) === "write";

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

export const ALL_KNOWN_NOTION_TOOLS: readonly string[] = [...READ_TOOLS, ...KNOWN_WRITE_TOOLS];

export function allToolsExcept(server: string, tool: string): string[] {
  return ALL_KNOWN_NOTION_TOOLS.filter((t) => `notion-${t}` !== tool).map((t) => `mcp__${server}__notion-${t}`);
}

export function notionDisallowedTools(servers: readonly string[] = ["notion", "claude_ai_Notion", "claude.ai Notion"]): string[] {
  return servers.flatMap((server) => KNOWN_WRITE_TOOLS.map((tool) => `mcp__${server}__notion-${tool}`));
}

export const BLOCKED_NOTION_WRITE_MESSAGE = "Direct Notion writes are disabled in Lodestar. Use the notion_update_page or notion_create_pages tool from the lodestar_notion server instead. The user reviews the change as a diff and approves it before anything is sent to Notion.";
