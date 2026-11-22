import { syntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState, StateField, Transaction, type ChangeSpec, type Extension, type TransactionSpec } from "@codemirror/state";
import { EditorView, type Command } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import type { EditorOptions } from "../shared/editorOptions";


type EnterRule = {
  before: RegExp;
  after?: RegExp;
  previous?: RegExp;
  action: { indent: "none" | "indentOutdent"; append?: string; remove?: number };
};

const DOC_OPEN = /^\s*\/\*\*(?!\/)([^\*]|\*(?!\/))*$/;
const DOC_PREVIOUS = /(?=^(\s*(\/\*\*|\*)).*)(?=(?!(\s*\*\/)))/;
const LINE_COMMENT_RULE: EnterRule = { before: /^\s*\/\/\s*\S|\s\/\/\s+\S/, after: /^(?!\s*$)/, action: { indent: "none", append: "// " } };

const JS_RULES: EnterRule[] = [
  { before: DOC_OPEN, after: /^\s*\*\/$/, action: { indent: "indentOutdent", append: " * " } },
  { before: DOC_OPEN, action: { indent: "none", append: " * " } },
  { before: /^(\t|[ ])*\*([ ]([^\*]|\*(?!\/))*)?$/, previous: DOC_PREVIOUS, action: { indent: "none", append: "* " } },
  { before: /^(\t|[ ])*[ ]\*\/\s*$/, action: { indent: "none", remove: 1 } },
  { before: /^(\t|[ ])*[ ]\*[^\/]*\*\/\s*$/, action: { indent: "none", remove: 1 } },
  LINE_COMMENT_RULE,
];

const JAVA_RULES: EnterRule[] = [
  { before: DOC_OPEN, after: /^\s*\*\/$/, action: { indent: "indentOutdent", append: " * " } },
  { before: DOC_OPEN, action: { indent: "none", append: " * " } },
  { before: /^(\t|[ ])*[ ]\*([ ]([^\*]|\*(?!\/))*)?$/, previous: DOC_PREVIOUS, action: { indent: "none", append: "* " } },
  { before: /^(\t|[ ])*[ ]\*\/\s*$/, action: { indent: "none", remove: 1 } },
  { before: /^(\t|[ ])*[ ]\*[^\/]*\*\/\s*$/, action: { indent: "none", remove: 1 } },
  LINE_COMMENT_RULE,
];

const RULES_BY_LANGUAGE: Record<string, EnterRule[]> = {
  typescript: JS_RULES,
  typescriptreact: JS_RULES,
  javascript: JS_RULES,
  javascriptreact: JS_RULES,
  java: JAVA_RULES,
  go: [LINE_COMMENT_RULE],
  swift: [LINE_COMMENT_RULE],
  json: [LINE_COMMENT_RULE],
};

export function enterWithRules(languageId: string | null): Command {
  const rules = enterRulesFor(languageId);
  return (view) => {
    if (!rules.length) return false;
    const { state } = view;
    if (state.readOnly) return false;
    const plans = state.selection.ranges.map((range) => {
      const startLine = state.doc.lineAt(range.from);
      const endLine = state.doc.lineAt(range.to);
      const before = startLine.text.slice(0, range.from - startLine.from);
      const after = endLine.text.slice(range.to - endLine.from);
      const previous = startLine.number > 1 ? state.doc.line(startLine.number - 1).text : "";
      return matchEnterRule(rules, previous, before, after);
    });
    if (plans.some((plan) => !plan)) return false;
    let index = 0;
    const spec = state.changeByRange((range) => {
      const rule = plans[index++]!;
      const line = state.doc.lineAt(range.from);
      let indentation = /^[ \t]*/.exec(line.text)![0];
      if (indentation.length > range.from - line.from) indentation = indentation.slice(0, range.from - line.from);
      if (rule.action.remove) indentation = indentation.slice(0, indentation.length - rule.action.remove);
      const append = rule.action.append ?? "";
      if (rule.action.indent === "indentOutdent") {
        const inner = indentation + append;
        return { changes: { from: range.from, to: range.to, insert: `\n${inner}\n${indentation}` }, range: EditorSelection.cursor(range.from + 1 + inner.length) };
      }
      const insert = `\n${indentation}${append}`;
      return { changes: { from: range.from, to: range.to, insert }, range: EditorSelection.cursor(range.from + insert.length) };
    });
    view.dispatch(state.update(spec, { userEvent: "input", scrollIntoView: true }));
    return true;
  };
}

export function enterRulesFor(languageId: string | null): EnterRule[] {
  return (languageId && RULES_BY_LANGUAGE[languageId]) || [];
}

export function matchEnterRule(rules: EnterRule[], previousLine: string, before: string, after: string): EnterRule | null {
  for (const rule of rules) {
    if (!rule.before.test(before)) continue;
    if (rule.after && !rule.after.test(after)) continue;
    if (rule.previous && !rule.previous.test(previousLine)) continue;
    return rule;
  }
  return null;
}

const DOC_CLOSE_LANGUAGES = new Set(["typescript", "typescriptreact", "javascript", "javascriptreact", "java"]);
const CLOSE_BEFORE_DEFAULT = ";:.,=}])> \n\t";
const CLOSE_BEFORE_JS = ";:.,=}])>` \n\t";

export function docCommentCloser(options: EditorOptions, languageId: string | null): Extension {
  if (!languageId || !DOC_CLOSE_LANGUAGES.has(languageId) || options.autoClosingBrackets === "never") return [];
  const closeBefore = languageId === "java" ? CLOSE_BEFORE_DEFAULT : CLOSE_BEFORE_JS;
  return EditorView.inputHandler.of((view, from, to, text) => {
    if (text !== "*" || from !== to || view.state.readOnly) return false;
    const { state } = view;
    if (state.sliceDoc(from - 2, from) !== "/*") return false;
    const next = state.sliceDoc(from, from + 1);
    const allowed = options.autoClosingBrackets === "always" || (options.autoClosingBrackets === "beforeWhitespace" ? next === "" || /\s/.test(next) : next === "" || closeBefore.includes(next));
    if (!allowed || insideString(state, from)) return false;
    view.dispatch({ changes: { from, insert: "* */" }, selection: { anchor: from + 1 }, userEvent: "input.type", scrollIntoView: true });
    return true;
  });
}

function insideString(state: EditorState, pos: number): boolean {
  for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1); node; node = node.parent) {
    if (/String|Template/.test(node.name) && node.from < pos && pos < node.to) return true;
  }
  return false;
}

export const autoWhitespaceLines = StateField.define<readonly number[]>({
  create: () => [],
  update(value, tr) {
    if (!tr.docChanged) return value;
    const event = tr.annotation(Transaction.userEvent);
    if (event === undefined) return value.map((pos) => tr.changes.mapPos(pos, 1));
    if (/^(undo|redo)/.test(event)) return [];
    return event === "input" ? newAutoLines(tr) : [];
  },
});

function newAutoLines(tr: Transaction): number[] {
  const found = new Set<number>();
  tr.changes.iterChanges((fromA, _toA, fromB, toB, inserted) => {
    if (inserted.lines < 2) return;
    const oldLine = tr.startState.doc.lineAt(fromA);
    const first = tr.state.doc.lineAt(fromB).number;
    const last = tr.state.doc.lineAt(toB).number;
    for (let n = first; n <= last; n++) {
      const line = tr.state.doc.line(n);
      if (n === first && /\S/.test(oldLine.text)) continue;
      const oldContent = n === first ? oldLine.text : "";
      if (line.length > 0 && line.text !== oldContent && !/\S/.test(line.text)) found.add(line.from);
    }
  });
  return [...found];
}

const trimFilter = EditorState.transactionFilter.of((tr): TransactionSpec | readonly TransactionSpec[] => {
  if (!tr.docChanged) return tr;
  const event = tr.annotation(Transaction.userEvent);
  if (event === undefined || /^(undo|redo)/.test(event)) return tr;
  const tracked = tr.startState.field(autoWhitespaceLines, false);
  if (!tracked?.length) return tr;
  const doc = tr.startState.doc;
  const edits: { fromA: number; toA: number; insertedStartsWithBreak: boolean; insertedEndsWithBreak: boolean }[] = [];
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    edits.push({ fromA, toA, insertedStartsWithBreak: inserted.lines > 1 && inserted.line(1).length === 0, insertedEndsWithBreak: inserted.lines > 1 && inserted.line(inserted.lines).length === 0 });
  });
  for (const range of tr.startState.selection.ranges) {
    const cursorStart = doc.lineAt(range.from).number;
    const cursorEnd = doc.lineAt(range.to).number;
    const near = edits.some((edit) => !(doc.lineAt(edit.fromA).number > cursorEnd) && !(cursorStart > doc.lineAt(edit.toA).number));
    if (!near) return tr;
  }
  const deletions: ChangeSpec[] = [];
  for (const pos of tracked) {
    if (pos > doc.length) continue;
    const line = doc.lineAt(pos);
    if (line.from !== pos || line.length === 0 || /\S/.test(line.text)) continue;
    const touched = edits.some((edit) => {
      const startLine = doc.lineAt(edit.fromA).number;
      const endLine = doc.lineAt(edit.toA).number;
      if (line.number < startLine || line.number > endLine) return false;
      if (edit.fromA === edit.toA && edit.fromA === line.to && edit.insertedStartsWithBreak) return false;
      if (edit.fromA === edit.toA && edit.fromA === line.from && edit.insertedEndsWithBreak) return false;
      return true;
    });
    if (!touched) deletions.push({ from: line.from, to: line.to });
  }
  return deletions.length ? [tr, { changes: deletions }] : tr;
});

export function trimAutoWhitespace(options: EditorOptions): Extension {
  return options.trimAutoWhitespace ? [autoWhitespaceLines, trimFilter] : [];
}
