import { acceptChunk, getChunks, rejectChunk, type Chunk } from "@codemirror/merge";
import type { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { S } from "./strings";

export type ChunkPosition = { index: number; count: number };

export function chunkPosition(state: EditorState): ChunkPosition {
  const chunks = getChunks(state)?.chunks ?? [];
  const head = state.selection.main.head;
  const at = chunks.findIndex((chunk) => head <= Math.max(chunk.toB - 1, chunk.fromB));
  return { index: chunks.length === 0 ? 0 : at < 0 ? chunks.length : at + 1, count: chunks.length };
}

function chunkAt(view: EditorView, x: number, y: number): Chunk | null {
  const pos = view.posAtCoords({ x, y });
  if (pos === null) return null;
  return getChunks(view.state)?.chunks.find((chunk) => pos >= chunk.fromB && pos <= Math.max(chunk.toB - 1, chunk.fromB)) ?? null;
}

function textButton(label: string, title: string, primary: boolean, run: () => void) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "chunk-hover-button";
  if (primary) button.dataset.primary = "";
  button.textContent = label;
  button.title = title;
  button.addEventListener("mousedown", (event) => event.preventDefault());
  button.addEventListener("click", (event) => event.detail <= 1 && run());
  return button;
}

export function inlineChunkControls(view: EditorView): () => void {
  const box = document.createElement("div");
  box.className = "chunk-hover-box";
  box.hidden = true;
  let current: Chunk | null = null;
  const place = () => {
    if (!current) {
      box.hidden = true;
      return;
    }
    box.style.top = `${view.lineBlockAt(current.fromB).top + view.documentTop - view.dom.getBoundingClientRect().top}px`;
    box.hidden = false;
  };
  const act = (run: (target: EditorView, pos: number) => boolean) => () => {
    if (!current) return;
    run(view, current.fromB);
    current = null;
    place();
  };
  box.append(textButton(S.keep, S.keepChunk, true, act(acceptChunk)), textButton(S.undo, S.undoChunk, false, act(rejectChunk)));
  view.dom.appendChild(box);
  const move = (event: MouseEvent) => {
    if (box.contains(event.target as Node)) return;
    const next = chunkAt(view, event.clientX, event.clientY);
    if (next?.fromB === current?.fromB && next?.toB === current?.toB) return;
    current = next;
    place();
  };
  const leave = () => {
    current = null;
    place();
  };
  view.dom.addEventListener("mousemove", move);
  view.dom.addEventListener("mouseleave", leave);
  view.scrollDOM.addEventListener("scroll", place, { passive: true });
  return () => {
    view.dom.removeEventListener("mousemove", move);
    view.dom.removeEventListener("mouseleave", leave);
    view.scrollDOM.removeEventListener("scroll", place);
    box.remove();
  };
}
