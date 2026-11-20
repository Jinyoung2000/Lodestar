import { localhostTarget } from "./browserUrl";
import { getState, openBrowser } from "./store";

// 설정 Open Localhost Links: 대화 속 localhost 링크를 시스템 브라우저 대신 Browser 탭으로 연다. 열 주소의 판정은 web/browserUrl.ts 의 localhostTarget 이다.
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
