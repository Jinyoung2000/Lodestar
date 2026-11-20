import type { Extension } from "@codemirror/state";
import { ViewPlugin, tooltips, type EditorView } from "@codemirror/view";

export function hoverSpace(): Extension {
  return [
    tooltips({
      tooltipSpace: (view: EditorView) => {
        const { left, right } = spaceOf(view);
        return { top: 0, left, right, bottom: view.dom.ownerDocument.documentElement.clientHeight };
      },
    }),
    ViewPlugin.define((view) => {
      const publish = () => view.dom.style.setProperty("--hover-space-width", `${Math.max(spaceOf(view).right - spaceOf(view).left, 0)}px`);
      publish();
      const observer = new ResizeObserver(publish);
      observer.observe(view.dom);
      return { destroy: () => observer.disconnect() };
    }),
  ];
}

function spaceOf(view: EditorView) {
  const box = view.dom.getBoundingClientRect();
  const inset = Number.parseFloat(getComputedStyle(view.dom).getPropertyValue("--space-2")) || 0;
  return { left: box.left + inset, right: box.right - inset };
}
