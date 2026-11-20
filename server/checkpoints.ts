import { mkdirSync } from "node:fs";
import { readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { getSessionMessages, query, type RewindFilesResult, type SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Agent, CheckpointMode, TimelineItem } from "../shared/protocol";
import { claudeBin, claudeEnv } from "./claude";
import { HOME } from "./store";
import { spawnInGroup } from "./processGroups";

// B2: 체크포인트 복원(파일 되돌리기와 Redo)과 메시지 단위 갈래가 쓰는 조각들. 순수한 부분(keptEntryBefore, messageText, findMessageId, occurrenceOf, checkpointMode, splitTimeline)은 test/checkpoint.test.ts 가 시험한다.

// 세션 기록 체인(getSessionMessages 순서)에서 사용자 메시지 바로 앞 항목의 uuid.
// 첫 사용자 메시지면 null(남길 앞부분이 없다), 체인에 없으면 undefined.
export function keptEntryBefore(messages: { uuid: string }[], userMessageId: string): string | null | undefined {
  const index = messages.findIndex((m) => m.uuid === userMessageId);
  if (index === -1) return undefined;
  return index === 0 ? null : messages[index - 1].uuid;
}

// 사용자가 직접 보낸 메시지의 글. 도구 결과를 담은 사용자 항목이나 글이 없는 항목은 null.
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

// 항목에 messageId 가 없을 때(체크포인트 이전 메시지, 갈래로 복사된 메시지): 같은 글을 가진 사용자 메시지 중
// 타임라인에서 그 글이 몇 번째로 나왔는지(occurrence)와 같은 순번의 기록 항목을 찾는다.
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

// 타임라인에서 itemId 와 같은 글을 가진 사용자 항목 중 itemId 가 몇 번째인지(0부터). findMessageId 의 occurrence.
export function occurrenceOf(items: TimelineItem[], itemId: string): number {
  const item = items.find((i) => i.id === itemId);
  if (item?.kind !== "user") return -1;
  const text = item.text.trim();
  // 압축 이전 항목은 세션 줄기(sessionChain)에 없으므로 순번에서 뺀다
  return items.filter((i) => i.kind === "user" && i.source !== "system" && !i.preCompact && i.text.trim() === text).findIndex((i) => i.id === itemId);
}

// 사용자 항목 itemId 의 messageId. 항목에 없으면(옛 빌드가 보낸 메시지) 세션 기록에서 글과 순번으로 짝짓는다. chain 을 이미 읽었으면 넘긴다.
export async function resolveMessageId(agent: Agent, items: TimelineItem[], itemId: string, chain?: PairableMessage[]): Promise<string | null> {
  const item = items.find((i) => i.id === itemId);
  if (item?.kind !== "user" || item.source === "system" || item.preCompact) return null;
  if (item.messageId) return item.messageId;
  if (!checkpointSession(agent)) return null;
  return findMessageId(chain ?? (await sessionChain(agent)), item.text, occurrenceOf(items, itemId));
}

type PairableMessage = Pick<SessionMessage, "type" | "uuid" | "message" | "parent_tool_use_id">;

// 짝지은 uuid 와 그 uuid 의 rewindFiles dryRun 결과로 복원 범위를 정한다.
// dryRun 만으로는 "스냅샷이 없는 진짜 메시지"와 "없는 uuid" 가 같은 오류라서, 짝을 찾았는지가 먼저다.
// 스냅샷이 없다는 오류만 대화만 복원으로 보고, 그 밖의 거절 사유는 파일을 건드리지 않고 그대로 알린다.
export function checkpointMode(paired: string | null, preview: Pick<RewindFilesResult, "canRewind" | "error"> | null): { mode: CheckpointMode; reason?: string } {
  if (!paired) return { mode: "none", reason: "unmatched" };
  if (!preview) return { mode: "none", reason: "unprobed" };
  if (preview.canRewind) return { mode: "files" };
  if (/no file checkpoint/i.test(preview.error ?? "")) return { mode: "chat" };
  return { mode: "none", reason: preview.error ?? "unknown" };
}

// 체크포인트를 읽고 되돌릴 세션. 갈래는 첫 턴에서야 자기 세션 id 를 받으므로 그 전에는 원 세션(resumeFrom)을 쓴다.
// 갈래 세션은 원 세션 기록을 그 지점까지 그대로(메시지 uuid 도 같게) 이어받고 파일 스냅샷도 함께 옮겨 가니, 같은 uuid 로 어느 쪽에서든 가리킬 수 있다.
export function checkpointSession(agent: Pick<Agent, "sessionId" | "resumeFrom">): string | null {
  return agent.sessionId ?? agent.resumeFrom ?? null;
}

export function sessionChain(agent: Agent) {
  return getSessionMessages(checkpointSession(agent) as string, { dir: agent.cwd });
}

// 타임라인을 itemId 앞에서 자른다. kept 는 남는 앞부분, removed 는 itemId 부터 끝까지.
export function splitTimeline(items: TimelineItem[], itemId: string) {
  const index = items.findIndex((i) => i.id === itemId);
  if (index === -1) return null;
  return { kept: items.slice(0, index), removed: items.slice(index) };
}

// 턴이 끝난 세션의 파일을 되돌리려면 같은 세션을 resume 한 유휴 쿼리가 필요하다(rewindFiles 는 Query 의 메서드).
// 프롬프트를 주지 않고 열어 두기만 하므로 모델을 부르지 않는다. 쓰고 나면 반드시 닫는다.
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
      // 이 쿼리는 파일만 되돌린다. 설정 훅과 MCP 서버를 띄울 이유가 없다.
      settingSources: [],
    },
  });
  try {
    return await run((messageId, dryRun) => q.rewindFiles(messageId, { dryRun }));
  } finally {
    q.close();
  }
}

// messageId 없는 사용자 항목별 복원 범위. 짝을 찾은 항목만 유휴 쿼리 하나로 dryRun 한다(항목마다 프로세스를 띄우지 않는다).
// 스냅샷 유무는 이미 끝난 기록의 속성이라 바뀌지 않으므로 files, chat 결과는 세션 단위로 기억한다.
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

// --- Redo ---

// 복원 직전의 상태. 파일 내용은 base64(null 은 파일이 없었음). 데몬을 다시 띄워도 Redo 할 수 있게 디스크에 둔다.
export type RedoRecord = {
  items: TimelineItem[];
  files: Record<string, string | null>;
  prevSessionId: string | null;
  prevResumeAt: string | null;
  // 복원 전 대화의 끝 항목 uuid. 이전 resumeAt 이 없을 때 Redo 가 이 위치로 다시 이어 간다.
  tip: string | null;
  // 파일 스냅샷이 없어 대화만 되돌린 복원. Redo 도 대화만 되살린다.
  chatOnly?: boolean;
  // 첫 턴 전의 갈래는 원 세션에서 이어 간다. 첫 메시지로 되돌리면(Start Over) 이 값이 지워지니 Redo 가 되돌릴 수 있게 남긴다.
  prevResumeFrom?: string | null;
  // FIX5-0: 복원 직후 files 의 각 파일 해시(없으면 absent). Redo 는 디스크가 이 해시와 같은 파일만 다시 쓴다(복원 뒤 누가 고친 파일을 덮어쓰지 않는다).
  restoredHash?: Record<string, string>;
};

const REDO_DIR = join(HOME, "redo");
const redoFile = (agentId: string) => join(REDO_DIR, `${agentId}.json`);
const stagedRedoFile = (agentId: string) => `${redoFile(agentId)}.staged`;

// 파일을 되돌리기 전에 Redo 기록을 옆 파일에 먼저 쓴다. 쓰지 못하면(디스크 가득 등) 여기서 던져서 파일을 건드리기 전에 멈춘다.
// 되돌린 뒤에 commitRedo 가 이름만 바꿔 자리에 넣는다. 복원 전 내용과 대화가 들어 있어 이 사용자만 읽게 만든다.
export async function stageRedo(agentId: string, record: RedoRecord) {
  mkdirSync(REDO_DIR, { recursive: true });
  await writeFile(stagedRedoFile(agentId), JSON.stringify(record), { mode: 0o600 });
}

export async function commitRedo(agentId: string) {
  await rename(stagedRedoFile(agentId), redoFile(agentId));
}

// 옆 파일에 다 쓴 뒤 바꾸므로 쓰다 끊겨도 앞선 Redo 기록이 반쪽으로 남지 않는다.
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

// 세션 폴더 안의 파일만 다룬다. 심볼릭 링크 때문에 경로 표기가 달라질 수 있어(/tmp 와 /private/tmp) 실제 경로로 비교한다.
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

