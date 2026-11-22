import { notionPageId, singleEmoji } from "./notionLink";

export type NotionPageKind = "page" | "database" | "other";

export type NotionPageData = {
  kind: NotionPageKind;
  id: string | null;
  title: string;
  url: string;
  icon: string | null;
  path: string | null;
  lastEditedAt: string | null;
  markdown: string;
  enhanced: string;
  properties: Record<string, unknown>;
  truncated: boolean;
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

const CONTAINERS = new Set(["columns", "column", "callout", "details", "table", "tr", "td", "th", "synced_block", "toggle"]);
const KEEP_HTML = new Set(["br", "details", "summary", "table", "thead", "tbody", "tr", "td", "th", "colgroup", "col", "sub", "sup", "u", "kbd", "mark", "strong", "em", "code", "del", "a", "img", "b", "i", "s"]);

export function enhancedToMarkdown(source: string): string {
  const out: string[] = [];
  let depth = 0;
  let fence: string | null = null;
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

function inline(line: string): string {
  let text = line;
  text = text.replace(/\s*\{(?:[a-z_]+="[^"]*"\s*)+\}\s*$/, "");
  if (/^\s*<empty-block\/>\s*$/.test(text)) return "";
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
  text = text.replace(/<\/?([a-zA-Z][\w-]*)\b[^>]*?\/?>/g, (tag, name: string) => (KEEP_HTML.has(name.toLowerCase()) ? tag : ""));
  return text;
}

function link(label: string, url: string): string {
  return url ? `[${label}](${url})` : label;
}

export function propertyRows(properties: Record<string, unknown>): { name: string; value: string }[] {
  const rows: { name: string; value: string }[] = [];
  for (const [name, value] of Object.entries(properties)) {
    if (value === null || value === undefined || value === "") continue;
    rows.push({ name, value: typeof value === "string" ? value : Array.isArray(value) ? value.map(String).join(", ") : JSON.stringify(value) });
  }
  return rows;
}
