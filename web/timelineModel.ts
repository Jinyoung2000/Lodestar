import type { ModelInfo, PermissionMode, TimelineItem } from "../shared/protocol";
import { countLineChanges } from "../shared/lineDiff";
import { aliasModelName, modelNameFromId, versionedDisplayName } from "../shared/modelName";
import { isInternalStep } from "../shared/internalSteps";
import { planText, QUESTION_TOOL, readQuestions } from "../shared/interactive";
import { isPreviewTool } from "../shared/previewCard";
import { isAgentTool, mainFlow, type ToolItem } from "../shared/subagents";
import { isTaskTool } from "../shared/tasks";

export type PermissionItem = Extract<TimelineItem, { kind: "permission" }>;
export type UserItem = Extract<TimelineItem, { kind: "user" }>;
export type AssistantItem = Extract<TimelineItem, { kind: "assistant" }>;
export type ResultItem = Extract<TimelineItem, { kind: "result" }>;

export type StepEntry = { item: TimelineItem; permission: PermissionItem | null };

export type Block =
  | { kind: "item"; item: TimelineItem }
  | { kind: "steps"; key: string; items: StepEntry[]; finished: boolean; durationMs: number | null }
  | { kind: "agents"; key: string; items: StepEntry[] };

export type Turn = { key: string; user: UserItem | null; blocks: Block[] };

const STEP_KINDS = new Set(["tool", "permission", "thinking"]);

export const isUserTurnStart = (item: TimelineItem): item is UserItem => item.kind === "user" && item.source !== "system";

export function turnGrouper(): (all: TimelineItem[]) => Block[] {
  let last: { items: TimelineItem[]; blocks: Block[] }[] = [];
  return (all) => {
    const next = splitAtTurns(all).map((items, i) => {
      const prev = last[i];
      if (prev && prev.items.length === items.length && prev.items.every((item, k) => item === items[k])) return prev;
      return { items, blocks: groupTurns(items) };
    });
    last = next;
    return next.flatMap((turn) => turn.blocks);
  };
}

function splitAtTurns(all: TimelineItem[]): TimelineItem[][] {
  const turns: TimelineItem[][] = [];
  let start = 0;
  for (let i = 1; i < all.length; i++) {
    if (!isUserTurnStart(all[i])) continue;
    turns.push(all.slice(start, i));
    start = i;
  }
  if (all.length) turns.push(all.slice(start));
  return turns;
}

export function groupTurns(all: TimelineItem[]): Block[] {
  const hidden = new Set(all.flatMap((i) => (i.kind === "tool" && isInternalStep(i.name, i.input, i.status) ? [i.id] : [])));
  const items = hidden.size ? mainFlow(all).filter((i) => !(i.kind === "tool" && hidden.has(i.id)) && !(i.kind === "permission" && i.status !== "pending" && i.toolUseId !== undefined && hidden.has(i.toolUseId))) : mainFlow(all);
  const durationOf = new Map<number, number | null>();
  let turnStart = 0;
  let turnDuration: number | null = null;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (isUserTurnStart(item)) {
      durationOf.set(turnStart, turnDuration);
      turnStart = i;
      turnDuration = null;
    }
    if (item.kind === "result") turnDuration = (turnDuration ?? 0) + item.durationMs;
  }
  durationOf.set(turnStart, turnDuration);

  const toolIds = new Set(items.filter((i) => i.kind === "tool").map((i) => i.id));
  const permissionByTool = new Map<string, PermissionItem>();
  for (const item of items) {
    if (item.kind === "permission" && item.toolUseId && toolIds.has(item.toolUseId)) permissionByTool.set(item.toolUseId, item);
  }

  const blocks: Block[] = [];
  let current: StepEntry[] = [];
  let currentTurn = 0;
  let agents: StepEntry[] = [];
  const flushAgents = () => {
    if (!agents.length) return;
    blocks.push({ kind: "agents", key: agents[0].item.id, items: agents });
    agents = [];
  };
  const flush = () => {
    flushAgents();
    if (!current.length) return;
    const finished = !current.some(({ item: i, permission }) => (i.kind === "tool" && i.status === "running" && permission?.status !== "denied") || (i.kind === "permission" && i.status === "pending") || permission?.status === "pending");
    blocks.push({ kind: "steps", key: current[0].item.id, items: current, finished, durationMs: finished ? (durationOf.get(currentTurn) ?? null) : null });
    current = [];
  };
  turnStart = 0;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (isUserTurnStart(item)) {
      flush();
      turnStart = i;
    }
    if (STEP_KINDS.has(item.kind) && !(item.kind === "tool" && isPreviewTool(item.name))) {
      if (item.kind === "permission" && item.toolUseId && permissionByTool.get(item.toolUseId) === item) continue;
      if (item.kind === "tool" && isAgentTool(item.name) && item.task) {
        if (current.length) flush();
        agents.push({ item, permission: permissionByTool.get(item.id) ?? null });
        continue;
      }
      flushAgents();
      if (!current.length) currentTurn = turnStart;
      current.push({ item, permission: item.kind === "tool" ? (permissionByTool.get(item.id) ?? null) : null });
      continue;
    }
    flush();
    blocks.push({ kind: "item", item });
  }
  flush();
  return blocks;
}

export function splitTurns(blocks: Block[]): Turn[] {
  const turns: Turn[] = [];
  for (const block of blocks) {
    if (block.kind === "item" && isUserTurnStart(block.item)) {
      turns.push({ key: block.item.id, user: block.item, blocks: [] });
      continue;
    }
    if (!turns.length) turns.push({ key: "head", user: null, blocks: [] });
    turns[turns.length - 1].blocks.push(block);
  }
  return turns;
}

export function reuseTurns(prev: Turn[], next: Turn[]): Turn[] {
  if (!prev.length) return next;
  const before = new Map(prev.map((turn) => [turn.key, turn]));
  const merged = next.map((turn) => {
    const old = before.get(turn.key);
    return old ? reuseTurn(old, turn) : turn;
  });
  return merged.length === prev.length && merged.every((turn, i) => turn === prev[i]) ? prev : merged;
}

function reuseTurn(old: Turn, next: Turn): Turn {
  const oldBlocks = new Map(old.blocks.map((block) => [blockKey(block), block]));
  const blocks = next.blocks.map((block) => {
    const earlier = oldBlocks.get(blockKey(block));
    return earlier && sameBlock(earlier, block) ? earlier : block;
  });
  return old.user === next.user && blocks.length === old.blocks.length && blocks.every((block, i) => block === old.blocks[i]) ? old : { key: next.key, user: next.user, blocks };
}

const blockKey = (block: Block) => (block.kind === "item" ? block.item.id : `${block.kind}:${block.key}`);

function sameBlock(a: Block, b: Block): boolean {
  if (a.kind === "item") return b.kind === "item" && a.item === b.item;
  if (a.kind === "agents") return b.kind === "agents" && sameEntries(a.items, b.items);
  return b.kind === "steps" && a.finished === b.finished && a.durationMs === b.durationMs && sameEntries(a.items, b.items);
}

function sameEntries(a: StepEntry[], b: StepEntry[]) {
  return a.length === b.length && a.every((entry, i) => entry.item === b[i].item && entry.permission === b[i].permission);
}

export function turnFooter(turn: Turn) {
  let assistant: AssistantItem | null = null;
  let result: ResultItem | null = null;
  const texts: string[] = [];
  for (const block of turn.blocks) {
    if (block.kind !== "item") continue;
    if (block.item.kind === "assistant" && !block.item.streaming) {
      assistant = block.item;
      texts.push(block.item.text);
    }
    if (block.item.kind === "result") result = block.item;
  }
  return { assistant, result, text: texts.join("\n\n") };
}

export const createdNewFile = (name: string, output: string | null) => name === "Write" && !!output && output.startsWith("File created successfully");

export function toolChanges(name: string, input: Record<string, unknown>): { additions: number; deletions: number } | null {
  const str = (value: unknown) => (typeof value === "string" ? value : null);
  if (name === "Edit") {
    const before = str(input.old_string);
    const after = str(input.new_string);
    return before === null || after === null ? null : countLineChanges(before, after);
  }
  if (name === "MultiEdit" && Array.isArray(input.edits)) {
    const total = { additions: 0, deletions: 0 };
    for (const edit of input.edits as Record<string, unknown>[]) {
      const one = toolChanges("Edit", edit);
      if (!one) continue;
      total.additions += one.additions;
      total.deletions += one.deletions;
    }
    return total;
  }
  if (name === "Write") {
    const content = str(input.content);
    return content === null ? null : countLineChanges("", content);
  }
  return null;
}

export function stepsChanges(steps: StepEntry[]) {
  const total = { additions: 0, deletions: 0 };
  for (const { item, permission } of steps) {
    if (item.kind !== "tool" || item.status === "error" || permission?.status === "denied") continue;
    const changes = toolChanges(item.name, item.input);
    if (!changes) continue;
    total.additions += changes.additions;
    total.deletions += changes.deletions;
  }
  return total.additions || total.deletions ? total : null;
}

export function queuedStepIds(steps: StepEntry[]): Set<string> {
  const queued = new Set<string>();
  let waiting = false;
  for (const { item, permission } of steps) {
    const own = item.kind === "permission" ? item : permission;
    if (own?.status === "pending") waiting = true;
    else if (waiting && item.kind === "tool" && item.status === "running" && !own) queued.add(item.id);
  }
  return queued;
}

export function currentStep(steps: StepEntry[]) {
  const queued = queuedStepIds(steps);
  for (let i = steps.length - 1; i >= 0; i--) {
    const { item } = steps[i];
    if (item.kind === "tool" && item.status === "running" && !queued.has(item.id)) return item;
  }
  return null;
}

const CLOCK = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });

export function formatClock(iso: string | undefined) {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : CLOCK.format(date);
}

export function modelLabel(id: string, models: Pick<ModelInfo, "value" | "resolvedModel" | "displayName">[], withId = true) {
  const name = modelName(id, models);
  if (name && name !== id) return withId ? `${name} (${id})` : name;
  return id;
}

export function modelName(id: string, models: Pick<ModelInfo, "value" | "resolvedModel" | "displayName">[]) {
  const base = id.replace(/\[[^\]]*\]$/, "");
  const known = models.find((m) => m.value !== "default" && (m.resolvedModel === base || m.value === base));
  return known ? versionedDisplayName(known.displayName, known.resolvedModel ?? (base.startsWith("claude-") ? base : null)) : (modelNameFromId(base) ?? aliasModelName(base, models.map((m) => m.resolvedModel)));
}

export type InteractiveStep = {
  state: "pending" | "done" | "skipped";
  verb: string;
  detail: string;
  qa: { question: string; answer: string }[];
  plan: string | null;
  note: string | null;
};

type InteractiveLabels = { asked: string; ask: string; skipped: string; planApproved: string; planKept: string; planWaiting: string; feedback: string; after: (mode: PermissionMode) => string };

export function interactiveStep(name: string, input: Record<string, unknown>, permission: PermissionItem | null, toolDone: boolean, labels: InteractiveLabels): InteractiveStep {
  const pending = permission?.status === "pending" || (!permission && !toolDone);
  const outcome = permission?.outcome;
  if (name === QUESTION_TOOL) {
    const questions = readQuestions(input);
    const answers = outcome?.answers ?? {};
    const qa = questions.map((q) => ({ question: q.question, answer: answers[q.question] ?? "" })).filter((row) => row.answer !== "");
    const state = pending ? "pending" : qa.length || !permission ? "done" : "skipped";
    return { state, verb: state === "pending" ? labels.ask : state === "done" ? labels.asked : labels.skipped, detail: state === "done" && questions.length > 1 ? `${questions.length} questions` : (questions[0]?.question ?? ""), qa, plan: null, note: null };
  }
  const plan = planText(input);
  const first = (plan ?? "").split("\n").find((line) => line.trim())?.replace(/^#+\s*/, "") ?? "";
  const decision = outcome?.plan;
  if (pending) return { state: "pending", verb: labels.planWaiting, detail: first, qa: [], plan, note: null };
  if (!decision) return { state: "done", verb: labels.planApproved, detail: first, qa: [], plan, note: null };
  if (decision.decision === "approved") return { state: "done", verb: labels.planApproved, detail: first, qa: [], plan, note: labels.after(decision.mode) };
  return { state: "skipped", verb: labels.planKept, detail: first, qa: [], plan, note: decision.feedback ? `${labels.feedback}: ${decision.feedback}` : null };
}

export function systemMessageView(text: string): { preview: string; body: string } | null {
  const body = text.trim();
  if (!body) return null;
  const summary = /<summary>([\s\S]*?)<\/summary>/.exec(body)?.[1]?.trim();
  const line = summary ?? body.split("\n").map((l) => l.trim()).find((l) => l && !/^<\/?[\w-]+>$/.test(l)) ?? "";
  return { preview: line.slice(0, 120), body };
}

export type StepGroup = { kind: "step"; entry: StepEntry } | { kind: "tasks"; key: string; items: ToolItem[] };

export function foldTaskSteps(steps: StepEntry[]): StepGroup[] {
  const groups: StepGroup[] = [];
  let run: StepEntry[] = [];
  const flush = () => {
    if (run.length > 1) groups.push({ kind: "tasks", key: run[0].item.id, items: run.map((e) => e.item as ToolItem) });
    else groups.push(...run.map((entry) => ({ kind: "step" as const, entry })));
    run = [];
  };
  for (const entry of steps) {
    const { item, permission } = entry;
    if (item.kind === "tool" && isTaskTool(item.name) && !permission && item.status !== "error") {
      run.push(entry);
      continue;
    }
    flush();
    groups.push({ kind: "step", entry });
  }
  flush();
  return groups;
}
