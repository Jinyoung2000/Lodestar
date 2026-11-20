// 검증 스크립트(.verify)가 페이지 상태를 읽고 조작하도록 window.__agentNav 에 노출한다. 같은 출처의 페이지만 접근할 수 있다.
// 화면마다 아는 것이 달라서(앱 창, 미니 채팅, 빠른 입력창) 부를 때마다 덧붙인다.
const hooks: Record<string, unknown> = {};

export function exposeHooks(extra: Record<string, unknown>) {
  Object.assign(hooks, extra);
  Object.assign(window, { __agentNav: hooks });
}
