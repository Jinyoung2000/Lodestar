import type { DisplayPart } from "./typeParts";

// 네이티브 TypeScript(typescript-go) LSP 는 tsserver 의 quickinfo-full(typescript.tsserverRequest)이 없다.
// 대신 hover 마크다운의 첫 ```typescript 블록(`const x: T`, `function f(a: A): R` 처럼 tsserver 가 displayParts 를 이어 붙인 것과 같은 글)을
// 조각 목록으로 다시 쪼개 web/typeParts.ts 가 그대로 읽게 한다. DOM 과 LSP 가 없어 단위 시험이 읽는다.

const MODIFIERS = new Set(["export", "declare", "default", "abstract", "async", "readonly", "static", "public", "private", "protected", "override"]);
const DECLARATION_WORDS = new Set(["function", "const", "let", "var", "using", "class", "interface", "type", "enum", "namespace", "module"]);
const TOKEN = /(\r?\n[ \t]*)|([ \t]+)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)|([A-Za-z_$][\w$]*)|(\d[\w.]*)|(=>|\.\.\.)|([^\s])/g;

export function partsFromHoverMarkdown(markdown: string): DisplayPart[] | null {
  const block = /```(?:typescript|ts|tsx|javascript|js)[^\n]*\n([\s\S]*?)```/.exec(markdown);
  const code = block?.[1]?.trimEnd();
  return code ? tokenize(code) : null;
}

function tokenize(code: string): DisplayPart[] {
  const parts: DisplayPart[] = [];
  // 머리(`(alias)` 라벨, 수정자, 선언 키워드)까지만 keyword 로 칠한다. 그 뒤의 `type` 같은 이름은 변수 이름이다.
  let inLabel = false;
  let headDone = false;
  for (const match of code.matchAll(TOKEN)) {
    const [text, lineBreak, space, literal, word, number, multi, single] = match;
    const operator = multi ?? single;
    if (lineBreak) {
      parts.push({ text: lineBreak, kind: "lineBreak" });
      // import 별칭의 hover 는 `(alias) function f(): T` 다음 줄에 들여쓰기 없는 `import f` 가 붙는다.
      if (/^\r?\n$/.test(lineBreak) && /^import\b/.test(code.slice(match.index + lineBreak.length))) headDone = false;
    } else if (space) parts.push({ text, kind: "space" });
    else if (literal) parts.push({ text, kind: "stringLiteral" });
    else if (number) parts.push({ text, kind: "numericLiteral" });
    else if (operator) {
      parts.push({ text, kind: "punctuation" });
      if (!headDone && parts.length === 1 && text === "(") inLabel = true;
      else if (inLabel && text === ")") inLabel = false;
    } else if (word) {
      if (inLabel) parts.push({ text, kind: "text" });
      else if (!headDone && MODIFIERS.has(word)) parts.push({ text, kind: "keyword" });
      else if (!headDone && (DECLARATION_WORDS.has(word) || word === "import")) {
        parts.push({ text, kind: "keyword" });
        headDone = true;
      } else {
        parts.push({ text, kind: "text" });
        headDone = true;
      }
    }
  }
  return parts;
}
