import { isNotionUrl, notionPageKey, singleEmoji } from "./notionLink";

export type NotionPin = {
  id: string;
  title: string;
  url: string;
  icon: string | null;
  kind: "page" | "database";
  titleSource: "url" | "page" | "user";
};

export type NotionPinInput = { title: string; url: string; icon?: string | null; kind?: "page" | "database"; titleSource?: NotionPin["titleSource"] };

export type NotionPinPatch = Partial<Pick<NotionPin, "title" | "icon" | "kind" | "titleSource">>;

export const MAX_NOTION_PINS = 100;
export const MAX_PIN_TITLE = 200;

export const pinMatches = (pin: Pick<NotionPin, "url">, url: string) => notionPageKey(pin.url) === notionPageKey(url);

export function cleanTitle(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, MAX_PIN_TITLE) : "";
}

export function sanitizePin(raw: unknown): NotionPin | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !r.id || typeof r.url !== "string" || !isNotionUrl(r.url)) return null;
  const title = cleanTitle(r.title);
  if (!title) return null;
  return {
    id: r.id,
    title,
    url: new URL(r.url).href,
    icon: singleEmoji(r.icon),
    kind: r.kind === "database" ? "database" : "page",
    titleSource: r.titleSource === "page" || r.titleSource === "user" ? r.titleSource : "url",
  };
}

export function sanitizePins(raw: unknown): NotionPin[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: NotionPin[] = [];
  for (const item of list) {
    const pin = sanitizePin(item);
    if (pin && !out.some((p) => p.id === pin.id || pinMatches(p, pin.url)) && out.length < MAX_NOTION_PINS) out.push(pin);
  }
  return out;
}
