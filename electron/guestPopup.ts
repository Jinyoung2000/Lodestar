import { isNotionHost } from "../shared/notionLink";

// Browser 탭 guest 가 연 새 창을 어떻게 다룰지. 이 파일은 electron 을 가져오지 않아 단위 시험이 그대로 부른다.
//   popup: 로그인 창. Notion 페이지가 window.open 으로(크기 지정, disposition new-window) 연 Notion 또는 로그인 제공자 창만 앱 안 작은 창으로 허락한다.
//          Notion 로그인은 팝업이 opener 에 결과를 되돌려 주는 방식일 수 있어서 거절하면 로그인이 끝나지 않는다.
//   link: 지금까지처럼 새 창은 만들지 않고 링크로 보낸다(앱 설정에 따라 Browser 탭, Notion 앱, 기본 브라우저).
//   deny: http, https 가 아닌 주소
export type PopupDecision = "popup" | "link" | "deny";

// 로그인 제공자: 이 목록 밖의 도메인(광고, 임의 사이트)은 Notion 페이지가 열어도 창을 만들지 않는다.
const SIGN_IN_HOSTS = new Set(["accounts.google.com", "appleid.apple.com"]);

export function guestPopupDecision(request: { openerUrl: string; targetUrl: string; disposition: string }): PopupDecision {
  let target: URL;
  let opener: URL;
  try {
    target = new URL(request.targetUrl);
    opener = new URL(request.openerUrl);
  } catch {
    return "deny";
  }
  if (target.protocol !== "https:" && target.protocol !== "http:") return "deny";
  const fromNotion = (opener.protocol === "https:" || opener.protocol === "http:") && isNotionHost(opener.hostname);
  const sizedWindow = request.disposition === "new-window";
  const host = target.hostname.toLowerCase();
  return fromNotion && sizedWindow && target.protocol === "https:" && (isNotionHost(host) || SIGN_IN_HOSTS.has(host)) ? "popup" : "link";
}

// Google 로그인은 사용자 에이전트에 Electron 이 든 요청을 "안전하지 않은 앱" 으로 막는다. accounts.google.com 요청의 헤더에서만 앱 이름과 Electron 조각을 뺀다(페이지의 navigator.userAgent 는 그대로).
export function chromeLikeUserAgent(userAgent: string): string {
  return userAgent
    .replace(/\s+Electron\/\S+/i, "")
    .replace(/\s+(?:agent-nav|Lodestar)\/\S+/i, "")
    .trim();
}
