import { ParseContext } from "@codemirror/language";
import { parseMixed, type Input, type Parser, type SyntaxNodeRef } from "@lezer/common";
import { refineGraphql } from "./editorSyntax";


const TAGS = new Set(["graphql", "gql"]);

let parser: Parser | null = null;
let loading: Promise<unknown> | null = null;

export function loadGraphqlParser() {
  loading ??= import("cm6-graphql").then(({ graphqlLanguage }) => {
    parser = refineGraphql(graphqlLanguage).parser;
    // 에디터는 위 promise 로 다시 파싱하지만, 파서를 직접 부르는 곳(대화 코드 블록, PR diff)은 언어 버전이 바뀌어야 다시 칠한다.
    // languages.ts 가 이 파일을 거쳐 editorSyntax 를 가져오므로 순환을 피해 동적으로 부른다.
    void import("./languages").then(({ loadLanguage }) => loadLanguage("graphql"));
  });
  return loading;
}

// refineJavascript 가 JS 언어의 wrap 으로 쓴다.
export const graphqlTemplates = parseMixed((node: SyntaxNodeRef, input: Input) => {
  if (node.name !== "TemplateString" || !isGraphqlTag(node, input)) return null;
  const overlay = templateBody(node);
  if (!overlay.length) return null;
  return { parser: parser ?? ParseContext.getSkippingParser(loadGraphqlParser()), overlay };
});

function isGraphqlTag(node: SyntaxNodeRef, input: Input) {
  const tagged = node.node.parent;
  if (tagged?.name !== "TaggedTemplateExpression") return false;
  const tag = tagged.firstChild;
  return tag?.name === "VariableName" && TAGS.has(input.read(tag.from, tag.to));
}

// 백틱 안쪽에서 ${...} 를 뺀 범위들
export function templateBody(node: SyntaxNodeRef): { from: number; to: number }[] {
  const ranges: { from: number; to: number }[] = [];
  let start = node.from + 1;
  for (let child = node.node.firstChild; child; child = child.nextSibling) {
    if (child.name !== "Interpolation") continue;
    if (child.from > start) ranges.push({ from: start, to: child.from });
    start = child.to;
  }
  const end = node.to - 1;
  if (end > start) ranges.push({ from: start, to: end });
  return ranges;
}
