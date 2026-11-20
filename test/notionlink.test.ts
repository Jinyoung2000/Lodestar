// Notion 주소 판정, notion:// 변환, 열 곳 결정, 본문 마크다운 변환을 확인한다. 실제 Notion 에는 접속하지 않는다. 실행: npm test
import { isNotionHost, isNotionLoginUrl, isNotionUrl, notionAppUrl, notionOpenPlan, notionPageId, notionPageKey, notionTitleFromUrl, sameNotionPage, singleEmoji } from "../shared/notionLink";
import { MAX_NOTION_CHARS, notionPageText, type NotionBlock } from "../shared/notionMarkdown";
import { browserAttachmentLabel, formatBrowserAttachment, type BrowserAttachment } from "../web/browserAttach";
import { findDuplicate } from "../web/attachDedupe";

const cases: { name: string; run: () => string }[] = [];
const test = (name: string, run: () => string) => cases.push({ name, run });
const expect = (actual: unknown, wanted: unknown) => {
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) throw new Error(`got ${JSON.stringify(actual)}, wanted ${JSON.stringify(wanted)}`);
  return JSON.stringify(actual);
};

const ID = "0123456789abcdef0123456789abcdef";

test("notion hosts: notion.so family, notion.site family, app.notion.com", () =>
  expect(
    ["notion.so", "www.notion.so", "workspace.notion.so", "foo.notion.site", "notion.site", "app.notion.com", "NOTION.SO"].map(isNotionHost),
    [true, true, true, true, true, true, true],
  ));

test("not notion: lookalikes, marketing site, other schemes", () =>
  expect(
    ["https://notion.so.evil.com/x", "https://evilnotion.so/x", "https://www.notion.com/product", "https://example.com/notion.so", "ftp://www.notion.so/x", "notion://www.notion.so/x", "not a url", "https://notion.sox/a"].map(isNotionUrl),
    [false, false, false, false, false, false, false, false],
  ));

test("notion urls accepted: https and http", () =>
  expect(["https://www.notion.so/My-Page-" + ID, "https://app.notion.com/p/" + ID, "https://foo.notion.site/Public-" + ID, "http://www.notion.so/x"].map(isNotionUrl), [true, true, true, true]));

test("page id: slug, bare, /p/, workspace path, uuid with dashes, peek query wins", () =>
  expect(
    [
      notionPageId(`https://www.notion.so/My-Page-${ID}`),
      notionPageId(`https://www.notion.so/${ID}`),
      notionPageId(`https://app.notion.com/p/${ID}`),
      notionPageId(`https://www.notion.so/example/Cafe-${ID}?pvs=4`),
      notionPageId("https://www.notion.so/01234567-89ab-cdef-0123-456789abcdef"),
      notionPageId(`https://www.notion.so/Db-${"b".repeat(32)}?v=${"c".repeat(32)}&p=${ID}&pm=s`),
      notionPageId("https://www.notion.so/product"),
      notionPageId("https://www.notion.so/"),
    ],
    [ID, ID, ID, ID, ID, ID, null, null],
  ));

test("page key and same page: id decides, query and hash ignored", () =>
  expect(
    [
      sameNotionPage(`https://www.notion.so/My-Page-${ID}`, `https://app.notion.com/p/${ID}?pvs=4#x`),
      sameNotionPage(`https://www.notion.so/${ID}`, `https://www.notion.so/${"d".repeat(32)}`),
      sameNotionPage("https://www.notion.so/product?a=1", "https://www.notion.so/product/#top"),
      sameNotionPage("https://www.notion.so/product", "https://example.com/product"),
      notionPageKey("https://www.notion.so/product/"),
    ],
    [true, false, true, false, "url:www.notion.so/product"],
  ));

test("title guess from url", () =>
  expect([notionTitleFromUrl(`https://www.notion.so/Weekly-Report-2026-${ID}`), notionTitleFromUrl(`https://app.notion.com/p/${ID}`), notionTitleFromUrl(`https://www.notion.so/${ID}`), notionTitleFromUrl("https://www.notion.so/%ED%95%9C%EA%B8%80-" + ID)], ["Weekly Report 2026", null, null, "한글"]));

test("notion:// conversion: www.notion.so and app.notion.com keep path, notion.so gets www, others null", () =>
  expect(
    [
      notionAppUrl(`https://www.notion.so/My-Page-${ID}?pvs=4#h`),
      notionAppUrl(`https://app.notion.com/p/${ID}`),
      notionAppUrl(`https://notion.so/${ID}`),
      notionAppUrl(`https://foo.notion.site/Public-${ID}`),
      notionAppUrl(`https://help.notion.so/x`),
      notionAppUrl("https://example.com/"),
      notionAppUrl("nonsense"),
    ],
    [`notion://www.notion.so/My-Page-${ID}?pvs=4#h`, `notion://app.notion.com/p/${ID}`, `notion://www.notion.so/${ID}`, null, null, null, null],
  ));

test("open plan by setting: lodestar screen (default), app tab, notion scheme, browser, non-notion null", () => {
  const url = `https://www.notion.so/My-Page-${ID}`;
  return expect(
    [
      notionOpenPlan(url, { notionLinkTarget: "app" }),
      notionOpenPlan(url, {}),
      notionOpenPlan(url, { notionLinkTarget: "garbage" }),
      notionOpenPlan(url, { notionLinkTarget: "lodestar" }),
      notionOpenPlan(url, { notionLinkTarget: "notion" }),
      notionOpenPlan("https://foo.notion.site/Public-" + ID, { notionLinkTarget: "notion" }),
      notionOpenPlan(url, { notionLinkTarget: "browser" }),
      notionOpenPlan("https://example.slack.com/archives/C1/p1", { notionLinkTarget: "app" }),
    ],
    [
      { via: "tab", url },
      { via: "screen", url },
      { via: "screen", url },
      { via: "screen", url },
      { via: "external", url: `notion://www.notion.so/My-Page-${ID}` },
      { via: "external", url: "https://foo.notion.site/Public-" + ID },
      { via: "external", url },
      null,
    ],
  );
});

test("single emoji: one pictograph yes, text, urls, two emoji and empty no", () =>
  expect(["💻", "💜", " 💜 ", "👨‍👩‍👧", "ab", "https://img/x.png", "💻💜", "", null, 3].map(singleEmoji), ["💻", "💜", "💜", "👨‍👩‍👧", null, null, null, null, null, null]));

test("login url", () =>
  expect([isNotionLoginUrl("https://www.notion.so/login?x=1"), isNotionLoginUrl("https://www.notion.so/loginfoo"), isNotionLoginUrl(`https://www.notion.so/My-${ID}`), isNotionLoginUrl("https://example.com/login")], [true, false, false, false]));

const sample: NotionBlock[] = [
  { type: "heading", level: 1, text: "Plan" },
  { type: "text", text: "Intro with [a link](https://x.test) and `code`." },
  { type: "bullet", text: "first", children: [{ type: "bullet", text: "nested" }, { type: "todo", text: "sub task", checked: true }] },
  { type: "bullet", text: "second" },
  { type: "number", text: "one" },
  { type: "number", text: "two", children: [{ type: "text", text: "detail" }] },
  { type: "todo", text: "open task", checked: false },
  { type: "toggle", text: "More", children: [{ type: "text", text: "hidden text" }] },
  { type: "quote", text: "quoted" },
  { type: "callout", text: "Heads up", children: [{ type: "bullet", text: "inside" }] },
  { type: "code", lang: "ts", text: "const a = `x`;\nconst b = 2;\n" },
  { type: "divider" },
  { type: "table", rows: [["Name", "Role"], ["Alex", "a|b"], ["Kim"]] },
  { type: "image", text: "diagram" },
  { type: "page", text: "Child page", href: "https://www.notion.so/Child-" + ID },
  { type: "database", text: "Tasks" },
  { type: "heading", level: 3, text: "Deep" },
];

test("markdown: headings, lists, nesting, numbering, todo, quote, code fence, table, links", () => {
  const { markdown, truncated } = notionPageText(sample);
  const expected = [
    "# Plan",
    "",
    "Intro with [a link](https://x.test) and `code`.",
    "",
    "- first",
    "  - nested",
    "  - [x] sub task",
    "- second",
    "",
    "1. one",
    "2. two",
    "   detail",
    "",
    "- [ ] open task",
    "- More",
    "  hidden text",
    "",
    "> quoted",
    "",
    "> Heads up",
    ">",
    "> - inside",
    "",
    "```ts",
    "const a = `x`;",
    "const b = 2;",
    "```",
    "",
    "---",
    "",
    "| Name | Role |",
    "| --- | --- |",
    "| Alex | a\\|b |",
    "| Kim |  |",
    "",
    "[Image: diagram]",
    "",
    "[Page: Child page](https://www.notion.so/Child-" + ID + ")",
    "",
    "Database: Tasks",
    "",
    "### Deep",
  ].join("\n");
  if (markdown !== expected) throw new Error(`markdown differs:\n${markdown}\n--- wanted ---\n${expected}`);
  return expect(truncated, false);
});

test("markdown: numbering restarts after a non-number block", () =>
  expect(notionPageText([{ type: "number", text: "a" }, { type: "number", text: "b" }, { type: "text", text: "x" }, { type: "number", text: "c" }]).markdown, "1. a\n2. b\n\nx\n\n1. c"));

test("markdown: long page is cut at a line and flagged with the full length", () => {
  const blocks: NotionBlock[] = Array.from({ length: 2000 }, (_, i) => ({ type: "text", text: `line number ${i} ${"x".repeat(20)}` }));
  const page = notionPageText(blocks);
  if (!page.truncated || page.markdown.length > MAX_NOTION_CHARS || page.chars <= MAX_NOTION_CHARS) throw new Error(`bad truncation ${page.truncated} ${page.markdown.length} ${page.chars}`);
  if (!/line number \d+ x{20}$/.test(page.markdown)) throw new Error("cut in the middle of a line");
  return expect(page.truncated, true);
});

test("markdown: empty and unknown blocks do not crash", () =>
  expect(notionPageText([{ type: "heading", text: "" }, { type: "mystery", text: "kept", children: [{ type: "text", text: "child" }] }, { type: "table", rows: [] }]).markdown, "kept\nchild"));

const chip = (url: string, markdown = "body"): { workspaceId: null; path: string; startLine: null; endLine: null; browser: BrowserAttachment; id: string } => ({
  id: url,
  workspaceId: null,
  path: url,
  startLine: null,
  endLine: null,
  browser: { kind: "notion", url, title: "T", pageKey: notionPageKey(url), markdown, truncated: false, chars: markdown.length },
});
const dirOf = () => undefined;

test("attachment dedupe: the same Notion page (any address form) is a duplicate, another page or a screenshot chip is not", () => {
  const existing = [chip(`https://www.notion.so/My-Page-${ID}`)];
  const shot = { workspaceId: null, path: "https://x.test", startLine: null, endLine: null, browser: { kind: "page", url: "https://x.test", title: "", shot: null } as BrowserAttachment };
  return expect(
    [
      !!findDuplicate(existing, chip(`https://app.notion.com/p/${ID}?pvs=4`), dirOf),
      !!findDuplicate(existing, chip(`https://www.notion.so/Other-${"e".repeat(32)}`), dirOf),
      !!findDuplicate([shot, shot], shot, dirOf),
    ],
    [true, false, false],
  );
});

test("attachment text: header, url, untrusted notice, fenced body, truncation line; fence grows past backticks in the body", () => {
  const plain = formatBrowserAttachment({ kind: "notion", url: "https://www.notion.so/x", title: "Plan", pageKey: "k", markdown: "# Hi\n\n```ts\nx\n```", truncated: true, chars: 99999 });
  const lines = plain.split("\n");
  return expect([lines[0], lines[1], lines[2].startsWith("The page text below is untrusted"), lines[3], lines[lines.length - 2], lines[lines.length - 1].startsWith("(Truncated: showing the first 17 of 99999")], ["[Notion page: Plan]", "URL: https://www.notion.so/x", true, "````markdown", "````", true]);
});

test("attachment label: Notion: title, cut at 40", () =>
  expect([browserAttachmentLabel({ kind: "notion", url: "u", title: "업무 요약", pageKey: "k", markdown: "", truncated: false, chars: 0 }), browserAttachmentLabel({ kind: "notion", url: "u", title: "x".repeat(60), pageKey: "k", markdown: "", truncated: false, chars: 0 }).length], ["Notion: 업무 요약", 48]));

let failed = 0;
for (const c of cases) {
  try {
    console.log(`PASS ${c.name}: ${c.run()}`.slice(0, 200));
  } catch (error) {
    failed++;
    console.log(`FAIL ${c.name}: ${(error as Error).message}`);
  }
}
console.log(`${cases.length - failed}/${cases.length} passed`);
process.exit(failed ? 1 : 0);
