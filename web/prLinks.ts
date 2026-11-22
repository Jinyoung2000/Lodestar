import { parsePrUrl } from "../shared/prUrl";
import { openPrFromLink } from "./prStore";
import { agentOfElement } from "./store";
import { IN_ELECTRON } from "./shortcuts";

const PR_LINK_SCOPE = ".timeline, .markdown, .card-link";

export function initPrLinks() {
  if (!IN_ELECTRON) return;
  document.addEventListener(
    "click",
    (event) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor || !anchor.closest(PR_LINK_SCOPE)) return;
      const link = parsePrUrl(anchor.href);
      if (!link) return;
      event.preventDefault();
      openPrFromLink(link.repo, link.number, { tab: link.tab, anchor: link.anchor, agentId: agentOfElement(anchor) });
    },
    true,
  );
  window.addEventListener("agent-nav:open-pr", (event) => {
    const detail = (event as CustomEvent<unknown>).detail;
    const url = typeof detail === "string" ? detail : typeof (detail as { url?: unknown } | null)?.url === "string" ? (detail as { url: string }).url : null;
    const agentId = typeof (detail as { agentId?: unknown } | null)?.agentId === "string" ? (detail as { agentId: string }).agentId : undefined;
    const link = url ? parsePrUrl(url) : null;
    if (link) openPrFromLink(link.repo, link.number, { tab: link.tab, anchor: link.anchor, ...(agentId ? { agentId } : {}) });
  });
}
