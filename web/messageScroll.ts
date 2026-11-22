
const FLASH_MS = 1600;
const GAP_PX = 8;

export function scrollToItem(scroller: HTMLElement, itemId: string): boolean {
  const target = scroller.querySelector<HTMLElement>(`[data-item-id="${CSS.escape(itemId)}"]`);
  if (!target) return false;
  for (let details = target.closest("details"); details; details = details.parentElement?.closest("details") ?? null) details.open = true;
  const turn = target.closest<HTMLElement>("[data-turn-key]");
  const bubble = turn?.querySelector<HTMLElement>(":scope > .turn-user") ?? null;
  const isBubble = target === bubble;
  const reference = isBubble && turn ? turn : target;
  const covered = isBubble ? 0 : (bubble?.offsetHeight ?? 0);
  const top = reference.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
  scroller.scrollTop = Math.max(0, top - covered - GAP_PX);
  target.setAttribute("data-flash", "");
  window.setTimeout(() => target.removeAttribute("data-flash"), FLASH_MS);
  return true;
}
