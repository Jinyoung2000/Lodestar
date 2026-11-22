import { MATCH_LIMIT } from "./findModel";
import { partIndexAt, textMatches } from "./chatFindModel";

type Part = { node: Text; start: number };
export type Block = { text: string; parts: Part[] };

const SKIP = "svg, script, style, [aria-hidden='true'], .turn-footer, .response-bar";
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
