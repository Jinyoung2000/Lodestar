import type { MobileBrowseResult, MobileModelCatalog, MobileModelSelection, MobileSessionRequest, MobileWorktreeRequest } from "@shared/mobile";
import type { Agent, BranchesResult, Harness, ImageRef, PermissionDecision, ServerEvent, TimelineItem, Workspace } from "@shared/protocol";
import type { ConnStatus } from "../net/rpc";
import { mergeTail, prependOlder, remove, upsert } from "../logic/timeline";
import { markEnd, markStart, now, record } from "./perf";

export type Cache = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(keys: string[]): Promise<void>;
};

export type Link = {
  status: ConnStatus;
  host: string | null;
  call(method: string, params: unknown, timeoutMs?: number): Promise<unknown>;
  onEvent(listener: (event: ServerEvent) => void): () => void;
  onStatus(listener: (status: ConnStatus) => void): () => void;
  onReady(listener: (ready: { host: string }) => void): () => void;
};

export type GitSummary = { repoRoot: string | null; current: string | null; uncommitted: number };

export type SessionTimeline = { items: TimelineItem[]; hasMore: boolean; synced: boolean; cached: boolean; loading: boolean; loadingOlder: boolean };

export type State = {
  conn: ConnStatus;
  hostName: string | null;
  loaded: boolean;
  syncedAt: number | null;
  agents: Agent[];
  workspaces: Workspace[];
  git: Record<string, GitSummary>;
  timelines: Record<string, SessionTimeline>;
  error: string | null;
};

const PAGE = 60;
const CACHE_ITEMS = 40;
const CACHE_SESSIONS = 8;
const MODEL_TIMEOUT_MS = 75_000;
const SAVE_DELAY_MS = 400;
const INDEX_KEY = "cache:v1:index";
const timelineKey = (id: string) => `cache:v1:tl:${id}`;

const EMPTY: SessionTimeline = { items: [], hasMore: false, synced: false, cached: false, loading: false, loadingOlder: false };

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
  private timelineRequests = new Map<string, Promise<void>>();

  constructor(private cache: Cache) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getState = (): State => this.state;

  private set(patch: Partial<State>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

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
    this.timelineRequests.clear();
  }

  async reset() {
    this.detach();
    this.opened.clear();
    const keys = [INDEX_KEY, ...this.recent.map(timelineKey), ...Object.keys(this.state.timelines).map(timelineKey)];
    this.recent = [];
    this.set({ conn: "idle", hostName: null, loaded: false, syncedAt: null, agents: [], workspaces: [], git: {}, timelines: {}, error: null });
    await this.cache.remove([...new Set(keys)]).catch(() => {});
  }

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
      if (this.opened.size > 0) void link.call("agents.setOpen", { agentIds: [...this.opened] }).catch(() => {});
      await Promise.all([...this.opened].filter((id) => agents.some((a) => a.id === id)).map((id) => this.syncTimeline(id)));
    } catch (error) {
      markEnd("list-sync", "failed");
      this.set({ error: message(error) });
    }
  }

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
        if (event.agent.unread && this.opened.has(event.agent.id)) void this.link?.call("agents.markRead", { agentId: event.agent.id, read: true }).catch(() => {});
        break;
      }
      case "agentRemoved": {
        const { [event.agentId]: _gone, ...timelines } = this.state.timelines;
        this.opened.delete(event.agentId);
        this.timelineRequests.delete(event.agentId);
        this.set({ agents: this.state.agents.filter((a) => a.id !== event.agentId), timelines });
        this.touchIndex();
        break;
      }
      case "timelineUpsert": {
        const current = this.state.timelines[event.agentId];
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

  async openSession(agentId: string) {
    markStart(`open:${agentId}`);
    this.opened.add(agentId);
    this.recent = [agentId, ...this.recent.filter((id) => id !== agentId)].slice(0, CACHE_SESSIONS);
    const existing = this.state.timelines[agentId];
    if (!existing?.synced && !existing?.cached && !existing?.items.length) {
      const raw = await this.cache.get(timelineKey(agentId)).catch(() => null);
      if (!this.opened.has(agentId)) return;
      const current = this.state.timelines[agentId];
      if (raw && !current?.synced && !current?.items.length) {
        try {
          const cached = JSON.parse(raw) as { items: TimelineItem[]; hasMore: boolean };
          if (Array.isArray(cached.items)) {
            this.set({ timelines: { ...this.state.timelines, [agentId]: { ...(current ?? EMPTY), items: cached.items, hasMore: cached.hasMore, cached: true } } });
          }
          markEnd(`open:${agentId}`, `cache ${cached.items.length} items`);
          markStart(`open-sync:${agentId}`);
        } catch {
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
    if (link?.status !== "online") return;
    const pending = this.timelineRequests.get(agentId);
    if (pending) return pending;
    const started = now();
    const request = link.call("agents.timelinePage", { agentId, limit: PAGE }, 8_000).then((result) => {
      if (this.timelineRequests.get(agentId) !== request) return;
      const page = result as Parameters<typeof mergeTail>[2];
      const current = this.state.timelines[agentId];
      const merged = mergeTail(current.items, current.hasMore, page);
      this.setTimeline(agentId, { ...current, items: merged.items, hasMore: merged.hasMore, synced: true, loading: false });
      const ms = Math.round((now() - started) * 10) / 10;
      record(`timeline-sync`, ms, `${page.items.length}/${page.total} items`);
      markEnd(`open-sync:${agentId}`);
      markEnd(`open:${agentId}`, "server");
    }).catch((error: unknown) => {
      if (this.timelineRequests.get(agentId) !== request) return;
      const current = this.state.timelines[agentId];
      this.set({ timelines: { ...this.state.timelines, [agentId]: { ...current, loading: false } }, error: message(error) });
    }).finally(() => {
      if (this.timelineRequests.get(agentId) === request) this.timelineRequests.delete(agentId);
    });
    this.timelineRequests.set(agentId, request);
    this.set({ timelines: { ...this.state.timelines, [agentId]: { ...(this.state.timelines[agentId] ?? EMPTY), loading: true } } });
    return request;
  }

  async loadOlder(agentId: string) {
    const link = this.link;
    const current = this.state.timelines[agentId];
    if (link?.status !== "online" || !current || !current.hasMore || current.loadingOlder || current.items.length === 0) return;
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

  private call(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    if (!this.link) return Promise.reject(new Error("Not connected to your Mac"));
    return this.link.call(method, params, timeoutMs);
  }

  send(agentId: string, prompt: string, opts: { steer?: boolean; images?: ImageRef[] } = {}) {
    return this.call("agents.send", { agentId, prompt, steer: opts.steer === true, ...(opts.images?.length ? { images: opts.images } : {}) }) as Promise<{ queued: boolean }>;
  }

  createSession(workspaceId: string | null, prompt: string, images?: ImageRef[], worktree?: MobileWorktreeRequest, selection?: MobileModelSelection) {
    const params: MobileSessionRequest = { workspaceId, prompt, ...(images?.length ? { images } : {}), ...(worktree ? { worktree } : {}) };
    if (!selection) return this.call("agents.create", params, worktree ? 90_000 : undefined) as Promise<Agent>;
    return this.modelCall<Agent>("mobile.createSession", { ...params, selection }, MODEL_TIMEOUT_MS + (worktree ? 90_000 : 0));
  }

  models(agentId?: string, harness?: Harness) {
    return this.modelCall<MobileModelCatalog>("mobile.models", { agentId, harness }, MODEL_TIMEOUT_MS);
  }

  async setModel(agentId: string, selection: MobileModelSelection) {
    const before = this.state.agents.find((agent) => agent.id === agentId);
    const saved = await this.modelCall<MobileModelSelection>("mobile.setModel", { agentId, selection }, MODEL_TIMEOUT_MS);
    if (before && this.state.agents.includes(before)) {
      this.set({ agents: this.state.agents.map((agent) => agent === before ? { ...before, ...saved } : agent) });
      this.touchIndex();
    }
    return saved;
  }

  private async modelCall<T>(method: "mobile.models" | "mobile.setModel" | "mobile.createSession", params: unknown, timeoutMs: number) {
    try {
      return (await this.call(method, params, timeoutMs)) as T;
    } catch (error) {
      if (error instanceof Error && error.message === `The phone app cannot call ${method}`) throw new Error("Update Lodestar on your Mac to change models.");
      throw error;
    }
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

  browse(path?: string) {
    return this.call("mobile.browse", path === undefined ? {} : { path }) as Promise<MobileBrowseResult>;
  }

  async addWorkspace(dir: string): Promise<Workspace> {
    const workspace = (await this.call("workspaces.add", { dir })) as Workspace;
    if (!this.state.workspaces.some((w) => w.id === workspace.id)) this.set({ workspaces: [...this.state.workspaces, workspace] });
    this.touchIndex();
    return workspace;
  }

  async removeWorkspace(id: string): Promise<{ hidden: number }> {
    const result = (await this.call("workspaces.remove", { id })) as { hidden: number };
    const gone = new Set([id, ...this.state.workspaces.filter((w) => w.parentId === id).map((w) => w.id)]);
    const { [id]: _git, ...git } = this.state.git;
    this.set({ workspaces: this.state.workspaces.filter((w) => !gone.has(w.id)), agents: this.state.agents.filter((a) => a.workspaceId === null || !gone.has(a.workspaceId)), git });
    this.touchIndex();
    return result;
  }

  async branches(workspaceId: string): Promise<BranchesResult> {
    const info = (await this.call("git.branches", { workspaceId })) as BranchesResult;
    this.set({ git: { ...this.state.git, [workspaceId]: { repoRoot: info.repoRoot, current: info.current, uncommitted: info.uncommitted } } });
    return info;
  }

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
