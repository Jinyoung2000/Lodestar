import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Agent, AntigravityMeta, EffortLevel, PermissionDecision, TimelineItem, UserAttachment } from "../../shared/protocol";
import { isEffortLevel } from "../../shared/protocol";
import { antigravityApprovesAll, antigravityMode } from "../../shared/antigravityPermission";
import type { CodexHost } from "../codex/runner";
import { isDirectory } from "../cwdWatch";
import { imageBlock } from "../images";
import { chatGuidance } from "../sessionEnv";
import { T } from "../strings";
import { AcpConnection, AcpError, antigravityBin, antigravityEnv } from "./acp";
import {
  chooseOption,
  currentValue,
  isAuthText,
  mergeToolCall,
  modelChoice,
  parseAgyModels,
  permissionCard,
  planToTool,
  toolToTimeline,
  type AcpConfigOption,
  type AcpPermissionOption,
  type AcpPlanEntry,
  type AcpToolCall,
} from "./mapping";

export type AntigravityHost = CodexHost;

type ToolItem = Extract<TimelineItem, { kind: "tool" }>;
type PendingApproval = { requestId: string | number; decide: (decision: PermissionDecision | "cancel") => void };
type Applied = { model: string | null; effort: string | null; mode: string | null };

type Session = {
  agentId: string;
  sessionId: string | null;
  loaded: boolean;
  replaying: boolean;
  active: boolean;
  interrupted: boolean;
  cwd: string;
  turn: number;
  promptTurn: PromptTurn | null;
  startedAt: number;
  options: AcpConfigOption[];
  applied: Applied;
  segment: { kind: "assistant" | "thinking"; id: string; text: string } | null;
  tools: Map<string, AcpToolCall>;
  recorded: Set<string>;
  approvals: Map<string, PendingApproval>;
  approvalWaitMs: number;
  approvalSince: number | null;
  interruptTimer: NodeJS.Timeout | null;
  folders: string;
};

type SessionResponse = { sessionId?: string; configOptions?: AcpConfigOption[]; models?: { currentModelId?: string } };
type PromptResponse = { stopReason?: string; usage?: { totalTokens?: number } };
type PromptTurn = { pending: number; initial: PromiseSettledResult<PromptResponse> | null };
type PromptDisplay = { display?: string; attachments?: UserAttachment[] };

function promptContent(prompt: string, shown: PromptDisplay) {
  return [
    { type: "text", text: prompt },
    ...(shown.attachments ?? []).flatMap((attachment) => {
      const block = attachment.kind === "image" ? imageBlock(attachment.id) : null;
      return block ? [{ type: "image", mimeType: block.source.media_type, data: block.source.data }] : [];
    }),
  ];
}

const INTERRUPT_GRACE_MS = 10_000;
const META_TTL_MS = 5 * 60_000;
const MODELS_TIMEOUT_MS = 30_000;
const IDLE_CLOSE_ENV_MS = Number(process.env.AGENT_NAV_IDLE_CLOSE_MS) || 0;
const EMPTY_APPLIED: Applied = { model: null, effort: null, mode: null };

export class AntigravityRunner {
  private connection: AcpConnection | null = null;
  private starting: Promise<AcpConnection> | null = null;
  private sessions = new Map<string, Session>();
  private bySession = new Map<string, string>();
  private idleTimer: NodeJS.Timeout | null = null;
  private metaCache: { at: number; meta: AntigravityMeta } | null = null;
  private learnedDefaults: { model: string | null; effort: EffortLevel | null } = { model: null, effort: null };

  constructor(private host: AntigravityHost) {}

  isActive(agentId: string) {
    return this.sessions.get(agentId)?.active === true;
  }

  activeCount() {
    let count = 0;
    for (const session of this.sessions.values()) if (session.active) count += 1 + session.approvals.size;
    return count;
  }

  isLive(agentId: string) {
    return this.isActive(agentId);
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
    session.interrupted = false;
    session.turn += 1;
    session.startedAt = Date.now();
    session.segment = null;
    session.tools.clear();
    session.recorded.clear();
    session.approvalWaitMs = 0;
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
    console.log(`[antigravity] turn ${agentId.slice(0, 8)} model=${agent.model ?? "(default)"} effort=${agent.effort ?? "(default)"} permission=${agent.permissionMode}`);
    let sessionId: string;
    let connection: AcpConnection;
    try {
      connection = await this.ensureConnection();
      sessionId = await this.ensureSession(connection, session, agent);
      await this.applyConfig(connection, session, this.host.store.agent(agentId));
    } catch (error) {
      this.failStart(session, error);
      return;
    }
    if (session.interrupted) {
      this.finishTurn(session, "interrupted");
      return;
    }
    const turn: PromptTurn = { pending: 1, initial: null };
    session.promptTurn = turn;
    void connection.request<PromptResponse>("session/prompt", { sessionId, prompt: promptContent(prompt, shown) }).then(
      (value) => {
        turn.initial = { status: "fulfilled", value };
        this.promptSettled(session, turn);
      },
      (reason: unknown) => {
        turn.initial = { status: "rejected", reason };
        this.promptSettled(session, turn);
      },
    );
  }

  steer(agentId: string, prompt: string, shown: PromptDisplay): boolean {
    const session = this.sessions.get(agentId);
    const connection = this.connection;
    const turn = session?.promptTurn;
    if (!session?.active || session.interrupted || !turn || !session.sessionId || !connection || connection.closed) return false;
    turn.pending += 1;
    this.closeSegment(session);
    this.recordPrompt(agentId, prompt, shown);
    void connection.request<PromptResponse>("session/prompt", { sessionId: session.sessionId, prompt: promptContent(prompt, shown) }).then(
      () => this.promptSettled(session, turn),
      (error: unknown) => {
        if (session.promptTurn !== turn) return;
        if (!session.interrupted) {
          const message = error instanceof Error ? error.message : String(error);
          this.host.upsert(agentId, { id: randomUUID(), kind: "error", text: T.steerFailed(message), auth: false });
          console.error("[antigravity] steering prompt failed", error);
        }
        this.promptSettled(session, turn);
      },
    );
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

  private promptSettled(session: Session, turn: PromptTurn) {
    if (session.promptTurn !== turn) return;
    turn.pending -= 1;
    if (turn.pending > 0 || !turn.initial) return;
    session.promptTurn = null;
    if (turn.initial.status === "fulfilled" || session.interrupted) {
      const response = turn.initial.status === "fulfilled" ? turn.initial.value : undefined;
      void this.onPromptEnd(session, response ?? {}).catch((error) => console.error("[antigravity] turn end failed", error));
      return;
    }
    this.settleTools(session, false);
    this.failStart(session, turn.initial.reason);
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
    if (session.sessionId && this.connection && !this.connection.closed) this.connection.notify("session/cancel", { sessionId: session.sessionId });
  }

  respond(agentId: string, itemId: string, decision: PermissionDecision) {
    const pending = this.sessions.get(agentId)?.approvals.get(itemId);
    if (!pending) throw new Error(T.errPermissionHandled);
    pending.decide(decision);
  }

  async remove(agentId: string) {
    const session = this.sessions.get(agentId);
    if (!session) return;
    await this.interrupt(agentId);
    this.dropSession(session);
  }

  closeAll() {
    this.cancelIdle();
    for (const session of this.sessions.values()) if (session.interruptTimer) clearTimeout(session.interruptTimer);
    this.connection?.close();
    this.connection = null;
    this.starting = null;
  }

  cutOffText() {
    return T.daemonStoppedMidReplyAntigravity;
  }

  async meta(refresh = false): Promise<AntigravityMeta> {
    if (!refresh && this.metaCache && Date.now() - this.metaCache.at < META_TTL_MS) return this.withDefaults(this.metaCache.meta);
    const meta = await this.readMeta();
    this.metaCache = { at: Date.now(), meta };
    return this.withDefaults(meta);
  }

  private withDefaults(meta: AntigravityMeta): AntigravityMeta {
    return { ...meta, defaultModel: this.learnedDefaults.model ?? meta.defaultModel, defaultEffort: this.learnedDefaults.effort ?? meta.defaultEffort };
  }

  private ensureConnection(): Promise<AcpConnection> {
    if (this.connection && !this.connection.closed) return Promise.resolve(this.connection);
    this.starting ??= AcpConnection.start({
      onNotification: (method, params) => this.onNotification(method, params),
      onRequest: (id, method, params) => this.onRequest(id, method, params),
      onExit: (info) => this.onExit(info),
    }).then(
      (connection) => {
        this.connection = connection;
        this.starting = null;
        console.log(`[antigravity] acp started pid=${connection.pid} version=${connection.version ?? "?"}`);
        return connection;
      },
      (error) => {
        this.starting = null;
        throw error;
      },
    );
    return this.starting;
  }

  private onExit(info: { code: number | null; signal: NodeJS.Signals | null; stderrTail: string }) {
    console.error(`[antigravity] acp exited code=${info.code} signal=${info.signal}${info.stderrTail ? ` stderr=${info.stderrTail.slice(-300)}` : ""}`);
    this.connection = null;
    for (const session of this.sessions.values()) {
      session.loaded = false;
      session.applied = { ...EMPTY_APPLIED };
      for (const pending of [...session.approvals.values()]) pending.decide("cancel");
      if (!session.active) continue;
      this.settleTools(session, false);
      this.host.upsert(session.agentId, { id: randomUUID(), kind: "error", text: T.antigravityEnded, auth: false });
      this.finishTurn(session, "error");
    }
  }

  private armIdle() {
    this.cancelIdle();
    const limit = IDLE_CLOSE_ENV_MS || this.host.idleLimitMs();
    if (limit === 0 || !this.connection) return;
    this.idleTimer = setTimeout(() => {
      if ([...this.sessions.values()].some((s) => s.active)) return this.armIdle();
      console.log("[antigravity] acp idle close");
      this.connection?.close();
      this.connection = null;
      for (const session of this.sessions.values()) {
        session.loaded = false;
        session.applied = { ...EMPTY_APPLIED };
      }
    }, limit);
    this.idleTimer.unref();
  }

  private cancelIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private sessionOf(agent: Agent): Session {
    let session = this.sessions.get(agent.id);
    if (session && !session.active && session.sessionId !== (agent.antigravitySessionId ?? null)) {
      this.dropSession(session);
      session = undefined;
    }
    if (session && session.loaded && session.folders !== this.host.store.agentRoots(agent).join("\n")) session.loaded = false;
    if (!session) {
      session = {
        agentId: agent.id,
        sessionId: agent.antigravitySessionId ?? null,
        loaded: false,
        replaying: false,
        active: false,
        interrupted: false,
        cwd: agent.cwd,
        turn: 0,
        promptTurn: null,
        startedAt: 0,
        options: [],
        applied: { ...EMPTY_APPLIED },
        segment: null,
        tools: new Map(),
        recorded: new Set(),
        approvals: new Map(),
        approvalWaitMs: 0,
        approvalSince: null,
        interruptTimer: null,
        folders: "",
      };
      this.sessions.set(agent.id, session);
      if (session.sessionId) this.bySession.set(session.sessionId, agent.id);
    }
    return session;
  }

  private dropSession(session: Session) {
    session.promptTurn = null;
    if (session.interruptTimer) clearTimeout(session.interruptTimer);
    if (session.sessionId) {
      this.bySession.delete(session.sessionId);
      const connection = this.connection;
      if (session.loaded && connection && !connection.closed && connection.canClose()) void connection.request("session/close", { sessionId: session.sessionId }, 5000).catch(() => undefined);
    }
    this.sessions.delete(session.agentId);
  }

  private async ensureSession(connection: AcpConnection, session: Session, agent: Agent): Promise<string> {
    if (session.loaded && session.sessionId) return session.sessionId;
    const extraDirs = this.host.store.extraDirs(agent);
    const guidance = connection.canAppendSystemPrompt() ? chatGuidance(agent, this.host.store.workspaces, { explicitId: true }) : null;
    const common = {
      cwd: agent.cwd,
      mcpServers: [],
      ...(extraDirs.length && connection.canAddDirectories() ? { additionalDirectories: extraDirs } : {}),
      ...(guidance ? { _meta: { antigravity: { systemPrompt: { append: guidance } } } } : {}),
    };
    let response: SessionResponse | null = null;
    if (session.sessionId) {
      const sessionId = session.sessionId;
      this.bySession.set(sessionId, agent.id);
      try {
        if (connection.canResume()) response = await connection.request<SessionResponse>("session/resume", { sessionId, ...common });
        else if (connection.canLoad()) {
          session.replaying = true;
          try {
            response = await connection.request<SessionResponse>("session/load", { sessionId, ...common });
          } finally {
            session.replaying = false;
          }
        }
        if (response) response = { ...response, sessionId };
      } catch (error) {
        console.error("[antigravity] resume failed, starting a new session", error);
        response = null;
      }
      if (!response) {
        this.host.upsert(agent.id, { id: randomUUID(), kind: "notice", text: T.antigravityResumeFailed });
        this.bySession.delete(sessionId);
        session.sessionId = null;
      }
    }
    if (!response) response = await connection.request<SessionResponse>("session/new", common);
    const sessionId = response?.sessionId;
    if (!sessionId) throw new AcpError("Antigravity did not return a session id");
    session.sessionId = sessionId;
    session.loaded = true;
    session.folders = [agent.cwd, ...extraDirs].join("\n");
    session.options = response.configOptions ?? [];
    this.bySession.set(sessionId, agent.id);
    const model = currentValue(session.options, "model");
    const effort = currentValue(session.options, "thought_level");
    this.learnedDefaults = { model: model ?? this.learnedDefaults.model, effort: isEffortLevel(effort) ? effort : this.learnedDefaults.effort };
    session.applied = { model: null, effort: null, mode: currentValue(session.options, "mode") };
    this.host.store.patchAgent(agent.id, { antigravitySessionId: sessionId });
    this.publishActive(session);
    return sessionId;
  }

  private async applyConfig(connection: AcpConnection, session: Session, agent: Agent) {
    const sessionId = session.sessionId!;
    const choice = modelChoice(agent.model, agent.effort, session.options);
    const set = async (configId: string, value: string) => {
      const response = await connection.request<{ configOptions?: AcpConfigOption[] }>("session/set_config_option", { sessionId, configId, value });
      if (response?.configOptions?.length) session.options = response.configOptions;
    };
    if (choice.model && session.applied.model !== choice.model) {
      await set("model", choice.model);
      session.applied.model = choice.model;
      session.applied.effort = null;
    }
    const effort = modelChoice(null, choice.effort, session.options).effort;
    if (effort && session.applied.effort !== effort) {
      await set("thought_level", effort);
      session.applied.effort = effort;
    }
    const mode = antigravityMode(agent.permissionMode);
    if (session.applied.mode !== mode) {
      await set("mode", mode);
      session.applied.mode = mode;
    }
    this.publishActive(session);
  }

  private publishActive(session: Session) {
    const model = currentValue(session.options, "model");
    const effort = currentValue(session.options, "thought_level");
    this.host.store.patchAgent(session.agentId, { activeModel: model, activeEffort: isEffortLevel(effort) ? effort : null });
    this.host.emit({ type: "agent", agent: this.host.store.agent(session.agentId) });
  }

  private failStart(session: Session, error: unknown) {
    const raw = error instanceof Error ? error.message : String(error);
    const missing = (error as NodeJS.ErrnoException)?.code === "ENOENT";
    const auth = !missing && isAuthText(raw);
    const text = missing ? T.antigravityNotInstalled(antigravityBin()) : auth ? T.antigravityNotLoggedIn : raw;
    this.host.upsert(session.agentId, { id: randomUUID(), kind: "error", text, auth });
    this.finishTurn(session, "error");
  }

  private sessionById(sessionId: unknown): Session | null {
    const agentId = typeof sessionId === "string" ? this.bySession.get(sessionId) : undefined;
    return agentId ? (this.sessions.get(agentId) ?? null) : null;
  }

  private onNotification(method: string, params: Record<string, unknown>) {
    if (method !== "session/update") return;
    const session = this.sessionById(params.sessionId);
    if (!session || session.replaying) return;
    const update = (params.update ?? {}) as Record<string, unknown> & { sessionUpdate?: string };
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        return this.appendText(session, "assistant", update.content);
      case "agent_thought_chunk":
        return this.appendText(session, "thinking", update.content);
      case "tool_call":
      case "tool_call_update":
        return this.onToolCall(session, update as unknown as Partial<AcpToolCall> & { toolCallId: string });
      case "plan": {
        const entries = (update.entries as AcpPlanEntry[] | undefined) ?? [];
        if (session.active && entries.length) this.host.upsert(session.agentId, planToTool(`agy-plan:${session.agentId}:${session.turn}`, entries));
        return;
      }
      case "usage_update": {
        const used = update.used;
        const size = update.size;
        if (typeof used === "number" && typeof size === "number" && size > 0 && used > 0) {
          this.host.store.patchAgent(session.agentId, { contextUsage: { used, limit: size, source: "api", at: new Date().toISOString() } });
          this.host.emit({ type: "agent", agent: this.host.store.agent(session.agentId) });
        }
        return;
      }
      case "config_option_update": {
        const options = update.configOptions as AcpConfigOption[] | undefined;
        if (options?.length) {
          session.options = options;
          this.publishActive(session);
        }
        return;
      }
      default:
        return;
    }
  }

  private appendText(session: Session, kind: "assistant" | "thinking", content: unknown) {
    if (!session.active) return;
    const text = content && typeof content === "object" && typeof (content as { text?: unknown }).text === "string" ? (content as { text: string }).text : "";
    if (!text) return;
    if (session.segment?.kind !== kind) {
      this.closeSegment(session);
      session.segment = { kind, id: randomUUID(), text: "" };
    }
    const segment = session.segment!;
    segment.text += text;
    if (kind === "assistant") this.host.upsert(session.agentId, { id: segment.id, kind: "assistant", text: segment.text, streaming: true });
    else if (segment.text.trim()) this.host.upsert(session.agentId, { id: segment.id, kind: "thinking", text: segment.text.trim() });
  }

  private closeSegment(session: Session) {
    const segment = session.segment;
    session.segment = null;
    if (segment?.kind !== "assistant") return;
    const model = this.host.store.agent(session.agentId).activeModel;
    this.host.upsert(session.agentId, { id: segment.id, kind: "assistant", text: segment.text, streaming: false, at: new Date().toISOString(), ...(model ? { model } : {}) });
  }

  private onToolCall(session: Session, update: Partial<AcpToolCall> & { toolCallId: string }) {
    if (!session.active || !update.toolCallId) return;
    this.closeSegment(session);
    const previous = session.tools.get(update.toolCallId);
    const call = mergeToolCall(previous, update);
    session.tools.set(call.toolCallId, call);
    const item = toolToTimeline(call, { cwd: session.cwd, interrupted: session.interrupted });
    const editing = item.name === "Write" || item.name === "Edit" || item.name === "MultiEdit";
    if (editing && typeof item.input.file_path === "string" && item.input.file_path) {
      if (!session.recorded.has(call.toolCallId)) {
        session.recorded.add(call.toolCallId);
        void this.host.recordBeforeEdit(session.agentId, item.name, item.input).catch(() => undefined);
      }
      if (item.status === "done" && previous?.status !== "completed") void this.host.recordAfterEdit(session.agentId, item.name, item.input).catch(() => undefined);
    }
    this.host.upsert(session.agentId, item);
  }

  private async onPromptEnd(session: Session, response: PromptResponse) {
    if (!session.active) return;
    if (session.interruptTimer) clearTimeout(session.interruptTimer);
    session.interruptTimer = null;
    const agentId = session.agentId;
    const turn = session.turn;
    const stop = response.stopReason ?? "end_turn";
    const interrupted = stop === "cancelled" || session.interrupted;
    this.settleTools(session, interrupted);
    this.closeSegment(session);
    if (interrupted) return this.finishTurn(session, "interrupted");
    const failed = stop === "refusal";
    if (failed) this.host.upsert(agentId, { id: randomUUID(), kind: "error", text: T.antigravityRefused, auth: false });
    if (stop === "max_tokens" || stop === "max_turn_requests") this.host.upsert(agentId, { id: randomUUID(), kind: "notice", text: T.antigravityStopped(stop) });
    const waited = session.approvalWaitMs;
    session.approvalWaitMs = 0;
    const changes = await this.host.turnChanges(agentId);
    if (this.sessions.get(agentId) !== session || !session.active || session.turn !== turn) return;
    const tokens = response.usage?.totalTokens ?? 0;
    this.host.upsert(agentId, {
      id: `agy-result:${randomUUID()}`,
      kind: "result",
      isError: failed,
      durationMs: Math.max(0, Date.now() - session.startedAt - waited),
      costUsd: null,
      ...(tokens > 0 ? { tokens } : {}),
      ...(changes ? { changes } : {}),
    });
    this.finishTurn(session, failed ? "error" : "ok");
  }

  private settleTools(session: Session, cancelled: boolean) {
    for (const item of this.host.store.timeline(session.agentId)) {
      if (item.kind !== "tool" || item.status !== "running" || !session.tools.has(item.id)) continue;
      this.host.upsert(session.agentId, { ...item, status: "error", cancelled: cancelled || undefined } as ToolItem);
    }
    for (const item of this.host.store.timeline(session.agentId)) {
      if (item.kind === "permission" && item.status === "pending") this.host.upsert(session.agentId, { ...item, status: "denied" });
    }
  }

  private finishTurn(session: Session, outcome: "ok" | "error" | "interrupted") {
    const agentId = session.agentId;
    if (!session.active) return;
    session.active = false;
    session.promptTurn = null;
    session.interrupted = false;
    if (session.interruptTimer) clearTimeout(session.interruptTimer);
    session.interruptTimer = null;
    for (const pending of [...session.approvals.values()]) pending.decide("cancel");
    session.approvals.clear();
    session.approvalSince = null;
    this.closeSegment(session);
    void this.host.finishTouch(agentId).catch((error) => console.error("[antigravity] change ledger not closed", error));
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
    if (method !== "session/request_permission") return Promise.reject(new AcpError(`Method not supported: ${method}`, -32601));
    const session = this.sessionById(params.sessionId);
    const options = (params.options as AcpPermissionOption[] | undefined) ?? [];
    if (!session?.active) return Promise.resolve({ outcome: { outcome: "cancelled" } });
    const agent = this.host.store.agent(session.agentId);
    if (antigravityApprovesAll(agent.permissionMode)) {
      const optionId = chooseOption(options, "allow");
      return Promise.resolve(optionId ? { outcome: { outcome: "selected", optionId } } : { outcome: { outcome: "cancelled" } });
    }
    return this.askApproval(session, id, params.toolCall as AcpToolCall | undefined, options);
  }

  private askApproval(session: Session, requestId: number | string, rawCall: AcpToolCall | undefined, options: AcpPermissionOption[]): Promise<unknown> {
    const agentId = session.agentId;
    const call = rawCall?.toolCallId ? mergeToolCall(session.tools.get(rawCall.toolCallId), rawCall) : { toolCallId: String(requestId), ...(rawCall ?? {}) };
    if (rawCall?.toolCallId) {
      session.tools.set(call.toolCallId, call);
      this.host.upsert(agentId, toolToTimeline({ ...call, status: "pending" }, { cwd: session.cwd }));
    }
    const card = permissionCard(requestId, call, session.cwd);
    this.host.upsert(agentId, card);
    session.approvalSince ??= Date.now();
    this.host.setStatus(agentId, "waiting");
    return new Promise((resolve) => {
      const decide = (decision: PermissionDecision | "cancel") => {
        if (!session.approvals.delete(card.id)) return;
        const optionId = decision === "cancel" ? null : chooseOption(options, decision);
        const allowed = decision === "allow" || decision === "allowAlways";
        this.host.upsert(agentId, { ...card, status: allowed && optionId ? "allowed" : "denied" });
        if (session.approvals.size === 0 && session.approvalSince !== null) {
          session.approvalWaitMs += Date.now() - session.approvalSince;
          session.approvalSince = null;
          if (session.active) this.host.setStatus(agentId, "running");
        }
        resolve(optionId ? { outcome: { outcome: "selected", optionId } } : { outcome: { outcome: "cancelled" } });
      };
      session.approvals.set(card.id, { requestId, decide });
    });
  }

  private async readMeta(): Promise<AntigravityMeta> {
    const base: AntigravityMeta = { installed: true, version: null, loggedIn: false, account: null, models: [], defaultModel: null, defaultEffort: null, error: null, fetchedAt: new Date().toISOString() };
    const bin = antigravityBin();
    const listed = await new Promise<{ stdout: string; error: (Error & { code?: string | number }) | null; stderr: string }>((resolve) => {
      execFile(bin, ["models"], { env: antigravityEnv(), timeout: MODELS_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), error }));
    });
    if (listed.error?.code === "ENOENT") return { ...base, installed: false, error: T.antigravityNotInstalled(bin) };
    base.models = parseAgyModels(listed.stdout);
    base.loggedIn = base.models.length > 0;
    if (!base.models.length) {
      const reason = (listed.stderr.trim() || listed.error?.message || "").split("\n").filter((line) => line.trim() && !/^Fetching available models/i.test(line)).join("\n").trim();
      base.error = reason ? (isAuthText(reason) ? T.antigravityNotLoggedIn : reason) : null;
      if (reason && !isAuthText(reason)) base.loggedIn = true;
    }
    const first = base.models.find((m) => m.isDefault);
    base.defaultModel = first?.value ?? null;
    if (this.connection && !this.connection.closed) base.version = this.connection.version;
    return base;
  }
}
