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

void run();
