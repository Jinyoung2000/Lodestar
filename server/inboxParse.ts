import type { InboxItem, InboxKind, InboxThreadMessage } from "../shared/protocol";

export { appLink } from "../shared/inbox";


export const SLACK_READ_TOOLS = {
  search: "mcp__slack__slack_search_public_and_private",
  thread: "mcp__slack__slack_read_thread",
  profile: "mcp__slack__slack_read_user_profile",
} as const;

// 쓰기 도구 이름의 패턴. 데몬은 이 이름의 도구를 허용하지 않고, init 의 도구 목록에 보이면 가져오기를 중단한다.
export const SLACK_WRITE_PATTERN = /^mcp__slack__slack_(send|add|create|update|schedule|complete|get_file_upload|delete|remove|set|invite|archive|join|leave|mark|upload)/;

// 위 패턴과 별개로, 이름을 직접 적은 차단 목록 (disallowedTools). claude.ai Slack 커넥터의 쓰기 도구 전부.
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

// tool_result 의 content (문자열이거나 [{type:"text", text}] 배열)에서 JSON 본문을 꺼낸다.
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

// 다음 쪽 커서. 있으면 검색 결과가 한 쪽을 넘는다는 뜻이다.
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

// 검색 결과 마크다운을 블록별로 나눠 읽는다. 본문(Text:) 안에 "Channel:" 같은 줄이 있을 수 있어서, Text: 앞의 머리 줄만 필드로 읽는다.
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

// 종류는 결과 자체에서 정한다: DM 채널(D 로 시작) > 본문의 멘션 > 스레드 답글. 어느 것도 아니면 그 검색의 종류(fallback)를 쓴다.
export function classify(hit: SearchHit, selfUserId: string, fallback: InboxKind): InboxKind {
  if (hit.channelId.startsWith("D") || hit.channelName === "DM") return "dm";
  if (hit.text.includes(`<@${selfUserId}`)) return "mention";
  if (hit.threadTs && hit.threadTs !== hit.ts) return "thread";
  return fallback;
}

// 본인 글을 빼고, (채널, ts) 로 중복을 없애고, 항목으로 바꾼다. 스레드 검색(fallback "thread")에서 답글이 아닌 글은 버린다.
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

// 스레드 읽기 결과. 검색 결과와 라벨이 다르다 ("Message TS:", From 에 "ID:" 없음). 첫 메시지가 부모, 나머지가 답글이다.
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
    // 본문은 Message TS 다음 줄부터. 다음 구역 머리(=== ... ===)나 반응/스레드 정보 줄 앞에서 끊는다.
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

// 멘션 검색 결과만 항목으로 바꾼다 (Mentions 화면용). 검색 자체가 "<@내ID>" 키워드라서 종류는 항상 mention 이고,
// 본인 글과 DM 채널(D 로 시작)은 뺀다. (채널, ts) 로 중복을 없앤다. 스레드 답글이어도 나를 멘션했으면 들어온다.
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

// 참여한 스레드 검색(is:thread with:<@나>) 결과를 항목으로 바꾼다 (Mentions 화면의 Threads 항목).
// 본인 글, DM 채널, 답글이 아닌 글(스레드 부모)은 뺀다. 나를 멘션한 답글은 멘션으로 둔다:
// 멘션 검색이 한 쪽 한도(20건)에 걸려 빠졌더라도 이 검색에서 잡히면 놓치지 않고, 멘션이라 요청 판단 대상이 된다.
export function toThreadItems(hits: SearchHit[], selfUserId: string, fetchedAt: string): InboxItem[] {
  const replies = hits.filter((hit) => hit.threadTs && hit.threadTs !== hit.ts);
  return toMentionItems(replies, selfUserId, fetchedAt).map((item) => (item.text.includes(`<@${selfUserId}`) ? item : { ...item, kind: "thread" as const }));
}

// --- 멘션 분석 세션이 쓰는 도구 ---
// 분석 세션은 읽기만 한다: Slack 읽기 3개, Notion fetch 와 search, 그리고 워크스페이스 안의 Read, Grep, Glob.
// 이름으로 허용한 것만 통과시키고(PreToolUse 훅), 쓰기 도구는 disallowedTools 로 한 번 더 막고, init 의 도구 목록에 쓰기 이름이 보이면 중단한다.

export const NOTION_READ_TOOLS = ["mcp__notion__notion-fetch", "mcp__notion__notion-search"] as const;

export const NOTION_WRITE_PATTERN = /^mcp__notion__notion-(create|update|delete|move|duplicate|restore|upload|send|spawn|stop|set|convert|add)/;

// Notion 의 쓰기 도구 이름 전부 (disallowedTools). 읽기 도구라도 fetch, search 가 아니면 허용하지 않는다.
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

// 분석에 필요 없는 읽기 도구. 쓰기가 아니라 비용 때문에 숨긴다: 도구 정의가 모델 입력에 들어가서, 46개를 다 열면 한 턴 입력이 7만 5천 토큰이라 비용 상한($0.15)이 한 턴에 찬다.
// 허용 목록(PreToolUse 훅)이 이 도구들도 이름으로 거절하므로 숨김은 비용 절감일 뿐 안전 장치가 아니다.
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

// 내장 도구 중 막는 것. 분석 세션은 tools 로 Read, Grep, Glob 만 열고 이 목록으로 한 번 더 막는다.
export const ANALYSIS_BLOCKED_BUILTINS = ["Edit", "Write", "Bash", "NotebookEdit", "WebFetch", "WebSearch", "Task", "Agent", "TodoWrite", "MultiEdit"];

export const ANALYSIS_ALLOWED_TOOLS: string[] = [...Object.values(SLACK_READ_TOOLS), ...NOTION_READ_TOOLS, "Read", "Grep", "Glob"];
