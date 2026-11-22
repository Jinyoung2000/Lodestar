
export type NotionLinkTarget = "lodestar" | "app" | "notion" | "browser";

export const NOTION_LINK_TARGETS: readonly NotionLinkTarget[] = ["lodestar", "app", "notion", "browser"];

export const DEFAULT_NOTION_LINK_TARGET: NotionLinkTarget = "lodestar";

function parse(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

export function isNotionHost(host: string): boolean {
  const name = host.toLowerCase();
  return name === "notion.so" || name.endsWith(".notion.so") || name === "notion.site" || name.endsWith(".notion.site") || name === "app.notion.com";
}

export function isNotionUrl(value: string): boolean {
  const url = parse(value);
  return url !== null && (url.protocol === "https:" || url.protocol === "http:") && isNotionHost(url.hostname);
}

const UUID_TAIL = /(?:^|[^0-9a-f])([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const HEX32_TAIL = /(?:^|[^0-9a-f])([0-9a-f]{32})$/i;

export function notionPageId(value: string): string | null {
  const url = parse(value);
  if (!url) return null;
  const idOf = (text: string) => {
    const uuid = UUID_TAIL.exec(text)?.[1];
    if (uuid) return uuid.replace(/-/g, "").toLowerCase();
    return HEX32_TAIL.exec(text)?.[1]?.toLowerCase() ?? null;
  };
  const peek = url.searchParams.get("p");
  const fromPeek = peek ? idOf(peek) : null;
  if (fromPeek) return fromPeek;
  let path = url.pathname;
  try {
    path = decodeURIComponent(path);
  } catch {
  }
  return idOf(path.split("/").filter(Boolean).pop() ?? "");
}

export function notionPageKey(value: string): string {
  const id = notionPageId(value);
  if (id) return `id:${id}`;
  const url = parse(value);
  return url ? `url:${url.hostname.toLowerCase()}${url.pathname.replace(/\/+$/, "")}` : `url:${value}`;
}

export function sameNotionPage(a: string, b: string): boolean {
  return isNotionUrl(a) && isNotionUrl(b) && notionPageKey(a) === notionPageKey(b);
}

export function notionTitleFromUrl(value: string): string | null {
  const url = parse(value);
  if (!url) return null;
  let path = url.pathname;
  try {
    path = decodeURIComponent(path);
  } catch {
  }
  const last = path.split("/").filter(Boolean).pop() ?? "";
  const slug = last.replace(/-?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "").replace(/-?[0-9a-f]{32}$/i, "");
  if (!slug || slug === "p") return null;
  const words = slug.replace(/[-_+]+/g, " ").trim();
  return words || null;
}

export function notionAppUrl(value: string): string | null {
  const url = parse(value);
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) return null;
  const host = url.hostname.toLowerCase();
  const appHost = host === "notion.so" ? "www.notion.so" : host === "www.notion.so" || host === "app.notion.com" ? host : null;
  return appHost ? `notion://${appHost}${url.pathname}${url.search}${url.hash}` : null;
}

export type NotionOpenPlan = { via: "screen"; url: string } | { via: "tab"; url: string } | { via: "external"; url: string };

export function notionOpenPlan(value: string, settings: { notionLinkTarget?: unknown }): NotionOpenPlan | null {
  if (!isNotionUrl(value)) return null;
  const target = NOTION_LINK_TARGETS.find((t) => t === settings.notionLinkTarget) ?? DEFAULT_NOTION_LINK_TARGET;
  if (target === "lodestar") return { via: "screen", url: value };
  if (target === "app") return { via: "tab", url: value };
  if (target === "notion") return { via: "external", url: notionAppUrl(value) ?? value };
  return { via: "external", url: value };
}

export function singleEmoji(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.length > 16) return null;
  const graphemes = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)];
  return graphemes.length === 1 && /\p{Extended_Pictographic}/u.test(text) ? text : null;
}

export function isNotionLoginUrl(value: string): boolean {
  const url = parse(value);
  return url !== null && isNotionHost(url.hostname) && /^\/(login|signup|sign-up|logout)(\/|$)/.test(url.pathname);
}

export function notionRefToUrl(ref: string): string {
  const text = ref.trim();
  return /^[0-9a-f]{32}$/i.test(text) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text) ? `https://www.notion.so/${text.replace(/-/g, "").toLowerCase()}` : text;
}
