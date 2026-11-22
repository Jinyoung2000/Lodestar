import { defaultBoard } from "../shared/board";
import type { Board, BoardCard } from "../shared/protocol";
import { cardBodyFrom, cardTitleFrom, findSourceCard, messageLink, parseMessageLink, pickColumn, plainExcerpt, sourcePart, TITLE_MAX } from "../shared/toBoard";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed++;
};
const title = (text: string, max?: number) => cardTitleFrom(text, max);

check("takes the first sentence", title("Fix the login redirect. Then update the tests.") === "Fix the login redirect");
check("keeps ? and ! on the sentence", title("Why does the board reset on restart? Look at sanitizeBoard.") === "Why does the board reset on restart?");
check("does not split inside version numbers or file names", title("Upgrade to v1.2.3 before the release goes out") === "Upgrade to v1.2.3 before the release goes out");
check("a short abbreviation does not end the title", title("e.g. rename the helper and move it") === "e.g. rename the helper and move it");
check("splits Korean sentences at the period", title("카드 제목을 짧게 뽑는다. 그 뒤에 설명을 붙인다.") === "카드 제목을 짧게 뽑는다");
check("strips heading, list, quote and checkbox markers", title("## Plan") === "Plan" && title("- [ ] write the doc") === "write the doc" && title("1. first step of many") === "first step of many" && title("> quoted line here") === "quoted line here");
check("strips emphasis, code ticks and links", title("Use **bold** and `code` with [a link](https://x.dev/a_b_c) today") === "Use bold and code with a link today");
check("keeps snake_case and star math intact", title("rename my_var_name to other_name now") === "rename my_var_name to other_name now" && title("2 * 3 * 4 is 24 in total") === "2 * 3 * 4 is 24 in total");
check("keeps the alt text of an image", title("![diagram](a.png) shows the flow") === "diagram shows the flow");
check("skips a leading code block and blank lines", title("\n\n```ts\nconst a = 1;\n```\n\nThen rename it.") === "Then rename it");
check("uses the code when the text is only a code block", title("```\nnpm run build\n```") === "npm run build");
check("an empty text gives an empty title", title("   \n ") === "" && title("```\n```") === "");
check("a long line is cut at a word boundary with an ellipsis", (() => {
  const result = title("word ".repeat(40));
  return result.length <= TITLE_MAX && result.endsWith("…") && !result.endsWith(" …");
})());
check("a long line without spaces is hard cut", (() => {
  const result = title("가".repeat(200));
  return result.length === TITLE_MAX && result.endsWith("…");
})());
check("a line at the limit is left alone", title("x".repeat(TITLE_MAX)) === "x".repeat(TITLE_MAX));

check("a short heading is joined with the first sentence under it", title("## Plan\n\nThe redirect target is read from returnTo. More text.") === "Plan: The redirect target is read from returnTo");
check("a long heading stands alone", title("## A heading that is longer than the limit\n\nBody text.") === "A heading that is longer than the limit");
check("a short first line that is not a heading stands alone", title("Plan\n\nBody text here.") === "Plan");
check("a lone short heading stays as it is", title("## Plan") === "Plan");
check("excerpt is plain text on one line", plainExcerpt("## Plan\n\n- one `two`\n- three") === "Plan one two three");

check("part collapses whitespace and is stable", sourcePart("a\n  b   c") === "a b c" && sourcePart("a b c") === "a b c");
check("part is null for the whole item and for blank text", sourcePart(null) === null && sourcePart("  \n") === null);
check("part keeps only the first 200 characters", sourcePart("x".repeat(500))?.length === 200);

check("message link round trips ids with colons", (() => {
  const link = messageLink("agent-1", "3f2a:text");
  const parsed = parseMessageLink(link);
  return link.startsWith("#") && parsed?.agentId === "agent-1" && parsed.itemId === "3f2a:text";
})());
check("other hrefs are not message links", parseMessageLink("https://example.com") === null && parseMessageLink("#other") === null && parseMessageLink("#lodestar-message=%E0%A4%A/x") === null);

const body = cardBodyFrom({ text: "First line\n\nThird [x] line", sessionTitle: "Fix [login] bug", agentId: "a1", itemId: "i1" });
check("body quotes every line and keeps the blank one", body.startsWith("> First line\n>\n> Third [x] line\n\n"));
check("body names the session without brackets", body.includes("From session: Fix login bug"));
check("body ends with the link back to the message", body.endsWith(`[Go to message](${messageLink("a1", "i1")})`));
check("body uses CRLF input the same way", cardBodyFrom({ text: "a\r\nb", sessionTitle: "s", agentId: "a", itemId: "i" }).startsWith("> a\n> b\n\n"));
check("a blank session name falls back", cardBodyFrom({ text: "a", sessionTitle: "  ", agentId: "a", itemId: "i" }).includes("From session: Untitled"));
check("a huge quote is cut under the card body limit and marked", (() => {
  const huge = cardBodyFrom({ text: Array.from({ length: 5000 }, (_, i) => `line number ${i} with some padding text`).join("\n"), sessionTitle: "s", agentId: "a", itemId: "i" });
  return huge.length <= 20_000 && huge.includes("\n> …\n\nFrom session: s");
})());

const card = (id: string, source: BoardCard["source"]): BoardCard => ({ id, columnId: "backlog", title: id, body: "", labels: [], priority: 0, number: 1, workspaceId: null, agentIds: [], links: [], source, createdAt: "", updatedAt: "" });
const board: Board = { ...defaultBoard(), cards: [card("whole", { agentId: "a", itemId: "i", part: null }), card("part", { agentId: "a", itemId: "i", part: "some words" }), card("none", null), { ...card("old", undefined) }] };
check("finds the card for the whole item", findSourceCard(board, { agentId: "a", itemId: "i", part: null })?.id === "whole");
check("finds the card for the same selection", findSourceCard(board, { agentId: "a", itemId: "i", part: "some words" })?.id === "part");
check("another selection of the same item is not a duplicate", findSourceCard(board, { agentId: "a", itemId: "i", part: "other words" }) === null);
check("another item or session is not a duplicate", findSourceCard(board, { agentId: "a", itemId: "j", part: null }) === null && findSourceCard(board, { agentId: "b", itemId: "i", part: null }) === null);
check("a missing board has no duplicate", findSourceCard(null, { agentId: "a", itemId: "i", part: null }) === null);
check("an undefined part counts as null", findSourceCard(board, { agentId: "a", itemId: "i", part: undefined as unknown as null })?.id === "whole");

const custom: Board = { ...defaultBoard(), columns: [{ id: "x", name: "Inbox", role: null }, { id: "backlog", name: "Backlog", role: "backlog" }, { id: "todo", name: "Todo", role: "todo" }], cards: [] };
check("remembered column wins when it still exists", pickColumn(custom, "todo") === "todo");
check("falls back to Backlog by role", pickColumn(custom, null) === "backlog" && pickColumn(custom, "gone") === "backlog");
check("falls back to the first column when Backlog was deleted", pickColumn({ ...custom, columns: custom.columns.filter((c) => c.role !== "backlog") }, null) === "x");

if (failed) {
  console.log(`${failed} failed`);
  process.exit(1);
}
console.log("all passed");
