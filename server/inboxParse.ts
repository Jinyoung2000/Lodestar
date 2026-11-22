import type { InboxItem, InboxKind, InboxThreadMessage } from "../shared/protocol";

export { appLink } from "../shared/inbox";


export const SLACK_READ_TOOLS = {
  search: "mcp__slack__slack_search_public_and_private",
  thread: "mcp__slack__slack_read_thread",
  profile: "mcp__slack__slack_read_user_profile",
} as const;

export const SLACK_WRITE_PATTERN = /^mcp__slack__slack_(send|add|create|update|schedule|complete|get_file_upload|delete|remove|set|invite|archive|join|leave|mark|upload)/;

export const SLACK_DISALLOWED_TOOLS = [
  "slack_send_message",
  "slack_send_message_draft",
  "slack_schedule_message",
  "slack_add_reaction",
  "slack_create_canvas",
  "slack_update_canvas",
  "slack_create_conversation",
  "slack_create_list",
  "slack_add_list_record",
  "slack_update_list",
  "slack_update_list_record",
  "slack_get_file_upload_url",
  "slack_complete_file_upload",
].map((name) => `mcp__slack__${name}`);

export function toolResultJson(content: unknown): Record<string, unknown> | null {
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((block) => (block && typeof block === "object" && "text" in block ? String((block as { text: unknown }).text) : "")).join("")
        : "";
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function parseProfile(result: Record<string, unknown> | null): string | null {
  const text = typeof result?.result === "string" ? result.result : "";
  return text.match(/^User ID:\s*(U[0-9A-Z]+)\s*$/m)?.[1] ?? null;
}

export function nextCursor(result: Record<string, unknown> | null): string | null {
  const text = typeof result?.pagination_info === "string" ? result.pagination_info : "";
  return text.match(/cursor `([^`]+)`/)?.[1] ?? null;
}

export type SearchHit = {
  channelId: string;
  channelName: string;
  fromId: string;
  fromName: string;
  isBot: boolean;
  ts: string;
  threadTs: string | null;
  permalink: string;
  text: string;
};

const RESULT_SPLIT = /^### Result \d+ of \d+\s*$/m;

export function parseSearch(result: Record<string, unknown> | null): SearchHit[] {
  const markdown = typeof result?.results === "string" ? result.results : "";
  const hits: SearchHit[] = [];
  const blocks = markdown.split(RESULT_SPLIT).slice(1);
  for (const block of blocks) {
    const at = block.search(/^Text:/m);
    if (at < 0) continue;
    const head = block.slice(0, at);
    const body = block
      .slice(at)
      .replace(/^Text:[ \t]*\n?/, "")
      .replace(/\n+---\s*$/, "")
      .trim();
    const field = (label: string) => head.match(new RegExp(`^${label}:[ \\t]*(.*)$`, "m"))?.[1]?.trim() ?? "";
    const channel = field("Channel").match(/^(.*?)\s*\(ID:\s*([A-Z0-9]+)\)\s*$/);
    const from = field("From").match(/^(.*?)(?:\s*<[^>]*>)?\s*\(ID:\s*(U[0-9A-Z]+)\)\s*(\[BOT\])?\s*$/);
    const ts = field("Message_ts");
    const permalink = field("Permalink").match(/\((https?:\/\/[^)\s]+)\)/)?.[1] ?? "";
    if (!channel || !from || !/^\d+\.\d+$/.test(ts)) continue;
    const threadTs = permalink.match(/[?&]thread_ts=(\d+\.\d+)/)?.[1] ?? null;
    hits.push({
      channelId: channel[2],
      channelName: channel[1] || channel[2],
      fromId: from[2],
      fromName: from[1].trim() || from[2],
      isBot: !!from[3],
      ts,
      threadTs,
      permalink,
      text: body,
    });
  }
  return hits;
}

export function classify(hit: SearchHit, selfUserId: string, fallback: InboxKind): InboxKind {
  if (hit.channelId.startsWith("D") || hit.channelName === "DM") return "dm";
  if (hit.text.includes(`<@${selfUserId}`)) return "mention";
  if (hit.threadTs && hit.threadTs !== hit.ts) return "thread";
  return fallback;
}

export function toItems(hits: { hit: SearchHit; fallback: InboxKind }[], selfUserId: string, fetchedAt: string): InboxItem[] {
  const items = new Map<string, InboxItem>();
  for (const { hit, fallback } of hits) {
    if (hit.fromId === selfUserId) continue;
    const kind = classify(hit, selfUserId, fallback);
    if (kind === "thread" && !(hit.threadTs && hit.threadTs !== hit.ts)) continue;
    const id = `${hit.channelId}:${hit.ts}`;
    if (items.has(id)) continue;
    items.set(id, {
      id,
      kind,
      channelId: hit.channelId,
      channelName: hit.channelName,
      ts: hit.ts,
      threadTs: hit.threadTs && hit.threadTs !== hit.ts ? hit.threadTs : null,
      from: { id: hit.fromId, name: hit.fromName },
      text: hit.text,
      permalink: hit.permalink,
      time: new Date(parseFloat(hit.ts) * 1000).toISOString(),
      read: false,
      archived: false,
      fetchedAt,
    });
  }
  return [...items.values()];
}

export function parseThread(result: Record<string, unknown> | null): InboxThreadMessage[] {
  const text = typeof result?.messages === "string" ? result.messages : "";
  const messages: InboxThreadMessage[] = [];
  const parts = text.split(/^(?:===\s*(?:thread\s+)?parent message\s*===|---\s*reply\s+\d+\s+of\s+\d+\s*---)\s*$/im).slice(1);
  for (const part of parts) {
    const lines = part.replace(/^\n/, "").split("\n");
    const from = lines.find((l) => l.startsWith("From:"))?.match(/^From:\s*(.*?)(?:\s*<[^>]*>)?\s*\((U[0-9A-Z]+)\)/);
    const tsLine = lines.findIndex((l) => /^Message TS:\s*\d+\.\d+\s*$/i.test(l));
    if (!from || tsLine < 0) continue;
    const ts = lines[tsLine].replace(/^Message TS:\s*/i, "").trim();
    const bodyLines: string[] = [];
    for (const line of lines.slice(tsLine + 1)) {
      if (/^=== .* ===\s*$/.test(line)) break;
      bodyLines.push(line);
    }
    const body = bodyLines
      .filter((l) => !/^(Reactions|Thread|Files|Thread info):/i.test(l))
      .join("\n")
      .trim();
    messages.push({ ts, from: { id: from[2], name: from[1].trim() || from[2] }, text: body });
  }
  return messages;
}

export function toMentionItems(hits: SearchHit[], selfUserId: string, fetchedAt: string): InboxItem[] {
  const items = new Map<string, InboxItem>();
  for (const hit of hits) {
    if (hit.fromId === selfUserId) continue;
    if (hit.channelId.startsWith("D") || hit.channelName === "DM") continue;
    const id = `${hit.channelId}:${hit.ts}`;
    if (items.has(id)) continue;
    items.set(id, {
      id,
      kind: "mention",
      channelId: hit.channelId,
      channelName: hit.channelName,
      ts: hit.ts,
      threadTs: hit.threadTs && hit.threadTs !== hit.ts ? hit.threadTs : null,
      from: { id: hit.fromId, name: hit.fromName },
      text: hit.text,
      permalink: hit.permalink,
      time: new Date(parseFloat(hit.ts) * 1000).toISOString(),
      read: false,
      archived: false,
      fetchedAt,
    });
  }
  return [...items.values()];
}

export function toThreadItems(hits: SearchHit[], selfUserId: string, fetchedAt: string): InboxItem[] {
  const replies = hits.filter((hit) => hit.threadTs && hit.threadTs !== hit.ts);
  return toMentionItems(replies, selfUserId, fetchedAt).map((item) => (item.text.includes(`<@${selfUserId}`) ? item : { ...item, kind: "thread" as const }));
}

export const NOTION_READ_TOOLS = ["mcp__notion__notion-fetch", "mcp__notion__notion-search"] as const;

export const NOTION_WRITE_PATTERN = /^mcp__notion__notion-(create|update|delete|move|duplicate|restore|upload|send|spawn|stop|set|convert|add)/;

export const NOTION_DISALLOWED_TOOLS = [
  "notion-create-attachment",
  "notion-create-comment",
  "notion-create-database",
  "notion-create-file-upload",
  "notion-create-folder",
  "notion-create-pages",
  "notion-create-view",
  "notion-delete-comment",
  "notion-delete-databases",
  "notion-delete-pages",
  "notion-duplicate-page",
  "notion-move-pages",
  "notion-restore-pages",
  "notion-send-message-to-session",
  "notion-set-comment-reaction",
  "notion-set-discussion-resolved",
  "notion-spawn-session",
  "notion-stop-session",
  "notion-update-comment",
  "notion-update-data-source",
  "notion-update-enabled-skills",
  "notion-update-folder",
  "notion-update-page",
  "notion-update-view",
  "notion-upload-skill",
  "notion-convert-page-to-skill",
].map((name) => `mcp__notion__${name}`);

export const ANALYSIS_HIDDEN_READ_TOOLS = [
  ...[
    "slack_get_reactions",
    "slack_list_channel_members",
    "slack_list_user_channels",
    "slack_read_canvas",
    "slack_read_channel",
    "slack_read_file",
    "slack_read_list",
    "slack_search_channels",
    "slack_search_emojis",
    "slack_search_public",
    "slack_search_users",
  ].map((name) => `mcp__slack__${name}`),
  ...[
    "notion-check-mcp-next-steps",
    "notion-download-attachment",
    "notion-download-skill",
    "notion-get-async-task",
    "notion-get-comments",
    "notion-get-enabled-skills",
    "notion-get-file-download-urls",
    "notion-get-self",
    "notion-get-session-status",
    "notion-get-teams",
    "notion-get-tool-access",
    "notion-get-users",
    "notion-list-favorite-pages",
    "notion-list-private-pages",
    "notion-list-recent-pages",
    "notion-list-session-events",
    "notion-list-shared-pages",
    "notion-memory-search",
    "notion-query-data-sources",
    "notion-query-meeting-notes",
    "notion-query-multiple-data-sources",
    "notion-query-sessions",
    "notion-read-session-event",
    "notion-search-agents",
    "notion-search-sessions",
    "notion-show-advanced-analysis-next-steps",
    "notion-wait-session",
  ].map((name) => `mcp__notion__${name}`),
];

export const ANALYSIS_BLOCKED_BUILTINS = ["Edit", "Write", "Bash", "NotebookEdit", "WebFetch", "WebSearch", "Task", "Agent", "TodoWrite", "MultiEdit"];

export const ANALYSIS_ALLOWED_TOOLS: string[] = [...Object.values(SLACK_READ_TOOLS), ...NOTION_READ_TOOLS, "Read", "Grep", "Glob"];
