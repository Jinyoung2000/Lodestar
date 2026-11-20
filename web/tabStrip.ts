// Q2: 탭 줄에서 활성 탭을 보이게 스크롤할 위치. DOM 이 없어서 단위 시험(test/tabstrip.test.ts)이 그대로 쓴다.
// 좌표는 탭 줄 안쪽 내용 기준(스크롤 0 일 때 왼쪽 끝이 0). padRight 는 오른쪽에 sticky 로 붙은 꼬리 단추의 폭이다.
export type TabBox = { left: number; right: number };

// 활성 탭이 보이는 가장 가까운 위치로 간 뒤, 왼쪽 가장자리에 잘린 탭이 남으면 다음 탭의 왼쪽 경계로 맞춘다(활성 탭이 가려지지 않는 범위에서만).
// maxScroll 는 더 갈 수 없는 끝(scrollWidth 에서 보이는 폭을 뺀 값)이다. 다음 탭 경계가 그 끝 너머면 잘린 탭의 왼쪽 경계로 되돌아가 보이게 한다(활성 탭이 그대로 보일 때만).
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
