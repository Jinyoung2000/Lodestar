import { highlightTree } from "@lezer/highlight";
import { syntaxHighlighters } from "./editorSyntax";
import { languageIdFor } from "./languageId";
import { languageById } from "./languages";

// PR diff 의 구문 색. 에디터와 같은 언어 결정(languageIdFor)과 같은 하이라이터(syntaxHighlighters)를 쓰고, 클래스 이름(cm-syn-*)도 같다. 색은 web/pr.css 가 토큰 변수로 준다.
// 아직 읽지 않은 언어는 읽기를 시작하고 색 없이 돌려준다. 호출한 화면은 useLanguagesVersion 으로 다시 그린다.
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
