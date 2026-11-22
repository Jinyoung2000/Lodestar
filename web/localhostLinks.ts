import { localhostTarget } from "./browserUrl";
import { getState, openBrowser } from "./store";

export function initLocalhostLinks() {
  document.addEventListener(
    "click",
    (event) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      if (!(getState().settings?.browserOpenLocalhostLinks ?? true)) return;
      const anchor = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor) return;
      const target = localhostTarget(anchor.href, window.location);
      if (!target) return;
      event.preventDefault();
      openBrowser(target);
    },
    true,
  );
}
