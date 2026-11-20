// 대화 스크롤이 바닥을 따라가는지 정한다. DOM 을 모르는 순수 함수라 test/timelinescroll.test.ts 가 그대로 부른다.

// 바닥과 이 거리 안이면 바닥에 있는 것으로 본다(px)
export const BOTTOM_SLACK = 40;

// 스크롤 이벤트 뒤에 바닥을 따라갈지. distance 는 바닥까지 남은 거리.
// 높이가 바뀌어(resized) 생긴 스크롤 이벤트는 사용자가 올린 것이 아니므로 판단을 바꾸지 않는다. 바닥에 붙어 있던 대화가 터미널을 여는 것만으로 풀리지 않게 한다.
export function followsBottom(following: boolean, distance: number, resized: boolean): boolean {
  if (resized) return following;
  return distance < BOTTOM_SLACK;
}
