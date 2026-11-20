import { randomUUID } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { EFFORT_LEVELS, PERMISSION_MODE_VALUES, type Agent, type EffortLevel, type PermissionMode, type ServerEvent, type TimelineItem, type VscodeCandidate, type VscodeImportList, type VscodeImportResult, type Workspace } from "../shared/protocol";
import { titleFrom, type AgentRunner } from "./agents";
import { defaultsReader } from "./defaults";
import * as gitOps from "./git";
import { T } from "./strings";
import type { Store } from "./store";
import { modelNameOf, readVscodeState, stateFileOf, vscodeUserDir, type PeerMeta, type SessionMeta, type VscodeState } from "./vscodeState";
import { buildItems, findTranscript, loadChain, markPreCompact, mergeBuilt, peekTranscript, projectDirName, readRawIndex, splitAtCompaction, type TranscriptPeek } from "./vscodeTimeline";


export type ImportDeps = {
  store: Store;
  runner: AgentRunner;
  emit: (event: ServerEvent) => void;
  // 시험에서만 바꾼다
  userDir?: string;
  projects?: string;
  now?: () => number;
};

const ACTIVE_WINDOW_MS = 15_000;
const OWN_WRITE_GRACE_MS = 20_000;
// 모델 이름으로 받는 글자(설정 화면과 같다)
const MODEL_NAME = /^[\w.[\]:/-]+$/;

// --- 후보 목록 ---

export async function listVscodeSessions(deps: ImportDeps): Promise<VscodeImportList> {
  const userDir = deps.userDir ?? vscodeUserDir();
  const stateFile = stateFileOf(userDir);
  const empty = { cached: 0, cachedExternal: 0, sessionDb: 0, importable: 0, alreadyImported: 0 };
  let state: VscodeState;
  try {
    state = await readVscodeState(userDir);
  } catch (error) {
    return { available: false, reason: error instanceof Error ? error.message : String(error), stateFile, candidates: [], stats: empty };
  }
  const probed = await Promise.all(collectDrafts(state).map((draft) => probe(deps, draft)));
  const candidates = orderCandidates(probed.map((p) => candidateOf(deps, p)));
  const claudeCached = state.cached.filter((c) => c.provider === "claude");
  return {
    available: true,
    reason: null,
    stateFile,
    candidates,
    stats: {
      cached: claudeCached.length,
      cachedExternal: claudeCached.filter((c) => c.external).length,
      sessionDb: state.sessions.length,
      importable: candidates.filter((c) => !c.problem && !c.importedAgentId).length,
      alreadyImported: candidates.filter((c) => c.importedAgentId).length,
    },
  };
}

// --- 가져오기 ---

let importQueue: Promise<unknown> = Promise.resolve();

// 가져오기는 한 번에 하나씩 한다. 같은 Claude 세션을 두 호출이 동시에 만들지 않게 하고, 부모 채팅이 자식보다 먼저 들어오는 순서를 지킨다.
export function importVscodeSessions(deps: ImportDeps, keys: string[]): Promise<VscodeImportResult[]> {
  const run = importQueue.then(() => runImport(deps, keys));
  importQueue = run.catch(() => undefined);
  return run;
}

async function runImport(deps: ImportDeps, keys: string[]): Promise<VscodeImportResult[]> {
  const userDir = deps.userDir ?? vscodeUserDir();
  let state: VscodeState;
  try {
    state = await readVscodeState(userDir);
  } catch (error) {
    return keys.map((key) => ({ key, agentId: null, outcome: "failed", items: 0, added: 0, note: error instanceof Error ? error.message : String(error) }));
  }
  const drafts = collectDrafts(state);
  const done = new Map<string, VscodeImportResult>();
  // 부모(기본 채팅)가 먼저 들어와야 다른 채팅이 바로 그 아래에 붙는다. 결과는 요청한 순서대로 돌려준다.
  const wanted = [...new Set(keys)].map((key) => ({ key, draft: drafts.find((d) => d.key === key) })).sort((a, b) => Number(a.draft?.kind === "peer") - Number(b.draft?.kind === "peer"));
  for (const { key, draft } of wanted) {
    if (!draft) {
      done.set(key, { key, agentId: null, outcome: "failed", items: 0, added: 0, note: T.importNotFound });
      continue;
    }
    try {
      done.set(key, await importDraft(deps, await probe(deps, draft)));
    } catch (error) {
      console.error("[import] failed", key, error);
      done.set(key, { key, agentId: null, outcome: "failed", items: 0, added: 0, note: error instanceof Error ? error.message : String(error) });
    }
  }
  return [...new Set(keys)].map((key) => done.get(key) as VscodeImportResult);
}

async function importDraft(deps: ImportDeps, p: Probed): Promise<VscodeImportResult> {
  const { draft } = p;
  const base = { key: draft.key, agentId: null, items: 0, added: 0 };
  if (!draft.claudeSessionId) return { ...base, outcome: "skipped", note: T.importNoSessionId };
  const existing = deps.store.agents.find((a) => a.sessionId === draft.claudeSessionId);
  if (existing) {
    // agent-nav 가 직접 만든 세션은 건드리지 않는다. 가져온 세션만 새 메시지를 더한다.
    if (!existing.imported) return { ...base, agentId: existing.id, outcome: "unchanged", items: deps.store.timeline(existing.id).length, note: T.importExistingNative };
    const synced = await reconcile(deps, existing.id, { force: true });
    linkFamily(deps, existing);
    return { ...base, agentId: existing.id, outcome: synced.added || synced.updated ? "updated" : "unchanged", items: deps.store.timeline(existing.id).length, added: synced.added, note: null };
  }
  if (!p.file) return { ...base, outcome: "skipped", note: T.importNoTranscript };
  const raw = await readRawIndex(p.file, { keepEntries: true });
  const cwd = chooseCwd(p.file, draft.cwd, raw.cwd);
  if (!cwd) return { ...base, outcome: "failed", note: T.importNoFolder };
  const chain = await loadChain(draft.claudeSessionId, cwd);
  const running = p.running;
  // 압축 이전 대화도 읽기 전용으로 앞에 붙인다(압축 지점은 구분선 항목)
  const split = splitAtCompaction(chain, raw.notes, raw.entries, raw.entryOrder);
  const before = markPreCompact(buildItems(split.before, raw.notes, { finishLastTurn: true }).built);
  const { built, lastTimestamp, model } = buildItems(split.after, raw.notes, { finishLastTurn: !running });
  const items = [...before, ...built].map((b) => b.item);

  const placement = await placeSession(deps.store, cwd, draft);
  const now = new Date().toISOString();
  const createdAt = isoOf(draft.createdMs) ?? raw.firstTimestamp ?? now;
  const updatedAt = isoOf(draft.modifiedMs) ?? raw.lastTimestamp ?? createdAt;
  if (placement.cwdMissing) items.push({ id: "import-cwd-missing", kind: "error", text: T.errWorkingDirectoryGone(cwd), auth: false });
  const agent: Agent = {
    id: randomUUID(),
    workspaceId: placement.workspaceId,
    cwd: placement.cwd,
    worktree: placement.worktree,
    forkedFrom: parentAgentOf(deps.store, draft)?.id ?? null,
    resumeFrom: null,
    startCommit: placement.startCommit,
    feedbackId: null,
    title: draft.title?.trim() ? titleFrom(draft.title) : titleFrom(p.peek?.aiTitle ?? raw.aiTitle ?? p.peek?.firstPrompt ?? firstUserText(items) ?? ""),
    sessionId: draft.claudeSessionId,
    status: placement.cwdMissing ? "error" : "idle",
    permissionMode: permissionOf(deps.store, draft.permissionMode ?? raw.permissionMode),
    model: modelOf(draft.modelId),
    effort: effortOf(draft.thinkingLevel),
    activeModel: model,
    activeEffort: null,
    backgroundTasks: 0,
    createdAt,
    updatedAt,
    unread: draft.unread || placement.cwdMissing,
    pinned: false,
    done: draft.archived,
    imported: {
      source: "vscode",
      vsSessionId: draft.vsSessionId,
      chatId: draft.chatId,
      origin: draft.origin,
      importedAt: now,
      syncedMtimeMs: p.mtimeMs ?? 0,
      syncedUntil: lastTimestamp,
      ...(placement.cwdMissing ? { cwdMissing: true } : {}),
      ...(running ? { vsRunning: true } : {}),
    },
  };
  deps.runner.adoptImported(agent, items);
  deps.emit({ type: "workspaces", workspaces: deps.store.workspaces });
  linkFamily(deps, agent);
  return { ...base, agentId: agent.id, outcome: "created", items: items.length, added: items.length, note: placement.cwdMissing ? T.importFolderMissing : null };
}

function linkFamily(deps: ImportDeps, agent: Agent) {
  const imported = agent.imported;
  if (!imported) return;
  if (imported.chatId === "default") {
    for (const child of deps.store.agents) {
      if (child.id === agent.id || child.imported?.vsSessionId !== imported.vsSessionId || child.imported.chatId === "default" || child.forkedFrom) continue;
      deps.store.patchAgent(child.id, { forkedFrom: agent.id });
      deps.emit({ type: "agent", agent: deps.store.agent(child.id) });
    }
    return;
  }
  if (agent.forkedFrom) return;
  const parent = deps.store.agents.find((a) => a.imported?.vsSessionId === imported.vsSessionId && a.imported.chatId === "default");
  if (!parent) return;
  deps.store.patchAgent(agent.id, { forkedFrom: parent.id });
  deps.emit({ type: "agent", agent: deps.store.agent(agent.id) });
}

const parentAgentOf = (store: Store, draft: Draft) => (draft.kind === "peer" ? store.agents.find((a) => a.imported?.vsSessionId === draft.vsSessionId && a.imported.chatId === "default") : undefined);


// 메시지를 보내기 전에 부른다. 세션 기록이 마지막으로 맞춘 뒤 바뀌었고, 그 안에 타임라인에 없는 새 항목이 있으면 타임라인을 맞추고 true.
export async function reconcileBeforeTurn(deps: ImportDeps, agentId: string): Promise<boolean> {
  const synced = await reconcile(deps, agentId, { force: false });
  return synced.added > 0 || synced.updated > 0;
}

// agent-nav 가 직접 돌린 턴이 끝났다. 그 턴이 쓴 기록까지 맞춘 것으로 표지를 올린다.
export function markSynced(deps: ImportDeps, agentId: string) {
  const agent = deps.store.agents.find((a) => a.id === agentId);
  if (!agent?.imported || !agent.sessionId) return;
  const file = findTranscript(agent.sessionId, agent.cwd, deps.projects);
  if (!file) return;
  void peekTranscript(file).then((peek) => {
    const current = deps.store.agents.find((a) => a.id === agentId);
    if (!peek || !current?.imported) return;
    deps.store.patchAgent(agentId, { imported: { ...current.imported, syncedMtimeMs: peek.mtimeMs, syncedUntil: peek.lastTimestamp ?? current.imported.syncedUntil } });
  });
}

type Reconciled = { added: number; updated: number };

async function reconcile(deps: ImportDeps, agentId: string, options: { force: boolean }): Promise<Reconciled> {
  const agent = deps.store.agent(agentId);
  const imported = agent.imported;
  const none = { added: 0, updated: 0 };
  if (!agent.sessionId) return none;
  const file = findTranscript(agent.sessionId, agent.cwd, deps.projects);
  if (!file) return none;
  const mtimeMs = statSync(file).mtimeMs;
  if (imported && !options.force && mtimeMs <= imported.syncedMtimeMs) return none;
  const raw = await readRawIndex(file);
  const chain = await loadChain(agent.sessionId, agent.cwd);
  const { built, lastTimestamp } = buildItems(chain, raw.notes, { finishLastTurn: !isRecent(mtimeMs, deps) });
  const merged = mergeBuilt(deps.store.timeline(agentId), built, imported?.syncedUntil ?? null);
  const changed: TimelineItem[] = [...merged.update, ...merged.add];
  if (changed.length) deps.runner.applyImported(agentId, changed);
  if (imported) {
    const next = { ...imported, syncedMtimeMs: mtimeMs, syncedUntil: lastTimestamp && (!imported.syncedUntil || lastTimestamp > imported.syncedUntil) ? lastTimestamp : imported.syncedUntil };
    deps.store.patchAgent(agentId, { imported: next });
    deps.emit({ type: "agent", agent: deps.store.agent(agentId) });
  }
  return { added: merged.add.length, updated: merged.update.length };
}

export function importActivity(deps: ImportDeps, agentId: string): { active: boolean; lastWriteAt: string | null } {
  const agent = deps.store.agents.find((a) => a.id === agentId);
  if (!agent?.imported || !agent.sessionId) return { active: false, lastWriteAt: null };
  const file = findTranscript(agent.sessionId, agent.cwd, deps.projects);
  if (!file) return { active: false, lastWriteAt: null };
  const { mtimeMs } = statSync(file);
  const now = (deps.now ?? Date.now)();
  const ownTurn = agent.status === "running" || agent.status === "waiting" || now - Date.parse(agent.updatedAt) < OWN_WRITE_GRACE_MS;
  return { active: !ownTurn && now - mtimeMs < ACTIVE_WINDOW_MS && mtimeMs > agent.imported.syncedMtimeMs, lastWriteAt: new Date(mtimeMs).toISOString() };
}

const isRecent = (mtimeMs: number, deps: ImportDeps) => (deps.now ?? Date.now)() - mtimeMs < ACTIVE_WINDOW_MS;


// 후보 하나가 되기 전의 내부 모양. 가져올 때 필요한 값(권한, 모델, 폴더 힌트)까지 담는다.
export type Draft = {
  key: string;
  claudeSessionId: string | null;
  vsSessionId: string;
  chatId: string;
  kind: "main" | "peer";
  parentKey: string | null;
  origin: "user" | "sideChat" | null;
  title: string | null;
  cwd: string | null;
  createdMs: number | null;
  modifiedMs: number | null;
  chats: number;
  subagentChats: number;
  archived: boolean;
  unread: boolean;
  from: "cache" | "session" | "both";
  workspaceless: boolean;
  permissionMode: string | null;
  modelId: string | null;
  thinkingLevel: string | null;
  diffBase: string | null;
};

export function collectDrafts(state: VscodeState): Draft[] {
  const drafts = new Map<string, Draft>();
  const mainByVs = new Map<string, Draft>();
  const sessionByVs = new Map(state.sessions.map((s) => [s.dir, s]));

  for (const s of state.sessions) {
    if (!s.claudeSessionId) continue;
    const draft = blankDraft(s.claudeSessionId, s.dir, "default", "main", "session");
    applySession(draft, s);
    drafts.set(draft.key, draft);
    mainByVs.set(s.dir, draft);
  }

  for (const c of state.cached.filter((x) => x.provider === "claude")) {
    const s = sessionByVs.get(c.vsSessionId);
    const claudeId = s?.claudeSessionId ?? (c.external ? c.vsSessionId : null);
    const key = claudeId ?? `${c.vsSessionId}:default`;
    let draft = drafts.get(key);
    if (draft) draft.from = "both";
    else {
      draft = blankDraft(claudeId, c.vsSessionId, "default", "main", "cache");
      if (s) applySession(draft, s);
      drafts.set(draft.key, draft);
    }
    mainByVs.set(c.vsSessionId, draft);
    draft.createdMs = c.startMs ?? draft.createdMs;
    draft.modifiedMs = c.modifiedMs ?? draft.modifiedMs;
    draft.cwd = c.cwd ?? draft.cwd;
    draft.title = draft.title ?? (c.summary.trim() || null);
    draft.unread = draft.unread || c.chats.some((chat) => chat.isRead === false);
    draft.subagentChats = Math.max(draft.subagentChats, c.chats.filter((chat) => chat.authority === "subagent").length);
    // 캐시에만 있고 session.db 에서 풀지 못한 다른 채팅은 Claude 세션 id 를 모르는 채로 보인다
    for (const chat of c.chats) {
      if (chat.authority === "default" || chat.authority === "subagent" || !chat.authority) continue;
      if (state.peers.some((p) => p.authority === chat.authority && p.parentVsSessionId === c.vsSessionId)) continue;
      const peerKey = `${c.vsSessionId}:${chat.authority}`;
      if (!drafts.has(peerKey)) drafts.set(peerKey, { ...blankDraft(null, c.vsSessionId, chat.authority, "peer", "cache"), parentKey: draft.key, cwd: draft.cwd, createdMs: draft.createdMs, modifiedMs: draft.modifiedMs });
    }
  }

  for (const [vs, parent] of mainByVs) parent.subagentChats = Math.max(parent.subagentChats, state.subagentDirs.get(vs) ?? 0);

  for (const p of state.peers) {
    const parent = p.parentVsSessionId ? mainByVs.get(p.parentVsSessionId) : undefined;
    const key = p.claudeSessionId ?? `${p.parentVsSessionId}:${p.authority}`;
    if (drafts.has(key)) continue;
    const owner = p.parentVsSessionId ? sessionByVs.get(p.parentVsSessionId) : undefined;
    const draft = blankDraft(p.claudeSessionId, p.parentVsSessionId ?? "", p.authority, "peer", "session");
    applyPeer(draft, p, owner, parent);
    drafts.set(key, draft);
  }

  const peerCount = new Map<string, number>();
  for (const d of drafts.values()) if (d.kind === "peer" && d.parentKey) peerCount.set(d.parentKey, (peerCount.get(d.parentKey) ?? 0) + 1);
  for (const d of drafts.values()) if (d.kind === "main") d.chats = 1 + (peerCount.get(d.key) ?? 0) + d.subagentChats;
  return [...drafts.values()];
}

function blankDraft(claudeSessionId: string | null, vsSessionId: string, chatId: string, kind: "main" | "peer", from: Draft["from"]): Draft {
  return {
    key: claudeSessionId ?? `${vsSessionId}:${chatId}`,
    claudeSessionId,
    vsSessionId,
    chatId,
    kind,
    parentKey: null,
    origin: null,
    title: null,
    cwd: null,
    createdMs: null,
    modifiedMs: null,
    chats: 1,
    subagentChats: 0,
    archived: false,
    unread: false,
    from,
    workspaceless: false,
    permissionMode: null,
    modelId: null,
    thinkingLevel: null,
    diffBase: null,
  };
}

function applySession(draft: Draft, s: SessionMeta) {
  draft.title = s.customTitle ?? defaultChatTitle(s) ?? draft.title;
  draft.cwd = s.cwd ?? draft.cwd;
  draft.archived = s.archived;
  draft.unread = s.isRead === false;
  draft.workspaceless = s.workspaceless;
  draft.permissionMode = s.permissionMode;
  draft.modelId = s.modelId;
  draft.thinkingLevel = s.thinkingLevel;
  draft.diffBase = s.diffBase;
}

const defaultChatTitle = (s: SessionMeta) => [...s.chatTitles].find(([uri]) => uri.startsWith("ahp-chat://default/"))?.[1] ?? null;

function applyPeer(draft: Draft, p: PeerMeta, owner: SessionMeta | undefined, parent: Draft | undefined) {
  draft.origin = p.origin;
  draft.parentKey = parent?.key ?? null;
  draft.cwd = p.cwd ?? parent?.cwd ?? owner?.cwd ?? null;
  draft.createdMs = parent?.createdMs ?? null;
  draft.modifiedMs = parent?.modifiedMs ?? null;
  draft.archived = parent?.archived ?? false;
  draft.unread = p.isRead === false;
  draft.workspaceless = parent?.workspaceless ?? false;
  draft.permissionMode = parent?.permissionMode ?? null;
  draft.modelId = p.modelId ?? parent?.modelId ?? null;
  draft.thinkingLevel = p.thinkingLevel ?? parent?.thinkingLevel ?? null;
  draft.diffBase = parent?.diffBase ?? null;
  draft.title = [...(owner?.chatTitles ?? [])].find(([uri]) => uri.startsWith(`ahp-chat://${p.authority}/`))?.[1] ?? null;
}

// --- 파일 시스템에서 보충 ---

type Probed = { draft: Draft; file: string | null; peek: TranscriptPeek | null; mtimeMs: number | null; running: boolean; cwd: string | null; cwdExists: boolean };

// 세션 기록의 위치와 앞뒤 일부(작업 폴더, 시각, 제목)를 읽고 작업 폴더가 있는지 본다.
async function probe(deps: ImportDeps, draft: Draft): Promise<Probed> {
  const file = draft.claudeSessionId ? findTranscript(draft.claudeSessionId, draft.cwd, deps.projects) : null;
  const peek = file ? await peekTranscript(file) : null;
  const cwd = draft.cwd ?? peek?.cwd ?? null;
  const mtimeMs = peek?.mtimeMs ?? null;
  const running = mtimeMs !== null && (deps.now ?? Date.now)() - mtimeMs < ACTIVE_WINDOW_MS;
  return { draft: { ...draft, cwd, createdMs: draft.createdMs ?? msOf(peek?.firstTimestamp), modifiedMs: draft.modifiedMs ?? mtimeMs }, file, peek, mtimeMs, running, cwd, cwdExists: !!cwd && isDirectorySync(cwd) };
}

function candidateOf(deps: ImportDeps, p: Probed): VscodeCandidate {
  const { draft } = p;
  const agent = draft.claudeSessionId ? deps.store.agents.find((a) => a.sessionId === draft.claudeSessionId) : undefined;
  return {
    key: draft.key,
    claudeSessionId: draft.claudeSessionId,
    vsSessionId: draft.vsSessionId,
    chatId: draft.chatId,
    kind: draft.kind,
    parentKey: draft.parentKey,
    origin: draft.origin,
    title: draft.title?.trim() || p.peek?.aiTitle || p.peek?.firstPrompt || (draft.kind === "peer" ? T.importPeerTitle : T.importUntitled),
    cwd: p.cwd,
    cwdExists: p.cwdExists,
    createdAt: isoOf(draft.createdMs),
    updatedAt: isoOf(draft.modifiedMs),
    chats: draft.chats,
    subagentChats: draft.subagentChats,
    hasJsonl: !!p.file,
    archived: draft.archived,
    unread: draft.unread,
    running: p.running,
    from: draft.from,
    importedAgentId: agent?.id ?? null,
    problem: !draft.claudeSessionId ? "noSessionId" : !p.file ? "noTranscript" : null,
  };
}

// 기본 채팅 바로 아래에 그 세션의 다른 채팅이 오고, 기본 채팅은 최근 수정 순서다. 부모가 목록에 없는 다른 채팅은 맨 위 줄로 올라온다.
function orderCandidates(list: VscodeCandidate[]): VscodeCandidate[] {
  const keys = new Set(list.map((c) => c.key));
  const children = new Map<string, VscodeCandidate[]>();
  const roots: VscodeCandidate[] = [];
  for (const c of list) {
    if (c.parentKey && keys.has(c.parentKey)) children.set(c.parentKey, [...(children.get(c.parentKey) ?? []), c]);
    else roots.push(c);
  }
  const time = (c: VscodeCandidate) => c.updatedAt ?? c.createdAt ?? "";
  roots.sort((a, b) => time(b).localeCompare(time(a)));
  return roots.flatMap((root) => [root, ...(children.get(root.key) ?? []).sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? "") || a.key.localeCompare(b.key))]);
}

// --- 작업 폴더와 워크스페이스 ---

type Placement = { workspaceId: string | null; cwd: string; worktree: Agent["worktree"]; startCommit: string | null; cwdMissing: boolean };

// 세션이 실제로 돈 폴더. 세션 기록이 들어 있는 프로젝트 폴더 이름과 맞는 쪽을 쓴다(CLI 가 이어 갈 때 이 이름으로 기록을 찾는다).
function chooseCwd(file: string, vscodeCwd: string | null, recordedCwd: string | null): string | null {
  const dir = basename(dirname(file));
  for (const candidate of [vscodeCwd, recordedCwd]) {
    if (candidate && (projectDirName(candidate) === dir || projectDirName(realOrSame(candidate)) === dir)) return candidate;
  }
  return vscodeCwd ?? recordedCwd;
}

// 폴더를 워크스페이스로 등록하고(없으면 자동 등록), git worktree 면 원 레포 워크스페이스 아래에 붙인다(AgentRunner.create 와 같은 모양).
// 폴더가 없으면 그 경로로 등록은 하되 cwdMissing 으로 알린다. 폴더 없는 채팅(workspaceless)은 Chats 묶음에 들어간다.
async function placeSession(store: Store, cwd: string, draft: Draft): Promise<Placement> {
  const real = realOrSame(cwd);
  if (draft.workspaceless || /\/\.copilot\/chats\/[^/]+$/.test(real)) return { workspaceId: null, cwd: real, worktree: null, startCommit: null, cwdMissing: !isDirectorySync(real) };
  if (!isDirectorySync(real)) return { workspaceId: store.addWorkspace(real).id, cwd: real, worktree: null, startCommit: null, cwdMissing: true };
  const tree = await detectWorktree(real);
  if (!tree) return { workspaceId: store.addWorkspace(real).id, cwd: real, worktree: null, startCommit: await gitOps.headCommit(real).catch(() => null), cwdMissing: false };
  const parent: Workspace = store.addWorkspace(join(tree.mainRoot, relative(tree.root, real)));
  const base = draft.diffBase ?? (await gitOps.defaultBase(tree.mainRoot).catch(() => null)) ?? "main";
  const child = store.addWorkspace(real, parent.id, `${parent.name} (${tree.branch})`);
  return { workspaceId: child.id, cwd: real, worktree: { root: tree.root, branch: tree.branch, base }, startCommit: null, cwdMissing: false };
}

// cwd 가 레포의 추가 worktree 안이면 그 worktree 의 뿌리, 원 레포 뿌리, 브랜치. 아니면 null.
export async function detectWorktree(cwd: string): Promise<{ root: string; mainRoot: string; branch: string } | null> {
  const run = async (args: string[]) => {
    try {
      return (await gitOps.git(cwd, args)).trim();
    } catch {
      return null;
    }
  };
  const root = await run(["rev-parse", "--show-toplevel"]);
  const gitDir = await run(["rev-parse", "--path-format=absolute", "--git-dir"]);
  const common = await run(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!root || !gitDir || !common || realOrSame(gitDir) === realOrSame(common) || basename(common) !== ".git") return null;
  return { root: realOrSame(root), mainRoot: realOrSame(dirname(common)), branch: (await run(["rev-parse", "--abbrev-ref", "HEAD"])) ?? "HEAD" };
}

// --- 값 옮기기 ---

function permissionOf(store: Store, value: string | null): PermissionMode {
  if (value && (PERMISSION_MODE_VALUES as readonly string[]).includes(value)) return value as PermissionMode;
  return defaultsReader.resolve(store.settings).permissionMode.value;
}

function modelOf(id: string | null): string | null {
  const name = modelNameOf(id);
  return name && MODEL_NAME.test(name) ? name : null;
}

const effortOf = (level: string | null): EffortLevel | null => (level && (EFFORT_LEVELS as string[]).includes(level) ? (level as EffortLevel) : null);

function firstUserText(items: TimelineItem[]): string | null {
  for (const item of items) if (item.kind === "user" && item.source !== "system") return item.text;
  return null;
}

const isoOf = (ms: number | null | undefined) => (typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : null);
const msOf = (iso: string | null | undefined) => (iso && !Number.isNaN(Date.parse(iso)) ? Date.parse(iso) : null);

function realOrSame(path: string) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function isDirectorySync(path: string) {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}
