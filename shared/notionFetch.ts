import { notionPageId, singleEmoji } from "./notionLink";

// notion-fetch 의 결과(2026-10-16 실제 응답으로 확인)를 앱 화면용 값으로 바꾼다. DOM 을 건드리지 않아 데몬과 화면이 같이 쓰고 단위 시험이 그대로 부른다.
//
// 응답은 JSON 한 덩어리다: { metadata: { type }, title, url, text, icon, cover, path, verification, page_last_edited_at }.
// text 는 "Here is the result of ..." 한 줄 뒤에 <page url icon> 안에 <ancestor-path>, <properties>(JSON), <content>(Notion enhanced markdown) 가 든 글이다.
// enhanced markdown 은 탭으로 들여 쓴 <columns>, <callout>, <page url>제목</page>, <empty-block/> 같은 태그가 섞여 있어 표준 마크다운으로 먼저 풀어야 화면에 그린다.

export type NotionPageKind = "page" | "database" | "other";

export type NotionPageData = {
  kind: NotionPageKind;
  id: string | null;
  title: string;
  url: string;
  // 이모지 하나. 이미지 아이콘은 서명 주소가 5분 뒤 만료돼 쓰지 않는다.
  icon: string | null;
  // 상위 경로("사업 부문 / Local Jobs"). 없으면 null.
  path: string | null;
  lastEditedAt: string | null;
  // 화면에 그리는 표준 마크다운
  markdown: string;
  // 모델에 주고 diff 의 기준이 되는 enhanced markdown 원문 (<content> 안쪽)
  enhanced: string;
  // 데이터베이스에 속한 페이지의 속성 (title 제외). 없으면 빈 객체.
  properties: Record<string, unknown>;
  // 응답이 일부만 담았다고 알린 경우
  truncated: boolean;
  // 이 화면이 마크다운으로 못 그리는 구성(표 보기, 보드, 데이터베이스 행)이 있다
  needsBrowser: boolean;
};

export type NotionParse = { ok: true; page: NotionPageData } | { ok: false; error: string };

export function parseFetchResult(raw: string): NotionParse {
  let json: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") throw new Error("shape");
    json = parsed as Record<string, unknown>;
  } catch {
    // JSON 이 아니면 오류 글이다 (권한 없음, 찾을 수 없음 등)
    return { ok: false, error: raw.trim().slice(0, 300) || "Empty result from Notion" };
  }
  const text = typeof json.text === "string" ? json.text : "";
  if (!text) {
    const message = typeof json.error === "string" ? json.error : typeof json.message === "string" ? json.message : "Notion returned no content for this page";
    return { ok: false, error: message.slice(0, 300) };
  }
  const meta = (json.metadata && typeof json.metadata === "object" ? json.metadata : {}) as Record<string, unknown>;
  const type = typeof meta.type === "string" ? meta.type : "";
  const kind: NotionPageKind = type === "page" ? "page" : /database|data_source|data-source/.test(type) || /<database\b|<data-source\b/.test(text.slice(0, 600)) ? "database" : "other";
  const enhanced = contentOf(text);
  const url = cleanUrl(typeof json.url === "string" ? json.url : (/<(?:page|database)\s+url="([^"]+)"/.exec(text)?.[1] ?? ""));
  const properties = propertiesOf(text);
  const { title: propTitle, ...rest } = properties;
  const title = (typeof json.title === "string" && json.title.trim()) || (typeof propTitle === "string" && propTitle.trim()) || "Untitled";
  const markdown = enhancedToMarkdown(enhanced);
  return {
    ok: true,
    page: {
      kind,
      id: notionPageId(url),
      title,
      url,
      icon: iconOf(json, text),
      path: typeof json.path === "string" && json.path.trim() ? json.path.trim() : null,
      lastEditedAt: typeof json.page_last_edited_at === "string" ? json.page_last_edited_at : null,
      markdown,
      enhanced,
      properties: rest,
      truncated: json.truncated === true || meta.truncated === true || /\btruncated="true"/.test(text.slice(0, 2000)),
      needsBrowser: kind === "database" || /<view\b|<data-source\b|<database\b/.test(enhanced),
    },
  };
}

// 주소에서 ?pvs= 같은 보기 표시를 뗀다 (같은 페이지가 다른 주소로 두 번 저장되지 않게).
function cleanUrl(value: string): string {
  try {
    const url = new URL(value);
    url.searchParams.delete("pvs");
    return url.href.replace(/\?$/, "");
  } catch {
    return value;
  }
}

function contentOf(text: string): string {
  const start = text.indexOf("<content>");
  const end = text.lastIndexOf("</content>");
  if (start < 0) return "";
  return text.slice(start + "<content>".length, end > start ? end : undefined).replace(/^\n/, "").replace(/\n$/, "");
}

function propertiesOf(text: string): Record<string, unknown> {
  const match = /<properties>\s*([\s\S]*?)\s*<\/properties>/.exec(text);
  if (!match) return {};
  try {
    const parsed = JSON.parse(match[1]);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function iconOf(json: Record<string, unknown>, text: string): string | null {
  const icon = json.icon;
  if (icon && typeof icon === "object") {
    const emoji = (icon as Record<string, unknown>).emoji;
    const found = singleEmoji(emoji);
    if (found) return found;
  }
  const attr = /<page\s[^>]*?\bicon="([^"]*)"/.exec(text)?.[1];
  return singleEmoji(attr) ?? null;
}

// ---- enhanced markdown -> 표준 마크다운 ----

// 안쪽을 들여 쓰는 컨테이너 태그. 여는 태그마다 자식 줄이 탭 한 칸씩 더 들어간다.
const CONTAINERS = new Set(["columns", "column", "callout", "details", "table", "tr", "td", "th", "synced_block", "toggle"]);
const KEEP_HTML = new Set(["br", "details", "summary", "table", "thead", "tbody", "tr", "td", "th", "colgroup", "col", "sub", "sup", "u", "kbd", "mark", "strong", "em", "code", "del", "a", "img", "b", "i", "s"]);

export function enhancedToMarkdown(source: string): string {
  const out: string[] = [];
  let depth = 0;
  let fence: string | null = null;
  // callout 안쪽 줄은 인용문(> )으로 보낸다. 열린 callout 마다 한 단계.
  const callouts: { icon: string; first: boolean }[] = [];
  const emit = (line: string) => {
    if (callouts.length === 0) {
      out.push(line);
      return;
    }
    const prefix = "> ".repeat(callouts.length);
    const top = callouts[callouts.length - 1];
    if (top.first && line.trim()) {
      top.first = false;
      out.push(`${prefix}${top.icon}${line}`);
    } else out.push(`${prefix}${line}`.trimEnd());
  };

  for (const rawLine of source.split("\n")) {
    // 코드 울타리 안은 손대지 않는다 (들여 쓰기만 걷는다)
    const stripped = stripTabs(rawLine, depth);
    const fenceMark = /^\s*(`{3,}|~{3,})/.exec(stripped)?.[1];
    if (fence) {
      emit(stripped);
      if (fenceMark && fenceMark[0] === fence[0] && fenceMark.length >= fence.length) fence = null;
      continue;
    }
    if (fenceMark) {
      fence = fenceMark;
      emit(stripped);
      continue;
    }
    const line = stripped;
    const trimmed = line.trim();

    const open = /^<(columns|column|callout|details|table|tr|td|th|synced_block|toggle)\b([^>]*)>$/.exec(trimmed);
    const openInline = /^<(td|th)\b([^>]*)>([\s\S]*)<\/\1>$/.exec(trimmed);
    const close = /^<\/(columns|column|callout|details|table|tr|td|th|synced_block|toggle)>$/.exec(trimmed);
    if (openInline) {
      emit(trimmed);
      continue;
    }
    if (open) {
      const name = open[1];
      if (name === "callout") {
        emit("");
        callouts.push({ icon: calloutIcon(open[2]), first: true });
      }
      else if (name === "details" || name === "table" || name === "tr") emit(trimmed.replace(/\s[^<>]*>$/, ">"));
      else if (name === "column" && out.length && out[out.length - 1] !== "") emit("");
      if (CONTAINERS.has(name)) depth++;
      continue;
    }
    if (close) {
      const name = close[1];
      depth = Math.max(0, depth - 1);
      if (name === "callout") {
        callouts.pop();
        emit("");
      }
      else if (name === "details" || name === "table" || name === "tr") emit(trimmed);
      continue;
    }
    emit(inline(line));
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function stripTabs(line: string, depth: number): string {
  let i = 0;
  while (i < depth && line[i] === "\t") i++;
  return line.slice(i);
}

function calloutIcon(attrs: string): string {
  const icon = /\bicon="([^"]*)"/.exec(attrs)?.[1] ?? "";
  return singleEmoji(icon) ? `${icon} ` : "";
}

const attr = (tag: string, name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1] ?? "";

// 한 줄 안의 태그를 풀어 쓴다.
function inline(line: string): string {
  let text = line;
  // 헤딩 끝의 {toggle="true" color="..."} 같은 표지는 화면에 의미가 없다
  text = text.replace(/\s*\{(?:[a-z_]+="[^"]*"\s*)+\}\s*$/, "");
  if (/^\s*<empty-block\/>\s*$/.test(text)) return "";
  // 페이지 안 링크는 워크스페이스 기준 경로(/<id>)로 올 때가 있다. 앱 주소 기준으로 읽히지 않게 Notion 주소로 바꾼다.
  text = text.replace(/\]\(\/(?!\/)/g, "](https://www.notion.so/");
  text = text.replace(/<page\s([^>]*?)>([\s\S]*?)<\/page>/g, (_m, tag: string, title: string) => link(`📄 ${title.trim() || "Untitled"}`, attr(tag, "url")));
  text = text.replace(/<database\s([^>]*?)>([\s\S]*?)<\/database>/g, (_m, tag: string, title: string) => link(`🗂 ${title.trim() || "Database"}`, attr(tag, "url")));
  text = text.replace(/<mention-page\s([^>]*?)\/>/g, (_m, tag: string) => link(attr(tag, "title") || "Page", attr(tag, "url")));
  text = text.replace(/<mention-page\s([^>]*?)>([\s\S]*?)<\/mention-page>/g, (_m, tag: string, title: string) => link(title.trim() || "Page", attr(tag, "url")));
  text = text.replace(/<mention-database\s([^>]*?)(?:\/>|>([\s\S]*?)<\/mention-database>)/g, (_m, tag: string, title?: string) => link(title?.trim() || attr(tag, "title") || "Database", attr(tag, "url")));
  text = text.replace(/<mention-user\s[^>]*?>([\s\S]*?)<\/mention-user>/g, (_m, name: string) => `@${name.trim()}`);
  text = text.replace(/<mention-user\s[^>]*?\/>/g, "@user");
  text = text.replace(/<mention-date\s([^>]*?)\/>/g, (_m, tag: string) => [attr(tag, "start"), attr(tag, "end")].filter(Boolean).join(" to "));
  text = text.replace(/<image\s([^>]*?)>([\s\S]*?)<\/image>/g, (_m, tag: string, caption: string) => {
    const source = attr(tag, "source");
    const label = caption.trim() || "image";
    return /^https?:/.test(source) ? `![${label}](${source})` : `[Image: ${label}]`;
  });
  text = text.replace(/<(?:file|pdf|video|audio)\s([^>]*?)>([\s\S]*?)<\/(?:file|pdf|video|audio)>/g, (_m, _tag: string, caption: string) => `[File: ${caption.trim() || "attachment"}]`);
  text = text.replace(/<span\b[^>]*>([\s\S]*?)<\/span>/g, "$1");
  text = text.replace(/<\/?(?:summary)\b[^>]*>/g, (tag) => tag);
  // 남은 알 수 없는 태그는 지운다 (안쪽 글은 남는다). 화면이 아는 HTML 태그는 그대로 둔다.
  text = text.replace(/<\/?([a-zA-Z][\w-]*)\b[^>]*?\/?>/g, (tag, name: string) => (KEEP_HTML.has(name.toLowerCase()) ? tag : ""));
  return text;
}

function link(label: string, url: string): string {
  return url ? `[${label}](${url})` : label;
}

// ---- 속성 표시 ----

// 데이터베이스 행 페이지의 속성을 화면용 (이름, 값) 쌍으로. 값은 문자열로 줄인다.
export function propertyRows(properties: Record<string, unknown>): { name: string; value: string }[] {
  const rows: { name: string; value: string }[] = [];
  for (const [name, value] of Object.entries(properties)) {
    if (value === null || value === undefined || value === "") continue;
    rows.push({ name, value: typeof value === "string" ? value : Array.isArray(value) ? value.map(String).join(", ") : JSON.stringify(value) });
  }
  return rows;
}
