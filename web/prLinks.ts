import { parsePrUrl } from "../shared/prUrl";
import { openPrFromLink } from "./prStore";
import { agentOfElement } from "./store";
import { IN_ELECTRON } from "./shortcuts";

// 링크를 가로챌 자리: 대화, 보드 카드와 플랜 카드 같은 Markdown 글, 카드의 링크 목록
const PR_LINK_SCOPE = ".timeline, .markdown, .card-link";

// 앱 창 안의 GitHub PR 링크(대화, 보드 카드 본문과 링크 목록, 플랜 카드 같은 Markdown 글)의 왼쪽 클릭을 시스템 브라우저나 Browser 탭 대신 Lodestar 의 PR 화면으로 보낸다.
// 세션 화면에서는 PR 화면이 에디터 칸의 탭으로 열려 대화는 그대로 보이고, 리뷰, 코멘트, 승인 같은 동작을 거기서 바로 한다. 같은 PR 이 이미 열려 있으면 그 탭으로 간다.
// 보드처럼 옆 칸이 없는 화면에서는 가운데 PR 화면으로 연다(openPrFromLink).
// 탭은 링크를 누른 대화의 세션에 붙는다(그 대화가 든 칸의 세션). 미니 채팅의 링크는 미니 패널이 보여 주던 세션에 붙는다.
// 수정 키를 누른 클릭은 시스템 브라우저로 간다. 사이드바 PR 목록처럼 링크가 아닌 진입점은 각자 연다(가운데 PR 화면).
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
  // 미니 채팅에서 누른 PR 링크: 메인 프로세스가 이 창에 보낸다(electron/main.ts 의 agent-nav:quick-host)
  // detail 은 주소 글자(옛 형식) 또는 { url, agentId }. 세션을 모르면 활성 칸의 세션에 붙는다.
  window.addEventListener("agent-nav:open-pr", (event) => {
    const detail = (event as CustomEvent<unknown>).detail;
    const url = typeof detail === "string" ? detail : typeof (detail as { url?: unknown } | null)?.url === "string" ? (detail as { url: string }).url : null;
    const agentId = typeof (detail as { agentId?: unknown } | null)?.agentId === "string" ? (detail as { agentId: string }).agentId : undefined;
    const link = url ? parsePrUrl(url) : null;
    if (link) openPrFromLink(link.repo, link.number, { tab: link.tab, anchor: link.anchor, ...(agentId ? { agentId } : {}) });
  });
}
