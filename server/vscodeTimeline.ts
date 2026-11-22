import { createReadStream, existsSync, readdirSync, realpathSync } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import type { TimelineItem } from "../shared/protocol";
import { toolResultText } from "./agents";
import { messageText } from "./checkpoints";
import { T } from "./strings";

export type RawNote = {
  type: string;
  subtype?: string;
  timestamp?: string;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  originKind?: string;
  promptSource?: string;
  turnOrigin?: string;
  isApiError?: boolean;
};

export type RawIndex = {
  notes: Map<string, RawNote>;
  firstTimestamp: string | null;
  lastTimestamp: string | null;
  aiTitle: string | null;
  cwd: string | null;
  permissionMode: string | null;
  effort: string | null;
  entries: Map<string, RawEntry>;
  entryOrder: string[];
};

export type RawEntry = { type: string; uuid: string; parentUuid: string | null; logicalParentUuid: string | null; isSidechain: boolean; message: unknown; timestamp?: string };

export type ChainMessage = {
  type: "user" | "assistant" | "system";
  uuid: string;
  message?: unknown;
  parent_tool_use_id?: string | null;
  timestamp?: string;
};

export type BuiltItem = { item: TimelineItem; ts: string | null };

export function claudeProjectsDir(env: NodeJS.ProcessEnv = process.env) {
  return join(env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");
}

export const projectDirName = (cwd: string) => cwd.replace(/[^A-Za-z0-9]/g, "-");

export function findTranscript(claudeSessionId: string, cwd: string | null, projects = claudeProjectsDir()): string | null {
  const name = `${claudeSessionId}.jsonl`;
  if (cwd) {
    for (const base of new Set([cwd, realOrSame(cwd)])) {
      const file = join(projects, projectDirName(base), name);
      if (existsSync(file)) return file;
    }
  }
  if (!existsSync(projects)) return null;
  for (const dir of readdirSync(projects)) {
    const file = join(projects, dir, name);
    if (existsSync(file)) return file;
  }
  return null;
}

const realOrSame = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

export async function readRawIndex(file: string, options: { keepEntries?: boolean } = {}): Promise<RawIndex> {
  const index: RawIndex = { notes: new Map(), firstTimestamp: null, lastTimestamp: null, aiTitle: null, cwd: null, permissionMode: null, effort: null, entries: new Map(), entryOrder: [] };
  const lines = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line) continue;
    let entry: Record<string, any>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type === "ai-title" && typeof entry.aiTitle === "string" && entry.aiTitle.trim()) index.aiTitle = entry.aiTitle.trim();
    if (typeof entry.uuid !== "string") continue;
    const timestamp = typeof entry.timestamp === "string" ? entry.timestamp : undefined;
    index.notes.set(entry.uuid, {
      type: String(entry.type),
      subtype: typeof entry.subtype === "string" ? entry.subtype : undefined,
      timestamp,
      isMeta: entry.isMeta === true || undefined,
      isCompactSummary: entry.isCompactSummary === true || undefined,
      originKind: typeof entry.origin?.kind === "string" ? entry.origin.kind : undefined,
      promptSource: typeof entry.promptSource === "string" ? entry.promptSource : undefined,
      turnOrigin: typeof entry.turnOrigin === "string" ? entry.turnOrigin : undefined,
      isApiError: entry.isApiErrorMessage === true || undefined,
    });
    if (options.keepEntries && !index.entries.has(entry.uuid) && (entry.type === "user" || entry.type === "assistant" || entry.type === "system" || entry.type === "attachment")) {
      index.entries.set(entry.uuid, { type: entry.type, uuid: entry.uuid, parentUuid: typeof entry.parentUuid === "string" ? entry.parentUuid : null, logicalParentUuid: typeof entry.logicalParentUuid === "string" ? entry.logicalParentUuid : null, isSidechain: entry.isSidechain === true, message: entry.message, timestamp });
      index.entryOrder.push(entry.uuid);
    }
    if (timestamp) {
      index.firstTimestamp ??= timestamp;
      if (!index.lastTimestamp || timestamp > index.lastTimestamp) index.lastTimestamp = timestamp;
    }
    if (!index.cwd && typeof entry.cwd === "string") index.cwd = entry.cwd;
    if (entry.type === "user" && typeof entry.permissionMode === "string") index.permissionMode = entry.permissionMode;
    if (entry.type === "assistant" && typeof entry.effort === "string") index.effort = entry.effort;
  }
  return index;
}

export async function loadChain(claudeSessionId: string, cwd: string | null): Promise<ChainMessage[]> {
  const options = { includeSystemMessages: true };
  const found = cwd ? await getSessionMessages(claudeSessionId, { ...options, dir: cwd }) : [];
  const chain = found.length ? found : await getSessionMessages(claudeSessionId, options);
  return chain as unknown as ChainMessage[];
}

const HIDDEN_COMMAND_TEXT = /^<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat)>/;
const SYSTEM_TEXT = /^<(task-notification|local-command|command-name|command-message|system-reminder)/;
const SYSTEM_TURN_ORIGINS = new Set(["task_notification", "scheduled", "peer"]);

export function userSource(note: RawNote | undefined, text: string): "user" | "system" {
  if (note?.isMeta) return "system";
  if (note?.originKind && note.originKind !== "human") return "system";
  if (note?.promptSource === "system") return "system";
  if (note?.turnOrigin && SYSTEM_TURN_ORIGINS.has(note.turnOrigin)) return "system";
  if (SYSTEM_TEXT.test(text.trimStart())) return "system";
  return "user";
}

type Block = { type?: string; text?: string; thinking?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown; is_error?: boolean };

const INTERRUPTED = /^\[Request interrupted/;

type Turn = { userId: string; startMs: number | null; lastMs: number | null; lastTs: string | null; replied: boolean };

export function buildItems(chain: ChainMessage[], notes: Map<string, RawNote>, opts: { finishLastTurn: boolean }): { built: BuiltItem[]; lastTimestamp: string | null; model: string | null } {
  const built: BuiltItem[] = [];
  const toolAt = new Map<string, number>();
  const open: { turn: Turn | null } = { turn: null };
  let lastTimestamp: string | null = null;
  let model: string | null = null;

  const closeTurn = () => {
    const turn = open.turn;
    if (turn?.replied && turn.startMs !== null && turn.lastMs !== null) {
      built.push({ item: { id: `result:${turn.userId}`, kind: "result", isError: false, durationMs: Math.max(0, turn.lastMs - turn.startMs), costUsd: null }, ts: turn.lastTs });
    }
    open.turn = null;
  };
  const touch = (ts: string | null) => {
    const turn = open.turn;
    if (!turn || !ts) return;
    const ms = Date.parse(ts);
    if (Number.isNaN(ms)) return;
    turn.lastMs = ms;
    turn.lastTs = ts;
  };

  for (const m of chain) {
    const note = notes.get(m.uuid);
    const ts = m.timestamp ?? note?.timestamp ?? null;
    if (ts && (!lastTimestamp || ts > lastTimestamp)) lastTimestamp = ts;
    if (m.parent_tool_use_id) continue;

    if (m.type === "system") {
      if (note?.subtype === "compact_boundary") built.push({ item: { id: m.uuid, kind: "notice", text: T.compactedDivider, divider: true }, ts });
      continue;
    }

    const content = (m.message as { content?: unknown } | null | undefined)?.content;
    if (m.type === "assistant") {
      if (!Array.isArray(content)) continue;
      const modelId = (m.message as { model?: unknown }).model;
      if (typeof modelId === "string" && modelId && modelId !== "<synthetic>") model = modelId;
      if (open.turn) open.turn.replied = true;
      touch(ts);
      for (const [index, block] of (content as Block[]).entries()) {
        const id = `${m.uuid}:${index}`;
        if (block.type === "text" && typeof block.text === "string") {
          if (note?.isApiError) built.push({ item: { id, kind: "error", text: block.text, auth: false }, ts });
          else built.push({ item: { id, kind: "assistant", text: block.text, streaming: false, ...(ts ? { at: ts } : {}), ...(typeof modelId === "string" && modelId !== "<synthetic>" ? { model: modelId } : {}) }, ts });
        } else if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim()) {
          built.push({ item: { id, kind: "thinking", text: block.thinking }, ts });
        } else if (block.type === "tool_use" && typeof block.id === "string") {
          toolAt.set(block.id, built.length);
          built.push({ item: { id: block.id, kind: "tool", name: String(block.name ?? ""), input: (block.input ?? {}) as Record<string, unknown>, status: "running", output: null }, ts });
        }
      }
      continue;
    }

    if (typeof content === "string") {
      pushUser(m.uuid, content, ts, note);
      continue;
    }
    if (!Array.isArray(content)) continue;
    const blocks = content as Block[];
    if (!blocks.some((b) => b.type === "tool_result")) {
      const text = messageText(m as Parameters<typeof messageText>[0]);
      if (text !== null && text.trim()) pushUser(m.uuid, text, ts, note);
      continue;
    }
    touch(ts);
    for (const block of blocks) {
      if (block.type === "text" && block.text?.trim()) {
        built.push({ item: { id: `${m.uuid}:text`, kind: "user", text: block.text, source: "system" }, ts });
        continue;
      }
      if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
      const at = toolAt.get(block.tool_use_id);
      const tool = at === undefined ? undefined : built[at]?.item;
      if (tool?.kind !== "tool") continue;
      const output = toolResultText(block.content);
      built[at as number] = { item: { ...tool, status: block.is_error ? "error" : "done", output, ...(block.is_error && INTERRUPTED.test(output) ? { cancelled: true } : {}) }, ts: built[at as number].ts };
    }
  }

  function pushUser(id: string, text: string, ts: string | null, note: RawNote | undefined) {
    if (!text.trim() || note?.isCompactSummary || HIDDEN_COMMAND_TEXT.test(text.trimStart())) return;
    const source = userSource(note, text);
    if (source === "user") {
      closeTurn();
      const startMs = ts ? Date.parse(ts) : Number.NaN;
      open.turn = { userId: id, startMs: Number.isNaN(startMs) ? null : startMs, lastMs: null, lastTs: null, replied: false };
    } else touch(ts);
    built.push({ item: { id, kind: "user", text, source, ...(ts ? { at: ts } : {}) }, ts });
  }

  for (const entry of built) {
    if (entry.item.kind === "tool" && entry.item.status === "running") entry.item = { ...entry.item, status: "error", cancelled: true };
  }
  if (opts.finishLastTurn) closeTurn();
  return { built, lastTimestamp, model };
}

export function splitAtCompaction(chain: ChainMessage[], notes: Map<string, RawNote>, entries: Map<string, RawEntry>, order: string[]): { before: ChainMessage[]; after: ChainMessage[] } {
  const boundary = chain.find((m) => m.type === "system" && notes.get(m.uuid)?.subtype === "compact_boundary");
  if (!boundary) return { before: [], after: chain };
  const logical = entries.get(boundary.uuid)?.logicalParentUuid;
  const at = order.indexOf(boundary.uuid);
  const start = logical && entries.has(logical) ? logical : at > 0 ? order[at - 1] : null;
  if (!start) return { before: [], after: chain };
  const seen = new Set<string>();
  const collected: RawEntry[] = [];
  for (let cur: string | null = start; cur && !seen.has(cur); ) {
    seen.add(cur);
    const entry = entries.get(cur);
    if (!entry) break;
    collected.push(entry);
    cur = entry.parentUuid ?? entry.logicalParentUuid;
  }
  const before: ChainMessage[] = collected
    .reverse()
    .filter((e) => !e.isSidechain && (e.type === "user" || e.type === "assistant" || e.type === "system"))
    .map((e) => ({ type: e.type as ChainMessage["type"], uuid: e.uuid, message: e.message, parent_tool_use_id: null, timestamp: e.timestamp }));
  const preUuids = new Set(before.map((m) => m.uuid));
  return { before, after: chain.filter((m) => m === boundary || !preUuids.has(m.uuid)) };
}

export const markPreCompact = (built: BuiltItem[]): BuiltItem[] => built.map((b) => (b.item.kind === "user" ? { ...b, item: { ...b.item, preCompact: true } } : b));

export function mergeBuilt(existing: TimelineItem[], built: BuiltItem[], syncedUntil: string | null): { add: TimelineItem[]; update: TimelineItem[] } {
  const byId = new Map(existing.map((i) => [i.id, i]));
  const messageIds = new Set(existing.flatMap((i) => (i.kind === "user" && i.messageId ? [i.messageId] : [])));
  const add: TimelineItem[] = [];
  const update: TimelineItem[] = [];
  for (const { item, ts } of built) {
    const current = byId.get(item.id);
    if (current) {
      if (current.kind === "tool" && item.kind === "tool" && current.status !== "done" && item.status === "done") update.push({ ...current, status: item.status, output: item.output, cancelled: undefined });
      continue;
    }
    if (item.kind === "user" && messageIds.has(item.id)) continue;
    if (item.kind === "result") {
      const userId = item.id.slice("result:".length);
      if (byId.has(userId) || messageIds.has(userId)) continue;
    }
    if (syncedUntil && ts && ts <= syncedUntil) continue;
    add.push(item);
  }
  return { add, update };
}

const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 512 * 1024;

export type TranscriptPeek = { mtimeMs: number; cwd: string | null; firstTimestamp: string | null; lastTimestamp: string | null; aiTitle: string | null; firstPrompt: string | null };

export async function peekTranscript(file: string): Promise<TranscriptPeek | null> {
  let handle;
  try {
    handle = await open(file, "r");
    const { size, mtimeMs } = await handle.stat();
    const head = await readRange(handle, 0, Math.min(size, HEAD_BYTES));
    const tailStart = Math.max(0, size - TAIL_BYTES);
    const tail = size <= HEAD_BYTES ? head : await readRange(handle, tailStart, size - tailStart);
    const peek: TranscriptPeek = { mtimeMs, cwd: null, firstTimestamp: null, lastTimestamp: null, aiTitle: null, firstPrompt: null };
    for (const entry of parseLines(head, false)) {
      if (!peek.cwd && typeof entry.cwd === "string") peek.cwd = entry.cwd;
      if (!peek.firstTimestamp && typeof entry.timestamp === "string") peek.firstTimestamp = entry.timestamp;
      if (!peek.firstPrompt && entry.type === "user" && !entry.isMeta && !entry.parent_tool_use_id) {
        const text = messageText({ type: "user", message: entry.message, parent_tool_use_id: null });
        if (text && userSource(undefined, text) === "user") peek.firstPrompt = text.replace(/\s+/g, " ").trim().slice(0, 200) || null;
      }
    }
    for (const entry of parseLines(tail, tailStart > 0)) {
      if (entry.type === "ai-title" && typeof entry.aiTitle === "string" && entry.aiTitle.trim()) peek.aiTitle = entry.aiTitle.trim();
      if (typeof entry.timestamp === "string") peek.lastTimestamp = entry.timestamp;
    }
    return peek;
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

async function readRange(handle: Awaited<ReturnType<typeof open>>, start: number, length: number) {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, start);
  return buffer.subarray(0, bytesRead).toString("utf8");
}

function parseLines(text: string, skipFirst: boolean): Record<string, any>[] {
  const lines = text.split("\n");
  if (skipFirst) lines.shift();
  const out: Record<string, any>[] = [];
  for (const line of lines) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
    }
  }
  return out;
}
