// Slack 멘션 수집과 분석은 사용자의 실제 Slack 을 읽고 모델 비용을 쓴다. 시험용 인스턴스(Electron 시험 모드, 검증 창구, 시험 데몬)는 설정과 상관없이 하지 않는다.
// settings 를 넘기면 Slack 화면을 숨긴 상태(showSlack 이 true 가 아님)에서도 하지 않는다. 숨긴 화면의 멘션을 읽느라 모델을 부르면 안 된다.
export function mentionCollectionBlocked(env: NodeJS.ProcessEnv = process.env, settings?: { showSlack?: boolean }): boolean {
  if (env.AGENT_NAV_INACTIVE === "1" || !!env.AGENT_NAV_E2E_PORT || env.AGENT_NAV_NO_MENTIONS === "1") return true;
  return settings !== undefined && settings.showSlack !== true;
}

// 아침 리뷰 자동 실행은 Board 화면 위쪽에 보이는 결과를 만든다. Board 를 숨긴 상태에서는 볼 곳이 없으니 모델을 부르지 않는다(수동 실행은 막지 않는다).
export function morningReviewAutoBlocked(env: NodeJS.ProcessEnv = process.env, settings?: { showBoard?: boolean }): boolean {
  if (settings !== undefined && settings.showBoard !== true) return true;
  return (env.AGENT_NAV_INACTIVE === "1" || !!env.AGENT_NAV_E2E_PORT || env.AGENT_NAV_NO_MENTIONS === "1") && env.AGENT_NAV_REVIEW_AUTO !== "1";
}
