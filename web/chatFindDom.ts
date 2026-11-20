import { MATCH_LIMIT } from "./findModel";
import { partIndexAt, textMatches } from "./chatFindModel";

// Q2: 대화 칸의 글에서 찾기. 글자 노드를 DOM 에서 읽고, 일치는 Range 로 만들어 CSS Custom Highlight 로 칠한다(DOM 을 바꾸지 않아서 React 가 그린 것과 부딪치지 않는다).

type Part = { node: Text; start: number };
export type Block = { text: string; parts: Part[] };

// 눈에 보이는 글이 아닌 것: 아이콘, 응답 아래 줄(복사 단추, 시간, 모델)
const SKIP = "svg, script, style, [aria-hidden='true'], .turn-footer, .response-bar";
// 같은 블록 안에서는 인라인 요소(굵게, 코드, 링크)를 건너 글이 이어진다.
const BLOCK = "p, li, div, pre, h1, h2, h3, h4, h5, h6, td, th, summary, blockquote, details, section, tr, ul, ol, table";

export function collectBlocks(root: HTMLElement): Block[] {
  const blocks: Block[] = [];
  let currentBlock: Element | null = null;
  let current: Block | null = null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const parent = node.parentElement;
    if (!parent || !node.data || parent.closest(SKIP)) continue;
    const block = parent.closest(BLOCK) ?? root;
    if (block !== currentBlock || !current) {
      current = { text: "", parts: [] };
      blocks.push(current);
      currentBlock = block;
    }
    current.parts.push({ node, start: current.text.length });
    current.text += node.data;
  }
  return blocks;
}

// 블록마다 일치를 찾아 Range 로 만든다. 일치가 limit 을 넘으면 capped.
export function findRanges(blocks: Block[], regex: RegExp, limit = MATCH_LIMIT): { ranges: Range[]; capped: boolean } {
  const ranges: Range[] = [];
  for (const block of blocks) {
    const { list, capped } = textMatches(block.text, regex, limit - ranges.length);
    const starts = block.parts.map((part) => part.start);
    for (const match of list) {
      const first = block.parts[partIndexAt(starts, match.from)];
      const last = block.parts[partIndexAt(starts, match.to - 1)];
      const range = document.createRange();
      range.setStart(first.node, match.from - first.start);
      range.setEnd(last.node, match.to - last.start);
      ranges.push(range);
    }
    if (capped || ranges.length >= limit) return { ranges, capped: true };
  }
  return { ranges, capped: false };
}

const MATCH_NAME = "chat-find-match";
const CURRENT_NAME = "chat-find-current";

export function paint(ranges: Range[], current: number) {
  if (typeof Highlight === "undefined") return;
  CSS.highlights.set(MATCH_NAME, new Highlight(...ranges.filter((_, index) => index !== current)));
  if (ranges[current]) CSS.highlights.set(CURRENT_NAME, new Highlight(ranges[current]));
  else CSS.highlights.delete(CURRENT_NAME);
}

export function clearPaint() {
  if (typeof CSS === "undefined" || !CSS.highlights) return;
  CSS.highlights.delete(MATCH_NAME);
  CSS.highlights.delete(CURRENT_NAME);
}

// 스크롤 위치 기준으로 처음 고를 일치: 보이는 영역 맨 위 이후의 첫 일치, 없으면 처음. 접혀 있어 자리가 없는 일치(높이 0)는 건너뛴다.
export function firstVisibleIndex(ranges: Range[], root: HTMLElement): number {
  if (!ranges.length) return -1;
  const top = root.getBoundingClientRect().top;
  const limit = Math.min(ranges.length, 3000);
  for (let index = 0; index < limit; index++) {
    const rect = ranges[index].getBoundingClientRect();
    if (rect.height > 0 && rect.top >= top) return index;
  }
  return 0;
}

// 일치가 접힌 줄(details) 안이면 펼치고, 대화 영역 가운데로 스크롤한다. 줄 머리(summary) 안의 일치는 그 줄을 펼치지 않는다.
export function reveal(root: HTMLElement, range: Range) {
  const start = range.startContainer.parentElement;
  const summary = start?.closest("summary") ?? null;
  for (let details = start?.closest("details") ?? null; details; details = details.parentElement?.closest("details") ?? null) {
    if (summary && summary.parentElement === details) continue;
    if (!details.open) details.open = true;
  }
  const rect = range.getBoundingClientRect();
  if (!rect.height) return;
  const box = root.getBoundingClientRect();
  const margin = Math.min(box.height / 4, 80);
  if (rect.top >= box.top + margin && rect.bottom <= box.bottom - margin) return;
  root.scrollTop += rect.top - box.top - (box.height - rect.height) / 2;
}
