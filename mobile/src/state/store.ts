// 앱 상태 저장소. 서버 이벤트와 응답을 받아 세션 목록과 타임라인을 들고 있고, 캐시에 저장해 다음 실행 때 즉시 보인다.
// React 에 의존하지 않는다(화면은 useSyncExternalStore 로 읽는다). 시험은 가짜 RpcClient 와 메모리 캐시로 돌린다(test/store.test.ts).
import type { MobileBrowseResult, MobileWorktreeRequest } from "@shared/mobile";
import type { Agent, BranchesResult, ImageRef, PermissionDecision, ServerEvent, TimelineItem, Workspace } from "@shared/protocol";
import type { ConnStatus } from "../net/rpc";
import { mergeTail, prependOlder, remove, upsert } from "../logic/timeline";
import { markEnd, markStart, now, record } from "./perf";

export type Cache = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(keys: string[]): Promise<void>;
};

// 저장소가 쓰는 연결의 최소 모양(RpcClient 가 만족한다)
export type Link = {
  status: ConnStatus;
  host: string | null;
  call(method: string, params: unknown, timeoutMs?: number): Promise<unknown>;
  onEvent(listener: (event: ServerEvent) => void): () => void;
  onStatus(listener: (status: ConnStatus) => void): () => void;
  onReady(listener: (ready: { host: string }) => void): () => void;
};

// 워크스페이스 목록에 보이는 git 요약(폴더마다 git.branches 를 한 번 읽은 것). 캐시에는 저장하지 않는다.
export type GitSummary = { repoRoot: string | null; current: string | null; uncommitted: number };

export type SessionTimeline = { items: TimelineItem[]; hasMore: boolean; synced: boolean; loadingOlder: boolean };

export type State = {
  conn: ConnStatus;
  hostName: string | null;
  // 목록을 캐시나 서버에서 한 번이라도 받았는지
  loaded: boolean;
  syncedAt: number | null;
  agents: Agent[];
  workspaces: Workspace[];
  git: Record<string, GitSummary>;
  timelines: Record<string, SessionTimeline>;
  // 마지막 동기화나 호출의 오류 문구(없으면 null)
  error: string | null;
};

const PAGE = 60;
const CACHE_ITEMS = 40;
const CACHE_SESSIONS = 8;
const SAVE_DELAY_MS = 400;
const INDEX_KEY = "cache:v1:index";
const timelineKey = (id: string) => `cache:v1:tl:${id}`;

const EMPTY: SessionTimeline = { items: [], hasMore: false, synced: false, loadingOlder: false };

export class AppStore {
  private state: State = { conn: "idle", hostName: null, loaded: false, syncedAt: null, agents: [], workspaces: [], git: {}, timelines: {}, error: null };
  private listeners = new Set<() => void>();
  private link: Link | null = null;
  private unsubscribers: (() => void)[] = [];
  private opened = new Set<string>();
  private recent: string[] = [];
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = new Set<string>();
  private syncing: Promise<void> | null = null;

  constructor(private cache: Cache) {}

  // --- 구독 ---

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getState = (): State => this.state;

  private set(patch: Partial<State>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  // --- 시작과 연결 ---

  // 캐시를 읽어 목록을 바로 채운다. 캐시가 없으면 아무것도 하지 않는다.
  async loadCache(): Promise<boolean> {
    const raw = await this.cache.get(INDEX_KEY);
    if (!raw) return false;
    try {
      const index = JSON.parse(raw) as { agents: Agent[]; workspaces: Workspace[]; recent: string[]; hostName: string | null };
      this.recent = index.recent ?? [];
      this.set({ agents: index.agents, workspaces: index.workspaces, hostName: index.hostName ?? null, loaded: true });
      return true;
    } catch {
      return false;
    }
  }

  attach(link: Link) {
    this.detach();
    this.link = link;
    this.set({ conn: link.status });
    this.unsubscribers = [
      link.onStatus((conn) => this.set({ conn })),
      link.onEvent((event) => this.onEvent(event)),
      link.onReady((ready) => {
        this.set({ hostName: ready.host });
        void this.sync();
      }),
    ];
  }

  detach() {
    for (const off of this.unsubscribers) off();
    this.unsubscribers = [];
    this.link = null;
  }

  // 페어링을 풀 때: 캐시와 상태를 비운다
  async reset() {
    this.detach();
    this.opened.clear();
    const keys = [INDEX_KEY, ...this.recent.map(timelineKey), ...Object.keys(this.state.timelines).map(timelineKey)];
    this.recent = [];
    this.set({ conn: "idle", hostName: null, loaded: false, syncedAt: null, agents: [], workspaces: [], git: {}, timelines: {}, error: null });
    await this.cache.remove([...new Set(keys)]).catch(() => {});
  }

  // 연결이 (다시) 맺어질 때마다: 세션 목록과 폴더, 열려 있는 세션들의 타임라인 끝을 다시 받아 맞춘다.
  // 끊긴 사이에 놓친 이벤트는 id 기준으로 이 조각에 다 들어 있다.
  sync(): Promise<void> {
    if (this.syncing) return this.syncing;
    this.syncing = this.runSync().finally(() => {
      this.syncing = null;
    });
    return this.syncing;
  }

  private async runSync() {
    const link = this.link;
    if (!link) return;
    markStart("list-sync");
    try {
      const [agents, workspaces] = await Promise.all([link.call("agents.list", {}) as Promise<Agent[]>, link.call("workspaces.list", {}) as Promise<Workspace[]>]);
      this.set({ agents, workspaces, loaded: true, syncedAt: Date.now(), error: null });
      markEnd("list-sync", `${agents.length} sessions`);
      this.touchIndex();
      // 열려 있는 세션은 병렬로 맞춘다. 지워진 세션은 건너뛴다.
      if (this.opened.size > 0) void link.call("agents.setOpen", { agentIds: [...this.opened] }).catch(() => {});
      await Promise.all([...this.opened].filter((id) => agents.some((a) => a.id === id)).map((id) => this.syncTimeline(id)));
    } catch (error) {
      markEnd("list-sync", "failed");
      this.set({ error: message(error) });
    }
  }

  // --- 이벤트 ---

  private onEvent(event: ServerEvent) {
    switch (event.type) {
      case "workspaces":
        this.set({ workspaces: event.workspaces });
        this.touchIndex();
        break;
      case "agent": {
        const at = this.state.agents.findIndex((a) => a.id === event.agent.id);
        const agents = at === -1 ? [...this.state.agents, event.agent] : this.state.agents.map((a, i) => (i === at ? event.agent : a));
        this.set({ agents });
        this.touchIndex();
        // 보고 있는 세션에서 턴이 끝나 안 읽음이 되면 바로 읽음으로 돌린다
        if (event.agent.unread && this.opened.has(event.agent.id)) void this.link?.call("agents.markRead", { agentId: event.agent.id, read: true }).catch(() => {});
        break;
      }
      case "agentRemoved": {
        const { [event.agentId]: _gone, ...timelines } = this.state.timelines;
        this.opened.delete(event.agentId);
        this.set({ agents: this.state.agents.filter((a) => a.id !== event.agentId), timelines });
        this.touchIndex();
        break;
      }
      case "timelineUpsert": {
        const current = this.state.timelines[event.agentId];
        // 열어 본 적 없는 세션의 항목은 받지 않는다(열 때 끝 조각을 받는다)
        if (!current) break;
        this.setTimeline(event.agentId, { ...current, items: upsert(current.items, event.item) });
        break;
      }
      case "timelineRemove": {
        const current = this.state.timelines[event.agentId];
        if (!current) break;
        this.setTimeline(event.agentId, { ...current, items: remove(current.items, event.itemId) });
        break;
      }
      default:
        break;
    }
  }

  private setTimeline(agentId: string, timeline: SessionTimeline) {
    this.set({ timelines: { ...this.state.timelines, [agentId]: timeline } });
    this.dirty.add(agentId);
    this.scheduleSave();
  }

  // --- 세션 ---

  // 세션 화면이 열렸다. 캐시된 끝 조각이 있으면 바로 보이고, 서버의 최신 조각을 받아 맞춘다.
  async openSession(agentId: string) {
    markStart(`open:${agentId}`);
    this.opened.add(agentId);
    this.recent = [agentId, ...this.recent.filter((id) => id !== agentId)].slice(0, CACHE_SESSIONS);
    if (!this.state.timelines[agentId]) {
      const raw = await this.cache.get(timelineKey(agentId)).catch(() => null);
      if (raw && !this.state.timelines[agentId]) {
        try {
          const cached = JSON.parse(raw) as { items: TimelineItem[]; hasMore: boolean };
          this.set({ timelines: { ...this.state.timelines, [agentId]: { items: cached.items, hasMore: cached.hasMore, synced: false, loadingOlder: false } } });
          markEnd(`open:${agentId}`, `cache ${cached.items.length} items`);
          markStart(`open-sync:${agentId}`);
        } catch {
          // 깨진 캐시는 서버 조각으로 대체된다
        }
      }
    }
    const link = this.link;
    if (link?.status === "online") {
      void link.call("agents.setOpen", { agentIds: [...this.opened] }).catch(() => {});
      const agent = this.state.agents.find((a) => a.id === agentId);
      if (agent?.unread) void link.call("agents.markRead", { agentId, read: true }).catch(() => {});
      await this.syncTimeline(agentId);
    }
  }

  closeSession(agentId: string) {
    this.opened.delete(agentId);
    const link = this.link;
    if (link?.status === "online") void link.call("agents.setOpen", { agentIds: [...this.opened] }).catch(() => {});
    void this.flushSave();
  }

  async syncTimeline(agentId: string) {
    const link = this.link;
    if (!link) return;
    const started = now();
    try {
      const page = (await link.call("agents.timelinePage", { agentId, limit: PAGE })) as Parameters<typeof mergeTail>[2];
      const current = this.state.timelines[agentId] ?? EMPTY;
      const merged = mergeTail(current.items, current.hasMore, page);
      // 받는 사이 도착한 이벤트가 이미 항목을 바꿨으면 조각이 옛 값이다. 같은 id 의 항목은 이벤트로 온 것이 더 새로울 수 있어, 조각 이후의 이벤트는 다음 이벤트가 다시 맞춘다.
      this.setTimeline(agentId, { items: merged.items, hasMore: merged.hasMore, synced: true, loadingOlder: false });
      const ms = Math.round((now() - started) * 10) / 10;
      record(`timeline-sync`, ms, `${page.items.length}/${page.total} items`);
      markEnd(`open-sync:${agentId}`);
      markEnd(`open:${agentId}`, "server");
    } catch (error) {
      this.set({ error: message(error) });
    }
  }

  async loadOlder(agentId: string) {
    const link = this.link;
    const current = this.state.timelines[agentId];
    if (!link || !current || !current.hasMore || current.loadingOlder || current.items.length === 0) return;
    this.setTimeline(agentId, { ...current, loadingOlder: true });
    try {
      const page = (await link.call("agents.timelinePage", { agentId, limit: PAGE, beforeId: current.items[0].id })) as Parameters<typeof prependOlder>[1];
      const latest = this.state.timelines[agentId] ?? current;
      const older = prependOlder(latest.items, page);
      this.setTimeline(agentId, { ...latest, items: older.items, hasMore: older.hasMore, loadingOlder: false });
    } catch (error) {
      this.setTimeline(agentId, { ...(this.state.timelines[agentId] ?? current), loadingOlder: false });
      this.set({ error: message(error) });
    }
  }

  // --- 동작 ---

  private call(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    if (!this.link) return Promise.reject(new Error("Not connected to your Mac"));
    return this.link.call(method, params, timeoutMs);
  }

  send(agentId: string, prompt: string, opts: { steer?: boolean; images?: ImageRef[] } = {}) {
    return this.call("agents.send", { agentId, prompt, steer: opts.steer === true, ...(opts.images?.length ? { images: opts.images } : {}) }) as Promise<{ queued: boolean }>;
  }

  // worktree 를 만들면 데몬이 git worktree add 를 끝낸 뒤에 응답하므로(큰 저장소는 몇 초) 기다리는 시간을 늘린다.
  createSession(workspaceId: string | null, prompt: string, images?: ImageRef[], worktree?: MobileWorktreeRequest) {
    return this.call("agents.create", { workspaceId, prompt, ...(images?.length ? { images } : {}), ...(worktree ? { worktree } : {}) }, worktree ? 90_000 : undefined) as Promise<Agent>;
  }

  interrupt(agentId: string) {
    return this.call("agents.interrupt", { agentId });
  }

  respondPermission(agentId: string, itemId: string, decision: Extract<PermissionDecision, "allow" | "deny">) {
    return this.call("agents.respondPermission", { agentId, itemId, decision });
  }

  answerQuestion(agentId: string, itemId: string, answers: Record<string, string> | null) {
    return this.call("agents.answerQuestion", { agentId, itemId, answers });
  }

  respondPlan(agentId: string, itemId: string, decision: { approve: true; mode: "acceptEdits" | "default" } | { approve: false; feedback?: string }) {
    return this.call("agents.respondPlan", { agentId, itemId, ...decision });
  }

  dequeue(agentId: string, queueId: string) {
    return this.call("agents.dequeue", { agentId, queueId }) as Promise<{ text: string } | null>;
  }

  sendQueuedNow(agentId: string, queueId: string) {
    return this.call("agents.sendQueuedNow", { agentId, queueId });
  }

  cancelSteering(agentId: string, steeringId: string) {
    return this.call("agents.cancelSteering", { agentId, steeringId }) as Promise<{ cancelled: boolean; text?: string } | null>;
  }

  markRead(agentId: string, read: boolean) {
    return this.call("agents.markRead", { agentId, read });
  }

  // --- 워크스페이스와 세션 관리 ---

  // 홈 아래 폴더 한 단계. path 가 없으면 홈.
  browse(path?: string) {
    return this.call("mobile.browse", path === undefined ? {} : { path }) as Promise<MobileBrowseResult>;
  }

  // 홈 아래 폴더를 워크스페이스로 더한다. 데몬의 workspaces 이벤트가 오기 전에 화면이 쓸 수 있게 목록에도 바로 넣는다.
  async addWorkspace(dir: string): Promise<Workspace> {
    const workspace = (await this.call("workspaces.add", { dir })) as Workspace;
    if (!this.state.workspaces.some((w) => w.id === workspace.id)) this.set({ workspaces: [...this.state.workspaces, workspace] });
    this.touchIndex();
    return workspace;
  }

  // 목록에서만 뺀다(디스크의 폴더는 그대로). 그 폴더의 세션은 데몬이 숨기고 agentRemoved 로 알린다. 응답을 받으면 화면에서도 바로 치운다.
  async removeWorkspace(id: string): Promise<{ hidden: number }> {
    const result = (await this.call("workspaces.remove", { id })) as { hidden: number };
    const gone = new Set([id, ...this.state.workspaces.filter((w) => w.parentId === id).map((w) => w.id)]);
    const { [id]: _git, ...git } = this.state.git;
    this.set({ workspaces: this.state.workspaces.filter((w) => !gone.has(w.id)), agents: this.state.agents.filter((a) => a.workspaceId === null || !gone.has(a.workspaceId)), git });
    this.touchIndex();
    return result;
  }

  // 새 세션 화면이 쓰는 브랜치 정보. 목록용 요약도 같이 갱신한다.
  async branches(workspaceId: string): Promise<BranchesResult> {
    const info = (await this.call("git.branches", { workspaceId })) as BranchesResult;
    this.set({ git: { ...this.state.git, [workspaceId]: { repoRoot: info.repoRoot, current: info.current, uncommitted: info.uncommitted } } });
    return info;
  }

  // 목록의 폴더들의 git 요약을 읽는다(실패한 폴더는 건너뛴다). 이미 읽은 것도 새로 맞춘다.
  async refreshGit(workspaceIds: readonly string[]) {
    await Promise.all(workspaceIds.map((id) => this.branches(id).catch(() => null)));
  }

  checkBranchName(workspaceId: string, branch: string) {
    return this.call("git.checkBranchName", { workspaceId, branch }) as Promise<{ problem: string | null }>;
  }

  rename(agentId: string, title: string) {
    return this.call("agents.rename", { agentId, title });
  }

  setPinned(agentId: string, pinned: boolean) {
    return this.call("agents.setPinned", { agentId, pinned });
  }

  setDone(agentId: string, done: boolean) {
    return this.call("agents.setDone", { agentId, done });
  }

  clearError() {
    if (this.state.error) this.set({ error: null });
  }

  // --- 캐시 저장 ---

  private touchIndex() {
    this.dirty.add("*index");
    this.scheduleSave();
  }

  private scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => void this.flushSave(), SAVE_DELAY_MS);
  }

  async flushSave() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const dirty = [...this.dirty];
    this.dirty.clear();
    const writes: Promise<void>[] = [];
    for (const key of dirty) {
      if (key === "*index") {
        writes.push(this.cache.set(INDEX_KEY, JSON.stringify({ agents: this.state.agents, workspaces: this.state.workspaces, recent: this.recent, hostName: this.state.hostName })));
        continue;
      }
      const timeline = this.state.timelines[key];
      if (!timeline || !this.recent.includes(key)) continue;
      const tail = timeline.items.slice(-CACHE_ITEMS);
      writes.push(this.cache.set(timelineKey(key), JSON.stringify({ items: tail, hasMore: timeline.hasMore || tail.length < timeline.items.length })));
    }
    await Promise.all(writes).catch(() => {});
  }
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
