import { appLink } from "./inbox";

export type SlackLinkTarget = "app" | "browser";

export const SLACK_LINK_TARGETS: readonly SlackLinkTarget[] = ["app", "browser"];

export const DEFAULT_SLACK_LINK_TARGET: SlackLinkTarget = "app";

// 메시지 링크(https://<워크스페이스>.slack.com/archives/<채널>/p<ts>)이면 slack:// 주소를, 아니면 받은 주소를 그대로 돌려준다.
export function externalOpenUrl(url: string, settings: { slackLinkTarget?: unknown; slackTeamId?: unknown }): string {
  if ((settings.slackLinkTarget ?? DEFAULT_SLACK_LINK_TARGET) !== "app") return url;
  const teamId = typeof settings.slackTeamId === "string" ? settings.slackTeamId.trim() : "";
  return slackAppUrl(url, teamId) ?? url;
}

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

function tsOfPermalinkDigits(digits: string): string {
  return `${digits.slice(0, -6)}.${digits.slice(-6)}`;
}
