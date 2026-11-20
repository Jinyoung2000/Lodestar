// notion-fetch 응답 해석과 enhanced markdown 변환을 확인한다. 응답 모양은 2026-10-16 실제 응답(Frontend 페이지)에서 확인한 구조를 합성 내용으로 옮긴 것이다. 실행: npm test
import { enhancedToMarkdown, parseFetchResult, propertyRows } from "../shared/notionFetch";
import { fenceFor, clip, pageContext } from "../shared/notionContext";
import { notionRefToUrl } from "../shared/notionLink";

const cases: { name: string; run: () => void }[] = [];
const test = (name: string, run: () => void) => cases.push({ name, run });
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
};
const same = (actual: unknown, wanted: unknown) => expect(JSON.stringify(actual) === JSON.stringify(wanted), `got ${JSON.stringify(actual)}, wanted ${JSON.stringify(wanted)}`);

const ID = "aaaaaaaabbbbccccddddeeeeeeeeeeee";
const URL_ = `https://app.notion.com/p/${ID}`;

function response(content: string, extra: Record<string, unknown> = {}, head = `<page url="${URL_}" icon="🗒️">\n<ancestor-path>\n<parent-page url="https://app.notion.com/p/${"f".repeat(32)}" title="Team"/>\n</ancestor-path>\n<properties>\n{"title":"Weekly Plan"}\n</properties>`) {
  const text = `Here is the result of "fetch" for the Page with URL ${URL_} as of 2026-10-16T01:00:00.000Z:\n${head}\n<content>\n${content}\n</content>\n</page>`;
  return JSON.stringify({ metadata: { type: "page" }, title: "Weekly Plan", url: `${URL_}?pvs=204`, text, cover: null, icon: { type: "emoji", emoji: "🗒️" }, path: "Team / Planning", verification: { state: "unverified" }, page_last_edited_at: "2026-10-16T00:40:00.000Z", ...extra });
}

test("parse: 제목, 주소(pvs 제거), id, 경로, 수정 시각, 이모지 아이콘", () => {
  const r = parseFetchResult(response("hello"));
  expect(r.ok, "ok");
  if (!r.ok) return;
  same([r.page.kind, r.page.title, r.page.url, r.page.id, r.page.path, r.page.lastEditedAt, r.page.icon], ["page", "Weekly Plan", URL_, ID, "Team / Planning", "2026-10-16T00:40:00.000Z", "🗒️"]);
  expect(r.page.enhanced === "hello" && r.page.markdown === "hello", "content 안쪽만");
});

test("parse: 파일 아이콘은 이모지가 아니라 null (서명 주소는 5분 뒤 만료)", () => {
  const r = parseFetchResult(response("x", { icon: { type: "file", file: { url: "https://s3/x.png?sig=1" } } }, `<page url="${URL_}" icon="https://s3/x.png?sig=1">\n<properties>\n{"title":"T"}\n</properties>`));
  expect(r.ok && r.page.icon === null, "icon null");
});

test("parse: 데이터베이스 행 페이지의 속성은 title 을 뺀 나머지", () => {
  const r = parseFetchResult(response("body", {}, `<page url="${URL_}">\n<properties>\n{"title":"Row","Status":"Done","Tags":["a","b"],"Empty":null}\n</properties>`));
  expect(r.ok, "ok");
  if (!r.ok) return;
  same(r.page.properties, { Status: "Done", Tags: ["a", "b"], Empty: null });
  same(propertyRows(r.page.properties), [{ name: "Status", value: "Done" }, { name: "Tags", value: "a, b" }]);
});

test("parse: 데이터베이스는 kind database 이고 브라우저가 필요하다고 표시", () => {
  const text = `Here is the result of "fetch" for the Database with URL ${URL_} as of x:\n<database url="${URL_}">\n<data-source url="collection://${ID}">\n<sqlite-table>CREATE TABLE ("Name" TEXT)</sqlite-table>\n</data-source>\n</database>`;
  const r = parseFetchResult(JSON.stringify({ metadata: { type: "database" }, title: "Work summary", url: URL_, text }));
  expect(r.ok && r.page.kind === "database" && r.page.needsBrowser && r.page.markdown === "", "database");
});

test("parse: JSON 이 아니거나 본문이 없으면 오류 글을 돌려준다", () => {
  const a = parseFetchResult("Could not find page with ID: x");
  const b = parseFetchResult(JSON.stringify({ metadata: { type: "page" }, error: "no access" }));
  expect(!a.ok && a.error.startsWith("Could not find"), "plain text error");
  expect(!b.ok && b.error === "no access", "json error");
});

test("parse: 잘렸다고 알린 응답은 truncated", () => {
  const r = parseFetchResult(response("x", { truncated: true }));
  expect(r.ok && r.page.truncated, "truncated");
});

test("markdown: callout 은 인용문, 이모지 앞붙임, 앞뒤에 빈 줄", () => {
  const md = enhancedToMarkdown('<callout icon="💡" color="gray_bg">\n\tKeep it short.\n\tSecond line.\n</callout>\n---\n## Goals');
  same(md.split("\n"), ["> 💡 Keep it short.", "> Second line.", "", "---", "## Goals"]);
});

test("markdown: columns 는 차례로 이어 붙이고 들여쓰기를 걷는다", () => {
  const md = enhancedToMarkdown('<columns>\n\t<column ratio="50">\n\t\t## Left\n\t\ttext a\n\t</column>\n\t<column ratio="50">\n\t\t## Right\n\t\ttext b\n\t</column>\n</columns>');
  same(md.split("\n").filter(Boolean), ["## Left", "text a", "## Right", "text b"]);
  expect(!/^[ \t]/m.test(md), "남은 들여쓰기 없음");
});

test("markdown: page 와 mention 은 링크, 상대 경로 링크는 Notion 주소로, empty-block 은 빈 줄", () => {
  const md = enhancedToMarkdown(`<page url="https://www.notion.so/${ID}">Child</page>\n<empty-block/>\nSee [Archives](/abcdef0123456789abcdef0123456789?pvs=25) and <mention-page url="https://www.notion.so/${ID}"/> and <mention-user url="user://1">Alex</mention-user>.`);
  expect(md.includes(`[📄 Child](https://www.notion.so/${ID})`), md);
  expect(md.includes("[Archives](https://www.notion.so/abcdef0123456789abcdef0123456789?pvs=25)"), md);
  expect(md.includes("@Alex") && md.includes(`[Page](https://www.notion.so/${ID})`), md);
});

test("markdown: 코드 울타리 안은 태그도 들여쓰기도 그대로", () => {
  const md = enhancedToMarkdown('<callout icon="💡">\n\tText\n\t```html\n\t<page url="x">keep</page>\n\t```\n</callout>');
  expect(md.includes('<page url="x">keep</page>') && !md.includes("[📄 keep]"), md);
});

test("markdown: 헤딩 끝의 속성 표지와 알 수 없는 태그는 지우고 안쪽 글은 남긴다", () => {
  const md = enhancedToMarkdown('## Title {toggle="true" color="gray"}\n<span color="red">red text</span> and <unknown a="1">kept</unknown>');
  same(md.split("\n"), ["## Title", "red text and kept"]);
});

test("markdown: details 와 table 은 HTML 로 남는다 (속성은 뗀다)", () => {
  const md = enhancedToMarkdown('<details color="gray">\n<summary>More</summary>\n\tinside\n</details>\n<table header-row="true">\n<tr>\n<td>a</td>\n<td>b</td>\n</tr>\n</table>');
  expect(md.includes("<details>") && md.includes("<summary>More</summary>") && md.includes("<table>") && md.includes("<td>a</td>"), md);
});

test("markdown: 이미지는 http 주소만 그림, 업로드 파일은 글로", () => {
  const md = enhancedToMarkdown('<image source="https://x/y.png">cap</image>\n<image source="notion-file-block://abc">file</image>');
  same(md.split("\n"), ["![cap](https://x/y.png)", "[Image: file]"]);
});

test("context: 페이지 정보, 쓰기 안내, 본문 울타리가 들어간다", () => {
  const r = parseFetchResult(response("## Goals\n- one"));
  if (!r.ok) throw new Error("parse");
  const text = pageContext(r.page, "2026-10-16T02:00:00.000Z");
  for (const part of ["Page: Weekly Plan", `Page ID: ${ID}`, "untrusted content", "notion_update_page", "Direct Notion write tools are disabled", "board_add_cards", "<notion-page-content>", "## Goals\n- one"]) expect(text.includes(part), `missing ${part}`);
});

test("context: 본문 안 백틱보다 긴 울타리, 길면 줄 경계에서 자르고 알린다", () => {
  expect(fenceFor("a ```` b") === "`````" && fenceFor("none") === "```", "fence");
  const long = `${"line\n".repeat(20_000)}`;
  const c = clip(long, 1000);
  expect(c.truncated && c.text.length <= 1000 && c.text.endsWith("line") && c.total === long.length, "clip");
  const r = parseFetchResult(response(long));
  if (!r.ok) throw new Error("parse");
  expect(pageContext(r.page, "x").includes('truncated="true"'), "truncated attr");
});

test("ref: 32자리 id 와 UUID 는 주소로, 주소는 그대로", () => {
  same([notionRefToUrl(ID), notionRefToUrl("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"), notionRefToUrl("https://x/y")], [`https://www.notion.so/${ID}`, `https://www.notion.so/${ID}`, "https://x/y"]);
});

let failed = 0;
for (const c of cases) {
  try {
    c.run();
    console.log(`ok   ${c.name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${c.name}: ${(error as Error).message}`);
  }
}
console.log(failed ? `${failed} failed` : `${cases.length} passed`);
process.exit(failed ? 1 : 0);
