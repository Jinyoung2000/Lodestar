// Notion 주소 판정과 변환. DOM 을 건드리지 않아 화면, 데몬, 메인 프로세스가 같이 쓰고 단위 시험이 그대로 부른다.

// lodestar: 앱 안 Notion 화면(Notion MCP 로 읽고 페이지 전용 대화를 붙임), app: Lodestar 의 Browser 탭, notion: Notion 데스크톱 앱, browser: 기본 브라우저
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

// notion.so 와 하위 도메인(www), 공개 페이지 notion.site 와 하위 도메인, 새 앱 주소 app.notion.com 만 Notion 으로 본다.
// www.notion.com 은 소개 사이트라 제외한다.
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

// 주소가 가리키는 페이지 id(소문자 32자리 16진수). 쿼리 ?p= 는 데이터베이스에서 옆으로 열어 본 페이지라 경로의 id 보다 앞선다.
// 경로는 /<제목>-<id>, /<id>, /p/<id>, /<워크스페이스>/<제목>-<id> 어느 모양이든 마지막 조각 끝에서 읽는다. 대시가 든 UUID 도 받는다.
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
    // 깨진 퍼센트 인코딩은 그대로 읽는다
  }
  return idOf(path.split("/").filter(Boolean).pop() ?? "");
}

// 열려 있는 탭이 같은 페이지인지 가르는 키. id 가 있으면 id, 없으면 쿼리와 해시를 뺀 주소.
export function notionPageKey(value: string): string {
  const id = notionPageId(value);
  if (id) return `id:${id}`;
  const url = parse(value);
  return url ? `url:${url.hostname.toLowerCase()}${url.pathname.replace(/\/+$/, "")}` : `url:${value}`;
}

export function sameNotionPage(a: string, b: string): boolean {
  return isNotionUrl(a) && isNotionUrl(b) && notionPageKey(a) === notionPageKey(b);
}

// 주소의 제목 조각("My-Page-abc...")에서 추정한 제목. 조각이 없거나 id 뿐이면 null.
export function notionTitleFromUrl(value: string): string | null {
  const url = parse(value);
  if (!url) return null;
  let path = url.pathname;
  try {
    path = decodeURIComponent(path);
  } catch {
    // 깨진 퍼센트 인코딩은 그대로 읽는다
  }
  const last = path.split("/").filter(Boolean).pop() ?? "";
  const slug = last.replace(/-?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "").replace(/-?[0-9a-f]{32}$/i, "");
  if (!slug || slug === "p") return null;
  const words = slug.replace(/[-_+]+/g, " ").trim();
  return words || null;
}

// Notion 데스크톱 앱(notion://)이 받는 주소. 앱 번들(app.asar)의 production 설정이 www.notion.so 와 app.notion.com 두 도메인에 notion 프로토콜을 둔다.
// 스킴만 바꾸고 나머지는 그대로 둔다. 공개 페이지(notion.site)와 그 밖의 하위 도메인은 앱이 받는다는 근거가 없어 null.
export function notionAppUrl(value: string): string | null {
  const url = parse(value);
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) return null;
  const host = url.hostname.toLowerCase();
  const appHost = host === "notion.so" ? "www.notion.so" : host === "www.notion.so" || host === "app.notion.com" ? host : null;
  return appHost ? `notion://${appHost}${url.pathname}${url.search}${url.hash}` : null;
}

export type NotionOpenPlan = { via: "screen"; url: string } | { via: "tab"; url: string } | { via: "external"; url: string };

// 앱 안에서 누른 링크를 설정 notionLinkTarget 에 따라 어디로 열지. Notion 링크가 아니면 null 이라 호출하는 쪽이 다른 규칙(Slack)으로 넘어간다.
// lodestar 는 앱 안 Notion 화면, app 은 Lodestar 의 Browser 탭, notion 은 Notion 데스크톱 앱(바꿀 수 없는 주소는 기본 브라우저), browser 는 기본 브라우저.
export function notionOpenPlan(value: string, settings: { notionLinkTarget?: unknown }): NotionOpenPlan | null {
  if (!isNotionUrl(value)) return null;
  const target = NOTION_LINK_TARGETS.find((t) => t === settings.notionLinkTarget) ?? DEFAULT_NOTION_LINK_TARGET;
  if (target === "lodestar") return { via: "screen", url: value };
  if (target === "app") return { via: "tab", url: value };
  if (target === "notion") return { via: "external", url: notionAppUrl(value) ?? value };
  return { via: "external", url: value };
}

// 고정 아이콘으로 받는 글: 이모지 하나. 이미지 주소나 글자는 받지 않는다.
export function singleEmoji(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.length > 16) return null;
  const graphemes = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)];
  return graphemes.length === 1 && /\p{Extended_Pictographic}/u.test(text) ? text : null;
}

// Browser 탭이 열린 Notion 페이지 중 로그인 화면 주소인가(본문을 읽을 수 없는 상태 판정에 쓴다).
export function isNotionLoginUrl(value: string): boolean {
  const url = parse(value);
  return url !== null && isNotionHost(url.hostname) && /^\/(login|signup|sign-up|logout)(\/|$)/.test(url.pathname);
}

// 페이지 id(32자리 16진수나 대시가 든 UUID)만 온 참조를 주소로 바꾼다. 이미 주소이면 그대로.
export function notionRefToUrl(ref: string): string {
  const text = ref.trim();
  return /^[0-9a-f]{32}$/i.test(text) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text) ? `https://www.notion.so/${text.replace(/-/g, "").toLowerCase()}` : text;
}
