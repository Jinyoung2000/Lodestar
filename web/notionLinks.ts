import { isNotionUrl, notionOpenPlan } from "../shared/notionLink";
import { openNotionInApp } from "./notionStore";
import { openNotionScreen } from "./notionScreen";
import { IN_ELECTRON } from "./shortcuts";
import { getState } from "./store";

export function initNotionLinks() {
  if (!IN_ELECTRON) return;
  document.addEventListener(
    "click",
    (event) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor || !isNotionUrl(anchor.href)) return;
      const plan = notionOpenPlan(anchor.href, getState().settings ?? {});
      if (!plan) return;
      event.preventDefault();
      if (plan.via === "screen") openNotionScreen(plan.url);
      else if (plan.via === "tab") openNotionInApp(plan.url);
      else window.open(anchor.href, "_blank", "noopener");
    },
    true,
  );
}
