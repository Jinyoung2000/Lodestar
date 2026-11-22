import { mkdirSync } from "node:fs";
import { readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { getSessionMessages, query, type RewindFilesResult, type SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Agent, CheckpointMode, TimelineItem } from "../shared/protocol";
import { claudeBin, claudeEnv } from "./claude";
import { HOME } from "./store";
import { spawnInGroup } from "./processGroups";

export function keptEntryBefore(messages: { uuid: string }[], userMessageId: string): string | null | undefined {
  const index = messages.findIndex((m) => m.uuid === userMessageId);
  if (index === -1) return undefined;
  return index === 0 ? null : messages[index - 1].uuid;
}

export function messageText(message: Pick<SessionMessage, "type" | "message" | "parent_tool_use_id">): string | null {
  if (message.type !== "user" || message.parent_tool_use_id) return null;
  const content = (message.message as { content?: unknown } | null)?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  if (content.some((b) => b && typeof b === "object" && (b as { type?: string }).type === "tool_result")) return null;
  const text = content
    .filter((b): b is { type: "text"; text: string } => !!b && typeof b === "object" && (b as { type?: string }).type === "text")
    .map((b) => b.text)
    .join("\n");
  return text || null;
}

export function findMessageId(messages: PairableMessage[], text: string, occurrence: number): string | null {
  const wanted = text.trim();
  let seen = 0;
  for (const m of messages) {
    const own = messageText(m);
    if (own === null || own.trim() !== wanted) continue;
    if (seen === occurrence) return m.uuid;
    seen++;
  }
  return null;
}

export function occurrenceOf(items: TimelineItem[], itemId: string): number {
  const item = items.find((i) => i.id === itemId);
  if (item?.kind !== "user") return -1;
  const text = item.text.trim();
  return items.filter((i) => i.kind === "user" && i.source !== "system" && !i.preCompact && i.text.trim() === text).findIndex((i) => i.id === itemId);
}

export async function resolveMessageId(agent: Agent, items: TimelineItem[], itemId: string, chain?: PairableMessage[]): Promise<string | null> {
  const item = items.find((i) => i.id === itemId);
  if (item?.kind !== "user" || item.source === "system" || item.preCompact) return null;
  if (item.messageId) return item.messageId;
  if (!checkpointSession(agent)) return null;
  return findMessageId(chain ?? (await sessionChain(agent)), item.text, occurrenceOf(items, itemId));
}

type PairableMessage = Pick<SessionMessage, "type" | "uuid" | "message" | "parent_tool_use_id">;

export function checkpointMode(paired: string | null, preview: Pick<RewindFilesResult, "canRewind" | "error"> | null): { mode: CheckpointMode; reason?: string } {
  if (!paired) return { mode: "none", reason: "unmatched" };
  if (!preview) return { mode: "none", reason: "unprobed" };
  if (preview.canRewind) return { mode: "files" };
  if (/no file checkpoint/i.test(preview.error ?? "")) return { mode: "chat" };
  return { mode: "none", reason: preview.error ?? "unknown" };
}

export function checkpointSession(agent: Pick<Agent, "sessionId" | "resumeFrom">): string | null {
  return agent.sessionId ?? agent.resumeFrom ?? null;
}

export function sessionChain(agent: Agent) {
  return getSessionMessages(checkpointSession(agent) as string, { dir: agent.cwd });
}

export function splitTimeline(items: TimelineItem[], itemId: string) {
  const index = items.findIndex((i) => i.id === itemId);
  if (index === -1) return null;
  return { kept: items.slice(0, index), removed: items.slice(index) };
}

export async function withRewindQuery<T>(agent: Agent, run: (rewind: (messageId: string, dryRun: boolean) => Promise<RewindFilesResult>) => Promise<T>): Promise<T> {
  async function* idle(): AsyncGenerator<never> {
    await new Promise(() => {});
  }
  const q = query({
    prompt: idle(),
    options: {
      cwd: agent.cwd,
      env: claudeEnv(),
      resume: checkpointSession(agent) as string,
      enableFileCheckpointing: true,
      pathToClaudeCodeExecutable: claudeBin(),
      spawnClaudeCodeProcess: spawnInGroup,
      settingSources: [],
    },
  });
  try {
    return await run((messageId, dryRun) => q.rewindFiles(messageId, { dryRun }));
  } finally {
    q.close();
  }
}

const modeCache = new Map<string, CheckpointMode>();

export async function probeCheckpointModes(agent: Agent, items: TimelineItem[]): Promise<Record<string, CheckpointMode>> {
  const legacy = items.filter((i) => i.kind === "user" && i.source !== "system" && !i.messageId && !i.preCompact);
  const modes: Record<string, CheckpointMode> = {};
  if (!legacy.length) return modes;
  const chain = checkpointSession(agent) ? await sessionChain(agent) : [];
  const pending: { itemId: string; messageId: string }[] = [];
  for (const item of legacy) {
    const messageId = await resolveMessageId(agent, items, item.id, chain);
    const cached = messageId ? modeCache.get(`${checkpointSession(agent)}:${messageId}`) : undefined;
    if (cached) modes[item.id] = cached;
    else if (messageId) pending.push({ itemId: item.id, messageId });
    else modes[item.id] = "none";
  }
  if (!pending.length) return modes;
  await withRewindQuery(agent, async (rewind) => {
    for (const { itemId, messageId } of pending) {
      const plan = checkpointMode(messageId, await rewind(messageId, true));
      modes[itemId] = plan.mode;
      if (plan.mode !== "none") modeCache.set(`${checkpointSession(agent)}:${messageId}`, plan.mode);
    }
  });
  return modes;
}

export type RedoRecord = {
  items: TimelineItem[];
  files: Record<string, string | null>;
  prevSessionId: string | null;
  prevResumeAt: string | null;
  tip: string | null;
  chatOnly?: boolean;
  prevResumeFrom?: string | null;
  restoredHash?: Record<string, string>;
};

const REDO_DIR = join(HOME, "redo");
const redoFile = (agentId: string) => join(REDO_DIR, `${agentId}.json`);
const stagedRedoFile = (agentId: string) => `${redoFile(agentId)}.staged`;

export async function stageRedo(agentId: string, record: RedoRecord) {
  mkdirSync(REDO_DIR, { recursive: true });
  await writeFile(stagedRedoFile(agentId), JSON.stringify(record), { mode: 0o600 });
}

export async function commitRedo(agentId: string) {
  await rename(stagedRedoFile(agentId), redoFile(agentId));
}

export async function saveRedo(agentId: string, record: RedoRecord) {
  await stageRedo(agentId, record);
  await commitRedo(agentId);
}

export async function loadRedo(agentId: string): Promise<RedoRecord | null> {
  try {
    return JSON.parse(await readFile(redoFile(agentId), "utf8")) as RedoRecord;
  } catch {
    return null;
  }
}

export async function dropRedo(agentId: string) {
  await rm(redoFile(agentId), { force: true });
  await rm(stagedRedoFile(agentId), { force: true });
}

export async function insideCwd(agent: Agent, path: string) {
  const root = await realpath(agent.cwd).catch(() => agent.cwd);
  const absolute = isAbsolute(path) ? path : resolve(agent.cwd, path);
  const parent = await realpath(dirname(absolute)).catch(() => dirname(absolute));
  const rel = relative(root, join(parent, basename(absolute)));
  return !rel.startsWith("..") && !isAbsolute(rel);
}

export async function readRaw(agent: Agent, paths: string[]) {
  const files: Record<string, string | null> = {};
  for (const path of paths) {
    if (!(await insideCwd(agent, path))) continue;
    try {
      files[path] = (await readFile(path)).toString("base64");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      files[path] = null;
    }
  }
  return files;
}

