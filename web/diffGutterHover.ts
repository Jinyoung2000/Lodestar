import type { MergeView } from "@codemirror/merge";
import type { EditorView } from "@codemirror/view";

function sideHeight(view: EditorView, from: number, to: number): number {
  if (to <= from) return 0;
  const end = Math.min(to - 1, view.state.doc.length);
  return view.lineBlockAt(end).bottom - view.lineBlockAt(from).top;
}

export function sizeChunkBoxes(view: MergeView) {
  for (const box of view.dom.querySelectorAll<HTMLElement>(".cm-merge-revert > [data-chunk]")) {
    const chunk = view.chunks[Number(box.dataset.chunk)];
    if (!chunk) continue;
    const height = Math.max(sideHeight(view.a, chunk.fromA, chunk.toA), sideHeight(view.b, chunk.fromB, chunk.toB), view.b.defaultLineHeight);
    const next = `${height}px`;
    if (box.style.height !== next) box.style.height = next;
  }
}

export function watchChunkBoxes(view: MergeView): () => void {
  let frame = 0;
  const schedule = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => sizeChunkBoxes(view));
  };
  const observer = new MutationObserver(schedule);
  const gap = view.dom.querySelector(".cm-merge-revert");
  if (gap) observer.observe(gap, { childList: true, subtree: true, attributes: true, attributeFilter: ["style"] });
  const resize = new ResizeObserver(schedule);
  resize.observe(view.a.contentDOM);
  resize.observe(view.b.contentDOM);
  schedule();
  return () => {
    cancelAnimationFrame(frame);
    observer.disconnect();
    resize.disconnect();
  };
}

export function trackHover(container: HTMLElement, selector: string): () => void {
  let current: HTMLElement | null = null;
  const set = (next: HTMLElement | null) => {
    if (next === current) return;
    current?.removeAttribute("data-hover");
    next?.setAttribute("data-hover", "");
    current = next;
  };
  const move = (event: MouseEvent) => {
    if (current?.contains(event.target as Node)) return;
    let found: HTMLElement | null = null;
    for (const element of container.querySelectorAll<HTMLElement>(selector)) {
      const rect = element.getBoundingClientRect();
      if (event.clientY >= rect.top && event.clientY < rect.bottom) {
        found = element;
        break;
      }
    }
    set(found);
  };
  const leave = () => set(null);
  container.addEventListener("mousemove", move);
  container.addEventListener("mouseleave", leave);
  return () => {
    container.removeEventListener("mousemove", move);
    container.removeEventListener("mouseleave", leave);
    set(null);
  };
}
