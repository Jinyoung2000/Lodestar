type ScrollPosition = { top: number; left: number };

export function scrollMemory(root: HTMLElement) {
  const positions = new Map<Element, ScrollPosition>();
  const note = (event: Event) => {
    const target = event.target;
    if (target instanceof Element && target.isConnected) positions.set(target, { top: target.scrollTop, left: target.scrollLeft });
  };
  return {
    watch() {
      root.addEventListener("scroll", note, { capture: true, passive: true });
      return () => root.removeEventListener("scroll", note, { capture: true });
    },
    restore() {
      for (const [element, { top, left }] of positions) {
        if (!root.contains(element)) {
          positions.delete(element);
          continue;
        }
        if (element.scrollTop !== top) element.scrollTop = top;
        if (element.scrollLeft !== left) element.scrollLeft = left;
      }
    },
  };
}
