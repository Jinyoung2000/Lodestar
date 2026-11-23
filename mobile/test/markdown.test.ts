import { parseMarkdown, plainText } from "../src/logic/markdown";
import { expect, run, test } from "./harness";

test("마크다운 토큰: 문단, 제목, 목록, 코드, 표, 인용", () => {
  const tokens = parseMarkdown("# Title\n\nHello **bold** and `code`.\n\n- a\n- b\n\n```ts\nconst x = 1;\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n> quote");
  expect(tokens.filter((t) => t.type !== "space").map((t) => t.type).join() === "heading,paragraph,list,code,table,blockquote", tokens.map((t) => t.type).join());
  const code = tokens.find((t) => t.type === "code") as { lang?: string; text: string };
  expect(code.lang === "ts" && code.text === "const x = 1;", "code block");
  return "ok";
});

test("스트리밍 중 닫히지 않은 코드 블록도 코드로 읽고, 같은 글은 캐시된 배열을 돌려준다", () => {
  const open = parseMarkdown("text\n\n```js\nlet a = 1;");
  expect(open.some((t) => t.type === "code"), "unclosed fence is code");
  const once = parseMarkdown("same");
  expect(parseMarkdown("same") === once, "cached");
  expect(plainText(parseMarkdown("a **b** c")[0].type === "paragraph" ? (parseMarkdown("a **b** c")[0] as unknown as { tokens: never[] }).tokens : []) === "a b c", "plainText");
  return "ok";
});

test("긴 글 파싱은 빠르다", () => {
  const text = Array.from({ length: 400 }, (_, i) => `Paragraph ${i} with **bold**, \`code\`, and a [link](https://example.com/${i}).\n\n- item a\n- item b\n`).join("\n");
  const start = performance.now();
  const tokens = parseMarkdown(text);
  const ms = performance.now() - start;
  expect(tokens.length > 400 && ms < 400, `${tokens.length} tokens in ${ms.toFixed(1)}ms`);
  return `${text.length} chars in ${ms.toFixed(1)}ms`;
});

type Inline = { type: string; text?: string; raw: string; tokens?: Inline[]; items?: { tokens: Inline[] }[] };

function shape(tokens: Inline[] | undefined): string {
  return (tokens ?? []).map((t) => {
    if (t.type === "strong") return `<b>${shape(t.tokens)}</b>`;
    if (t.type === "em") return `<i>${shape(t.tokens)}</i>`;
    if (t.type === "del") return `<s>${shape(t.tokens)}</s>`;
    if (t.type === "codespan") return `<code>${t.text}</code>`;
    if (t.type === "link") return `<a>${shape(t.tokens)}</a>`;
    if (t.type === "checkbox") return "";
    if (t.type === "text" && t.tokens) return shape(t.tokens);
    return t.text ?? t.raw;
  }).join("");
}

function inline(text: string): string {
  const block = parseMarkdown(text)[0] as unknown as Inline;
  if (block.type === "list") return shape(block.items?.[0].tokens);
  return shape(block.tokens);
}

test("한국어 글에서 깨지던 마크다운 점검표", () => {
  const cases: [string, string][] = [
    ["다음 편은 **〈카톡에 있겠지〉**로 잡았어요.", "다음 편은 <b>〈카톡에 있겠지〉</b>로 잡았어요."],
    ["첫 컷의 **“아까 찍은 사진 보냈어”**로 바꾸고", "첫 컷의 <b>“아까 찍은 사진 보냈어”</b>로 바꾸고"],
    ["컷 위에 **「몇 달 뒤」**를 넣어요.", "컷 위에 <b>「몇 달 뒤」</b>를 넣어요."],
    ["**배포 완료.**했어요", "<b>배포 완료.</b>했어요"],
    ["**`npm test`**를 돌려요", "<b><code>npm test</code></b>를 돌려요"],
    ["- [x] **사진 보내 준다며**는 게시했어요", "<b>사진 보내 준다며</b>는 게시했어요"],
    ["3~5개 정도, 10~20분 걸려요", "3~5개 정도, 10~20분 걸려요"],
    ["~하는 법과 ~할 때", "~하는 법과 ~할 때"],
    ["~~지운 줄~~ 남은 줄", "<s>지운 줄</s> 남은 줄"],
    ["`a~b~c` 그대로", "<code>a~b~c</code> 그대로"],
    ["2 ** 3 은 8이에요", "2 ** 3 은 8이에요"],
    ["snake_case_name 변수", "snake_case_name 변수"],
    ["보통 **굵게** 와 *기울임*", "보통 <b>굵게</b> 와 <i>기울임</i>"],
  ];
  const failed = cases.map(([text, want]) => [text, want, inline(text)]).filter(([, want, got]) => want !== got);
  expect(failed.length === 0, failed.map(([text, want, got]) => `${text}\n  want ${want}\n  got  ${got}`).join("\n"));
  return `${cases.length} cases`;
});

void run();
