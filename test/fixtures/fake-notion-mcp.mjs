import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const LOG = process.env.NOTION_FAKE_LOG;
const log = (tool, args) => LOG && appendFileSync(LOG, `${JSON.stringify({ at: new Date().toISOString(), tool, args })}\n`);

const WEEKLY_ID = "aaaaaaaabbbbccccddddeeeeeeeeeeee";
const DB_ID = "bbbbbbbbccccddddeeeeffffffffffff";
const pages = {
  [WEEKLY_ID]: {
    title: "Weekly Plan",
    icon: "🗒️",
    path: "Team / Planning",
    edited: "2026-10-16T01:00:00.000Z",
    content: [
      '<callout icon="💡" color="gray_bg">',
      "\tKeep this page short. Update it every Monday.",
      "</callout>",
      "---",
      "## Goals",
      "- Ship the Notion screen",
      "- [ ] Review the fetch parser",
      "- [x] Write the acceptance doc",
      "## Decisions",
      "We will read pages through the Notion MCP and show them as Markdown.",
      "The write path always asks for approval first.",
      "<columns>",
      '\t<column ratio="50">',
      "\t\t## Left",
      '\t\t<page url="https://www.notion.so/ccccccccddddeeeeffff000000000000">Child page</page>',
      "\t</column>",
      '\t<column ratio="50">',
      "\t\t## Right",
      "\t\tSecond column text.",
      "\t</column>",
      "</columns>",
      "<empty-block/>",
    ].join("\n"),
  },
  [DB_ID]: { title: "Work summary", icon: "📊", path: "Team", edited: "2026-10-15T09:00:00.000Z", database: true, content: "" },
};

const STATE = process.env.NOTION_FAKE_STATE;
const loadState = () => {
  if (!STATE || !existsSync(STATE)) return;
  const saved = JSON.parse(readFileSync(STATE, "utf8"));
  for (const [id, patch] of Object.entries(saved)) Object.assign(pages[id], patch);
};
const saveState = () => STATE && writeFileSync(STATE, JSON.stringify(Object.fromEntries(Object.entries(pages).map(([id, p]) => [id, { content: p.content, edited: p.edited }]))));
loadState();

const urlOf = (id) => `https://www.notion.so/${id}`;
const idOf = (ref) => (/[0-9a-f]{32}/i.exec(String(ref).replace(/-/g, ""))?.[0] ?? "").toLowerCase();

function fetchResult(ref) {
  const id = idOf(ref);
  const page = pages[id];
  if (!page) return { content: [{ type: "text", text: `Could not find page with ID: ${ref}. Make sure the page is shared with the integration.` }], isError: true };
  const url = urlOf(id);
  const body = page.database
    ? `<database url="${url}">\n<data-source url="collection://${id}">\n<sqlite-table>CREATE TABLE ("Name" TEXT, "Status" TEXT)</sqlite-table>\n</data-source>\n</database>`
    : `<page url="${url}" icon="${page.icon}">\n<ancestor-path>\n<parent-page url="${urlOf("ddddddddeeeeffff0000111111111111")}" title="${page.path}"/>\n</ancestor-path>\n<properties>\n{"title":"${page.title}"}\n</properties>\n<content>\n${page.content}\n</content>\n</page>`;
  const text = `Here is the result of "fetch" for the ${page.database ? "Database" : "Page"} with URL ${url} as of ${new Date().toISOString()}:\n${body}`;
  return { content: [{ type: "text", text: JSON.stringify({ metadata: { type: page.database ? "database" : "page" }, title: page.title, url, text, icon: { type: "emoji", emoji: page.icon }, path: page.path, page_last_edited_at: page.edited }) }] };
}

const server = new McpServer({ name: "fake-notion", version: "1.0.0" });
server.tool("notion-fetch", "Retrieves details about a Notion page or database by URL or ID.", { id: z.string(), include_discussions: z.boolean().optional() }, async (args) => {
  log("notion-fetch", args);
  return fetchResult(args.id);
});
server.tool("notion-search", "Search Notion.", { query: z.string() }, async (args) => {
  log("notion-search", args);
  return { content: [{ type: "text", text: JSON.stringify({ results: [{ title: "Weekly Plan", url: urlOf(WEEKLY_ID) }] }) }] };
});
server.tool(
  "notion-update-page",
  "Update a Notion page's properties or content.",
  { page_id: z.string(), command: z.string(), properties: z.record(z.any()).optional(), content_updates: z.array(z.object({ old_str: z.string(), new_str: z.string(), replace_all_matches: z.boolean().optional() })).optional(), new_str: z.string().optional(), content: z.string().optional(), position: z.any().optional(), icon: z.string().optional() },
  async (args) => {
    log("notion-update-page", args);
    const page = pages[idOf(args.page_id)];
    if (!page) return { content: [{ type: "text", text: "Page not found" }], isError: true };
    if (args.command === "update_content") {
      for (const u of args.content_updates ?? []) {
        if (!page.content.includes(u.old_str)) return { content: [{ type: "text", text: `old_str not found: ${u.old_str.slice(0, 40)}` }], isError: true };
        page.content = page.content.replace(u.old_str, () => u.new_str);
      }
    } else if (args.command === "replace_content") page.content = args.new_str ?? "";
    else if (args.command === "insert_content") page.content = args.position?.type === "start" ? `${args.content}\n${page.content}` : `${page.content}\n${args.content}`;
    page.edited = new Date().toISOString();
    saveState();
    return { content: [{ type: "text", text: JSON.stringify({ page_id: idOf(args.page_id), updated: true }) }] };
  },
);
server.tool(
  "notion-create-pages",
  "Creates one or more Notion pages.",
  { pages: z.array(z.any()), parent: z.any().optional(), creation_mode: z.string().optional() },
  async (args) => {
    log("notion-create-pages", args);
    return { content: [{ type: "text", text: JSON.stringify({ pages: args.pages.map((p, i) => ({ id: `new${i}`, url: urlOf(`${"1".repeat(31)}${i}`), title: p.properties?.title ?? p.properties?.Name ?? "Untitled" })) }) }] };
  },
);
server.tool("notion-create-comment", "Add a comment to a page.", { page_id: z.string(), rich_text: z.any() }, async (args) => {
  log("notion-create-comment", args);
  return { content: [{ type: "text", text: "comment created" }] };
});

server.tool("notion-archive-workspace", "Archive pages in bulk (a tool the app has never heard of).", { page_id: z.string() }, async (args) => {
  log("notion-archive-workspace", args);
  return { content: [{ type: "text", text: "archived" }] };
});

await server.connect(new StdioServerTransport());
