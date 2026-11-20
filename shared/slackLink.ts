import { appLink } from "./inbox";

export type SlackLinkTarget = "app" | "browser";

export const SLACK_LINK_TARGETS: readonly SlackLinkTarget[] = ["app", "browser"];

export const DEFAULT_SLACK_LINK_TARGET: SlackLinkTarget = "app";

// 앱 안에서 누른 외부 링크를 실제로 열 주소로 바꾼다. slackLinkTarget 이 "app" 이고 워크스페이스 ID 가 있고
// 메시지 링크(https://<워크스페이스>.slack.com/archives/<채널>/p<ts>)이면 slack:// 주소를, 아니면 받은 주소를 그대로 돌려준다.
export function externalOpenUrl(url: string, settings: { slackLinkTarget?: unknown; slackTeamId?: unknown }): string {
  if ((settings.slackLinkTarget ?? DEFAULT_SLACK_LINK_TARGET) !== "app") return url;
  const teamId = typeof settings.slackTeamId === "string" ? settings.slackTeamId.trim() : "";
  return slackAppUrl(url, teamId) ?? url;
}

// 메시지 퍼머링크를 slack://channel?team=...&id=...&message=...[&thread_ts=...] 로 바꾼다. 바꿀 수 없으면 null.
// team 을 뺀 slack:// 은 Slack 데스크톱 앱의 메인 프로세스까지는 그대로 전달되지만 이후 처리는 웹앱 코드(앱 번들에 없음)라 확인하지 못해서, ID 가 없으면 바꾸지 않는다.
export function slackAppUrl(url: string, teamId: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || !/^[a-z0-9-]+(\.[a-z0-9-]+)*\.slack\.com$/i.test(parsed.hostname) || parsed.hostname.toLowerCase() === "app.slack.com") return null;
  const match = /^\/archives\/([CDG][0-9A-Z]{6,})\/p(\d{11,})\/?$/.exec(parsed.pathname);
  if (!match) return null;
  const threadTs = parsed.searchParams.get("thread_ts");
  return appLink({ channelId: match[1], ts: tsOfPermalinkDigits(match[2]), threadTs: threadTs && /^\d+\.\d+$/.test(threadTs) ? threadTs : null }, teamId);
}

// 퍼머링크의 p1791974742663289 는 ts 1791974742.663289 에서 점을 뺀 것이다. 뒤 6자리가 마이크로초.
function tsOfPermalinkDigits(digits: string): string {
  return `${digits.slice(0, -6)}.${digits.slice(-6)}`;
}
