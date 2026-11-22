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


export function editorSyntax(options: { semantic?: boolean } = {}): Extension {
  return [
    editorSyntaxTheme,
    syntaxHighlighters.map((highlighter) => syntaxHighlighting(highlighter)),
    options.semantic ? syntaxHighlighting(tagHighlighter(toSpecs(BASE_RULES))) : [],
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
  "FragmentSpread/FragmentName/Name": tags.variableName,
});

export function refineJavascript(options?: Parameters<typeof javascript>[0]): LanguageSupport {
  const base = javascript(options);
  return new LanguageSupport((base.language as LRLanguage).configure({ props: [JS_OVERRIDES], wrap: graphqlTemplates }), base.support);
}

const PREFIX = "cm-syn-";

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
  { tag: [tags.heading, tags.heading1, tags.heading2, tags.heading3, tags.heading4, tags.heading5, tags.heading6], kind: "md-heading" },
  { tag: tags.strong, kind: "md-strong" },
  { tag: tags.emphasis, kind: "md-emphasis" },
  { tag: tags.monospace, kind: "md-code" },
  { tag: tags.quote, kind: "md-quote" },
];

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

const MARKUP_RULES: Rule[] = [
  ...BASE_RULES,
  { tag: tags.tagName, kind: "tag" },
  { tag: tags.attributeValue, kind: "string" },
  { tag: tags.character, kind: "kw" },
  { tag: [tags.processingInstruction, tags.documentMeta], kind: "tag-bracket" },
  { tag: tags.invalid, kind: "regexp" },
];

const SQL_RULES: Rule[] = [
  ...BASE_RULES,
  { tag: tags.typeName, kind: "kw" },
  { tag: tags.standard(tags.name), kind: "function" },
  { tag: tags.special(tags.name), kind: "variable" },
  { tag: tags.special(tags.string), kind: "variable" },
];

const PROPERTIES_RULES: Rule[] = [
  ...BASE_RULES,
  { tag: tags.heading, kind: "tag" },
  { tag: tags.quote, kind: "string" },
];

const SHELL_RULES: Rule[] = [...BASE_RULES, { tag: tags.meta, kind: "comment" }];

const DIFF_RULES: Rule[] = [
  { tag: tags.inserted, kind: "number" },
  { tag: tags.deleted, kind: "string" },
  { tag: tags.meta, kind: "kw" },
  { tag: tags.comment, kind: "comment" },
  { tag: tags.heading, kind: "tag" },
];

const CLIKE_RULES: Rule[] = [...BASE_RULES, { tag: tags.meta, kind: "type" }, { tag: tags.character, kind: "string" }];

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

export const syntaxHighlighters: Highlighter[] = [
  tagHighlighter(toSpecs(BASE_RULES), { scope: (top) => groupOf(top) === null }),
  ...(Object.keys(GROUP_RULES) as SyntaxGroup[]).map((group) => tagHighlighter(toSpecs(GROUP_RULES[group]), { scope: (top) => groupOf(top) === group })),
];

const JS_OVERRIDES = styleTags({
  "await yield as satisfies": tags.controlKeyword,
  "MethodDeclaration/PropertyDefinition": tags.function(tags.definition(tags.propertyName)),
  "ClassDeclaration/VariableName ClassExpression/VariableName": tags.className,
  "CallExpression/InstantiationExpression/VariableName": tags.function(tags.variableName),
  "CallExpression/InstantiationExpression/MemberExpression/PropertyName": tags.function(tags.propertyName),
});

const LANGUAGE_CONSTANTS = new Set(["undefined", "NaN", "Infinity"]);
const PATTERNS = new Set(["ObjectPattern", "ArrayPattern", "PatternProperty"]);
const DECLARATORS = new Set(["const", "let", "var", "using"]);

function declarationClass(definition: SyntaxNode): string | null {
  let owner = definition.parent;
  while (owner && PATTERNS.has(owner.name)) owner = owner.parent;
  if (!owner || !(owner.name === "VariableDeclaration" || owner.name === "ForOfSpec" || owner.name === "ForInSpec")) return null;
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

export const bracketColorization = Facet.define<boolean, boolean>({ combine: (values) => values.length === 0 || values[values.length - 1]! });

class BracketPairs {
  decorations: DecorationSet = Decoration.none;
  private tree: Tree | null = null;
  private builtTo = 0;
  private stack: string[] = [];
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

export function tokenMarks(view: EditorView): DecorationSet[] {
  return [view.plugin(refinements)?.decorations, view.plugin(semanticTokens)?.decorations, view.plugin(bracketPairs)?.decorations].filter((set): set is DecorationSet => set !== undefined);
}

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
