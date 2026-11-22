import { randomUUID } from "node:crypto";
import type { Agent, CodexMeta, CodexModelInfo, EffortLevel, PermissionDecision, QueuedMessage, ServerEvent, TimelineItem, TurnChanges, UserAttachment } from "../../shared/protocol";
import { EFFORT_LEVELS } from "../../shared/protocol";
import { CODEX_FALLBACK_MODE, codexPermission, codexSessionConfig, withWritableRoots } from "../../shared/codexPermission";
import { isDirectory } from "../cwdWatch";
import { imagePath } from "../images";
import { chatGuidance, sessionEnv } from "../sessionEnv";
import type { Store } from "../store";
import { T } from "../strings";
import { AppServer, AppServerError, CODEX_BIN } from "./appServer";
import { commandApproval, fileChangeApproval, itemToTimeline, planToTool, summarizeDiff, turnErrorOf } from "./mapping";
import type { CodexApprovalDecision, CodexPlanStep, CodexThreadItem, CodexTokenUsage, CodexTurn } from "./types";

export type CodexHost = {
  store: Store;
  emit: (event: ServerEvent) => void;
  upsert: (agentId: string, item: TimelineItem) => void;
  setStatus: (agentId: string, status: Agent["status"]) => void;
  turnStarted: (agentId: string) => void;
  turnEnded: (agentId: string) => void;
  turnChanges: (agentId: string) => Promise<TurnChanges | undefined>;
  finishTouch: (agentId: string) => Promise<void>;
  noteBash: (agentId: string) => void;
  recordBeforeEdit: (agentId: string, toolName: string, input: Record<string, unknown>) => Promise<unknown>;
  recordAfterEdit: (agentId: string, toolName: string, input: Record<string, unknown>) => Promise<unknown>;
  sendQueued: (agentId: string, next: QueuedMessage) => void;
  idleLimitMs: () => number;
};

type ToolItem = Extract<TimelineItem, { kind: "tool" }>;
type PendingApproval = { requestId: string | number; itemId: string; decide: (decision: CodexApprovalDecision) => void };

type Session = {
  agentId: string;
  threadId: string | null;
  loaded: boolean;
  turnId: string | null;
  completing: boolean;
  active: boolean;
  interrupted: boolean;
  interruptRequested: boolean;
  cwd: string;
  items: Map<string, CodexThreadItem>;
  text: Map<string, string>;
  thinking: Map<string, string[]>;
  approvals: Map<string, PendingApproval>;
  approvalWaitMs: number;
  approvalSince: number | null;
  errorShown: boolean;
  tokenBase: number;
  tokenNow: number;
  turnDiff: string | null;
  interruptTimer: NodeJS.Timeout | null;
};

const INTERRUPT_GRACE_MS = 10_000;
const STEER_TIMEOUT_MS = 10_000;
const META_TTL_MS = 5 * 60_000;
const IDLE_CLOSE_ENV_MS = Number(process.env.AGENT_NAV_IDLE_CLOSE_MS) || 0;

type PromptDisplay = { display?: string; attachments?: UserAttachment[] };

function promptInput(prompt: string, shown: PromptDisplay) {
  return [
    { type: "text", text: prompt, text_elements: [] },
    ...(shown.attachments ?? []).flatMap((attachment) => {
      const path = attachment.kind === "image" ? imagePath(attachment.id) : null;
      return path ? [{ type: "localImage", path }] : [];
    }),
  ];
}

export class CodexRunner {
  private server: AppServer | null = null;
  private starting: Promise<AppServer> | null = null;
  private sessions = new Map<string, Session>();
  private byThread = new Map<string, string>();
  private idleTimer: NodeJS.Timeout | null = null;
  private metaCache: { at: number; meta: CodexMeta } | null = null;

  constructor(private host: CodexHost) {}

  isActive(agentId: string) {
    return this.sessions.get(agentId)?.active === true;
  }

  activeCount() {
    let count = 0;
    for (const session of this.sessions.values()) if (session.active) count += 1 + session.approvals.size;
    return count;
  }

  isLive(agentId: string) {
    return this.sessions.get(agentId)?.active === true;
  }

  pendingApprovalIds(agentId: string): string[] {
    return [...(this.sessions.get(agentId)?.approvals.keys() ?? [])];
  }

  hasApproval(agentId: string, itemId: string) {
    return this.sessions.get(agentId)?.approvals.has(itemId) === true;
  }

  async startTurn(agentId: string, prompt: string, shown: PromptDisplay = {}) {
    const agent = this.host.store.agent(agentId);
    const session = this.sessionOf(agent);
    session.active = true;
    session.completing = false;
    session.interrupted = false;
    session.interruptRequested = false;
    session.errorShown = false;
    session.turnId = null;
    session.items.clear();
    session.text.clear();
    session.thinking.clear();
    session.approvalWaitMs = 0;
    session.turnDiff = null;
    session.cwd = agent.cwd;
    this.cancelIdle();
    this.recordPrompt(agentId, prompt, shown);
    if (agent.unread || agent.done) this.host.store.patchAgent(agentId, { unread: false, done: false });
    this.host.setStatus(agentId, "running");
    this.host.turnStarted(agentId);
    this.host.noteBash(agentId);
    if (!(await isDirectory(agent.cwd))) {
      this.host.upsert(agentId, { id: randomUUID(), kind: "error", text: T.errWorkingDirectoryGone(agent.cwd), auth: false });
      this.finishTurn(session, "error");
      return;
    }
    const permission = codexPermission(agent.permissionMode) ?? codexPermission(CODEX_FALLBACK_MODE)!;
    console.log(`[codex] turn ${agentId.slice(0, 8)} model=${agent.model ?? "(config default)"} effort=${agent.effort ?? "(config default)"} permission=${agent.permissionMode}`);
    try {
      const server = await this.ensureServer();
      const threadId = await this.ensureThread(server, session, agent, permission);
      const response = await server.request<{ turn?: CodexTurn }>("turn/start", {
        threadId,
        input: promptInput(prompt, shown),
        cwd: agent.cwd,
        approvalPolicy: permission.approvalPolicy,
        approvalsReviewer: permission.approvalsReviewer,
        sandboxPolicy: withWritableRoots(permission.sandboxPolicy, this.host.store.extraDirs(agent)),
        ...(agent.model ? { model: agent.model } : {}),
        ...(agent.effort ? { effort: agent.effort } : {}),
      });
      if (response.turn?.id && !session.turnId && !session.completing) session.turnId = response.turn.id;
      if (session.interruptRequested && session.turnId) void this.interruptTurn(session);
    } catch (error) {
      this.failStart(session, error);
    }
  }

  async steer(agentId: string, prompt: string, shown: PromptDisplay): Promise<boolean> {
    const session = this.sessions.get(agentId);
    const server = this.server;
    if (!session?.active || session.interrupted || session.completing || !session.threadId || !session.turnId || !server || server.closed) return false;
    const expectedTurnId = session.turnId;
    try {
      await server.request("turn/steer", { threadId: session.threadId, expectedTurnId, input: promptInput(prompt, shown) }, STEER_TIMEOUT_MS);
    } catch (error) {
      if (error instanceof AppServerError && /no active turn|expected active turn id|active turn already ended/i.test(error.message)) return false;
      throw error;
    }
    if (this.sessions.get(agentId) === session) this.recordPrompt(agentId, prompt, shown);
    return true;
  }

  private recordPrompt(agentId: string, prompt: string, shown: PromptDisplay) {
    this.host.upsert(agentId, {
      id: randomUUID(),
      kind: "user",
      text: prompt,
      source: "user",
      at: new Date().toISOString(),
      ...(shown.display !== undefined ? { shown: shown.display } : {}),
      ...(shown.attachments?.length ? { attachments: shown.attachments } : {}),
    });
  }

  async interrupt(agentId: string) {
    const session = this.sessions.get(agentId);
    if (!session?.active) return;
    for (const pending of [...session.approvals.values()]) pending.decide("cancel");
    session.interrupted = true;
    if (session.interruptTimer) clearTimeout(session.interruptTimer);
    session.interruptTimer = setTimeout(() => {
      if (!session.active || !session.interrupted) return;
      this.settleTools(session, true);
      this.finishTurn(session, "interrupted");
    }, INTERRUPT_GRACE_MS);
    session.interruptTimer.unref();
    if (!session.threadId || !session.turnId) {
      session.interruptRequested = true;
    } else {
      await this.interruptTurn(session);
    }
  }

  respond(agentId: string, itemId: string, decision: PermissionDecision) {
    const session = this.sessions.get(agentId);
    const pending = session?.approvals.get(itemId);
    if (!session || !pending) throw new Error(T.errPermissionHandled);
    pending.decide(decision === "allow" ? "accept" : decision === "allowAlways" ? "acceptForSession" : "decline");
  }

  async remove(agentId: string) {
    const session = this.sessions.get(agentId);
    if (!session) return;
    await this.interrupt(agentId);
    this.dropThread(session);
  }

  closeAll() {
    this.cancelIdle();
    for (const session of this.sessions.values()) if (session.interruptTimer) clearTimeout(session.interruptTimer);
    this.server?.close();
    this.server = null;
    this.starting = null;
  }

  cutOffText() {
    return T.daemonStoppedMidReplyCodex;
  }

  async meta(refresh = false): Promise<CodexMeta> {
    if (!refresh && this.metaCache && Date.now() - this.metaCache.at < META_TTL_MS) return this.metaCache.meta;
    const meta = await this.readMeta();
    this.metaCache = { at: Date.now(), meta };
    return meta;
  }

  private ensureServer(): Promise<AppServer> {
    if (this.server && !this.server.closed) return Promise.resolve(this.server);
    this.starting ??= AppServer.start({
      onNotification: (method, params) => this.onNotification(method, params),
      onRequest: (id, method, params) => this.onRequest(id, method, params),
      onExit: (info) => this.onExit(info),
    }).then(
      (server) => {
        this.server = server;
        this.starting = null;
        console.log(`[codex] app-server started pid=${server.pid} ${server.userAgent ?? ""}`);
        return server;
      },
      (error) => {
        this.starting = null;
        throw error;
      },
    );
    return this.starting;
  }

  private onExit(info: { code: number | null; signal: NodeJS.Signals | null; stderrTail: string }) {
    console.error(`[codex] app-server exited code=${info.code} signal=${info.signal}${info.stderrTail ? ` stderr=${info.stderrTail.slice(-300)}` : ""}`);
    this.server = null;
    for (const session of this.sessions.values()) {
      session.loaded = false;
      for (const pending of [...session.approvals.values()]) pending.decide("cancel");
      if (!session.active) continue;
      this.settleTools(session, false);
      this.host.upsert(session.agentId, { id: randomUUID(), kind: "error", text: T.codexServerEnded, auth: false });
      this.finishTurn(session, "error");
    }
  }

  private armIdle() {
    this.cancelIdle();
    const limit = IDLE_CLOSE_ENV_MS || this.host.idleLimitMs();
    if (limit === 0 || !this.server) return;
    this.idleTimer = setTimeout(() => {
      if ([...this.sessions.values()].some((s) => s.active)) return this.armIdle();
      console.log("[codex] app-server idle close");
      this.server?.close();
      this.server = null;
      for (const session of this.sessions.values()) session.loaded = false;
    }, limit);
    this.idleTimer.unref();
  }

  private cancelIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private sessionOf(agent: Agent): Session {
    let session = this.sessions.get(agent.id);
    if (session && !session.active && session.threadId !== (agent.codexThreadId ?? null)) {
      this.dropThread(session);
      session = undefined;
    }
    if (!session) {
      session = {
        agentId: agent.id,
        threadId: agent.codexThreadId ?? null,
        loaded: false,
        turnId: null,
        completing: false,
        active: false,
        interrupted: false,
        interruptRequested: false,
        cwd: agent.cwd,
        items: new Map(),
        text: new Map(),
        thinking: new Map(),
        approvals: new Map(),
        approvalWaitMs: 0,
        approvalSince: null,
        errorShown: false,
        tokenBase: 0,
        tokenNow: 0,
        turnDiff: null,
        interruptTimer: null,
      };
      this.sessions.set(agent.id, session);
      if (session.threadId) this.byThread.set(session.threadId, agent.id);
    }
    return session;
  }

  private dropThread(session: Session) {
    if (session.interruptTimer) clearTimeout(session.interruptTimer);
    if (session.threadId) {
      this.byThread.delete(session.threadId);
      if (session.loaded && this.server && !this.server.closed) void this.server.request("thread/unsubscribe", { threadId: session.threadId }).catch(() => undefined);
    }
    this.sessions.delete(session.agentId);
  }

  private async ensureThread(server: AppServer, session: Session, agent: Agent, permission: NonNullable<ReturnType<typeof codexPermission>>): Promise<string> {
    if (session.loaded && session.threadId) return session.threadId;
    const guidance = chatGuidance(agent, this.host.store.workspaces, { explicitId: false });
    const common = {
      cwd: agent.cwd,
      approvalPolicy: permission.approvalPolicy,
      approvalsReviewer: permission.approvalsReviewer,
      sandbox: permission.sandbox,
      config: codexSessionConfig(sessionEnv(agent.id)),
      ...(guidance ? { developerInstructions: guidance } : {}),
      ...(agent.model ? { model: agent.model } : {}),
    };
    let response: { thread?: { id?: string }; model?: string; reasoningEffort?: string | null } | null = null;
    if (session.threadId) {
      try {
        response = await server.request("thread/resume", { threadId: session.threadId, excludeTurns: true, ...common });
      } catch (error) {
        console.error("[codex] thread/resume failed, starting a new thread", error);
        this.host.upsert(agent.id, { id: randomUUID(), kind: "notice", text: T.codexResumeFailed });
        this.byThread.delete(session.threadId);
        session.threadId = null;
      }
    }
    if (!response) response = await server.request("thread/start", { ...common, serviceName: "lodestar" });
    const threadId = response?.thread?.id;
    if (!threadId) throw new AppServerError("Codex did not return a thread id");
    session.threadId = threadId;
    session.loaded = true;
    this.byThread.set(threadId, agent.id);
    const effort = response?.reasoningEffort;
    this.host.store.patchAgent(agent.id, {
      codexThreadId: threadId,
      activeModel: response?.model ?? null,
      activeEffort: effort && (EFFORT_LEVELS as string[]).includes(effort) ? (effort as EffortLevel) : null,
    });
    this.host.emit({ type: "agent", agent: this.host.store.agent(agent.id) });
    return threadId;
  }

  private async interruptTurn(session: Session) {
    if (!this.server || this.server.closed || !session.threadId || !session.turnId) return;
    try {
      await this.server.request("turn/interrupt", { threadId: session.threadId, turnId: session.turnId }, INTERRUPT_GRACE_MS);
    } catch (error) {
      console.error("[codex] turn/interrupt failed", error);
    }
  }

  private failStart(session: Session, error: unknown) {
    const raw = error instanceof Error ? error.message : String(error);
    const missing = (error as NodeJS.ErrnoException)?.code === "ENOENT";
    const text = missing ? T.codexNotInstalled(CODEX_BIN) : raw;
    const auth = /not logged in|log in|login|unauthorized|401/i.test(raw);
    this.host.upsert(session.agentId, { id: randomUUID(), kind: "error", text: auth ? T.codexNotLoggedIn : text, auth });
    this.finishTurn(session, "error");
  }

  private sessionByThread(threadId: unknown): Session | null {
    const agentId = typeof threadId === "string" ? this.byThread.get(threadId) : undefined;
    return agentId ? (this.sessions.get(agentId) ?? null) : null;
  }

  private onNotification(method: string, params: Record<string, unknown>) {
    const session = this.sessionByThread(params.threadId);
    if (!session) return;
    switch (method) {
      case "turn/started": {
        const turn = params.turn as CodexTurn | undefined;
        if (turn?.id) session.turnId = turn.id;
        if (session.interruptRequested) void this.interruptTurn(session);
        return;
      }
      case "item/started":
        return this.onItem(session, params.item as CodexThreadItem, "started");
      case "item/completed":
        return this.onItem(session, params.item as CodexThreadItem, "completed");
      case "item/agentMessage/delta": {
        const id = String(params.itemId);
        const text = (session.text.get(id) ?? "") + String(params.delta ?? "");
        session.text.set(id, text);
        this.host.upsert(session.agentId, { id, kind: "assistant", text, streaming: true });
        return;
      }
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta": {
        const id = String(params.itemId);
        const index = Number(params.summaryIndex ?? params.contentIndex ?? 0);
        const parts = session.thinking.get(id) ?? [];
        parts[index] = (parts[index] ?? "") + String(params.delta ?? "");
        session.thinking.set(id, parts);
        const text = parts.filter(Boolean).join("\n\n").trim();
        if (text) this.host.upsert(session.agentId, { id, kind: "thinking", text });
        return;
      }
      case "item/commandExecution/outputDelta": {
        const id = String(params.itemId);
        const current = this.currentTool(session.agentId, id);
        if (current && current.status === "running") this.host.upsert(session.agentId, { ...current, output: `${current.output ?? ""}${String(params.delta ?? "")}`.slice(-20_000) });
        return;
      }
      case "item/fileChange/patchUpdated": {
        const item = session.items.get(String(params.itemId));
        if (item) {
          const next = { ...item, changes: params.changes };
          session.items.set(item.id, next);
          for (const mapped of itemToTimeline(next, "started", this.mapContext(session))) this.host.upsert(session.agentId, mapped);
        }
        return;
      }
      case "turn/plan/updated": {
        const steps = (params.plan as CodexPlanStep[] | undefined) ?? [];
        if (steps.length) this.host.upsert(session.agentId, planToTool(String(params.turnId ?? session.turnId ?? "turn"), steps));
        return;
      }
      case "turn/diff/updated":
        session.turnDiff = typeof params.diff === "string" ? params.diff : null;
        return;
      case "thread/tokenUsage/updated":
        return this.onTokenUsage(session, params.tokenUsage as CodexTokenUsage | undefined);
      case "error":
        return this.onTurnError(session, params);
      case "serverRequest/resolved": {
        const resolved = [...session.approvals.values()].find((p) => p.requestId === params.requestId);
        resolved?.decide("cancel");
        return;
      }
      case "turn/completed":
        return void this.onTurnCompleted(session, params.turn as CodexTurn).catch((error) => console.error("[codex] turn end failed", error));
      default:
        return;
    }
  }

  private mapContext(session: Session) {
    return { cwd: session.cwd, interrupted: session.interrupted };
  }

  private currentTool(agentId: string, itemId: string): ToolItem | undefined {
    const found = this.host.store.timeline(agentId).find((i) => i.id === itemId);
    return found?.kind === "tool" ? found : undefined;
  }

  private onItem(session: Session, item: CodexThreadItem | undefined, phase: "started" | "completed") {
    if (!item?.id) return;
    const agentId = session.agentId;
    session.items.set(item.id, item);
    if (item.type === "fileChange") {
      const mapped = itemToTimeline(item, phase, this.mapContext(session));
      for (const tool of mapped) {
        if (tool.kind !== "tool") continue;
        if (phase === "started") void this.host.recordBeforeEdit(agentId, tool.name, tool.input).catch(() => undefined);
        else if (tool.status === "done") void this.host.recordAfterEdit(agentId, tool.name, tool.input).catch(() => undefined);
      }
      for (const next of mapped) this.host.upsert(agentId, next);
      return;
    }
    if (item.type === "agentMessage" && phase === "completed") session.text.delete(item.id);
    const model = this.host.store.agent(agentId).activeModel;
    for (const next of itemToTimeline(item, phase, this.mapContext(session))) {
      this.host.upsert(agentId, next.kind === "assistant" && phase === "completed" && model ? { ...next, model } : next);
    }
  }

  private onTokenUsage(session: Session, usage: CodexTokenUsage | undefined) {
    if (!usage) return;
    session.tokenNow = usage.total?.totalTokens ?? session.tokenNow;
    const used = usage.last?.totalTokens;
    if (typeof used === "number" && usage.modelContextWindow) {
      const next = { used, limit: usage.modelContextWindow, source: "api" as const, at: new Date().toISOString() };
      this.host.store.patchAgent(session.agentId, { contextUsage: next });
      this.host.emit({ type: "agent", agent: this.host.store.agent(session.agentId) });
    }
  }

  private onTurnError(session: Session, params: Record<string, unknown>) {
    if (params.willRetry === true) return;
    const { text, auth } = turnErrorOf(params.error as CodexTurn["error"]);
    session.errorShown = true;
    this.host.upsert(session.agentId, { id: randomUUID(), kind: "error", text, auth });
  }

  private async onTurnCompleted(session: Session, turn: CodexTurn | undefined) {
    if (!session.active || session.completing || (session.turnId && turn?.id && session.turnId !== turn.id)) return;
    session.completing = true;
    if (session.interruptTimer) clearTimeout(session.interruptTimer);
    session.interruptTimer = null;
    const agentId = session.agentId;
    const turnId = session.turnId;
    const status = turn?.status ?? "completed";
    const interrupted = status === "interrupted" || session.interrupted;
    this.settleTools(session, interrupted);
    this.closeDrafts(session);
    if (interrupted) return this.finishTurn(session, "interrupted");
    if (status === "failed" && !session.errorShown) {
      const { text, auth } = turnErrorOf(turn?.error);
      this.host.upsert(agentId, { id: randomUUID(), kind: "error", text, auth });
    }
    const waited = session.approvalWaitMs;
    session.approvalWaitMs = 0;
    const changes = (await this.host.turnChanges(agentId)) ?? (session.turnDiff ? summarizeDiff(session.turnDiff, session.cwd) : undefined);
    if (this.sessions.get(agentId) !== session || !session.active || !session.completing || session.turnId !== turnId) return;
    const tokens = Math.max(0, session.tokenNow - session.tokenBase);
    session.tokenBase = session.tokenNow;
    this.host.upsert(agentId, {
      id: `codex-result:${turn?.id ?? randomUUID()}`,
      kind: "result",
      isError: status === "failed",
      durationMs: Math.max(0, (turn?.durationMs ?? 0) - waited),
      costUsd: null,
      ...(tokens > 0 ? { tokens } : {}),
      ...(changes ? { changes } : {}),
    });
    this.finishTurn(session, status === "failed" ? "error" : "ok");
  }

  private closeDrafts(session: Session) {
    for (const [id, text] of session.text) this.host.upsert(session.agentId, { id, kind: "assistant", text, streaming: false, at: new Date().toISOString() });
    session.text.clear();
  }

  private settleTools(session: Session, cancelled: boolean) {
    for (const item of this.host.store.timeline(session.agentId)) {
      if (item.kind !== "tool" || item.status !== "running") continue;
      this.host.upsert(session.agentId, { ...item, status: "error", cancelled: cancelled || undefined });
    }
    for (const item of this.host.store.timeline(session.agentId)) {
      if (item.kind === "permission" && item.status === "pending") this.host.upsert(session.agentId, { ...item, status: "denied" });
    }
  }

  private finishTurn(session: Session, outcome: "ok" | "error" | "interrupted") {
    const agentId = session.agentId;
    if (!session.active) return;
    session.active = false;
    session.interrupted = false;
    session.interruptRequested = false;
    if (session.interruptTimer) clearTimeout(session.interruptTimer);
    session.interruptTimer = null;
    session.approvals.clear();
    session.approvalSince = null;
    this.closeDrafts(session);
    void this.host.finishTouch(agentId).catch((error) => console.error("[codex] change ledger not closed", error));
    if (outcome === "interrupted") this.host.upsert(agentId, { id: randomUUID(), kind: "notice", text: T.stopped });
    this.host.setStatus(agentId, outcome === "error" ? "error" : "idle");
    this.host.store.updateAgent(agentId, { unread: true });
    this.host.emit({ type: "agent", agent: this.host.store.agent(agentId) });
    if (outcome !== "error") this.host.turnEnded(agentId);
    this.armIdle();
    const next = outcome === "ok" ? this.host.store.agent(agentId).queue?.[0] : undefined;
    if (next) this.host.sendQueued(agentId, next);
  }

  private onRequest(id: number | string, method: string, params: Record<string, unknown>): Promise<unknown> {
    const session = this.sessionByThread(params.threadId);
    switch (method) {
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
        return session ? this.askApproval(session, id, method, params) : Promise.resolve({ decision: "decline" });
      case "item/permissions/requestApproval":
        if (session) this.host.upsert(session.agentId, { id: randomUUID(), kind: "notice", text: T.codexExtraPermission });
        return Promise.resolve({ permissions: {}, scope: "turn" });
      case "item/tool/requestUserInput":
        if (session) this.host.upsert(session.agentId, { id: randomUUID(), kind: "notice", text: T.codexUserInput });
        return Promise.resolve({ answers: {} });
      case "mcpServer/elicitation/request":
        if (session) this.host.upsert(session.agentId, { id: randomUUID(), kind: "notice", text: T.codexElicitation(String(params.serverName ?? "MCP")) });
        return Promise.resolve({ action: "decline", content: null, _meta: null });
      default:
        return Promise.reject(new Error(`Unsupported request: ${method}`));
    }
  }

  private askApproval(session: Session, requestId: number | string, method: string, params: Record<string, unknown>): Promise<unknown> {
    const agentId = session.agentId;
    const itemId = String(params.itemId ?? "");
    const isCommand = method === "item/commandExecution/requestApproval";
    const card = isCommand ? commandApproval(requestId, params, itemId) : fileChangeApproval(requestId, params, session.items.get(itemId), session.cwd);
    if (isCommand && !this.currentTool(agentId, itemId)) {
      this.host.upsert(agentId, { id: itemId, kind: "tool", name: "Bash", input: { command: String(card.input.command ?? "") }, status: "running", output: null });
    }
    this.host.upsert(agentId, card);
    session.approvalSince ??= Date.now();
    this.host.setStatus(agentId, "waiting");
    return new Promise((resolve) => {
      const decide = (decision: CodexApprovalDecision) => {
        if (!session.approvals.delete(card.id)) return;
        const allowed = decision === "accept" || decision === "acceptForSession";
        this.host.upsert(agentId, { ...card, status: allowed ? "allowed" : "denied" });
        if (session.approvals.size === 0 && session.approvalSince !== null) {
          session.approvalWaitMs += Date.now() - session.approvalSince;
          session.approvalSince = null;
          if (session.active) this.host.setStatus(agentId, "running");
        }
        resolve({ decision });
      };
      session.approvals.set(card.id, { requestId, itemId, decide });
    });
  }

  private async readMeta(): Promise<CodexMeta> {
    const base: CodexMeta = { installed: true, version: null, loggedIn: false, account: null, models: [], defaultModel: null, defaultEffort: null, error: null, fetchedAt: new Date().toISOString() };
    let server: AppServer;
    try {
      server = await this.ensureServer();
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException)?.code === "ENOENT";
      return { ...base, installed: !missing, error: missing ? T.codexNotInstalled(CODEX_BIN) : String(error instanceof Error ? error.message : error) };
    }
    base.version = /\/(\d+\.\d+\.\d+\S*)/.exec(server.userAgent ?? "")?.[1] ?? null;
    try {
      const account = await server.request<{ account?: { type?: string; planType?: string } | null }>("account/read", {}, 15_000);
      const type = account.account?.type;
      base.loggedIn = !!account.account;
      base.account = account.account ? { type: type === "chatgpt" ? "chatgpt" : type === "apiKey" ? "apiKey" : "other", plan: account.account.planType ?? null } : null;
    } catch (error) {
      base.error = error instanceof Error ? error.message : String(error);
    }
    try {
      const list = await server.request<{ data?: Record<string, unknown>[] }>("model/list", { includeHidden: false }, 15_000);
      base.models = (list.data ?? []).map(modelOf);
    } catch (error) {
      base.error ??= error instanceof Error ? error.message : String(error);
    }
    try {
      const config = await server.request<{ config?: { model?: string | null; model_reasoning_effort?: string | null } }>("config/read", { includeLayers: false }, 15_000);
      base.defaultModel = config.config?.model ?? null;
      const effort = config.config?.model_reasoning_effort;
      base.defaultEffort = effort && (EFFORT_LEVELS as string[]).includes(effort) ? (effort as EffortLevel) : null;
    } catch {
    }
    this.armIdle();
    return base;
  }
}

function modelOf(raw: Record<string, unknown>): CodexModelInfo {
  const options = Array.isArray(raw.supportedReasoningEfforts) ? (raw.supportedReasoningEfforts as { reasoningEffort?: string }[]) : [];
  const supported = options.map((o) => o.reasoningEffort).filter((e): e is EffortLevel => !!e && (EFFORT_LEVELS as string[]).includes(e));
  const def = typeof raw.defaultReasoningEffort === "string" && (EFFORT_LEVELS as string[]).includes(raw.defaultReasoningEffort) ? (raw.defaultReasoningEffort as EffortLevel) : null;
  return {
    value: String(raw.model ?? raw.id),
    displayName: String(raw.displayName ?? raw.model ?? raw.id),
    description: typeof raw.description === "string" ? raw.description : "",
    isDefault: raw.isDefault === true,
    supportedEffortLevels: supported,
    defaultEffort: def,
  };
}
