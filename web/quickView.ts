// 전역 빠른 입력창 창이면 true. 주소가 ?view=quick 이다(electron/quickEntry.ts 가 연다). 이 창은 메인 앱의 store 와 창 상태 저장을 쓰지 않는다(web/main.tsx).
export const QUICK = new URLSearchParams(location.search).get("view") === "quick";
