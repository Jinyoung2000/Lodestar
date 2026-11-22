import { isNotionHost } from "../shared/notionLink";

export type PopupDecision = "popup" | "link" | "deny";

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

export function chromeLikeUserAgent(userAgent: string): string {
  return userAgent
    .replace(/\s+Electron\/\S+/i, "")
    .replace(/\s+(?:agent-nav|Lodestar)\/\S+/i, "")
    .trim();
}
