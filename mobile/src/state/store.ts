import type { MobileBrowseResult, MobileCustomProvider, MobileDefaults, MobileFileRef, MobileWorkspaceIcons, MobileModelCatalog, MobileModelProvider, MobileModelSelection, MobileSessionRequest, MobileWorktreeRequest, PhoneFeedbackRequest } from "@shared/mobile";
import type { AssistantState } from "@shared/assistant";
import type { FollowUpsState } from "@shared/followups";
import type { SnoozeChoice } from "../logic/mateCore.generated";
import type { Agent, BranchesResult, Harness, ImageRef, PermissionDecision, RequestQueuing, ServerEvent, TimelineItem, Workspace } from "@shared/protocol";
import { TransportError, type ConnStatus } from "../net/rpc";
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

export type SessionTimeline = { items: TimelineItem[]; hasMore: boolean; synced: boolean; cached: boolean; loading: boolean; loadingOlder: boolean; error?: string };

type ModelProviders = Partial<Record<Harness, MobileModelProvider | null>>;

export const MODEL_HARNESSES: Harness[] = ["claude", "codex", "antigravity", "cursor"];

export type State = {
  modelProviders: ModelProviders;
  customProviders: MobileCustomProvider[];
  customModelProviders: MobileModelProvider[] | undefined;
  modelPins: string[] | null;
  requestQueuing: RequestQueuing;
  operator: boolean;
  workspaceIcons: MobileWorkspaceIcons;
  conn: ConnStatus;
  hostName: string | null;
  loaded: boolean;
  syncedAt: number | null;
  agents: Agent[];
  workspaces: Workspace[];
  git: Record<string, GitSummary>;
  timelines: Record<string, SessionTimeline>;
  followUps: FollowUpsState | null;
  assistant: AssistantState | null;
  error: string | null;
};

const PAGE = 60;
const CACHE_ITEMS = 40;
const CACHE_SESSIONS = 8;
const MODEL_TIMEOUT_MS = 75_000;
const SAVE_DELAY_MS = 2000;
const INDEX_KEY = "cache:v1:index";
const MODELS_KEY = "cache:v1:models";
const ICONS_KEY = "cache:v1:icons";
const timelineKey = (id: string) => `cache:v1:tl:${id}`;

const EMPTY: SessionTimeline = { items: [], hasMore: false, synced: false, cached: false, loading: false, loadingOlder: false };

export class AppStore {
  private state: State = { modelProviders: {}, customProviders: [], customModelProviders: undefined, modelPins: null, requestQueuing: "queue", operator: false, workspaceIcons: {}, conn:"idle", hostName: null, loaded: false, syncedAt: null, agents: [], workspaces: [], git: {}, timelines: {}, followUps: null, assistant: null, error: null };
  private listeners = new Set<() => void>();
  private link: Link | null = null;
  private unsubscribers: (() => void)[] = [];
  private opened = new Set<string>();
  private recent: string[] = [];
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = new Set<string>();
  private syncing: Promise<void> | null = null;
  private timelineRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private timelineRequests = new Map<string, Promise<void>>();

  private providerRequests = new Map<Harness, Promise<void>>();
  private providerFreshUntil = new Map<Harness, number>();
  private connectionGeneration = 0;
  private pinRevision = 0;
  private pinRead: Promise<void> | null = null;
  private pendingDone = new Map<string, { done: boolean; token: number }>();
  private doneToken = 0;

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
    const [raw, models, icons] = await Promise.all([INDEX_KEY, MODELS_KEY, ICONS_KEY].map((key) => this.cache.get(key).catch(() => null)));
    if (!raw) return false;
    try {
      const index = JSON.parse(raw) as { agents: Agent[]; workspaces: Workspace[]; recent: string[]; hostName: string | null; modelProviders?: ModelProviders; modelPins?: string[]; workspaceIcons?: MobileWorkspaceIcons; customProviders?: MobileCustomProvider[] };
      this.recent = index.recent ?? [];
      this.set({ modelProviders: savedObject<ModelProviders>(models) ?? index.modelProviders ?? {}, customProviders: Array.isArray(index.customProviders) ? index.customProviders : [], modelPins: index.modelPins ?? null, workspaceIcons: savedObject<MobileWorkspaceIcons>(icons) ?? index.workspaceIcons ?? {}, agents: index.agents, workspaces: index.workspaces, hostName: index.hostName ?? null, loaded: true });
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
        void this.warmModels().catch(() => {});
        void this.loadModelPins().catch(() => {});
      }),
    ];
  }

  detach() {
    for (const off of this.unsubscribers) off();
    this.unsubscribers = [];
    this.link = null;
    this.syncing = null;
    this.timelineRequests.clear();
    for (const id of this.timelineRetryTimers.keys()) this.clearTimelineRetry(id);
    this.connectionGeneration++;
    this.providerRequests.clear();
    this.providerFreshUntil.clear();
    this.pinRead = null;
  }

  async reset() {
    this.detach();
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.dirty.clear();
    this.opened.clear();
    const keys = [INDEX_KEY, MODELS_KEY, ICONS_KEY, ...this.recent.map(timelineKey), ...Object.keys(this.state.timelines).map(timelineKey)];
    this.recent = [];
    this.set({ modelProviders: {}, customProviders: [], customModelProviders: undefined, modelPins: null, requestQueuing: "queue", operator: false, workspaceIcons: {}, conn:"idle", hostName: null, loaded: false, syncedAt: null, agents: [], workspaces: [], git: {}, timelines: {}, followUps: null, assistant: null, error: null });
    await this.cache.remove([...new Set(keys)]).catch(() => {});
  }

  sync(): Promise<void> {
    if (this.syncing) return this.syncing;
    const request = Promise.all([this.runSync(), this.syncOpenTimelines()]).then(() => {}).finally(() => {
      if (this.syncing === request) this.syncing = null;
    });
    this.syncing = request;
    return request;
  }

  async syncOpenTimelines() {
    await Promise.all(Array.from(this.opened, (id) => this.syncTimeline(id)));
  }

  private async runSync() {
    const link = this.link;
    if (!link) return;
    const generation = this.connectionGeneration;
    markStart("list-sync");
    try {
      const [agents, workspaces] = await Promise.all([link.call("agents.list", {}) as Promise<Agent[]>, link.call("workspaces.list", {}) as Promise<Workspace[]>]);
      if (this.connectionGeneration !== generation) return;
      this.set({ agents: agents.map((a) => this.withPendingDone(a)), workspaces, loaded: true, syncedAt: Date.now(), error: null });
      markEnd("list-sync", `${agents.length} sessions`);
      this.touchIndex();
      if (this.opened.size > 0) void link.call("agents.setOpen", { agentIds: [...this.opened] }).catch(() => {});
      void this.loadDefaults(link, generation);
      void this.loadMate(link, generation);
      void this.loadCustomProviders();
      if (this.iconsGeneration !== generation || workspaces.some((w) => !(w.id in this.state.workspaceIcons))) void this.loadWorkspaceIcons(link, generation);
    } catch (error) {
      if (this.connectionGeneration !== generation) return;
      markEnd("list-sync", "failed");
      this.set({ error: message(error) });
    }
  }

  private iconsGeneration = -1;

  private async loadWorkspaceIcons(link: Link, generation: number) {
    this.iconsGeneration = generation;
    try {
      const icons = await link.call("mobile.workspaceIcons", {}, 20_000) as MobileWorkspaceIcons;
      if (this.connectionGeneration !== generation || !icons || typeof icons !== "object") return;
      this.set({ workspaceIcons: icons });
      this.touch("*icons");
    } catch {
      return;
    }
  }

  private async loadMate(link: Link, generation: number) {
    const [followUps, assistant] = await Promise.all([
      (link.call("followUps.get", {}) as Promise<FollowUpsState>).catch(() => null),
      (link.call("assistant.get", {}) as Promise<AssistantState>).catch(() => null),
    ]);
    if (this.connectionGeneration !== generation) return;
    this.set({ followUps, assistant });
  }

  private async loadDefaults(link: Link, generation: number) {
    try {
      const defaults = await link.call("mobile.defaults", {}) as MobileDefaults;
      if (this.connectionGeneration !== generation) return;
      if (defaults.requestQueuing === "queue" || defaults.requestQueuing === "steer") this.set({ requestQueuing: defaults.requestQueuing });
      this.set({ operator: defaults.operator === true });
    } catch {
      return;
    }
  }

  private onEvent(event: ServerEvent) {
    switch (event.type) {
      case "modelPins":
        this.acceptModelPins(event.pins);
        break;
      case "customProviders":
        this.customFreshUntil = 0;
        this.set({ customProviders: event.providers.map((p) => ({ id: p.id, name: p.name })), customModelProviders: undefined });
        this.touchIndex();
        break;
      case "workspaces":
        this.set({ workspaces: event.workspaces });
        this.touchIndex();
        break;
      case "agent": {
        const incoming = this.withPendingDone(event.agent);
        const at = this.state.agents.findIndex((a) => a.id === incoming.id);
        const agents = at === -1 ? [...this.state.agents, incoming] : this.state.agents.map((a, i) => (i === at ? incoming : a));
        this.set({ agents });
        this.touchIndex();
        if (event.agent.unread && this.opened.has(event.agent.id)) void this.link?.call("agents.markRead", { agentId: event.agent.id, read: true }).catch(() => {});
        break;
      }
      case "agentRemoved": {
        const { [event.agentId]: _gone, ...timelines } = this.state.timelines;
        this.opened.delete(event.agentId);
        this.timelineRequests.delete(event.agentId);
        this.clearTimelineRetry(event.agentId);
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
      case "followUps":
        this.set({ followUps: event.state });
        break;
      case "assistant":
        this.set({ assistant: event.state });
        break;
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
    this.dropUnusedTimelines();
    const generation = this.connectionGeneration;
    const cached = this.readSavedTimeline(agentId, generation);
    const link = this.link;
    if (link?.status === "online") {
      void link.call("agents.setOpen", { agentIds: [...this.opened] }).catch(() => {});
      const agent = this.state.agents.find((a) => a.id === agentId);
      if (agent?.unread) void link.call("agents.markRead", { agentId, read: true }).catch(() => {});
      await Promise.all([cached, this.syncTimeline(agentId)]);
    } else {
      await cached;
    }
  }

  private dropUnusedTimelines() {
    const kept = new Set([...this.opened, ...this.recent]);
    const unused = Object.keys(this.state.timelines).filter((id) => !kept.has(id));
    if (unused.length === 0) return;
    const timelines = { ...this.state.timelines };
    for (const id of unused) {
      delete timelines[id];
      this.timelineRequests.delete(id);
      this.clearTimelineRetry(id);
    }
    this.set({ timelines });
  }

  private async readSavedTimeline(agentId: string, generation: number) {
    const existing = this.state.timelines[agentId];
    if (existing?.synced || existing?.cached || existing?.items.length) return;
    const raw = await this.cache.get(timelineKey(agentId)).catch(() => null);
    const current = this.state.timelines[agentId];
    if (!raw || generation !== this.connectionGeneration || !this.opened.has(agentId) || current?.synced) return;
    try {
      const cached = JSON.parse(raw) as { items: TimelineItem[]; hasMore: boolean };
      if (!Array.isArray(cached.items)) return;
      const byId = new Map(cached.items.map((item) => [item.id, item]));
      for (const item of current?.items ?? []) byId.set(item.id, item);
      this.set({ timelines: { ...this.state.timelines, [agentId]: { ...(current ?? EMPTY), items: [...byId.values()], hasMore: cached.hasMore, cached: true } } });
      markEnd(`open:${agentId}`, `cache ${cached.items.length} items`);
      markStart(`open-sync:${agentId}`);
    } catch {
    }
  }

  private clearTimelineRetry(agentId: string) {
    const timer = this.timelineRetryTimers.get(agentId);
    if (timer !== undefined) clearTimeout(timer);
    this.timelineRetryTimers.delete(agentId);
  }

  closeSession(agentId: string) {
    this.opened.delete(agentId);
    this.clearTimelineRetry(agentId);
    const link = this.link;
    if (link?.status === "online") void link.call("agents.setOpen", { agentIds: [...this.opened] }).catch(() => {});
    void this.flushSave();
  }

  async syncTimeline(agentId: string, attempt = 0) {
    const link = this.link;
    if (link?.status !== "online") return;
    const pending = this.timelineRequests.get(agentId);
    if (pending) return pending;
    this.clearTimelineRetry(agentId);
    const started = now();
    const limit = attempt > 0 && !this.state.timelines[agentId]?.synced ? 16 : PAGE;
    const request = link.call("agents.timelinePage", { agentId, limit }, attempt > 0 ? 30_000 : 8_000).then((result) => {
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
      const transient = error instanceof TransportError;
      if (transient && this.opened.has(agentId) && link.status === "online") {
        const delay = Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5));
        const timer = setTimeout(() => {
          this.timelineRetryTimers.delete(agentId);
          void this.syncTimeline(agentId, attempt + 1);
        }, delay);
        this.timelineRetryTimers.set(agentId, timer);
      }
      this.set({ timelines: { ...this.state.timelines, [agentId]: { ...current, loading: false, error: transient ? undefined : message(error) } } });
    }).finally(() => {
      if (this.timelineRequests.get(agentId) === request) this.timelineRequests.delete(agentId);
    });
    this.timelineRequests.set(agentId, request);
    this.set({ timelines: { ...this.state.timelines, [agentId]: { ...(this.state.timelines[agentId] ?? EMPTY), loading: true, error: undefined } } });
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

  send(agentId: string, prompt: string, opts: { steer?: boolean; images?: ImageRef[]; files?: MobileFileRef[] } = {}) {
    return this.call("agents.send", { agentId, prompt, steer: opts.steer === true, ...(opts.images?.length ? { images: opts.images } : {}), ...(opts.files?.length ? { files: opts.files } : {}) }) as Promise<{ queued: boolean }>;
  }

  createSession(workspaceId: string | null, prompt: string, images?: ImageRef[], worktree?: MobileWorktreeRequest, selection?: MobileModelSelection, files?: MobileFileRef[]) {
    const params: MobileSessionRequest = { workspaceId, prompt, ...(images?.length ? { images } : {}), ...(files?.length ? { files } : {}), ...(worktree ? { worktree } : {}) };
    if (!selection) return this.call("agents.create", params, worktree ? 90_000 : undefined) as Promise<Agent>;
    return this.modelCall<Agent>("mobile.createSession", { ...params, selection }, MODEL_TIMEOUT_MS + (worktree ? 90_000 : 0));
  }

  sendFeedback(request: PhoneFeedbackRequest) {
    return this.call("mobile.feedback", request, 60_000) as Promise<Agent>;
  }

  private loadProvider(harness: Harness): Promise<void> {
    const provider = this.state.modelProviders[harness];
    const hasLegacyKeys = this.state.modelPins !== null && provider?.models.some((model) => !model.pinKey);
    if (!hasLegacyKeys && (this.providerFreshUntil.get(harness) ?? 0) > Date.now()) return Promise.resolve();
    const existing = this.providerRequests.get(harness);
    if (existing) return existing;
    const request = this.modelCall<MobileModelCatalog>("mobile.models", { harness }, MODEL_TIMEOUT_MS).then((catalog) => {
      if (this.providerRequests.get(harness) !== request) return;
      const provider = catalog.providers.find((item) => item.harness === harness) ?? null;
      this.set({ modelProviders: { ...this.state.modelProviders, [harness]: provider } });
      this.providerFreshUntil.set(harness, Date.now() + (provider ? 300_000 : 30_000));
      this.touch("*models");
    }).finally(() => {
      if (this.providerRequests.get(harness) === request) this.providerRequests.delete(harness);
    });
    this.providerRequests.set(harness, request);
    return request;
  }

  private customFreshUntil = 0;
  private customRequest: Promise<void> | null = null;

  loadCustomProviders(): Promise<void> {
    if (this.customFreshUntil > Date.now() && this.state.customModelProviders !== undefined) return Promise.resolve();
    if (this.customRequest) return this.customRequest;
    const generation = this.connectionGeneration;
    const request = this.call("mobile.providers", {})
      .then(async (result) => {
        const names = Array.isArray(result) ? (result as MobileCustomProvider[]) : [];
        const catalogs = await Promise.all(names.map((p) => this.modelCall<MobileModelCatalog>("mobile.models", { providerId: p.id }, MODEL_TIMEOUT_MS).catch(() => null)));
        if (generation !== this.connectionGeneration) return;
        const providers = catalogs.flatMap((catalog) => catalog?.providers.filter((p) => p.providerId) ?? []);
        this.customFreshUntil = Date.now() + 300_000;
        this.set({ customProviders: names.map((p) => ({ id: p.id, name: p.name })), customModelProviders: providers });
        this.touchIndex();
      })
      .catch(() => {
        if (generation === this.connectionGeneration) this.set({ customModelProviders: [] });
      })
      .finally(() => {
        if (this.customRequest === request) this.customRequest = null;
      });
    this.customRequest = request;
    return request;
  }

  async warmModels() {
    void this.loadCustomProviders();
    const results = await Promise.allSettled(MODEL_HARNESSES.map((harness) => this.loadProvider(harness)));
    const failed = MODEL_HARNESSES.filter((_, index) => results[index].status === "rejected");
    const missing = failed.filter((harness) => this.state.modelProviders[harness] === undefined);
    if (missing.length) this.set({ modelProviders: { ...this.state.modelProviders, ...Object.fromEntries(missing.map((harness) => [harness, null])) } });
    const firstError = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (firstError && failed.length === MODEL_HARNESSES.length && !MODEL_HARNESSES.some((harness) => this.state.modelProviders[harness])) throw firstError.reason;
  }

  async modelSwitchBlock(agentId: string, harness: Harness) {
    const catalog = await this.modelCall<MobileModelCatalog>("mobile.models", { agentId, harness, switchOnly: true }, MODEL_TIMEOUT_MS);
    return catalog.switchBlock;
  }

  private acceptModelPins(pins: string[]) {
    this.pinRevision++;
    this.set({ modelPins: pins });
    this.touchIndex();
  }

  loadModelPins(): Promise<void> {
    if (this.pinRead) return this.pinRead;
    const revision = this.pinRevision;
    const generation = this.connectionGeneration;
    const request = this.call("models.pins", {}).then((result) => {
      if (this.connectionGeneration === generation && revision === this.pinRevision && Array.isArray(result)) this.acceptModelPins(result);
    }).finally(() => {
      if (this.pinRead === request) this.pinRead = null;
    });
    this.pinRead = request;
    return request;
  }

  async setModelPin(harness: Harness, model: string, pinned: boolean, providerId?: string) {
    const revision = this.pinRevision;
    const generation = this.connectionGeneration;
    const pins = await this.call("models.setPin", { harness, model, pinned, ...(providerId ? { providerId } : {}) }) as string[];
    if (generation === this.connectionGeneration && revision === this.pinRevision) this.acceptModelPins(pins);
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

  async snoozeFollowUp(id: string, choice: SnoozeChoice) {
    this.set({ followUps: (await this.call("followUps.snooze", { id, choice })) as FollowUpsState });
  }

  async dismissFollowUp(id: string) {
    this.set({ followUps: (await this.call("followUps.dismiss", { id })) as FollowUpsState });
  }

  async keepSessionOpen(agentId: string) {
    this.set({ followUps: (await this.call("followUps.keepOpen", { agentId })) as FollowUpsState });
  }

  async checkInMate() {
    this.set({ assistant: (await this.call("assistant.checkIn", {})) as AssistantState });
  }

  async cancelMateReminder(id: string) {
    this.set({ assistant: (await this.call("assistant.cancelReminder", { id })) as AssistantState });
  }

  async undoMateAction(id: string) {
    await this.call("assistant.undo", { id });
  }

  async setDone(agentId: string, done: boolean) {
    const previous = this.state.agents.find((a) => a.id === agentId)?.done;
    const token = ++this.doneToken;
    this.pendingDone.set(agentId, { done, token });
    this.patchDone(agentId, done);
    try {
      await this.call("agents.setDone", { agentId, done });
    } catch (error) {
      if (this.pendingDone.get(agentId)?.token === token && previous !== undefined) this.patchDone(agentId, previous);
      throw error;
    } finally {
      if (this.pendingDone.get(agentId)?.token === token) this.pendingDone.delete(agentId);
    }
  }

  private withPendingDone(agent: Agent): Agent {
    const pending = this.pendingDone.get(agent.id);
    return pending && agent.done !== pending.done ? { ...agent, done: pending.done } : agent;
  }

  private patchDone(agentId: string, done: boolean) {
    if (!this.state.agents.some((a) => a.id === agentId && a.done !== done)) return;
    this.set({ agents: this.state.agents.map((a) => (a.id === agentId ? { ...a, done } : a)) });
    this.touchIndex();
  }

  clearError() {
    if (this.state.error) this.set({ error: null });
  }

  private touchIndex() {
    this.touch("*index");
  }

  private touch(part: "*index" | "*models" | "*icons") {
    this.dirty.add(part);
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
      if (key === "*models") {
        writes.push(this.cache.set(MODELS_KEY, JSON.stringify(this.state.modelProviders)));
        continue;
      }
      if (key === "*icons") {
        writes.push(this.cache.set(ICONS_KEY, JSON.stringify(this.state.workspaceIcons)));
        continue;
      }
      if (key === "*index") {
        writes.push(this.cache.set(INDEX_KEY, JSON.stringify({ agents: this.state.agents, workspaces: this.state.workspaces, recent: this.recent, hostName: this.state.hostName, modelPins: this.state.modelPins, customProviders: this.state.customProviders })));
        continue;
      }
      const timeline = this.state.timelines[key];
      if (!timeline || !this.recent.includes(key)) continue;
      if (!timeline.synced && !timeline.cached && !timeline.items.length) continue;
      const tail = timeline.items.slice(-CACHE_ITEMS);
      writes.push(this.cache.set(timelineKey(key), JSON.stringify({ items: tail, hasMore: timeline.hasMore || tail.length < timeline.items.length })));
    }
    await Promise.all(writes).catch(() => {});
  }
}

function savedObject<T extends object>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as T) : null;
  } catch {
    return null;
  }
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
