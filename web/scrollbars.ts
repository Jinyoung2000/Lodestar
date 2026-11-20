const HOLD_MS = 800;

export function initScrollbars() {
  const timers = new WeakMap<Element, ReturnType<typeof setTimeout>>();
  // scroll 은 버블링하지 않아서 capture 로 받는다
  document.addEventListener(
    "scroll",
    (event) => {
      const target = event.target instanceof Element ? event.target : document.documentElement;
      target.setAttribute("data-scrolling", "");
      const previous = timers.get(target);
      if (previous) clearTimeout(previous);
      timers.set(
        target,
        setTimeout(() => {
          target.removeAttribute("data-scrolling");
          timers.delete(target);
        }, HOLD_MS),
      );
    },
    { capture: true, passive: true },
  );
}
