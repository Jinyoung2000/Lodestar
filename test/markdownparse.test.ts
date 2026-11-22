import { parseMarkdown } from "../web/markdownParse";

const cases: { name: string; run: () => string }[] = [];
const test = (name: string, run: () => string) => cases.push({ name, run });
const html = (text: string) => parseMarkdown(text).trim();
const expectHtml = (text: string, want: string) => {
  const got = html(text);
  if (got !== want) throw new Error(`${JSON.stringify(text)}\n  got  ${got}\n  want ${want}`);
  return got;
};

test("bold closed by punctuation and followed by Korean", () => expectHtml("**일직선(linear)**으로 간다", "<p><strong>일직선(linear)</strong>으로 간다</p>"));
test("bold opened by punctuation after Korean", () => expectHtml("한글**(괄호)텍스트**입니다", "<p>한글<strong>(괄호)텍스트</strong>입니다</p>"));
test("bold with quotes and a particle", () => expectHtml('**"인용"**은 맞다', "<p><strong>&quot;인용&quot;</strong>은 맞다</p>"));
test("italic closed by punctuation and followed by Korean", () => expectHtml("*기울임)*이다", "<p><em>기울임)</em>이다</p>"));
test("inline code inside bold still renders", () => expectHtml("**`code`(x)**으로", "<p><strong><code>code</code>(x)</strong>으로</p>"));
test("bold wrapping inline code followed by a Korean particle", () => expectHtml("함수의 이름은 **`price`**입니다.", "<p>함수의 이름은 <strong><code>price</code></strong>입니다.</p>"));
test("bold wrapping inline code after Korean with no space", () => expectHtml("함수**`price`**는 쓴다", "<p>함수<strong><code>price</code></strong>는 쓴다</p>"));
test("bold that already worked is unchanged", () => expectHtml("**각 단계에서** 본다", "<p><strong>각 단계에서</strong> 본다</p>"));
test("English bold is unchanged", () => expectHtml("**bold** text", "<p><strong>bold</strong> text</p>"));
test("inline code is left alone", () => expectHtml("`**a(b)**c` 코드", "<p><code>**a(b)**c</code> 코드</p>"));
test("code block is left alone", () => expectHtml("```\n**a(b)**c\n```", "<pre><code>**a(b)**c\n</code></pre>"));
test("a lone asterisk list marker and spaced asterisks stay literal", () => expectHtml("2 ** 3 ** 4", "<p>2 ** 3 ** 4</p>"));
test("wikilink drops the brackets and keeps the title", () => expectHtml("([[약속 리마인더 응답과 노쇼 신고율]]).", '<p>(<span class="wikilink">약속 리마인더 응답과 노쇼 신고율</span>).</p>'));
test("wikilink alias shows the display name", () => expectHtml("[[노트|별칭]] 참고", '<p><span class="wikilink">별칭</span> 참고</p>'));
test("wikilink inside inline code is left alone", () => expectHtml("`[[노트]]` 는 코드", "<p><code>[[노트]]</code> 는 코드</p>"));
test("breaks option keeps line breaks", () => {
  const got = parseMarkdown("a\n**b(c)**다", { breaks: true }).trim();
  if (got !== "<p>a<br><strong>b(c)</strong>다</p>") throw new Error(got);
  return got;
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
