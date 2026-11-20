import { isNotionUrl, notionOpenPlan } from "../shared/notionLink";
import { openNotionInApp } from "./notionStore";
import { openNotionScreen } from "./notionScreen";
import { IN_ELECTRON } from "./shortcuts";
import { getState } from "./store";

// 설정 Open Notion Links 에 따라 대화, Slack 멘션, 카드, 빠른 질문 어디서든 Notion 링크의 왼쪽 클릭을 Browser 탭(기본), Notion 앱, 기본 브라우저로 보낸다.
// 판정은 shared/notionLink.ts 의 notionOpenPlan 이고, 앵커가 아닌 window.open 호출과 Browser 탭 안의 새 창 요청은 electron/main.ts 의 openExternalLink 가 같은 판정으로 받아 화면에 알린다.
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
      // 앱 안에서 바로 열거나, 메인 프로세스(openExternalLink)가 같은 설정으로 Notion 앱이나 기본 브라우저에 열게 한다. target 이 없는 앵커(사용자 메시지)가 앱 창을 옮겨 가지 않게 항상 가로챈다.
      if (plan.via === "screen") openNotionScreen(plan.url);
      else if (plan.via === "tab") openNotionInApp(plan.url);
      else window.open(anchor.href, "_blank", "noopener");
    },
    true,
  );
}
