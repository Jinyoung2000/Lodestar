import { EditorView } from "@codemirror/view";
import "./editorRightLayout.css";

export const rightFurniture = EditorView.editorAttributes.of({ "data-editor-right": "" });

export function verticalScrollbarWidth(scroller: HTMLElement): number {
  const measured = scroller.offsetWidth - scroller.clientWidth;
  if (measured > 0) return measured;
  return parseFloat(getComputedStyle(scroller).getPropertyValue("--size-editor-scrollbar-v")) || 0;
}
