export type TabBox = { left: number; right: number };

export function stripScrollTarget({ scrollLeft, width, padRight, tabs, active, maxScroll = Infinity }: { scrollLeft: number; width: number; padRight: number; tabs: TabBox[]; active: number; maxScroll?: number }): number {
  const target = tabs[active];
  if (!target) return scrollLeft;
  const visible = Math.max(0, width - padRight);
  let next = scrollLeft;
  if (target.left < scrollLeft) next = target.left;
  else if (target.right > scrollLeft + visible) next = target.right - target.left > visible ? target.left : Math.max(0, target.right - visible);
  const boundary = tabs.find((tab) => tab.left >= next - 0.5);
  if (boundary && Math.abs(boundary.left - next) <= 0.5) return next;
  if (boundary && boundary.left <= target.left + 0.5 && boundary.left <= maxScroll + 0.5) return boundary.left;
  const clipped = [...tabs].reverse().find((tab) => tab.left < next - 0.5);
  if (clipped && target.right <= clipped.left + visible + 0.5 && clipped.left <= target.left) return clipped.left;
  return next;
}
