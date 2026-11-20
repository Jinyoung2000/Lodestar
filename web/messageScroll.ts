// 대화 스크롤 영역 안에서 항목 id(data-item-id)가 붙은 요소를 찾아 그 자리로 간다. 카드의 "Go to Message" 가 쓴다(web/AgentView.tsx).

const FLASH_MS = 1600;
const GAP_PX = 8;

// 찾으면 true, 없으면(지워졌거나 단계 목록에서 숨겨진 항목) false. 접힌 단계 묶음 안에 있으면 펼친다.
export function scrollToItem(scroller: HTMLElement, itemId: string): boolean {
  const target = scroller.querySelector<HTMLElement>(`[data-item-id="${CSS.escape(itemId)}"]`);
  if (!target) return false;
  for (let details = target.closest("details"); details; details = details.parentElement?.closest("details") ?? null) details.open = true;
  const turn = target.closest<HTMLElement>("[data-turn-key]");
  const bubble = turn?.querySelector<HTMLElement>(":scope > .turn-user") ?? null;
  // 사용자 말풍선은 머리에 붙는(sticky) 요소라 자기 위치가 스크롤을 따라 움직인다. 그 턴 상자의 위쪽을 기준으로 삼는다.
  const isBubble = target === bubble;
  const reference = isBubble && turn ? turn : target;
  // 응답 쪽 항목은 같은 턴의 말풍선이 위에 붙어 가리므로 그만큼 내려서 보인다.
  const covered = isBubble ? 0 : (bubble?.offsetHeight ?? 0);
  const top = reference.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
  scroller.scrollTop = Math.max(0, top - covered - GAP_PX);
  target.setAttribute("data-flash", "");
  window.setTimeout(() => target.removeAttribute("data-flash"), FLASH_MS);
  return true;
}
