// TS 안 graphql 태그 템플릿을 GraphQL 문법으로 읽는지(web/graphqlEmbed.ts) 시험. 실행: npm test
import { highlightTree } from "@lezer/highlight";
import { refineJavascript, syntaxHighlighters } from "../web/editorSyntax";
import { loadGraphqlParser } from "../web/graphqlEmbed";

const src = "const q = graphql`\n  query FooQuery($id: ID!) { node(id: $id) { ...Bar_item } }\n`;\nconst s = `query NotGraphql { a }`;\nconst f = gql`fragment X on Y { a ${b} c }`;\n";
await loadGraphqlParser();
const language = refineJavascript({ typescript: true }).language;
const tree = language.parser.parse(src);
const classes = new Map<string, string>();
highlightTree(tree, syntaxHighlighters, (from, to, cls) => {
  classes.set(src.slice(from, to), `${classes.get(src.slice(from, to)) ?? ""} ${cls}`.trim());
});
const fail: string[] = [];
const expect = (cond: boolean, msg: string) => cond || fail.push(msg);
expect(/kw|control/.test(classes.get("query") ?? ""), `graphql 태그 안 query 는 키워드 색: ${classes.get("query")}`);
expect(!!classes.get("FooQuery") && !/string/.test(classes.get("FooQuery")!), `연산 이름은 문자열 색이 아니다: ${classes.get("FooQuery")}`);
expect(/variable/.test(classes.get("$id") ?? ""), `변수는 변수 색: ${classes.get("$id")}`);
expect(/kw|control/.test(classes.get("fragment") ?? ""), `gql 태그도 칠한다: ${classes.get("fragment")}`);
expect(/string/.test(classes.get("`query NotGraphql { a }`") ?? ""), `태그 없는 템플릿은 문자열 그대로: ${classes.get("`query NotGraphql { a }`")}`);
if (fail.length) {
  console.log(fail.map((f) => `FAIL ${f}`).join("\n"));
  console.log([...classes].map(([k, v]) => `${JSON.stringify(k)} ${v}`).join("\n"));
  process.exit(1);
}
console.log("graphqlembed: 5 passed");

{
  const { graphqlLanguage } = await import("cm6-graphql");
  const { refineGraphql } = await import("../web/editorSyntax");
  const schema = `"""\n채팅 오픈 일시\n"""\ntype Application {\n  chatOpenedAt: DateTime @deprecated(reason: "use chat")\n}\nquery Q { node { ...Frag } }\n`;
  const kinds = new Map<string, string>();
  highlightTree(refineGraphql(graphqlLanguage).parser.parse(schema), syntaxHighlighters, (from, to, cls) => kinds.set(schema.slice(from, to), cls));
  const want: [string, string][] = [
    ['"""\n채팅 오픈 일시\n"""', "cm-syn-comment"],
    ["Application", "cm-syn-type"],
    ["DateTime", "cm-syn-type"],
    ["@deprecated", "cm-syn-function"],
    ["reason", "cm-syn-variable"],
    ["chatOpenedAt", "cm-syn-variable"],
    ["Q", "cm-syn-function"],
    ["Frag", "cm-syn-variable"],
  ];
  const wrong = want.filter(([text, cls]) => kinds.get(text) !== cls);
  if (wrong.length) {
    console.log(wrong.map(([text, cls]) => `FAIL ${JSON.stringify(text)}: ${kinds.get(text)} !== ${cls}`).join("\n"));
    process.exit(1);
  }
  console.log(`graphqlembed: .graphql ${want.length} passed`);
}
