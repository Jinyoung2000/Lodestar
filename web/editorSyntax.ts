import { cssLanguage } from "@codemirror/lang-css";
import { javascript } from "@codemirror/lang-javascript";
import { jsonLanguage } from "@codemirror/lang-json";
import { languageDataProp, LanguageSupport, syntaxHighlighting, syntaxTree, type Language, type LRLanguage } from "@codemirror/language";
import { Facet, Prec, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { styleTags, tagHighlighter, tags, type Highlighter, type Tag } from "@lezer/highlight";
import type { NodeType, SyntaxNode, Tree } from "@lezer/common";
import { graphqlTemplates } from "./graphqlEmbed";
import { semanticTokens } from "./semanticTokens";


// 에디터와 diff 가 같이 쓰는 코드 색. semantic 은 LSP 가 붙은 에디터만 켠다(diff 에는 LSP 가 없다).
export function editorSyntax(options: { semantic?: boolean } = {}): Extension {
  return [
    editorSyntaxTheme,
    syntaxHighlighters.map((highlighter) => syntaxHighlighting(highlighter)),
    // LSP 의 hover 와 시그니처 도움말 속 코드 블록은 highlightingFor(state, tags) 를 scope 없이 부른다. scope 가 있는 위 하이라이터는 그때 빠지므로,
    // LSP 가 붙는 JS, TS 에디터에는 같은 규칙의 scope 없는 하이라이터를 하나 더 둔다(본문에는 같은 클래스가 겹쳐 붙을 뿐이다).
    options.semantic ? syntaxHighlighting(tagHighlighter(toSpecs(BASE_RULES))) : [],
    // 구문 색(syntaxHighlighting)은 Prec.high 의 mark 장식이고, 같은 글자에 mark 가 겹치면 우선순위가 높은 쪽이 안쪽 span 이 되어 색을 이긴다.
    // 아래 셋은 구문 색 위에 덮어야 하므로 그보다 높은 Prec.highest 로 둔다. 배열에서 앞선 쪽이 안쪽이라, 괄호 색, 의미 색, refinements 순으로 이긴다.
    Prec.highest([bracketPairs, options.semantic ? semanticTokens : [], refinements]),
  ];
}

export function refineGraphql<L extends LRLanguage>(language: L): L {
  return language.configure({ props: [GRAPHQL_OVERRIDES] }) as L;
}

const GRAPHQL_OVERRIDES = styleTags({
  "Description/StringValue": tags.blockComment,
  "NamedType/Name": tags.typeName,
  "ObjectTypeDefinition/Name InterfaceTypeDefinition/Name UnionTypeDefinition/Name EnumTypeDefinition/Name InputObjectTypeDefinition/Name ScalarTypeDefinition/Name": tags.typeName,
  "ObjectTypeExtension/Name InterfaceTypeExtension/Name UnionTypeExtension/Name EnumTypeExtension/Name InputObjectTypeExtension/Name ScalarTypeExtension/Name": tags.typeName,
  DirectiveName: tags.function(tags.variableName),
  ArgumentAttributeName: tags.variableName,
  "InputValueDefinition/Name FieldDefinition/Name": tags.variableName,
  "OperationDefinition/Name": tags.function(tags.definition(tags.variableName)),
  // ...Frag: variable.fragment (변수 색, cm6-graphql 은 atom 이라 키워드 색)
  "FragmentSpread/FragmentName/Name": tags.variableName,
});

export function refineJavascript(options?: Parameters<typeof javascript>[0]): LanguageSupport {
  const base = javascript(options);
  return new LanguageSupport((base.language as LRLanguage).configure({ props: [JS_OVERRIDES], wrap: graphqlTemplates }), base.support);
}

const PREFIX = "cm-syn-";

// 클래스 이름과 토큰 변수. 구두점은 기본 전경색이다.
const COLORS = {
  kw: "--syntax-keyword",
  control: "--syntax-keyword-control",
  function: "--syntax-function",
  type: "--syntax-type",
  string: "--syntax-string",
  comment: "--syntax-comment",
  variable: "--syntax-variable",
  constant: "--syntax-constant",
  number: "--syntax-number",
  regexp: "--syntax-regexp",
  escape: "--syntax-escape",
  operator: "--syntax-operator",
  tag: "--syntax-tag",
  "tag-bracket": "--syntax-tag-bracket",
  attribute: "--syntax-attribute",
  selector: "--syntax-selector",
  value: "--syntax-value",
  "json-key": "--syntax-json-key",
  punct: "--editor-fg",
} as const;

type Kind = keyof typeof COLORS;
type Rule = { tag: Tag | readonly Tag[]; kind: Kind | "md-heading" | "md-strong" | "md-emphasis" | "md-code" | "md-quote" };

const toSpecs = (rules: readonly Rule[]) => rules.map((r) => ({ tag: r.tag, class: PREFIX + r.kind }));

// TS, TSX, JS, JSX 와 마크다운. 한 노드에 규칙이 여럿 맞으면 태그가 더 구체적인 쪽이 이긴다(function(definition(variableName)) 가 definition(variableName) 보다 먼저).
const BASE_RULES: Rule[] = [
  { tag: [tags.controlKeyword, tags.moduleKeyword], kind: "control" },
  { tag: [tags.keyword, tags.operatorKeyword, tags.definitionKeyword, tags.modifier, tags.self, tags.null, tags.atom, tags.bool, tags.function(tags.punctuation), tags.special(tags.brace)], kind: "kw" },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.function(tags.definition(tags.variableName)), tags.function(tags.definition(tags.propertyName))], kind: "function" },
  { tag: [tags.typeName, tags.className, tags.namespace], kind: "type" },
  { tag: tags.standard(tags.tagName), kind: "tag" },
  { tag: tags.angleBracket, kind: "tag-bracket" },
  { tag: tags.attributeName, kind: "attribute" },
  { tag: [tags.variableName, tags.propertyName, tags.definition(tags.variableName), tags.definition(tags.propertyName)], kind: "variable" },
  { tag: tags.number, kind: "number" },
  { tag: [tags.string, tags.special(tags.string)], kind: "string" },
  { tag: tags.regexp, kind: "regexp" },
  { tag: tags.escape, kind: "escape" },
  { tag: tags.comment, kind: "comment" },
  { tag: tags.operator, kind: "operator" },
  { tag: [tags.punctuation, tags.derefOperator], kind: "punct" },
  // 마크다운
  { tag: [tags.heading, tags.heading1, tags.heading2, tags.heading3, tags.heading4, tags.heading5, tags.heading6], kind: "md-heading" },
  { tag: tags.strong, kind: "md-strong" },
  { tag: tags.emphasis, kind: "md-emphasis" },
  { tag: tags.monospace, kind: "md-code" },
  { tag: tags.quote, kind: "md-quote" },
];

// CSS: 선택자, 속성 이름, 값이 JS 와 다른 색이고, at-rule(@media, @import)은 제어 키워드 색이다.
const CSS_RULES: Rule[] = [
  { tag: tags.definitionKeyword, kind: "control" },
  { tag: tags.keyword, kind: "kw" },
  { tag: [tags.tagName, tags.className, tags.constant(tags.className), tags.labelName, tags.namespace], kind: "selector" },
  { tag: [tags.propertyName, tags.attributeName, tags.variableName], kind: "attribute" },
  { tag: [tags.atom, tags.color], kind: "value" },
  { tag: tags.operatorKeyword, kind: "function" },
  { tag: [tags.number, tags.unit], kind: "number" },
  { tag: tags.string, kind: "string" },
  { tag: tags.comment, kind: "comment" },
];

const JSON_RULES: Rule[] = [
  { tag: tags.propertyName, kind: "json-key" },
  { tag: [tags.bool, tags.null], kind: "kw" },
  { tag: tags.number, kind: "number" },
  { tag: tags.string, kind: "string" },
];


// YAML: 키는 entity.name.tag(파랑), 값은 string.unquoted(주황), 앵커와 별칭은 변수색, !!str 같은 태그는 storage.type(파랑), | 와 > 는 keyword.control.
// 숫자, true, null 은 Lezer 트리에 구분이 없어서 web/languages.ts 가 값(Literal) 안을 따로 파싱해 number, atom 으로 나눈다.
const YAML_RULES: Rule[] = [
  ...BASE_RULES,
  { tag: tags.definition(tags.propertyName), kind: "tag" },
  { tag: tags.content, kind: "string" },
  { tag: tags.attributeValue, kind: "string" },
  { tag: tags.labelName, kind: "variable" },
  { tag: tags.typeName, kind: "kw" },
  { tag: tags.special(tags.string), kind: "control" },
  { tag: tags.separator, kind: "punct" },
  { tag: tags.meta, kind: "punct" },
];

// HTML, XML: 태그 이름은 entity.name.tag(파랑), 꺾쇠는 회색, 속성 이름은 하늘색, 속성 값은 string, &amp; 는 constant.character.entity.
const MARKUP_RULES: Rule[] = [
  ...BASE_RULES,
  { tag: tags.tagName, kind: "tag" },
  { tag: tags.attributeValue, kind: "string" },
  { tag: tags.character, kind: "kw" },
  { tag: [tags.processingInstruction, tags.documentMeta], kind: "tag-bracket" },
  { tag: tags.invalid, kind: "regexp" },
];

// SQL: 자료형은 storage.type(파랑), 내장 함수 이름은 support.function(노랑), @변수는 variable. 식별자는 기본색.
const SQL_RULES: Rule[] = [
  ...BASE_RULES,
  { tag: tags.typeName, kind: "kw" },
  { tag: tags.standard(tags.name), kind: "function" },
  { tag: tags.special(tags.name), kind: "variable" },
  { tag: tags.special(tags.string), kind: "variable" },
];

// .properties, .ini, .env: [섹션] 은 entity.name.section(파랑), 키는 변수색, 값은 string.
const PROPERTIES_RULES: Rule[] = [
  ...BASE_RULES,
  { tag: tags.heading, kind: "tag" },
  { tag: tags.quote, kind: "string" },
];

// 셸: 단어 맨 앞의 명령 이름은 entity.name.command(노랑), `#!` 줄은 주석색, 그 밖에는 BASE_RULES 와 같다.
const SHELL_RULES: Rule[] = [...BASE_RULES, { tag: tags.meta, kind: "comment" }];

// diff: 추가 줄은 markup.inserted(연두), 삭제 줄은 markup.deleted(주황), @@ 줄은 meta.diff.range(파랑), 헤더는 markup.heading.
const DIFF_RULES: Rule[] = [
  { tag: tags.inserted, kind: "number" },
  { tag: tags.deleted, kind: "string" },
  { tag: tags.meta, kind: "kw" },
  { tag: tags.comment, kind: "comment" },
  { tag: tags.heading, kind: "tag" },
];

// Java, Kotlin, Swift 의 @Annotation 은 storage.type.annotation(타입색).
const CLIKE_RULES: Rule[] = [...BASE_RULES, { tag: tags.meta, kind: "type" }, { tag: tags.character, kind: "string" }];

// Go 의 룬 'a' 도 문자열색이다.
const CHARACTER_RULES: Rule[] = [...BASE_RULES, { tag: tags.character, kind: "string" }];

export type SyntaxGroup = "css" | "json" | "yaml" | "markup" | "sql" | "properties" | "shell" | "diff" | "clike" | "character";

const GROUP_RULES: Record<SyntaxGroup, readonly Rule[]> = {
  css: CSS_RULES,
  json: JSON_RULES,
  yaml: YAML_RULES,
  markup: MARKUP_RULES,
  sql: SQL_RULES,
  properties: PROPERTIES_RULES,
  shell: SHELL_RULES,
  diff: DIFF_RULES,
  clike: CLIKE_RULES,
  character: CHARACTER_RULES,
};

// 하이라이터의 scope 는 (중첩된 언어마다) 그 언어의 최상위 노드 타입으로 부른다.
// 묶음에 속한 언어는 읽어 올 때(web/languages.ts) markLanguage 로 등록하므로, 아직 읽지 않은 언어의 패키지를 여기서 import 하지 않는다.
const groupMembers = new Map<SyntaxGroup, Set<unknown>>();

export function markLanguage(group: SyntaxGroup, language: Language): void {
  const members = groupMembers.get(group) ?? new Set<unknown>();
  members.add(language.data);
  groupMembers.set(group, members);
}

markLanguage("css", cssLanguage);
markLanguage("json", jsonLanguage);

const groupOf = (top: NodeType): SyntaxGroup | null => {
  const data = top.prop(languageDataProp);
  if (data === undefined) return null;
  for (const [group, members] of groupMembers) if (members.has(data)) return group;
  return null;
};

// 한 노드에 두 하이라이터의 클래스가 겹치면 CSS 선언 순서에 기대게 되므로, 언어마다 하나만 맞게 scope 로 가른다.
export const syntaxHighlighters: Highlighter[] = [
  tagHighlighter(toSpecs(BASE_RULES), { scope: (top) => groupOf(top) === null }),
  ...(Object.keys(GROUP_RULES) as SyntaxGroup[]).map((group) => tagHighlighter(toSpecs(GROUP_RULES[group]), { scope: (top) => groupOf(top) === group })),
];

const JS_OVERRIDES = styleTags({
  "await yield as satisfies": tags.controlKeyword,
  "MethodDeclaration/PropertyDefinition": tags.function(tags.definition(tags.propertyName)),
  // class A extends Base: 상속한 클래스 이름은 타입 색이다(entity.other.inherited-class).
  "ClassDeclaration/VariableName ClassExpression/VariableName": tags.className,
  // useState<Foo>(x) 처럼 타입 인자가 붙은 호출은 CallExpression 안에 InstantiationExpression 이 한 겹 더 있다.
  "CallExpression/InstantiationExpression/VariableName": tags.function(tags.variableName),
  "CallExpression/InstantiationExpression/MemberExpression/PropertyName": tags.function(tags.propertyName),
});

// --- 이름만 봐서는 못 정하는 TS 색 (TextMate 문법이 하던 일) ---
//   undefined, NaN, Infinity: constant.language (파랑)
//   const 로 선언한 이름: variable.other.constant (밝은 파랑)
//   함수를 바로 대입한 이름(const f = () => {}): entity.name.function (노랑)
// 의미 기반 색(semanticTokens)이 오면 그쪽이 이 위를 덮는다.

const LANGUAGE_CONSTANTS = new Set(["undefined", "NaN", "Infinity"]);
const PATTERNS = new Set(["ObjectPattern", "ArrayPattern", "PatternProperty"]);
const DECLARATORS = new Set(["const", "let", "var", "using"]);

function declarationClass(definition: SyntaxNode): string | null {
  let owner = definition.parent;
  while (owner && PATTERNS.has(owner.name)) owner = owner.parent;
  if (!owner || !(owner.name === "VariableDeclaration" || owner.name === "ForOfSpec" || owner.name === "ForInSpec")) return null;
  // 직접 선언한 이름이 함수 값을 받으면 함수 색
  if (definition.parent === owner) {
    let next = definition.nextSibling;
    if (next?.name === "TypeAnnotation") next = next.nextSibling;
    if (next?.name === "Equals" && (next.nextSibling?.name === "ArrowFunction" || next.nextSibling?.name === "FunctionExpression")) return PREFIX + "function";
  }
  for (let child = owner.firstChild; child; child = child.nextSibling) {
    if (DECLARATORS.has(child.name)) return child.name === "const" ? PREFIX + "constant" : null;
  }
  return null;
}

// 객체 리터럴의 메서드(async handle() {}, get x() {})와 함수를 값으로 둔 속성(handle: () => {})의 이름은 함수 색이다(entity.name.function).
// 클래스 메서드는 JS_OVERRIDES 가 맡고, 객체 리터럴은 Property 안에 ParamList 가 있는지 봐야 해서 여기서 칠한다(사용자 10-28 defineProcessor({ async handle() }) 가 속성 색이었다).
function isFunctionProperty(definition: SyntaxNode): boolean {
  const property = definition.parent;
  if (property?.name !== "Property") return false;
  for (let next = definition.nextSibling; next; next = next.nextSibling) {
    if (next.name === "ParamList") return true;
    if (next.name === ":") return next.nextSibling?.name === "ArrowFunction" || next.nextSibling?.name === "FunctionExpression";
  }
  return false;
}

const MARKS = {
  kw: Decoration.mark({ class: PREFIX + "kw" }),
  constant: Decoration.mark({ class: PREFIX + "constant" }),
  function: Decoration.mark({ class: PREFIX + "function" }),
};

class Refinements {
  decorations: DecorationSet = Decoration.none;
  tree: Tree | null = null;
  constructor(view: EditorView) {
    this.build(view);
  }
  update(update: ViewUpdate) {
    if (update.docChanged || update.viewportChanged || syntaxTree(update.state) !== this.tree) this.build(update.view);
  }
  build(view: EditorView) {
    const tree = syntaxTree(view.state);
    this.tree = tree;
    const ranges: { from: number; to: number; mark: Decoration }[] = [];
    for (const { from, to } of view.visibleRanges) {
      tree.iterate({
        from,
        to,
        enter: (node) => {
          if (node.name === "VariableName") {
            if (LANGUAGE_CONSTANTS.has(view.state.sliceDoc(node.from, node.to))) ranges.push({ from: node.from, to: node.to, mark: MARKS.kw });
          } else if (node.name === "VariableDefinition") {
            const cls = declarationClass(node.node);
            if (cls) ranges.push({ from: node.from, to: node.to, mark: cls.endsWith("function") ? MARKS.function : MARKS.constant });
          } else if (node.name === "PropertyDefinition" && isFunctionProperty(node.node)) {
            ranges.push({ from: node.from, to: node.to, mark: MARKS.function });
          }
        },
      });
    }
    this.decorations = Decoration.set(ranges.map((r) => r.mark.range(r.from, r.to)), true);
  }
}

const refinements = ViewPlugin.fromClass(Refinements, { decorations: (plugin) => plugin.decorations });

const OPENERS: Record<string, string> = { "(": ")", "[": "]", "{": "}", "<": ">" };
const CLOSERS = new Set([")", "]", "}", ">"]);
const ANGLE_PARENTS = new Set(["TypeArgList", "TypeParamList"]);
const BRACKET_COLORS = 3;
const BRACKET_MARKS = [0, 1, 2].map((i) => Decoration.mark({ class: `cm-bracket-${i}` }));
const UNEXPECTED_MARK = Decoration.mark({ class: "cm-bracket-unexpected" });

// editor.bracketPairColorization. 에디터가 설정으로 끈다. 켜 둔 곳(diff 등)은 기본값이 켬이다.
export const bracketColorization = Facet.define<boolean, boolean>({ combine: (values) => values.length === 0 || values[values.length - 1]! });

class BracketPairs {
  decorations: DecorationSet = Decoration.none;
  private tree: Tree | null = null;
  private builtTo = 0;
  private stack: string[] = [];
  // 괄호 하나당 [위치, 색 번호(BRACKET_COLORS 면 짝 없음)]
  private found: [number, number][] = [];

  constructor(view: EditorView) {
    this.build(view);
  }

  update(update: ViewUpdate) {
    if (update.docChanged || update.viewportChanged || syntaxTree(update.state) !== this.tree || update.startState.facet(bracketColorization) !== update.state.facet(bracketColorization)) this.build(update.view);
  }

  private build(view: EditorView) {
    if (!view.state.facet(bracketColorization)) {
      this.decorations = Decoration.none;
      return;
    }
    const tree = syntaxTree(view.state);
    if (tree !== this.tree) {
      this.tree = tree;
      this.builtTo = 0;
      this.stack = [];
      this.found = [];
    }
    const last = view.visibleRanges[view.visibleRanges.length - 1];
    // 보이는 범위가 없을 때(본문이 비었거나 아직 재지 않음) 낡은 장식을 그대로 두면 다음 갱신에서 새 문서 밖 위치를 옮기다 RangeError 가 난다
    if (!last) {
      this.decorations = Decoration.none;
      return;
    }
    if (last.to > this.builtTo) {
      tree.iterate({
        from: this.builtTo,
        to: last.to,
        enter: (node) => {
          if (node.from < this.builtTo || node.to - node.from !== 1) return;
          const name = node.name;
          const isOpen = name in OPENERS;
          if (!isOpen && !CLOSERS.has(name)) return;
          if ((name === "<" || name === ">") && !ANGLE_PARENTS.has(node.node.parent?.name ?? "")) return;
          if (isOpen) {
            this.found.push([node.from, this.stack.length % BRACKET_COLORS]);
            this.stack.push(OPENERS[name]!);
          } else if (this.stack[this.stack.length - 1] === name) {
            this.stack.pop();
            this.found.push([node.from, this.stack.length % BRACKET_COLORS]);
          } else {
            this.found.push([node.from, BRACKET_COLORS]);
          }
        },
      });
      this.builtTo = last.to;
    }
    const ranges = [];
    for (const { from, to } of view.visibleRanges) {
      for (const [pos, color] of this.found) {
        if (pos < from) continue;
        if (pos >= to) break;
        ranges.push((color === BRACKET_COLORS ? UNEXPECTED_MARK : BRACKET_MARKS[color]!).range(pos, pos + 1));
      }
    }
    this.decorations = Decoration.set(ranges, true);
  }
}

const bracketPairs = ViewPlugin.fromClass(BracketPairs, { decorations: (plugin) => plugin.decorations });

// --- 색 ---

const kindRules = Object.fromEntries(
  (Object.entries(COLORS) as [Kind, string][]).map(([kind, variable]) => [`.${PREFIX}${kind}`, { color: `var(${variable})` }]),
);

export const editorSyntaxTheme = EditorView.theme({
  ...kindRules,
  [`.${PREFIX}md-heading`]: { color: "var(--syntax-tag)", fontWeight: "bold" },
  [`.${PREFIX}md-strong`]: { color: "var(--syntax-keyword)", fontWeight: "bold" },
  [`.${PREFIX}md-emphasis`]: { color: "var(--syntax-keyword-control)", fontStyle: "italic" },
  [`.${PREFIX}md-code`]: { color: "var(--syntax-string)" },
  [`.${PREFIX}md-quote`]: { color: "var(--syntax-comment)" },
  ".cm-bracket-0": { color: "var(--editor-bracket-1)" },
  ".cm-bracket-1": { color: "var(--editor-bracket-2)" },
  ".cm-bracket-2": { color: "var(--editor-bracket-3)" },
  ".cm-bracket-unexpected": { color: "var(--editor-bracket-unexpected)" },
});
