import { ParseContext } from "@codemirror/language";
import { parseMixed, type Input, type Parser, type SyntaxNodeRef } from "@lezer/common";
import { refineGraphql } from "./editorSyntax";


const TAGS = new Set(["graphql", "gql"]);

let parser: Parser | null = null;
let loading: Promise<unknown> | null = null;

export function loadGraphqlParser() {
  loading ??= import("cm6-graphql").then(({ graphqlLanguage }) => {
    parser = refineGraphql(graphqlLanguage).parser;
    void import("./languages").then(({ loadLanguage }) => loadLanguage("graphql"));
  });
  return loading;
}

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
