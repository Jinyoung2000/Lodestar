import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { NotionPageData } from "../shared/notionFetch";
import { OWN_SERVER, OWN_TOOLS } from "../shared/notionMcp";
import { cleanCreateArgs, cleanUpdateArgs, previewCreate, previewUpdate, type NotionWritePreview } from "../shared/notionWrite";
import { gatedWrite, writeResultText, type GatedOutcome, type WriteApproval, type WriteTool } from "./notionWrite";
import type { NotionWriteResult } from "./notion";

// 에이전트 세션에 붙는 in-process MCP 서버 (이름 lodestar_notion). Notion 에 쓰는 일은 여기 제안 도구 두 개만 거친다.
// 실제 Notion 쓰기 도구는 세션에서 막혀 있고(agents.ts 의 disallowedTools 와 PreToolUse 훅), 제안 도구의 핸들러가 승인을 받은 뒤에만 데몬의 쓰기 세션을 부른다.
// 승인은 도구 실행 안에서 받으므로 권한 모드(Bypass Permissions 포함)와 상관없다.

type CallToolResult = Awaited<ReturnType<Parameters<typeof tool>[3]>>;

export type NotionToolHost = {
  // Notion 에서 지금 페이지를 읽는다 (diff 의 기준). 못 읽으면 null.
  read: (idOrUrl: string) => Promise<NotionPageData | null>;
  // 캐시에 있는 제목 (네트워크 없음)
  cachedTitle: (idOrUrl: string) => string | null;
  ask: (toolName: string, input: Record<string, unknown>, preview: NotionWritePreview, signal?: AbortSignal) => Promise<WriteApproval>;
  write: (tool: WriteTool, args: Record<string, unknown>) => Promise<NotionWriteResult>;
  // 쓰기가 끝난 페이지 (화면이 다시 읽는다)
  changed: (idOrUrl: string) => void;
  // 페이지 전용 대화에서만 있는 앱 기능
  page: { url: string; title: string } | null;
  addCards: ((cards: { title: string; body?: string }[]) => { id: string; title: string }[]) | null;
  startSession: ((prompt: string) => void) | null;
};

const text = (value: string, isError = false): CallToolResult => ({ content: [{ type: "text", text: value }], ...(isError ? { isError: true } : {}) });

const propertyValue = z.union([z.string(), z.number(), z.array(z.string()), z.null()]);

export const UPDATE_DESCRIPTION =
  "Propose a change to a Notion page. The user sees a diff and must approve before anything is sent to Notion; this call returns after they decide (it can take a while). " +
  "Use the same Notion-flavored Markdown that notion-fetch returns. Make the smallest edit: command update_content with content_updates (old_str copied exactly from the page, new_str the replacement) for targeted changes, insert_content to prepend or append, " +
  "update_properties for database properties, and replace_content only when the whole page must change. Fetch the page first unless its text is already in this conversation.";

export const CREATE_DESCRIPTION =
  "Propose creating one or more Notion pages, including rows in a database. The user sees the new content and must approve before anything is sent to Notion; this call returns after they decide. " +
  "Give a parent (page_id, database_id or data_source_id) or set creation_mode to draft for a private page. For a database, fetch it first and use its collection:// data source id and exact property names. Put the title in properties, not at the top of content.";

export async function runUpdate(host: NotionToolHost, toolName: string, raw: unknown, signal?: AbortSignal): Promise<{ result: CallToolResult; outcome: GatedOutcome | null }> {
  const cleaned = cleanUpdateArgs(raw);
  if (!cleaned.ok) return { result: text(cleaned.error, true), outcome: null };
  const args = cleaned.args;
  const current = args.command === "update_properties" && !Object.keys(args.properties ?? {}).length ? null : await host.read(args.page_id).catch(() => null);
  const built = previewUpdate(args, current);
  if (!built.ok) return { result: text(built.error, true), outcome: null };
  const outcome = await gatedWrite({
    tool: "notion-update-page",
    args: args as unknown as Record<string, unknown>,
    ask: () => host.ask(toolName, args as unknown as Record<string, unknown>, built.preview, signal),
    run: (tool, frozen) => host.write(tool, frozen),
  });
  if (outcome.sent && !outcome.isError) host.changed(current?.url ?? args.page_id);
  return { result: text(writeResultText(outcome), outcome.sent && outcome.isError), outcome };
}

export async function runCreate(host: NotionToolHost, toolName: string, raw: unknown, signal?: AbortSignal): Promise<{ result: CallToolResult; outcome: GatedOutcome | null }> {
  const cleaned = cleanCreateArgs(raw);
  if (!cleaned.ok) return { result: text(cleaned.error, true), outcome: null };
  const args = cleaned.args;
  const parentId = args.parent?.type === "page_id" ? args.parent.page_id : null;
  const built = previewCreate(args, parentId ? host.cachedTitle(parentId) : null);
  if (!built.ok) return { result: text(built.error, true), outcome: null };
  const outcome = await gatedWrite({
    tool: "notion-create-pages",
    args: args as unknown as Record<string, unknown>,
    ask: () => host.ask(toolName, args as unknown as Record<string, unknown>, built.preview, signal),
    run: (tool, frozen) => host.write(tool, frozen),
  });
  if (outcome.sent && !outcome.isError && parentId) host.changed(parentId);
  return { result: text(writeResultText(outcome), outcome.sent && outcome.isError), outcome };
}

const signalOf = (extra: unknown) => (extra as { signal?: AbortSignal } | undefined)?.signal;

export function notionToolServer(host: NotionToolHost) {
  const prefix = `mcp__${OWN_SERVER}__`;
  const tools = [
    tool(
      OWN_TOOLS.updatePage,
      UPDATE_DESCRIPTION,
      {
        page_id: z.string().describe("The ID or URL of the Notion page to update."),
        command: z.enum(["update_properties", "update_content", "replace_content", "insert_content"]),
        properties: z.record(z.string(), propertyValue).optional().describe('For update_properties. Property names to new values; page title is "title". Use null to clear.'),
        content_updates: z
          .array(z.object({ old_str: z.string().min(1).describe("Exact text to find in the page."), new_str: z.string().describe("Replacement text."), replace_all_matches: z.boolean().optional() }))
          .optional()
          .describe("For update_content. Search-and-replace operations."),
        new_str: z.string().optional().describe("For replace_content. The new full page content."),
        content: z.string().optional().describe("For insert_content. The Markdown to add."),
        position: z.object({ type: z.enum(["start", "end"]) }).optional().describe("For insert_content. Defaults to the end."),
        icon: z.string().optional().describe("An emoji for the page icon."),
      },
      async (args, extra) => (await runUpdate(host, `${prefix}${OWN_TOOLS.updatePage}`, args, signalOf(extra))).result,
    ),
    tool(
      OWN_TOOLS.createPages,
      CREATE_DESCRIPTION,
      {
        pages: z.array(z.object({ properties: z.record(z.string(), propertyValue).optional(), content: z.string().optional(), icon: z.string().optional() })).min(1).max(20),
        parent: z
          .union([
            z.object({ type: z.literal("page_id"), page_id: z.string() }),
            z.object({ type: z.literal("database_id"), database_id: z.string() }),
            z.object({ type: z.literal("data_source_id"), data_source_id: z.string() }),
          ])
          .optional(),
        creation_mode: z.enum(["draft"]).optional().describe("Use draft for a private page when the user named no destination. Do not combine with parent."),
      },
      async (args, extra) => (await runCreate(host, `${prefix}${OWN_TOOLS.createPages}`, args, signalOf(extra))).result,
    ),
  ];
  const addCards = host.addCards;
  if (addCards) {
    tools.push(
      tool(
        OWN_TOOLS.boardAdd,
        "Add cards to the Lodestar board (the user's kanban inside this app). Use it to put action items or follow-ups on the board. This changes only the local board, not Notion. Each card links back to the Notion page of this conversation.",
        { cards: z.array(z.object({ title: z.string().min(1).max(200), body: z.string().max(4000).optional() })).min(1).max(30) },
        async (args) => {
          try {
            const made = addCards(args.cards);
            return text(`Added ${made.length} card${made.length === 1 ? "" : "s"} to the board:\n${made.map((c) => `- ${c.title}`).join("\n")}`);
          } catch (error) {
            return text(error instanceof Error ? error.message : String(error), true);
          }
        },
      ) as never,
    );
  }
  const startSession = host.startSession;
  if (startSession) {
    tools.push(
      tool(
        OWN_TOOLS.startSession,
        "Open a new coding session draft in Lodestar with the given first message. The user picks the working folder and sends it. Use it when the page contains a decision or plan that should become code work. Write the prompt so it stands alone (it will not see this conversation).",
        { prompt: z.string().min(1).max(8000) },
        async (args) => {
          startSession(args.prompt);
          return text("Opened a new session draft. The user chooses the working folder and sends it.");
        },
      ) as never,
    );
  }
  return createSdkMcpServer({ name: OWN_SERVER, tools });
}
