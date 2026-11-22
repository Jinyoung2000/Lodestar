import { lineComment, lineUncomment } from "@codemirror/commands";
import { EditorSelection, type ChangeSpec, type EditorState, type SelectionRange, type Text, type Transaction } from "@codemirror/state";


export type Target = { state: EditorState; dispatch: (tr: Transaction) => void };

export function joinLines({ state, dispatch }: Target): boolean {
  if (state.readOnly) return false;
  const doc = state.doc;
  type Sel = { from: number; to: number };
  const line = (offset: number) => doc.lineAt(offset).number;
  const sorted: Sel[] = state.selection.ranges.map((range) => ({ from: range.from, to: range.to }));
  const main = state.selection.main;
  let primary: Sel = { from: main.from, to: main.to };
  const groups: Sel[] = [];
  let acc = sorted[0];
  for (const next of sorted.slice(1)) {
    if (acc.from === acc.to) {
      if (line(acc.to) === line(next.from)) {
        if (primary.from === acc.from && primary.to === acc.to) primary = next;
        acc = next;
      } else if (line(next.from) > line(acc.to) + 1) {
        groups.push(acc);
        acc = next;
      } else acc = { from: acc.from, to: next.to };
    } else if (line(next.from) > line(acc.to)) {
      groups.push(acc);
      acc = next;
    } else acc = { from: acc.from, to: next.to };
  }
  groups.push(acc);

  const changes: ChangeSpec[] = [];
  const results: { build: (newDoc: Text, removed: number) => SelectionRange; removedLines: number; touchesPrimary: boolean }[] = [];
  for (const group of groups) {
    const startLine = line(group.from);
    const endLine = line(group.to);
    const empty = group.from === group.to;
    const endColumn = group.to - doc.line(endLine).from + 1;
    const startColumn = group.from - doc.line(startLine).from + 1;
    const afterEnd = doc.line(endLine).length - endColumn;
    let lastLine: number;
    if (empty || startLine === endLine) lastLine = startLine < doc.lines ? startLine + 1 : startLine;
    else lastLine = endLine;
    let joined = doc.line(startLine).text;
    let tail = 0;
    for (let n = startLine + 1; n <= lastLine; n++) {
      const text = doc.line(n).text;
      const firstNonSpace = text.search(/\S/);
      if (firstNonSpace >= 0) {
        let space = true;
        if (joined === "") space = false;
        if (space && (joined.endsWith(" ") || joined.endsWith("\t"))) {
          space = false;
          joined = joined.replace(/[\s﻿\xA0]+$/g, " ");
        }
        const rest = text.slice(firstNonSpace);
        joined += (space ? " " : "") + rest;
        tail = space ? rest.length + 1 : rest.length;
      } else tail = 0;
    }
    const from = doc.line(startLine).from;
    const to = doc.line(lastLine).to;
    if (from === to) continue;
    changes.push({ from, to, insert: joined });
    const removedLines = lastLine - startLine;
    const touchesPrimary = Math.max(from, primary.from) <= Math.min(to, primary.to);
    const build = (newDoc: Text, removed: number): SelectionRange => {
      const newLine = newDoc.line(startLine - removed);
      if (empty) return EditorSelection.cursor(newLine.from + joined.length - tail);
      if (startLine === endLine) return EditorSelection.range(newLine.from + startColumn - 1, newDoc.line(endLine - removed).from + endColumn - 1);
      return EditorSelection.range(newLine.from + startColumn - 1, newLine.from + joined.length - afterEnd - 1);
    };
    results.push({ build, removedLines, touchesPrimary });
  }
  if (!changes.length) return false;
  const set = state.changes(changes);
  const newDoc = set.apply(doc);
  const ranges: SelectionRange[] = [];
  let mainIndex = 0;
  let removed = 0;
  for (const result of results) {
    if (result.touchesPrimary) mainIndex = ranges.length;
    ranges.push(result.build(newDoc, removed));
    removed += result.removedLines;
  }
  dispatch(state.update({ changes: set, selection: EditorSelection.create(ranges, mainIndex), userEvent: "input.join", scrollIntoView: true }));
  return true;
}

export function addCommentLine(target: Target): boolean {
  if (target.state.readOnly || !touchesNonBlankLine(target.state)) return false;
  if (lineComment(target)) return true;
  return addCommentLayer(target);
}

function touchesNonBlankLine(state: EditorState): boolean {
  return state.selection.ranges.some((range) => {
    for (let n = state.doc.lineAt(range.from).number; n <= state.doc.lineAt(range.to).number; n++) if (/\S/.test(state.doc.line(n).text)) return true;
    return false;
  });
}

export function removeCommentLine(target: Target): boolean {
  if (target.state.readOnly) return false;
  return lineUncomment(target);
}

function addCommentLayer({ state, dispatch }: Target): boolean {
  const changes: ChangeSpec[] = [];
  let previousLine = -1;
  for (const range of state.selection.ranges) {
    const token = (state.languageDataAt<{ line?: string }>("commentTokens", range.from)[0] ?? {}).line;
    if (!token) continue;
    const lines: { from: number; indent: number; empty: boolean }[] = [];
    for (let pos = range.from; pos <= range.to; ) {
      const line = state.doc.lineAt(pos);
      if (line.from > previousLine && (range.from === range.to || range.to > line.from)) {
        previousLine = line.from;
        const indent = /^\s*/.exec(line.text)![0].length;
        lines.push({ from: line.from, indent, empty: indent === line.length });
      }
      pos = line.to + 1;
    }
    const minIndent = Math.min(1e9, ...lines.filter((l) => !l.empty).map((l) => l.indent));
    for (const l of lines) if (!l.empty || lines.length === 1) changes.push({ from: l.from + (l.empty ? l.indent : minIndent), insert: `${token} ` });
  }
  if (!changes.length) return false;
  dispatch(state.update({ changes, userEvent: "input.comment", scrollIntoView: true }));
  return true;
}

export function trimTrailingWhitespace({ state, dispatch }: Target): boolean {
  if (state.readOnly) return false;
  const changes: ChangeSpec[] = [];
  for (let n = 1; n <= state.doc.lines; n++) {
    const line = state.doc.line(n);
    const trimmed = line.text.replace(/[ \t]+$/, "");
    if (trimmed.length !== line.text.length) changes.push({ from: line.from + trimmed.length, to: line.to });
  }
  if (!changes.length) return false;
  dispatch(state.update({ changes, userEvent: "delete", scrollIntoView: true }));
  return true;
}

const COLLATOR = new Intl.Collator();

export function sortLines(descending: boolean) {
  return ({ state, dispatch }: Target): boolean => {
    if (state.readOnly) return false;
    const doc = state.doc;
    const spans = lineSpans(state);
    const edits: { from: number; to: number; text: string }[] = [];
    for (const span of spans) {
      const before = linesOf(state, span.startLine, span.endLine);
      const after = [...before].sort(COLLATOR.compare);
      if (descending) after.reverse();
      if (span.startLine >= span.endLine || before.every((text, i) => text === after[i])) return false;
      edits.push({ from: doc.line(span.startLine).from, to: doc.line(span.endLine).to, text: after.join("\n") });
    }
    dispatch(state.update({ changes: edits.map((e) => ({ from: e.from, to: e.to, insert: e.text })), selection: state.selection, userEvent: "input.sort", scrollIntoView: true }));
    return true;
  };
}

export function deleteDuplicateLines({ state, dispatch }: Target): boolean {
  if (state.readOnly) return false;
  const doc = state.doc;
  if (doc.lines === 1 && doc.length === 0) return false;
  let spans = state.selection.ranges.map((range) => ({ startLine: doc.lineAt(range.from).number, endLine: doc.lineAt(range.to).number }));
  let keepSelection = true;
  if (spans.length === 1 && spans[0].startLine === spans[0].endLine) {
    spans = [{ startLine: 1, endLine: doc.lines }];
    keepSelection = false;
  }
  spans = mergeSpans(spans);
  const changes: ChangeSpec[] = [];
  const kept: { startLine: number; count: number }[] = [];
  let removed = 0;
  for (const span of spans) {
    const seen = new Set<string>();
    const lines: string[] = [];
    for (let n = span.startLine; n <= span.endLine; n++) {
      const text = doc.line(n).text;
      if (!seen.has(text)) {
        lines.push(text);
        seen.add(text);
      }
    }
    changes.push({ from: doc.line(span.startLine).from, to: doc.line(span.endLine).to, insert: lines.join("\n") });
    kept.push({ startLine: span.startLine - removed, count: lines.length });
    removed += span.endLine - span.startLine + 1 - lines.length;
  }
  const set = state.changes(changes);
  if (set.empty) return false;
  if (!keepSelection) {
    dispatch(state.update({ changes: set, userEvent: "delete.dedupe", scrollIntoView: true }));
    return true;
  }
  const newDoc = set.apply(doc);
  const ranges = kept.map((k) => EditorSelection.range(newDoc.line(k.startLine).from, newDoc.line(k.startLine + k.count - 1).to));
  dispatch(state.update({ changes: set, selection: EditorSelection.create(ranges, Math.min(state.selection.mainIndex, ranges.length - 1)), userEvent: "delete.dedupe", scrollIntoView: true }));
  return true;
}

export function duplicateSelection({ state, dispatch }: Target): boolean {
  if (state.readOnly) return false;
  let lastLine = -1;
  const spec = state.changeByRange((range) => {
    if (range.empty) {
      const line = state.doc.lineAt(range.head);
      if (line.from === lastLine) return { range };
      lastLine = line.from;
      return { changes: { from: line.from, insert: `${line.text}\n` }, range: EditorSelection.cursor(range.head + line.length + 1) };
    }
    const text = state.sliceDoc(range.from, range.to);
    return { changes: { from: range.to, insert: text }, range: EditorSelection.range(range.to, range.to + text.length) };
  });
  dispatch(state.update(spec, { userEvent: "input.duplicate", scrollIntoView: true }));
  return true;
}

export function expandLineSelection({ state, dispatch }: Target): boolean {
  const doc = state.doc;
  const ranges = state.selection.ranges.map((range) => {
    const startLine = doc.lineAt(range.from);
    const endLine = doc.lineAt(range.to);
    return EditorSelection.range(startLine.from, endLine.number === doc.lines ? endLine.to : endLine.to + 1);
  });
  dispatch(state.update({ selection: EditorSelection.create(ranges, state.selection.mainIndex), scrollIntoView: true, userEvent: "select" }));
  return true;
}

function lineSpans(state: EditorState): { startLine: number; endLine: number }[] {
  const doc = state.doc;
  const ranges = state.selection.ranges;
  if (ranges.length === 1 && doc.lineAt(ranges[0].from).number === doc.lineAt(ranges[0].to).number) return [{ startLine: 1, endLine: doc.lines }];
  return mergeSpans(
    ranges.map((range) => {
      const startLine = doc.lineAt(range.from).number;
      let endLine = doc.lineAt(range.to).number;
      if (range.to === doc.line(endLine).from && endLine > startLine) endLine -= 1;
      return { startLine, endLine };
    }),
  );
}

function mergeSpans(spans: { startLine: number; endLine: number }[]): { startLine: number; endLine: number }[] {
  const out: { startLine: number; endLine: number }[] = [];
  for (const span of spans) {
    const last = out[out.length - 1];
    if (last && span.startLine <= last.endLine) last.endLine = Math.max(last.endLine, span.endLine);
    else out.push({ ...span });
  }
  return out;
}

function linesOf(state: EditorState, startLine: number, endLine: number): string[] {
  const out: string[] = [];
  for (let n = startLine; n <= endLine; n++) out.push(state.doc.line(n).text);
  return out;
}

export type Transform = "uppercase" | "lowercase" | "titlecase" | "snakecase" | "camelcase" | "pascalcase" | "kebabcase";

export function transformText(kind: Transform, text: string): string {
  switch (kind) {
    case "uppercase":
      return text.toLocaleUpperCase();
    case "lowercase":
      return text.toLocaleLowerCase();
    case "titlecase":
      return text.toLocaleLowerCase().replace(/(^|[^\p{L}\p{N}']|((^|\P{L})'))\p{L}/gmu, (match) => match.toLocaleUpperCase());
    case "snakecase":
      return text.replace(/(\p{Ll})(\p{Lu})/gmu, "$1_$2").replace(/(\p{Lu}|\p{N})(\p{Lu})(\p{Ll})/gmu, "$1_$2$3").toLocaleLowerCase();
    case "camelcase": {
      const boundary = /\r\n|\r|\n/.test(text) ? /[_-]+/gm : /[_\s-]+/gm;
      const words = text.split(boundary);
      const first = words.shift()?.replace(/^(\p{Lu}[^\p{Lu}])/gmu, (match) => match.toLocaleLowerCase());
      return first + words.map((word) => word.substring(0, 1).toLocaleUpperCase() + word.substring(1)).join("");
    }
    case "pascalcase":
      return text
        .split(/(?<=\.)/gm)
        .map((part) => part.split(/[_ \t-]/gm))
        .flat()
        .map((word) => {
          const capitalized = word.charAt(0).toLocaleUpperCase() + word.slice(1);
          return capitalized.length > 1 && /^\p{Lu}+$/mu.test(capitalized) ? capitalized.charAt(0) + capitalized.slice(1).toLocaleLowerCase() : capitalized;
        })
        .join("");
    case "kebabcase":
      return text
        .replace(/(\S)(_)(\S)/gm, "$1-$3")
        .replace(/(\p{Ll})(\p{Lu})/gmu, "$1-$2")
        .replace(/(\p{Lu}|\p{N})(\p{Lu}\p{Ll})/gmu, "$1-$2")
        .toLocaleLowerCase();
  }
}

export function transformSelection(kind: Transform) {
  return ({ state, dispatch }: Target): boolean => {
    if (state.readOnly) return false;
    const changes: ChangeSpec[] = [];
    for (const range of state.selection.ranges) {
      const span = range.empty ? state.wordAt(range.head) : range;
      if (!span || span.from === span.to) continue;
      const text = state.sliceDoc(span.from, span.to);
      const next = transformText(kind, text);
      if (next !== text) changes.push({ from: span.from, to: span.to, insert: next });
    }
    if (!changes.length) return false;
    dispatch(state.update({ changes, userEvent: "input.transform", scrollIntoView: true }));
    return true;
  };
}
