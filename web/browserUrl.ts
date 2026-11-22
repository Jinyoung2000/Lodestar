import type { BrowserSearchEngine, BrowserStorage } from "../shared/protocol";
import { S } from "./strings";

export type Address = { ok: true; url: string } | { ok: false; reason: string };

export const BROWSER_PARTITION = "persist:agent-nav-browser";

export type { BrowserStorage };
export type EffectiveStorage = "global" | "workspace" | "ephemeral" | "agent";
const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 40) || "x";

export function partitionFor(storage: BrowserStorage, workspaceId: string | null, tabKey: string): { partition: string; scope: EffectiveStorage } {
  if (storage === "workspace" && workspaceId) return { partition: `${BROWSER_PARTITION}-ws-${slug(workspaceId)}`, scope: "workspace" };
  if (storage === "ephemeral" || storage === "workspace") return { partition: `agent-nav-browser-eph-${slug(tabKey)}`, scope: "ephemeral" };
  if (storage === "agent") return { partition: "agent-nav-browser-agent", scope: "agent" };
  return { partition: BROWSER_PARTITION, scope: "global" };
}

export const isBrowserPartition = (value: unknown): value is string => typeof value === "string" && /^(persist:agent-nav-browser(-ws-[a-z0-9]{1,40})?|agent-nav-browser-eph-[a-z0-9]{1,40}|agent-nav-browser-agent)$/.test(value);

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1", "0.0.0.0", "[::]", "::"]);
const SEARCH_URLS: Record<Exclude<BrowserSearchEngine, "none">, (q: string) => string> = {
  bing: (q) => `https://www.bing.com/search?q=${q}`,
  google: (q) => `https://www.google.com/search?q=${q}`,
  yahoo: (q) => `https://search.yahoo.com/search?p=${q}`,
  duckduckgo: (q) => `https://duckduckgo.com/?q=${q}`,
};
export const searchUrl = (engine: BrowserSearchEngine, text: string) => (engine === "none" ? null : SEARCH_URLS[engine](encodeURIComponent(text).replace(/%20/g, "+")));

export function resolveAddress(input: string, engine: BrowserSearchEngine = "bing"): Address {
  const search = (text: string): Address => {
    const url = searchUrl(engine, text);
    return url ? { ok: true, url } : { ok: false, reason: S.browserSearchOff };
  };
  const text = input.trim();
  if (!text) return { ok: false, reason: S.browserUrlPlaceholder };
  const hostPort = /^(localhost|\[[0-9a-f:]+\]|[a-z0-9.-]+):\d+(\/|\?|#|$)/i.test(text);
  if (!hostPort && /^[a-z][a-z0-9+.-]*:/i.test(text)) {
    return /^(https?|file):\/\//i.test(text) && parseOpenable(text) ? { ok: true, url: parseOpenable(text)!.href } : { ok: false, reason: S.browserOnlyHttp };
  }
  if (/\s/.test(text)) return search(text);
  const host = text.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").split(/[/?#:]/)[0].toLowerCase();
  const local = LOOPBACK.has(host) || host === "[::1]" || /^(127|10)\.\d+\.\d+\.\d+$|^192\.168\.\d+\.\d+$/.test(host);
  if (local || host.includes(".") || hostPort) {
    const url = parse(`${local || hostPort ? "http" : "https"}://${text.replace(/^\/\//, "")}`);
    if (url) return { ok: true, url: url.href };
  }
  return search(text);
}

export function parseBrowsable(value: string) {
  const url = parse(value);
  return url && (url.protocol === "http:" || url.protocol === "https:") ? url : null;
}

export function parseOpenable(value: string) {
  const url = parse(value);
  return url && (url.protocol === "http:" || url.protocol === "https:" || (url.protocol === "file:" && url.hostname === "")) ? url : null;
}

export function filePathOf(value: string): string | null {
  const url = parse(value);
  if (!url || url.protocol !== "file:" || url.hostname !== "") return null;
  try {
    return decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
}

function parse(value: string) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

export function isOwnOrigin(url: string, own: { hostname: string; port: string; origin: string }) {
  const target = parse(url);
  if (!target) return false;
  if (target.origin === own.origin) return true;
  return LOOPBACK.has(target.hostname) && LOOPBACK.has(own.hostname) && target.port === own.port;
}

export const tabLabel = (title: string) => title.trim() || S.browserTabTitle;
export function tabTooltip(title: string, url: string) {
  const host = parse(url)?.host ?? "";
  if (!title.trim() || !host) return tabLabel(title);
  return title.trim() === host ? url : `${title.trim()} (${host})`;
}

export function localhostTarget(href: string, own: { hostname: string; port: string; origin: string }): string | null {
  const url = parseBrowsable(href);
  if (!url || !LOOPBACK.has(url.hostname) || isOwnOrigin(url.href, own)) return null;
  return url.href;
}

export function similarPage(existing: string, wanted: string, includeBlank = false): boolean {
  let want: URL;
  try {
    want = new URL(wanted);
  } catch {
    return false;
  }
  if (want.protocol !== "file:" && !want.host) return false;
  if (includeBlank && (!existing || existing === "about:blank")) return true;
  let have: URL;
  try {
    have = new URL(existing);
  } catch {
    return false;
  }
  return have.host === want.host || (want.protocol === "file:" && have.protocol === "file:") || !!(have.host && want.host && (have.host.endsWith(`.${want.host}`) || want.host.endsWith(`.${have.host}`)));
}

