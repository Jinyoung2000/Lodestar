import type { DisplayPart } from "./typeParts";

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
  let inLabel = false;
  let headDone = false;
  for (const match of code.matchAll(TOKEN)) {
    const [text, lineBreak, space, literal, word, number, multi, single] = match;
    const operator = multi ?? single;
    if (lineBreak) {
      parts.push({ text: lineBreak, kind: "lineBreak" });
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
