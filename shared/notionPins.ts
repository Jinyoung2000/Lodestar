import { isNotionUrl, notionPageKey, singleEmoji } from "./notionLink";

// 사이드바 Notion 묶음에 고정한 페이지. 순서는 배열 순서다.
export type NotionPin = {
  id: string;
  title: string;
  url: string;
  // 이모지 하나. 없으면 화면이 문서 아이콘(데이터베이스는 표 아이콘)을 그린다.
  icon: string | null;
  kind: "page" | "database";
  // url 은 주소에서 추정한 제목, page 는 Browser 탭에서 읽은 제목, user 는 사용자가 바꾼 이름. page 제목은 더 새로 읽은 제목으로 덮이지만 user 는 덮이지 않는다.
  titleSource: "url" | "page" | "user";
};

export type NotionPinInput = { title: string; url: string; icon?: string | null; kind?: "page" | "database"; titleSource?: NotionPin["titleSource"] };

export type NotionPinPatch = Partial<Pick<NotionPin, "title" | "icon" | "kind" | "titleSource">>;

export const MAX_NOTION_PINS = 100;
export const MAX_PIN_TITLE = 200;

// 두 주소가 같은 페이지인가(고정 중복 판정): 페이지 id 가 같거나 같은 주소.
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

// 저장 파일 내용을 검증된 목록으로. 모양이 맞지 않은 항목과 같은 페이지의 뒤쪽 중복, 한도 밖은 버린다.
export function sanitizePins(raw: unknown): NotionPin[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: NotionPin[] = [];
  for (const item of list) {
    const pin = sanitizePin(item);
    if (pin && !out.some((p) => p.id === pin.id || pinMatches(p, pin.url)) && out.length < MAX_NOTION_PINS) out.push(pin);
  }
  return out;
}
