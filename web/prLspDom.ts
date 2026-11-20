import { wordRangeAt } from "../shared/prLsp";

// PR diff 의 코드 칸(<code class="pr-code" data-row data-side>)에서 화면 좌표와 글자 위치를 오가는 DOM 도구. 칸 안에는 구문 색 <span> 이 섞여 있어서 글자 위치는 칸 전체 글 기준 offset 으로 센다.

export const CODE_SELECTOR = 'code.pr-code[data-side="RIGHT"]';

// 대상이 새 쪽(RIGHT) 코드 칸 안이면 그 칸
export function codeCellOf(target: EventTarget | Node | null): HTMLElement | null {
  const element = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
  return element?.closest<HTMLElement>(CODE_SELECTOR) ?? null;
}

// 칸 안의 (노드, 노드 안 위치)가 칸 전체 글에서 몇 번째 글자인지
export function textOffsetIn(code: HTMLElement, node: Node, nodeOffset: number): number {
  const range = document.createRange();
  range.selectNodeContents(code);
  range.setEnd(node, nodeOffset);
  return range.toString().length;
}

// 칸 전체 글의 [from, to) 를 덮는 Range. 구문 색 span 을 가로질러도 된다.
export function rangeIn(code: HTMLElement, from: number, to: number): Range {
  const range = document.createRange();
  const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
  let seen = 0;
  let started = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.textContent?.length ?? 0;
    if (!started && from <= seen + length) {
      range.setStart(node, from - seen);
      started = true;
    }
    if (started && to <= seen + length) {
      range.setEnd(node, to - seen);
      return range;
    }
    seen += length;
  }
  if (!started) range.setStart(code, 0);
  range.setEnd(code, code.childNodes.length);
  return range;
}

type CaretDocument = Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null; caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null };

// 좌표에서 가장 가까운 글자 경계가 칸 전체 글의 몇 번째인지. 칸 밖이면 null.
export function offsetAtPoint(code: HTMLElement, x: number, y: number): number | null {
  const doc = document as CaretDocument;
  const at = doc.caretRangeFromPoint?.(x, y);
  if (at && code.contains(at.startContainer)) return textOffsetIn(code, at.startContainer, at.startOffset);
  const position = doc.caretPositionFromPoint?.(x, y);
  if (position && code.contains(position.offsetNode)) return textOffsetIn(code, position.offsetNode, position.offset);
  return null;
}

export type WordHit = { from: number; to: number; text: string; rect: DOMRect };

const contains = (rect: DOMRect, x: number, y: number) => x >= rect.left - 1 && x <= rect.right + 1 && y >= rect.top - 1 && y <= rect.bottom + 1;

// 좌표 아래의 식별자. 줄 끝 너머나 글자 사이 빈 곳이면 null(캐럿 위치만으로 고르면 줄 끝 빈 곳에서도 마지막 단어가 잡힌다).
export function wordAtPoint(code: HTMLElement, text: string, x: number, y: number): WordHit | null {
  const offset = offsetAtPoint(code, x, y);
  if (offset === null) return null;
  for (const at of [offset, offset - 1]) {
    if (at < 0) continue;
    const word = wordRangeAt(text, at);
    if (!word) continue;
    const rects = [...rangeIn(code, word.from, word.to).getClientRects()];
    const hit = rects.find((rect) => contains(rect, x, y));
    if (hit) return { ...word, text: text.slice(word.from, word.to), rect: unionRect(rects) };
  }
  return null;
}

// 캐럿(offset)이 걸친 식별자의 화면 영역
export function wordAtOffset(code: HTMLElement, text: string, offset: number): WordHit | null {
  const word = wordRangeAt(text, offset);
  if (!word) return null;
  const rects = [...rangeIn(code, word.from, word.to).getClientRects()];
  return rects.length ? { ...word, text: text.slice(word.from, word.to), rect: unionRect(rects) } : null;
}

function unionRect(rects: DOMRect[]): DOMRect {
  const left = Math.min(...rects.map((r) => r.left));
  const top = Math.min(...rects.map((r) => r.top));
  const right = Math.max(...rects.map((r) => r.right));
  const bottom = Math.max(...rects.map((r) => r.bottom));
  return new DOMRect(left, top, right - left, bottom - top);
}

// --- CSS Custom Highlight: 글자를 쪼개지 않고 밑줄과 배경만 얹는다 (::highlight(이름) 규칙은 web/pr.css) ---

type HighlightRegistry = { set(name: string, value: unknown): void; delete(name: string): void };
const registry = () => (typeof CSS !== "undefined" ? ((CSS as unknown as { highlights?: HighlightRegistry }).highlights ?? null) : null);

export function paintHighlight(name: string, ranges: Range[]) {
  const highlights = registry();
  const Highlight = (globalThis as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
  if (!highlights || !Highlight) return;
  if (ranges.length) highlights.set(name, new Highlight(...ranges));
  else highlights.delete(name);
}

// --- hover 상자 ---

// CodeMirror 의 hover 상자와 같은 모양으로 놓는다. 상자 스타일이 에디터 테마 클래스 아래 자손 선택자(.cm-tooltip ...)라서, 테마가 붙은 .cm-editor 껍데기를 두르고 그 안에 상자를 둔다.
// themeClass 는 문서를 든 보기(EditorView)의 dom.className 이다.
export class HoverTip {
  private shell: HTMLElement | null = null;
  private box: HTMLElement | null = null;

  get element() {
    return this.box;
  }

  contains(target: EventTarget | null) {
    return !!this.shell && target instanceof Node && this.shell.contains(target);
  }

  show(content: HTMLElement, anchor: DOMRect, themeClass: string) {
    this.hide();
    const shell = document.createElement("div");
    shell.className = `${themeClass.replace(/\bcm-focused\b/, "").trim()} pr-lsp-tip`;
    content.classList.add("cm-tooltip");
    shell.append(content);
    document.body.append(shell);
    // 크기는 화면에 고정한 뒤에 잰다(껍데기 폭이 0 이라 흐름 안에서 재면 폭 0 기준의 높이가 나온다)
    content.style.position = "fixed";
    content.style.left = "0px";
    content.style.top = "0px";
    const { width, height } = content.getBoundingClientRect();
    const margin = 8;
    const above = anchor.top - height - 4 >= margin;
    content.style.left = `${Math.max(margin, Math.min(anchor.left, window.innerWidth - width - margin))}px`;
    content.style.top = `${above ? anchor.top - height - 4 : Math.min(anchor.bottom + 4, window.innerHeight - height - margin)}px`;
    this.shell = shell;
    this.box = content;
  }

  hide() {
    this.shell?.remove();
    this.shell = null;
    this.box = null;
  }
}
