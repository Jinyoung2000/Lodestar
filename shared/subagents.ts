import type { TimelineItem } from "./protocol";
import { sharedPrefix } from "./sharedPrefix";

export type ToolItem = Extract<TimelineItem, { kind: "tool" }>;

export const ASYNC_LAUNCH_PATTERN = /^Async agent launched/i;

export const isAgentTool = (name: string) => name === "Agent" || name === "Task";

export function runningBackground(items: readonly TimelineItem[] | undefined): ToolItem[] {
  return (items ?? []).filter(isRunningBackground);
}

export function runningBackgroundFrom(items: readonly TimelineItem[] | undefined, prev: { input: readonly TimelineItem[] | undefined; output: ToolItem[] } | null): ToolItem[] {
  if (!items || !prev?.input) return runningBackground(items);
  const before = prev.input;
  const from = sharedPrefix(before, items);
  const kept = prev.output.filter((hit) => {
    const at = before.lastIndexOf(hit);
    return at !== -1 && at < from;
  });
  for (let i = from; i < items.length; i++) if (isRunningBackground(items[i])) kept.push(items[i] as ToolItem);
  return kept;
}

const isRunningBackground = (i: TimelineItem): i is ToolItem => i.kind === "tool" && i.task?.status === "running" && !!i.task.backgrounded && !i.parentToolUseId;

const NO_STEPS: ToolItem[] = [];
const stepIndexes = new WeakMap<readonly TimelineItem[], Map<string, ToolItem[]>>();

export function subagentSteps(items: readonly TimelineItem[] | undefined, parentId: string): ToolItem[] {
  if (!items) return NO_STEPS;
  let index = stepIndexes.get(items);
  if (!index) {
    index = new Map();
    for (const item of items) {
      if (item.kind !== "tool" || !item.parentToolUseId) continue;
      const list = index.get(item.parentToolUseId);
      if (list) list.push(item);
      else index.set(item.parentToolUseId, [item]);
    }
    stepIndexes.set(items, index);
  }
  return index.get(parentId) ?? NO_STEPS;
}

export function subagentChildIds(items: readonly TimelineItem[]): Set<string> {
  const ids = new Set<string>();
  for (const item of items) if (item.kind === "tool" && item.parentToolUseId) ids.add(item.id);
  return ids;
}

export function mainFlow(items: readonly TimelineItem[]): TimelineItem[] {
  const children = subagentChildIds(items);
  if (!children.size) return items as TimelineItem[];
  return items.filter((i) => !(i.kind === "tool" && i.parentToolUseId) && !(i.kind === "permission" && i.toolUseId && children.has(i.toolUseId)));
}

export type SubagentUsage = { tokens: number | null; toolUses: number | null; durationMs: number | null };

const FRAME_START = /^\s*\[Subagent hand-back\]/;
const FRAME_END = /The report follows:[ \t]*\r?\n?/;
const USAGE_TAG = /<usage>([\s\S]*?)<\/usage>/;
const AGENT_ID_LINE = /^[ \t]*agentId:[^\n]*(?:\n|$)/gm;

export function cleanSubagentOutput(text: string): { text: string; usage: SubagentUsage | null } {
  let body = text;
  if (FRAME_START.test(body)) {
    const end = FRAME_END.exec(body);
    body = end ? body.slice(end.index + end[0].length) : body.replace(/^[^\n]*\n?/, "");
  }
  let usage: SubagentUsage | null = null;
  const tag = USAGE_TAG.exec(body);
  if (tag) {
    const num = (key: string) => {
      const found = new RegExp(`${key}:\\s*(\\d+)`).exec(tag[1]);
      return found ? Number(found[1]) : null;
    };
    usage = { tokens: num("subagent_tokens"), toolUses: num("tool_uses"), durationMs: num("duration_ms") };
    body = body.replace(USAGE_TAG, "");
  }
  body = body.replace(AGENT_ID_LINE, "");
  const lines = body.split("\n");
  const filled = lines.filter((line) => line.trim());
  if (filled.length && filled.every((line) => line.startsWith("  "))) body = lines.map((line) => (line.startsWith("  ") ? line.slice(2) : line)).join("\n");
  return { text: body.trim(), usage };
}
