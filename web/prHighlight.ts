import { highlightTree } from "@lezer/highlight";
import { syntaxHighlighters } from "./editorSyntax";
import { languageIdFor } from "./languageId";
import { languageById } from "./languages";

export type Seg = { text: string; cls: string | null };

const MAX_CHARS = 200_000;

export function highlightLines(lines: string[], path: string): Seg[][] {
  const plain = () => lines.map((text) => [{ text, cls: null }]);
  const doc = lines.join("\n");
  if (doc.length === 0 || doc.length > MAX_CHARS) return plain();
  const language = languageById(languageIdFor(path, lines[0]));
  if (!language) return plain();
  let tree;
  try {
    tree = language.parser.parse(doc);
  } catch {
    return plain();
  }
  const ranges: { from: number; to: number; cls: string }[] = [];
  highlightTree(tree, syntaxHighlighters, (from, to, cls) => ranges.push({ from, to, cls }));
  const out: Seg[][] = [];
  let offset = 0;
  let next = 0;
  for (const text of lines) {
    const start = offset;
    const end = offset + text.length;
    offset = end + 1;
    while (next < ranges.length && ranges[next].to <= start) next++;
    const segs: Seg[] = [];
    let pos = start;
    for (let i = next; i < ranges.length && ranges[i].from < end; i++) {
      const from = Math.max(ranges[i].from, start);
      const to = Math.min(ranges[i].to, end);
      if (to <= from) continue;
      if (from > pos) segs.push({ text: text.slice(pos - start, from - start), cls: null });
      segs.push({ text: text.slice(from - start, to - start), cls: ranges[i].cls });
      pos = to;
    }
    if (pos < end || segs.length === 0) segs.push({ text: text.slice(pos - start), cls: null });
    out.push(segs);
  }
  return out;
}
