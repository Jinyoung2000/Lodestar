import type { TimelineItem } from "@shared/protocol";
import type { TimelinePage } from "@shared/mobile";
import { PLAN_TOOL, QUESTION_TOOL } from "./questions";

export type Tail = { items: TimelineItem[]; hasMore: boolean };

function same(a: TimelineItem, b: TimelineItem): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

export function mergeTail(local: readonly TimelineItem[], localHasMore: boolean, page: TimelinePage): Tail {
  if (page.total === 0) return { items: [], hasMore: false };
  const first = page.items[0];
  const at = first ? local.findIndex((item) => item.id === first.id) : -1;
  const kept = at === -1 ? [] : local.slice(0, at);
  const byId = new Map(local.map((item) => [item.id, item]));
  const tail = page.items.map((item) => {
    const old = byId.get(item.id);
    return old && same(old, item) ? old : item;
  });
  return { items: [...kept, ...tail], hasMore: at <= 0 ? page.hasMore : localHasMore };
}

export function prependOlder(local: readonly TimelineItem[], page: TimelinePage): Tail {
  const have = new Set(local.map((item) => item.id));
  return { items: [...page.items.filter((item) => !have.has(item.id)), ...local], hasMore: page.hasMore };
}

export function upsert(items: readonly TimelineItem[], item: TimelineItem): TimelineItem[] {
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].id !== item.id) continue;
    const next = items.slice();
    next[i] = item;
    return next;
  }
  return [...items, item];
}

export function remove(items: readonly TimelineItem[], itemId: string): TimelineItem[] {
  return items.some((item) => item.id === itemId) ? items.filter((item) => item.id !== itemId) : (items as TimelineItem[]);
}

export type UserItem = Extract<TimelineItem, { kind: "user" }>;
export type AssistantItem = Extract<TimelineItem, { kind: "assistant" }>;
export type ToolItem = Extract<TimelineItem, { kind: "tool" }>;
export type ThinkingItem = Extract<TimelineItem, { kind: "thinking" }>;
export type PermissionItem = Extract<TimelineItem, { kind: "permission" }>;
export type NoticeItem = Extract<TimelineItem, { kind: "notice" }>;
export type ErrorItem = Extract<TimelineItem, { kind: "error" }>;
export type Step = ToolItem | ThinkingItem | PermissionItem;

export type Row =
  | { type: "user"; key: string; item: UserItem }
  | { type: "assistant"; key: string; item: AssistantItem }
  | { type: "steps"; key: string; steps: Step[]; decisions: PermissionItem[]; running: boolean; failed: boolean }
  | { type: "approval"; key: string; item: PermissionItem; tool: ToolItem | null; reviewOnDesktop: boolean }
  | { type: "question"; key: string; item: PermissionItem }
  | { type: "plan"; key: string; item: PermissionItem }
  | { type: "answered"; key: string; item: PermissionItem }
  | { type: "notice"; key: string; text: string; detail?: string }
  | { type: "error"; key: string; item: ErrorItem };

const NOTION_PROPOSE = /^mcp__lodestar_notion__notion_(update_page|create_pages)$/;

export function buildRows(items: readonly TimelineItem[]): Row[] {
  const decisions = new Map<string, PermissionItem>();
  const pendingTool = new Map<string, PermissionItem>();
  for (const item of items) {
    if (item.kind !== "permission" || !item.toolUseId) continue;
    if (item.status === "pending") pendingTool.set(item.toolUseId, item);
    else decisions.set(item.toolUseId, item);
  }
  const toolById = new Map<string, ToolItem>();
  for (const item of items) if (item.kind === "tool") toolById.set(item.id, item);

  const rows: Row[] = [];
  let steps: Step[] = [];
  const flush = () => {
    if (steps.length === 0) return;
    const last = steps[steps.length - 1];
    const toolDecisions = steps.flatMap((step) => {
      const decision = step.kind === "tool" ? decisions.get(step.id) : undefined;
      return decision ? [decision] : [];
    });
    rows.push({ type: "steps", key: `steps:${steps[0].id}`, steps, decisions: toolDecisions, running: steps.some((s) => s.kind === "tool" && s.status === "running"), failed: last.kind === "tool" && last.status === "error" });
    steps = [];
  };

  for (const item of items) {
    switch (item.kind) {
      case "tool":
        if (item.name === QUESTION_TOOL || item.name === PLAN_TOOL) break;
        if (item.parentToolUseId) break;
        if (pendingTool.has(item.id)) break;
        steps.push(item);
        break;
      case "thinking":
        if (item.text.trim()) steps.push(item);
        break;
      case "permission": {
        if (item.status === "pending") {
          flush();
          if (item.toolName === QUESTION_TOOL) rows.push({ type: "question", key: item.id, item });
          else if (item.toolName === PLAN_TOOL) rows.push({ type: "plan", key: item.id, item });
          else rows.push({ type: "approval", key: item.id, item, tool: item.toolUseId ? (toolById.get(item.toolUseId) ?? null) : null, reviewOnDesktop: NOTION_PROPOSE.test(item.toolName) });
        } else if (item.toolName === QUESTION_TOOL && Object.keys(item.outcome?.answers ?? {}).length > 0) {
          flush();
          rows.push({ type: "answered", key: item.id, item });
        } else {
          const tool = item.toolUseId ? toolById.get(item.toolUseId) : undefined;
          if (!tool || tool.parentToolUseId || tool.name === PLAN_TOOL || tool.name === QUESTION_TOOL) steps.push(item);
        }
        break;
      }
      case "user":
        flush();
        if (item.source === "system") rows.push({ type: "notice", key: item.id, text: (item.shown ?? item.text).slice(0, 200) });
        else rows.push({ type: "user", key: item.id, item });
        break;
      case "assistant":
        if (!item.text.trim() && !item.streaming) break;
        flush();
        rows.push({ type: "assistant", key: item.id, item });
        break;
      case "notice":
        flush();
        rows.push({ type: "notice", key: item.id, text: item.text, detail: item.detail });
        break;
      case "error":
        flush();
        rows.push({ type: "error", key: item.id, item });
        break;
      case "result":
      case "restored":
        break;
    }
  }
  flush();
  return rows;
}

export function lastIsStreaming(items: readonly TimelineItem[]): boolean {
  const last = items[items.length - 1];
  return last?.kind === "assistant" && last.streaming;
}

export function sameRow(a: Row, b: Row): boolean {
  if (a.type !== b.type || a.key !== b.key) return false;
  switch (a.type) {
    case "steps": {
      const other = b as typeof a;
      return a.running === other.running && a.failed === other.failed && a.steps.length === other.steps.length && a.steps.every((step, i) => step === other.steps[i]) && a.decisions.length === other.decisions.length && a.decisions.every((decision, i) => decision === other.decisions[i]);
    }
    case "approval": {
      const other = b as typeof a;
      return a.item === other.item && a.tool === other.tool && a.reviewOnDesktop === other.reviewOnDesktop;
    }
    case "notice": {
      const other = b as typeof a;
      return a.text === other.text && a.detail === other.detail;
    }
    default:
      return a.item === (b as typeof a).item;
  }
}

export function stabilizeRows(previous: readonly Row[], next: Row[]): Row[] {
  if (previous.length === 0) return next;
  const byKey = new Map(previous.map((row) => [row.key, row]));
  return next.map((row) => {
    const old = byKey.get(row.key);
    return old && sameRow(old, row) ? old : row;
  });
}
