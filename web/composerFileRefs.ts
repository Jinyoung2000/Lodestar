import type { MarkdownEdit } from "./composerMarkdown";

type Ref = { from: number; to: number; value: string };

export function fileRefText(path: string, startLine: number | null, endLine: number | null) {
  const range = startLine === null ? "" : `:L${startLine}${endLine && endLine !== startLine ? `-L${endLine}` : ""}`;
  const target = /[\s"\\]/.test(path) ? JSON.stringify(path) : path;
  return `@${target}${range}`;
}

export function inlineFileRefs(text: string, refs: Iterable<string>): Ref[] {
  const values = [...new Set(refs)].sort((a, b) => b.length - a.length);
  if (!values.length) return [];
  const ranges: Ref[] = [];
  for (let from = text.indexOf("@"); from !== -1; from = text.indexOf("@", from + 1)) {
    if (from > 0 && !/[\s\p{Ps}]/u.test(text[from - 1])) continue;
    const value = values.find((ref) => {
      if (!text.startsWith(ref, from)) return false;
      const end = from + ref.length;
      const next = text[end];
      return next === undefined || /[\s\p{Pe},;!?、。]/u.test(next) || (next === "." && (end + 1 === text.length || /\s/.test(text[end + 1])));
    });
    if (!value) continue;
    ranges.push({ from, to: from + value.length, value });
    from += value.length - 1;
  }
  return ranges;
}

export function insertFileRef(text: string, from: number, to: number, value: string): MarkdownEdit {
  const leading = from > 0 && !/\s/.test(text[from - 1]) ? " " : "";
  const trailing = to === text.length || !/\s/.test(text[to]) ? " " : "";
  const insert = leading + value + trailing;
  const caret = from + insert.length + (/^[ \t]/.test(text.slice(to, to + 1)) ? 1 : 0);
  return { from, to, insert, selStart: caret, selEnd: caret };
}

export function deleteFileRef(text: string, refs: readonly Ref[], caret: number, backward: boolean): MarkdownEdit | null {
  const edge = backward && text[caret - 1] === " " ? caret - 1 : caret;
  const ref = refs.find(({ from, to }) => backward ? from < edge && edge <= to : from <= edge && edge < to);
  if (!ref) return null;
  const to = text[ref.to] === " " ? ref.to + 1 : ref.to;
  return { from: ref.from, to, insert: "", selStart: ref.from, selEnd: ref.from };
}
