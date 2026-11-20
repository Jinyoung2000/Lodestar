// Notion 에 쓰는 요청(페이지 고치기, 페이지나 데이터베이스 행 만들기)의 미리보기와 검증. 순수 함수라 데몬, 화면, 시험이 같이 쓴다.
// 에이전트는 Notion 쓰기 도구를 직접 못 부르고, 이 요청을 만드는 제안 도구만 부른다. 사용자가 이 미리보기를 보고 승인해야 데몬이 같은 인자로 Notion 도구를 한 번 부른다.

import type { NotionPageData } from "./notionFetch";

export type UpdateCommand = "update_properties" | "update_content" | "replace_content" | "insert_content";

export type ContentUpdate = { old_str: string; new_str: string; replace_all_matches?: boolean };

// notion-update-page 인자 중 제안 도구가 받는 부분. 승인한 값이 그대로 Notion 도구에 간다.
export type NotionUpdateArgs = {
  page_id: string;
  command: UpdateCommand;
  properties?: Record<string, string | number | string[] | null>;
  content_updates?: ContentUpdate[];
  new_str?: string;
  content?: string;
  position?: { type: "start" | "end" };
  icon?: string;
};

export type NotionCreateParent = { type: "page_id"; page_id: string } | { type: "database_id"; database_id: string } | { type: "data_source_id"; data_source_id: string };

export type NotionCreatePage = { properties?: Record<string, string | number | string[] | null>; content?: string; icon?: string };

// notion-create-pages 인자 중 제안 도구가 받는 부분
export type NotionCreateArgs = { parent?: NotionCreateParent; creation_mode?: "draft"; pages: NotionCreatePage[] };

export type PropertyChange = { name: string; before: string | null; after: string | null };

// 승인 카드에 보이는 미리보기. 데몬이 만들어 타임라인의 승인 항목에 싣는다.
export type NotionWritePreview = {
  kind: "update" | "create";
  // 카드 머리 문구에 쓰는 한 줄 요약
  summary: string;
  // 바뀌는 페이지(만드는 경우는 부모). 모르면 null.
  target: { title: string; url: string | null } | null;
  // 본문 변경. 있으면 before 에서 after 로 바뀐다. 만드는 경우 before 는 빈 글이다.
  diff: { before: string; after: string; exact: boolean } | null;
  properties: PropertyChange[];
  // 이 변경을 승인했을 때 일어나는 일에 대한 경고 (바뀔 글을 페이지에서 못 찾음 등)
  warnings: string[];
  // 새로 만드는 페이지의 수와 제목들 (만들기에서만)
  creates?: { title: string }[];
};

export type PreviewResult = { ok: true; preview: NotionWritePreview } | { ok: false; error: string };

const UPDATE_COMMANDS: readonly string[] = ["update_properties", "update_content", "replace_content", "insert_content"];

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const str = (value: unknown) => (typeof value === "string" ? value : "");

// 모델이 준 인자를 제안 도구가 받는 모양으로 거른다. 모르는 필드는 버리므로, 승인 카드에 안 보인 필드가 Notion 으로 새어 나가지 않는다.
export function cleanUpdateArgs(raw: unknown): { ok: true; args: NotionUpdateArgs } | { ok: false; error: string } {
  if (!isObject(raw)) return { ok: false, error: "Arguments must be an object" };
  const page_id = str(raw.page_id).trim();
  if (!page_id) return { ok: false, error: "page_id is required" };
  if (!UPDATE_COMMANDS.includes(str(raw.command))) return { ok: false, error: `command must be one of ${UPDATE_COMMANDS.join(", ")}` };
  const command = raw.command as UpdateCommand;
  const args: NotionUpdateArgs = { page_id, command };
  if (command === "update_properties") {
    const properties = cleanProperties(raw.properties);
    if (!properties || Object.keys(properties).length === 0) return { ok: false, error: "update_properties needs a non-empty properties object" };
    args.properties = properties;
  } else if (command === "update_content") {
    const list = Array.isArray(raw.content_updates) ? raw.content_updates : [];
    const updates: ContentUpdate[] = [];
    for (const item of list) {
      if (!isObject(item) || typeof item.old_str !== "string" || !item.old_str || typeof item.new_str !== "string") return { ok: false, error: "Each content_updates item needs a non-empty old_str and a new_str" };
      updates.push({ old_str: item.old_str, new_str: item.new_str, ...(item.replace_all_matches === true ? { replace_all_matches: true } : {}) });
    }
    if (updates.length === 0) return { ok: false, error: "update_content needs at least one content_updates item" };
    args.content_updates = updates;
  } else if (command === "replace_content") {
    if (typeof raw.new_str !== "string") return { ok: false, error: "replace_content needs new_str" };
    args.new_str = raw.new_str;
  } else {
    if (typeof raw.content !== "string" || !raw.content) return { ok: false, error: "insert_content needs content" };
    args.content = raw.content;
    const position = isObject(raw.position) ? str(raw.position.type) : "";
    if (position === "start" || position === "end") args.position = { type: position };
  }
  if (typeof raw.icon === "string" && raw.icon.trim()) args.icon = raw.icon.trim();
  return { ok: true, args };
}

function cleanProperties(raw: unknown): Record<string, string | number | string[] | null> | null {
  if (!isObject(raw)) return null;
  const out: Record<string, string | number | string[] | null> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (value === null || typeof value === "string" || typeof value === "number") out[name] = value;
    else if (Array.isArray(value) && value.every((v) => typeof v === "string")) out[name] = value as string[];
    else return null;
  }
  return out;
}

export function cleanCreateArgs(raw: unknown): { ok: true; args: NotionCreateArgs } | { ok: false; error: string } {
  if (!isObject(raw)) return { ok: false, error: "Arguments must be an object" };
  const list = Array.isArray(raw.pages) ? raw.pages : [];
  if (list.length === 0 || list.length > 20) return { ok: false, error: "pages must have between 1 and 20 items" };
  const pages: NotionCreatePage[] = [];
  for (const item of list) {
    if (!isObject(item)) return { ok: false, error: "Each page must be an object" };
    const page: NotionCreatePage = {};
    if (item.properties !== undefined) {
      const properties = cleanProperties(item.properties);
      if (!properties) return { ok: false, error: "Page properties must map names to text, numbers, lists of text, or null" };
      page.properties = properties;
    }
    if (typeof item.content === "string" && item.content) page.content = item.content;
    if (typeof item.icon === "string" && item.icon.trim()) page.icon = item.icon.trim();
    pages.push(page);
  }
  const args: NotionCreateArgs = { pages };
  if (raw.creation_mode === "draft") args.creation_mode = "draft";
  const parent = raw.parent;
  if (isObject(parent)) {
    if (parent.type === "page_id" && str(parent.page_id)) args.parent = { type: "page_id", page_id: str(parent.page_id) };
    else if (parent.type === "database_id" && str(parent.database_id)) args.parent = { type: "database_id", database_id: str(parent.database_id) };
    else if (parent.type === "data_source_id" && str(parent.data_source_id)) args.parent = { type: "data_source_id", data_source_id: str(parent.data_source_id) };
    else return { ok: false, error: "parent needs a type of page_id, database_id, or data_source_id and the matching id" };
  }
  if (args.parent && args.creation_mode) return { ok: false, error: "Do not combine creation_mode draft with a parent" };
  if (!args.parent && !args.creation_mode) return { ok: false, error: "Give a parent, or set creation_mode to draft for a private page" };
  return { ok: true, args };
}

const show = (value: unknown): string | null => (value === null || value === undefined ? null : typeof value === "string" ? value : Array.isArray(value) ? value.map(String).join(", ") : String(value));

// 고치는 요청의 미리보기. current 는 승인을 묻는 지금 읽은 페이지(못 읽었으면 null).
export function previewUpdate(args: NotionUpdateArgs, current: NotionPageData | null): PreviewResult {
  const warnings: string[] = [];
  const target = current ? { title: current.title, url: current.url } : null;
  const properties: PropertyChange[] = Object.entries(args.properties ?? {}).map(([name, value]) => ({ name, before: show(current?.properties[name] ?? (name === "title" ? current?.title : undefined)), after: show(value) }));
  if (args.icon) properties.push({ name: "icon", before: current?.icon ?? null, after: args.icon });
  let diff: NotionWritePreview["diff"] = null;

  if (args.command === "update_content") {
    const updates = args.content_updates ?? [];
    if (current) {
      const applied = applyUpdates(current.enhanced, updates);
      if (applied.ok) diff = { before: current.enhanced, after: applied.text, exact: true };
      else warnings.push(applied.reason);
    } else warnings.push("The page could not be read just now, so only the changed pieces are shown.");
    if (!diff) diff = { before: updates.map((u) => u.old_str).join("\n"), after: updates.map((u) => u.new_str).join("\n"), exact: false };
  } else if (args.command === "replace_content") {
    if (!current) warnings.push("The page could not be read just now, so the whole new text is shown without a comparison.");
    diff = { before: current?.enhanced ?? "", after: args.new_str ?? "", exact: !!current };
    if (current && (args.new_str ?? "").length < current.enhanced.length * 0.5) warnings.push("The new text is less than half as long as the current page.");
  } else if (args.command === "insert_content") {
    const base = current?.enhanced ?? "";
    const addition = args.content ?? "";
    const after = args.position?.type === "start" ? `${addition}\n${base}` : base ? `${base}\n${addition}` : addition;
    diff = { before: base, after, exact: !!current };
    if (!current) warnings.push("The page could not be read just now, so only the inserted text is shown.");
  }

  const what = args.command === "update_properties" ? "Update properties" : args.command === "insert_content" ? "Add to page" : args.command === "replace_content" ? "Replace page content" : "Edit page";
  return { ok: true, preview: { kind: "update", summary: what, target, diff, properties, warnings } };
}

// content_updates 를 차례로 적용한 글. 각 old_str 은 한 번만 나와야 하고(replace_all_matches 가 아니면), 못 찾으면 이유를 돌려준다.
export function applyUpdates(text: string, updates: ContentUpdate[]): { ok: true; text: string } | { ok: false; reason: string } {
  let result = text;
  for (const [index, update] of updates.entries()) {
    const count = result.split(update.old_str).length - 1;
    const label = updates.length > 1 ? `Change ${index + 1}` : "The change";
    if (count === 0) return { ok: false, reason: `${label}: the text to replace was not found in the page as last read, so Notion may reject it.` };
    if (count > 1 && !update.replace_all_matches) return { ok: false, reason: `${label}: the text to replace appears ${count} times, so Notion may reject it.` };
    result = update.replace_all_matches ? result.split(update.old_str).join(update.new_str) : result.replace(update.old_str, () => update.new_str);
  }
  return { ok: true, text: result };
}

export function previewCreate(args: NotionCreateArgs, parentTitle: string | null): PreviewResult {
  const creates = args.pages.map((page) => ({ title: show(page.properties?.title) ?? show(page.properties?.Name) ?? "Untitled" }));
  const first = args.pages[0];
  const content = args.pages.length === 1 ? (first.content ?? "") : args.pages.map((p, i) => `# ${creates[i].title}\n${p.content ?? ""}`).join("\n\n");
  const properties: PropertyChange[] = args.pages.length === 1 ? Object.entries(first.properties ?? {}).map(([name, value]) => ({ name, before: null, after: show(value) })) : [];
  const where = args.creation_mode === "draft" ? "A private draft" : args.parent?.type === "page_id" ? (parentTitle ?? "A page") : args.parent ? "A database" : "Notion";
  const noun = args.pages.length === 1 ? "page" : `${args.pages.length} pages`;
  return {
    ok: true,
    preview: {
      kind: "create",
      summary: args.parent?.type === "data_source_id" || args.parent?.type === "database_id" ? `Add ${args.pages.length === 1 ? "a row" : `${args.pages.length} rows`}` : `Create ${noun}`,
      target: { title: where, url: null },
      diff: content ? { before: "", after: content, exact: true } : null,
      properties,
      warnings: [],
      // 페이지 하나는 속성 표와 본문이 이미 제목을 보이므로 여러 개일 때만 목록을 쓴다
      ...(args.pages.length > 1 ? { creates } : {}),
    },
  };
}

// 모델에게 돌려주는 거절 글. 사용자가 이유를 적었으면 그대로 싣는다.
export function rejectionMessage(feedback?: string): string {
  const base = "The user rejected this Notion change, so nothing was sent to Notion. Ask what to change instead of retrying the same edit.";
  const text = feedback?.trim();
  return text ? `${base}\n\nThe user's note:\n${text.slice(0, 2000)}` : base;
}
