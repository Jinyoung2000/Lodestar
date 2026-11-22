import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { cp, copyFile, lstat, mkdir, readFile, readdir, rename, rm, rmdir, symlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { Agent, ChangedFile, EffortLevel, ElementInfo, Feedback, FeedbackCheck, ScreenContext, ServerEvent, TimelineItem, UserAttachment } from "../shared/protocol";
import { AUTH_PROBE_MS, authRetriesLeft, classifyFailure, classifySessionError, envRetryDelay, missingTool, type FailureKind } from "../shared/feedbackBlock";
import { canRetryChecks } from "../shared/feedbackRetry";
import { canRunAgain, isInterruptible, resumePlan } from "../shared/feedbackResume";
import { planRetention, withPolicy, protectedReason, type RetentionFacts, type RetentionPolicy, type TidyEntry, type TidyPlan, type TidyResult } from "../shared/feedbackRetention";
import { baselineKey, newFailures, plainFailures, quotedStrings, readBaselineCache, testFailures, tscFailures, writeBaselineCache, type CheckFailure, type CheckOutcome } from "./checkBaseline";
import { screenLines } from "../shared/feedbackScreen";
import { parseFeedbackReply } from "../shared/feedbackQuestion";
import { summarySource } from "../shared/feedbackSummary";
import type { RestartOutcome } from "../shared/restartGate";
import type { AgentRunner } from "./agents";
import * as gitOps from "./git";
import { claudeBin, claudeEnv, stripAppEnv } from "./claude";
import { findTranscript } from "./vscodeTimeline";
import { HOME, type Store } from "./store";
import { T } from "./strings";
import { findExecutable, loginShellPath, withLoginPath } from "./loginPath";

const execFileAsync = promisify(execFile);
const FEEDBACK_DIR = join(HOME, "feedback");
const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;
const MAX_OUTPUT = 4000;
const MAX_QUESTION = 600;
const WINDOW_PNG = "window.png";
const THUMB_URL = /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/;
const MAX_THUMB_CHARS = 60_000;
const SKIP_TOP = new Set(["dist", "dist-electron", "release", ".verify"]);
const SKIP_ANY = new Set(["node_modules", ".git", ".DS_Store"]);
const RESTART_DIRS = ["server/", "shared/", "electron/"];
const NEVER_APPLY = new Set(["package.json", "package-lock.json"]);
type CheckSpec = { name: string; command: string; args: string[]; timeoutMs: number; kind?: "tsc" | "tests" | "build"; after?: string };
const CHECKS: CheckSpec[] = [
  { name: "npx tsc --noEmit", command: "npx", args: ["tsc", "-p", "tsconfig.json", "--noEmit"], timeoutMs: 180_000, kind: "tsc" },
  { name: "npm run build", command: "npm", args: ["run", "build"], timeoutMs: 300_000, kind: "build" },
  { name: "npm test", command: "npm", args: ["test"], timeoutMs: 900_000, kind: "tests", after: "npm run build" },
];
const BASELINE_CACHE_DIR = join(FEEDBACK_DIR, "baseline-cache");
const MAX_APPLY_ATTEMPTS = 3;
const APPLY_RETRY_WAIT_MS = 2000;
const MAX_AUTO_FIXES = 5;
const FEEDBACK_MODEL = "claude-opus-5-5";
const FEEDBACK_EFFORT: EffortLevel = "high";
const MAX_REAPPLIES = 2;
const DROPPED = "dropped";
const DROPPED_FROM = "dropped-from";

type Baseline = Record<string, string>;
type SyncResult = { conflicts: { rel: string; reason: string }[]; reset: { rel: string; reason: string }[] };
type SyncMode = { reset: boolean; landed: boolean };
type Manifest = {
  appliedAt: string;
  files: { rel: string; existed: boolean; applied: string | null }[];
  hadDist: boolean;
  hadDistElectron: boolean;
};

export type FeedbackRequest = {
  text: string;
  element: ElementInfo | null;
  screenshot: string | null;
  screenshotNote: string | null;
  screen?: ScreenContext | null;
  windowScreenshot?: string | null;
  thumb?: string | null;
  blockTries?: number;
};

export type DaemonBuild = { startedAt: number; builtAt: number; bundled: boolean };

export type FeedbackDeps = {
  store: Store;
  agents: AgentRunner;
  emit: (event: ServerEvent) => void;
  srcRoot: string;
  port: number;
  restart: () => RestartOutcome | void;
  daemon?: DaemonBuild;
  busyCount: () => number;
  distSwapped?: () => Promise<void>;
  checks?: CheckSpec[];
  autoFixes?: number;
  applyRetryWaitMs?: number;
  reapplies?: number;
  hasTranscript?: (sessionId: string, cwd: string) => boolean;
  readEnv?: (force: boolean) => Promise<NodeJS.ProcessEnv>;
  retryDelaysMs?: number[];
  authProbe?: () => Promise<boolean>;
  authProbeMs?: number;
};

export class FeedbackRunner {
  private items = new Map<string, Feedback>();
  private pipelines = new Set<string>();
  private applying = false;
  private restartTimer: NodeJS.Timeout | null = null;
  private cutByRestart: string[] = [];
  private blockTimers = new Map<string, NodeJS.Timeout>();
  private authTimer: NodeJS.Timeout | null = null;
  private probing = false;
  private blockedOnLoad: string[] = [];

  get swappingDist() {
    return this.applying;
  }

  constructor(private deps: FeedbackDeps) {
    mkdirSync(FEEDBACK_DIR, { recursive: true });
    for (const name of readdirSync(FEEDBACK_DIR)) {
      const file = join(FEEDBACK_DIR, name, "state.json");
      if (!existsSync(file)) continue;
      let feedback: Feedback;
      try {
        feedback = JSON.parse(readFileSync(file, "utf8")) as Feedback;
        if (!feedback || typeof feedback !== "object" || typeof feedback.id !== "string") throw new Error("not a feedback record");
      } catch (error) {
        console.error(`[feedback] skipped unreadable ${file}: ${(error as Error).message}`);
        continue;
      }
      if (isInterruptible(feedback.status)) {
        feedback.interrupted = true;
        this.cutByRestart.push(feedback.id);
      }
      if (feedback.status === "blocked") this.blockedOnLoad.push(feedback.id);
      feedback.restartRequested = false;
      feedback.retrying = false;
      this.items.set(feedback.id, feedback);
    }
  }

  list() {
    return [...this.items.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  resolve(id: string) {
    return this.tidy(id, "resolved", T.fbResolved);
  }

  dismiss(id: string) {
    return this.tidy(id, "dismissed", T.fbDismissed);
  }

  private tidy(id: string, status: "resolved" | "dismissed", note: string) {
    const feedback = this.get(id);
    if (feedback.status !== "failed") throw new Error(T.fbErrTidyState);
    const agentStatus = (() => {
      try {
        return this.deps.store.agent(feedback.agentId).status;
      } catch {
        return "idle";
      }
    })();
    if (feedback.retrying || this.pipelines.has(id) || agentStatus === "running" || agentStatus === "waiting") throw new Error(T.fbErrTidyBusy);
    this.set(feedback, { status, seen: true, interrupted: false, resumeCount: 0 });
    this.deps.agents.notice(feedback.agentId, note);
    return feedback;
  }

  checkingCount() {
    return this.pipelines.size;
  }

  async settleOnStart() {
    const build = this.deps.daemon;
    if (!build) return;
    for (const feedback of this.list()) {
      try {
        if (feedback.status === "awaitingRestart") await this.settleAwaiting(feedback, build);
        else if (feedback.status === "reverted" && feedback.restartPending && Date.parse(feedback.updatedAt) <= build.startedAt) {
          this.set(feedback, { restartPending: false, restartRequested: false, seen: true });
          this.deps.agents.notice(feedback.agentId, T.fbReverted);
        }
      } catch (error) {
        console.error(`[feedback] settle ${feedback.id} failed`, error);
      }
    }
  }

  private async settleAwaiting(feedback: Feedback, build: DaemonBuild) {
    const manifest = await readFile(join(this.dir(feedback.id), "manifest.json"), "utf8")
      .then((text) => JSON.parse(text) as Manifest)
      .catch(() => null);
    if (manifest) {
      if (Date.parse(manifest.appliedAt) > build.startedAt) return;
      this.markSettled(feedback);
      return;
    }
    const landed = await this.landedInMain(feedback, build);
    if (!landed) return;
    await this.writeManifest(feedback, landed.files, landed.at).catch((error) => console.error(`[feedback] manifest for ${feedback.id} not written`, error));
    this.markSettled(feedback);
  }

  private markSettled(feedback: Feedback) {
    const summary = feedback.summary ?? feedback.text.slice(0, 80);
    this.set(feedback, { status: "applied", failure: null, summary, restartRequested: false, restartPending: false });
    this.deps.agents.notice(feedback.agentId, T.fbSettledOnStart(summary), undefined, foldOf(feedback.checks));
  }

  private async landedInMain(feedback: Feedback, build: DaemonBuild): Promise<{ files: Manifest["files"]; at: number } | null> {
    const baseline = await this.baseline(feedback);
    const changes = await this.diffWorktree(feedback);
    if (changes.length === 0) return null;
    const files: Manifest["files"] = [];
    let latestAny = 0;
    let latestDaemon = 0;
    for (const change of changes) {
      const target = join(this.deps.srcRoot, change.rel);
      const want = change.status === "D" ? null : await hashFile(join(feedback.worktree, change.rel));
      if ((await hashFile(target)) !== want) return null;
      if (want !== null) {
        const mtime = (await lstat(target)).mtimeMs;
        latestAny = Math.max(latestAny, mtime);
        if (RESTART_DIRS.some((d) => change.rel.startsWith(d))) latestDaemon = Math.max(latestDaemon, mtime);
      }
      files.push({ rel: change.rel, existed: change.rel in baseline, applied: want });
    }
    const inBuild = build.bundled ? build.builtAt >= latestDaemon && build.builtAt <= build.startedAt : latestDaemon <= build.startedAt;
    return inBuild ? { files, at: latestAny } : null;
  }

  private async writeManifest(feedback: Feedback, files: Manifest["files"], at: number) {
    const dir = this.dir(feedback.id);
    const baseline = await this.baseline(feedback);
    for (const file of files) {
      if (!file.existed) continue;
      await mkdir(dirname(join(dir, "backup", file.rel)), { recursive: true });
      await writeFile(join(dir, "backup", file.rel), await catBlob(this.deps.srcRoot, baseline[file.rel]));
    }
    const manifest: Manifest = { appliedAt: new Date(at || Date.now()).toISOString(), files, hadDist: false, hadDistElectron: false };
    await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  }

  async resumeInterrupted() {
    for (const feedback of this.items.values()) {
      try {
        const agent = this.deps.store.agent(feedback.agentId);
        if (agent.model !== FEEDBACK_MODEL || agent.effort !== FEEDBACK_EFFORT || agent.permissionMode !== "bypassPermissions") {
          this.deps.store.patchAgent(agent.id, { model: FEEDBACK_MODEL, effort: FEEDBACK_EFFORT, permissionMode: "bypassPermissions" });
        }
      } catch {
      }
    }
    for (const id of this.blockedOnLoad.splice(0)) {
      const waiting = this.items.get(id);
      if (waiting) this.arm(waiting);
    }
    const ids = this.cutByRestart.splice(0);
    for (const id of ids) {
      const feedback = this.items.get(id);
      if (!feedback || !isInterruptible(feedback.status) || this.pipelines.has(id)) continue;
      try {
        await this.resumeOne(feedback);
      } catch (error) {
        this.giveUp(feedback, (error as Error).message);
      }
    }
  }

  private async resumeOne(feedback: Feedback) {
    let agent: Agent | null = null;
    try {
      agent = this.deps.store.agent(feedback.agentId);
    } catch {
      agent = null;
    }
    const hasTranscript = this.deps.hasTranscript ?? ((sessionId: string, cwd: string) => findTranscript(sessionId, cwd) !== null);
    const plan = resumePlan({
      status: feedback.status,
      resumeCount: feedback.resumeCount ?? 0,
      worktreeExists: existsSync(feedback.worktree),
      baselineExists: existsSync(join(this.dir(feedback.id), "baseline.json")),
      agentExists: agent !== null,
      hasSession: !!agent?.sessionId && hasTranscript(agent.sessionId, agent.cwd),
    });
    if (plan.action === "giveUp") {
      this.giveUp(feedback, T.fbGiveUp(plan.reason));
      return;
    }
    const resumeCount = (feedback.resumeCount ?? 0) + 1;
    if (plan.action === "recheck") {
      this.set(feedback, { status: "checking", resumeCount, interrupted: true, failure: null, checks: [] });
      this.deps.agents.notice(feedback.agentId, T.fbResumedChecks);
      this.pipelines.add(feedback.id);
      void this.finalize(feedback, true)
        .then(() => (feedback.resumeCount ? this.set(feedback, { resumeCount: 0 }) : undefined))
        .catch((error) => this.fail(feedback, `${(error as Error).message}`))
        .finally(() => this.pipelines.delete(feedback.id));
      return;
    }
    this.set(feedback, { status: feedback.status === "fixing" ? "fixing" : "running", resumeCount, interrupted: true, failure: null });
    this.deps.agents.notice(feedback.agentId, T.fbResumed);
    await this.deps.agents.send(feedback.agentId, T.fbResumePrompt, { display: T.fbResumeShown });
  }

  private failConflict(feedback: Feedback, message: string) {
    this.set(feedback, { conflict: true });
    this.fail(feedback, message);
  }

  private giveUp(feedback: Feedback, message: string) {
    this.set(feedback, { interrupted: true, checks: [] });
    this.fail(feedback, message);
  }

  async runAgain(id: string, carryTries = false): Promise<Feedback> {
    const old = this.get(id);
    if (!canRunAgain(old)) throw new Error(T.fbErrRunAgainState);
    const wasBlocked = old.status === "blocked";
    const blockTries = carryTries ? (old.blockTries ?? 0) : 0;
    const dir = this.dir(id);
    const png = async (name: string, wanted: boolean) => (wanted ? ((await readFile(join(dir, name)).catch(() => null))?.toString("base64") ?? null) : null);
    const [elementPng, windowPng] = await Promise.all([png("element.png", old.screenshot), png(WINDOW_PNG, !!old.windowScreenshot)]);
    if ((old.screenshot && !elementPng) || (old.windowScreenshot && !windowPng)) throw new Error(T.fbErrRunAgainFiles);
    const next = await this.create({ text: old.text, element: old.element, screenshot: elementPng, screenshotNote: old.screenshotNote, screen: old.screen ?? null, windowScreenshot: windowPng, blockTries });
    this.set(old, wasBlocked ? { status: "dismissed", interrupted: false, sessionFailed: false, seen: true } : { interrupted: false, sessionFailed: false, seen: true });
    this.deps.agents.notice(old.agentId, T.fbRanAgain(next.id));
    return next;
  }

  get(id: string) {
    const feedback = this.items.get(id);
    if (!feedback) throw new Error(T.fbErrUnknown(id));
    return feedback;
  }

  markSeen(id: string) {
    const feedback = this.get(id);
    feedback.seen = true;
    this.save(feedback);
  }

  async sourceReady() {
    return (await gitOps.repoRoot(this.deps.srcRoot)) === this.deps.srcRoot;
  }

  async create(request: FeedbackRequest): Promise<Feedback> {
    const text = request.text.trim().slice(0, 2000);
    if (!text) throw new Error(T.fbErrEmptyText);
    const png = decodePng(request.screenshot);
    const windowPng = decodePng(request.windowScreenshot);
    const src = this.deps.srcRoot;
    if (!(await this.sourceReady())) throw new Error(T.fbErrNotGit(src));

    const thumb = request.thumb && THUMB_URL.test(request.thumb) && request.thumb.length <= MAX_THUMB_CHARS ? request.thumb : null;
    const id = randomBytes(4).toString("hex");
    const dir = this.dir(id);
    await mkdir(dir, { recursive: true });
    if (png) await writeFile(join(dir, "element.png"), png);
    if (windowPng) await writeFile(join(dir, WINDOW_PNG), windowPng);
    const screenshot = png !== null;
    if (request.element) await writeFile(join(dir, "element.json"), JSON.stringify(request.element, null, 2));
    if (request.screen) await writeFile(join(dir, "screen.json"), JSON.stringify(request.screen, null, 2));

    const worktree = await this.createWorktree(id);
    const baseline = await this.mirror(src, worktree);
    await writeFile(join(dir, "baseline.json"), JSON.stringify(baseline));

    const workspace = this.deps.store.addWorkspace(worktree, null, `Lodestar (feedback ${id})`, true);
    const now = new Date().toISOString();
    const agent: Agent = {
      id: randomUUID(),
      workspaceId: workspace.id,
      cwd: worktree,
      worktree: null,
      forkedFrom: null,
      resumeFrom: null,
      startCommit: null,
      feedbackId: id,
      title: T.fbTitle(text.replace(/\s+/g, " ").slice(0, 50)),
      sessionId: null,
      status: "idle",
      permissionMode: "bypassPermissions",
      model: FEEDBACK_MODEL,
      effort: FEEDBACK_EFFORT,
      activeModel: null,
      activeEffort: null,
      backgroundTasks: 0,
      createdAt: now,
      updatedAt: now,
    };
    const feedback: Feedback = {
      id,
      agentId: agent.id,
      text,
      element: request.element,
      screen: request.screen ?? null,
      windowScreenshot: windowPng !== null,
      screenshot,
      screenshotNote: screenshot ? null : request.screenshotNote,
      status: "running",
      summary: null,
      ...(request.blockTries ? { blockTries: request.blockTries } : {}),
      changedFiles: [],
      needsRestart: false,
      restartRequested: false,
      restartPending: false,
      checks: [],
      failure: null,
      worktree,
      seen: false,
      createdAt: now,
      updatedAt: now,
    };
    const prompt = composePrompt(feedback, dir);
    await writeFile(join(dir, "prompt.md"), prompt);
    this.items.set(id, feedback);
    this.save(feedback);
    this.deps.agents.adopt(agent, []);
    this.deps.emit({ type: "workspaces", workspaces: this.deps.store.workspaces });
    void this.deps.agents.send(agent.id, prompt, { display: text, attachments: chipsOf(request.element, windowPng ? thumb : null) }).catch((error) => console.error("[feedback] first turn failed", error));
    return feedback;
  }

  options(agent: Agent): Partial<Options> | null {
    const feedback = agent.feedbackId ? this.items.get(agent.feedbackId) : null;
    if (!feedback) return null;
    const root = feedback.worktree;
    const dir = this.dir(feedback.id);
    return {
      settingSources: [],
      tools: ["Read", "Glob", "Grep", "Edit", "Write", "Bash"],
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      additionalDirectories: [dir],
      systemPrompt: SYSTEM_PROMPT,
      canUseTool: async (toolName, input) => {
        const path = typeof input.file_path === "string" ? input.file_path : null;
        if ((toolName === "Edit" || toolName === "Write") && (!path || !isInside(root, path))) return { behavior: "deny" as const, message: T.fbDeniedPath(String(path)) };
        return { behavior: "allow" as const, updatedInput: input };
      },
    };
  }

  turnStarted(agentId: string) {
    const feedback = this.list().find((f) => f.agentId === agentId);
    if (!feedback || this.pipelines.has(feedback.id)) return;
    const status = feedback.status;
    if (status === "needsInput" || status === "noChanges" || status === "blocked" || status === "failed" || status === "resolved" || status === "dismissed") {
      this.set(feedback, { status: "running", question: null, failure: null, sessionFailed: false, ...(status === "blocked" ? { blockTries: 0 } : {}) });
    }
  }

  async beforeTurn(agentId: string, prompt: string): Promise<string> {
    const feedback = this.list().find((f) => f.agentId === agentId);
    if (!feedback) return prompt;
    const status = feedback.status;
    if (this.pipelines.has(feedback.id) || status === "running" || status === "checking" || status === "fixing" || status === "applied" || status === "reverted") return prompt;
    if (!existsSync(feedback.worktree) || !existsSync(join(this.dir(feedback.id), "baseline.json"))) return prompt;
    this.pipelines.add(feedback.id);
    try {
      const landed = status === "resolved";
      const sync = await this.syncSource(feedback, { reset: true, landed });
      if (sync.reset.length === 0) return prompt;
      const dropped = join(this.dir(feedback.id), DROPPED);
      this.deps.agents.notice(feedback.agentId, T.fbSynced(sync.reset.map((f) => f.rel)));
      return `${T.fbSyncNote(landed, sync.reset, dropped)}\n\n${prompt}`;
    } finally {
      this.pipelines.delete(feedback.id);
    }
  }

  afterTurn(agentId: string) {
    const feedback = this.list().find((f) => f.agentId === agentId);
    if (!feedback || this.pipelines.has(feedback.id)) return;
    if (feedback.status === "applied" || feedback.status === "reverted") return;
    if (feedback.resumeCount) this.set(feedback, { resumeCount: 0 });
    if (feedback.status !== "fixing" && (feedback.fixAttempts || feedback.reapplyTries)) this.set(feedback, { fixAttempts: 0, reapplyTries: 0 });

    this.pipelines.add(feedback.id);
    void this.finalize(feedback)
      .catch((error) => this.fail(feedback, `${(error as Error).message}`))
      .finally(() => this.pipelines.delete(feedback.id));
  }

  private async finalize(feedback: Feedback, retry = false, applyNow = false) {
    if (!retry && this.deps.store.agent(feedback.agentId).status === "error") {
      const last = lastSessionError(this.deps.store.timeline(feedback.agentId));
      const kind = classifySessionError(last);
      if (kind === "auth") this.block(feedback, { reason: "auth", stage: "session", problem: T.fbBlockedAuth, detail: last?.text });
      else if (kind === "network") this.block(feedback, { reason: "environment", stage: "session", problem: T.fbProblemConnect, detail: last?.text });
      else {
        this.set(feedback, { sessionFailed: true });
        this.fail(feedback, T.fbErrAgent);
      }
      return;
    }
    for (let attempt = 1; ; attempt++) {
      this.set(feedback, { status: "checking", failure: null, checks: [] });
      let sync = await this.syncSource(feedback);
      if (sync.conflicts.length && this.canReapply(feedback) && !sync.conflicts.some((c) => c.reason === T.fbConflictBinary)) {
        sync = await this.syncSource(feedback, { reset: true, landed: false });
        if (sync.reset.length) {
          this.reapply(feedback, sync.reset);
          return;
        }
      }
      const stale = await this.checkAndApply(feedback, sync, applyNow);
      if (!stale) return;
      if (attempt >= MAX_APPLY_ATTEMPTS) {
        this.failConflict(feedback, T.fbNotAppliedConflict(T.fbErrConflict(stale.join("\n"))));
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, this.deps.applyRetryWaitMs ?? APPLY_RETRY_WAIT_MS));
    }
  }

  private async checkAndApply(feedback: Feedback, sync: SyncResult, applyNow = false): Promise<string[] | null> {
    const changes = await this.diffWorktree(feedback);
    const files = changes.map((c) => c.rel);
    const needsRestart = files.some((f) => RESTART_DIRS.some((d) => f.startsWith(d)));
    this.set(feedback, { changedFiles: files, needsRestart, summary: this.summaryOf(feedback) });
    if (files.length === 0) {
      const question = this.questionOf(feedback);
      if (question) {
        this.set(feedback, { status: "needsInput", question, failure: null });
        return null;
      }
      this.set(feedback, { status: "noChanges", question: null, failure: null });
      this.deps.agents.notice(feedback.agentId, T.fbNoChanges);
      return null;
    }
    if (files.some((f) => NEVER_APPLY.has(f))) {
      this.fail(feedback, T.fbErrDependency);
      return null;
    }
    if (sync.conflicts.length) {
      this.failMerge(
        feedback,
        sync.conflicts.map((c) => `${c.rel} (${c.reason})`),
      );
      return null;
    }

    const specs = this.deps.checks ?? CHECKS;
    const { env, missing } = await this.preflight(specs);
    if (missing) {
      const detail = T.fbSearchedPath(env.PATH ?? "");
      this.set(feedback, { checks: [{ name: T.fbEnvCheck, ok: false, output: `${T.fbProblemTool(missing)}\n${detail}` }] });
      this.block(feedback, { reason: "environment", stage: "checks", problem: T.fbProblemTool(missing), detail });
      return null;
    }
    const outcome = await exclusive(() => this.runChecks(feedback, specs, env));
    if (outcome.blocked) {
      this.block(feedback, { stage: "checks", ...outcome.blocked });
      return null;
    }
    if (outcome.failed) {
      const { spec, result, verdict } = outcome.failed;
      const done = feedback.fixAttempts ?? 0;
      if (verdict.judged && done < this.maxAutoFixes()) return this.autoFix(feedback, spec, result, verdict, done + 1);
      const shown = verdict.ignored ? verdict.fresh.map((f) => f.text).join("\n") : result.output;
      this.fail(feedback, T.fbNotApplied(spec.name, shown, done), { label: T.fbBaselineLabel, text: verdict.summary });
      return null;
    }
    const checks = outcome.checks;

    if (needsRestart && !applyNow) {
      this.set(feedback, { status: "awaitingRestart", failure: null });
      this.deps.agents.notice(feedback.agentId, T.fbAwaitingRestart(ignoredOf(checks)), undefined, foldOf(checks));
      return null;
    }
    return this.applyOnce(feedback);
  }

  private async runChecks(feedback: Feedback, specs: CheckSpec[], env: NodeJS.ProcessEnv) {
    const checks: FeedbackCheck[] = [];
    const base: { dir: string | null } = { dir: null };
    try {
      for (const spec of specs) {
        const result = await runCheck(spec, feedback.worktree, env);
        if (result.ok) {
          checks.push({ name: spec.name, ok: true, output: result.output });
          this.set(feedback, { checks: [...checks] });
          continue;
        }
        if (result.kind && result.kind !== "code") {
          checks.push({ name: spec.name, ok: false, output: result.output });
          this.set(feedback, { checks: [...checks] });
          return { checks, failed: null, blocked: blockOf(result.kind, result.output) };
        }
        const verdict = await this.judgeFailure(feedback, spec, specs, result, env, base);
        const fresh = verdict.fresh.length > 0;
        checks.push({ name: spec.name, ok: !fresh, output: result.output, ignored: verdict.ignored || undefined, baseline: verdict.summary });
        this.set(feedback, { checks: [...checks] });
        if (fresh) return { checks, failed: { spec, result, verdict }, blocked: null };
      }
    } finally {
      if (base.dir) await rm(base.dir, { recursive: true, force: true });
    }
    return { checks, failed: null, blocked: null };
  }

  private maxAutoFixes() {
    return this.deps.autoFixes ?? MAX_AUTO_FIXES;
  }

  private maxReapplies() {
    return this.deps.reapplies ?? MAX_REAPPLIES;
  }

  private canReapply(feedback: Feedback) {
    if ((feedback.reapplyTries ?? 0) >= this.maxReapplies()) return false;
    try {
      this.deps.store.agent(feedback.agentId);
      return true;
    } catch {
      return false;
    }
  }

  private failMerge(feedback: Feedback, lines: string[]) {
    this.set(feedback, { checks: [{ name: T.fbMergeCheck, ok: false, output: lines.join("\n") }] });
    this.failConflict(feedback, T.fbNotAppliedConflict(T.fbErrConflict(lines.join("\n"))));
  }

  private reapply(feedback: Feedback, files: { rel: string; reason: string }[]) {
    const attempt = (feedback.reapplyTries ?? 0) + 1;
    const max = this.maxReapplies();
    this.set(feedback, { status: "fixing", reapplying: true, reapplyTries: attempt, failure: null, checks: [], conflict: false });
    this.deps.agents.notice(feedback.agentId, T.fbReapplying(attempt, max));
    void this.droppedDiff(feedback, files)
      .then((diff) => this.deps.agents.send(feedback.agentId, T.fbReapplyPrompt(attempt, max, files, join(this.dir(feedback.id), DROPPED), diff), { display: T.fbReapplyShown(attempt, max) }))
      .catch((error) => this.failMerge(feedback, [...files.map((f) => `${f.rel} (${f.reason})`), (error as Error).message]));
  }

  private async droppedDiff(feedback: Feedback, files: { rel: string }[]) {
    const dir = this.dir(feedback.id);
    const parts: string[] = [];
    for (const { rel } of files) {
      const from = existsSync(join(dir, DROPPED_FROM, rel)) ? join(DROPPED_FROM, rel) : "/dev/null";
      const to = existsSync(join(dir, DROPPED, rel)) ? join(DROPPED, rel) : "/dev/null";
      if (from === "/dev/null" && to === "/dev/null") continue;
      try {
        await execFileAsync("git", [...gitOps.GIT_PATH_FLAGS, "diff", "--no-index", "--no-color", "-U2", "--", from, to], { cwd: dir, maxBuffer: 16 * 1024 * 1024 });
      } catch (error) {
        parts.push(String((error as { stdout?: string }).stdout ?? "").trim());
      }
    }
    const text = parts.filter(Boolean).join("\n");
    return text.length > 6000 ? `${text.slice(0, 6000)}\n…` : text;
  }

  private autoFix(feedback: Feedback, spec: CheckSpec, result: CheckRun, verdict: { fresh: CheckFailure[]; summary: string }, attempt: number): null {
    this.set(feedback, { status: "fixing", fixAttempts: attempt, failure: null });
    this.deps.agents.notice(feedback.agentId, T.fbFixing(attempt, this.maxAutoFixes(), spec.name));
    const message = T.fbFixPrompt(spec.name, verdict.fresh.map((f) => f.text).join("\n").slice(0, 2000), result.output, attempt, this.maxAutoFixes());
    void this.deps.agents
      .send(feedback.agentId, message, { display: T.fbFixShown(spec.name, attempt, this.maxAutoFixes()) })
      .catch((error) => this.fail(feedback, T.fbNotApplied(spec.name, (error as Error).message, attempt - 1)));
    return null;
  }

  private async judgeFailure(feedback: Feedback, spec: CheckSpec, specs: CheckSpec[], result: CheckRun, env: NodeJS.ProcessEnv, base: { dir: string | null }) {
    try {
      const outcome = await this.baselineOutcome(feedback, spec, specs, env, base);
      if (outcome.ok) return { fresh: result.failures, ignored: 0, judged: true, summary: "This check passes without this feedback's changes." };
      let fresh = newFailures(result.failures, outcome.failures);
      if (spec.kind === "build" && !existsSync(join(feedback.worktree, "dist/index.html"))) fresh = result.failures;
      const ignoredList = result.failures.filter((f) => !fresh.includes(f));
      const head = [
        "This check also fails without this feedback's changes.",
        ...(ignoredList.length ? [`Ignored (${ignoredList.length}):`, ...ignoredList.map((f) => f.text)] : []),
        "",
        "Output without the feedback:",
      ].join("\n");
      const room = Math.max(MAX_OUTPUT - head.length - 1, 500);
      const body = outcome.output.length > room ? `…${outcome.output.slice(-room)}` : outcome.output;
      return { fresh, ignored: ignoredList.length, judged: true, summary: `${head}\n${body}` };
    } catch (error) {
      return { fresh: result.failures, ignored: 0, judged: false, summary: `The baseline run did not finish: ${(error as Error).message}` };
    }
  }

  private async baselineOutcome(feedback: Feedback, spec: CheckSpec, specs: CheckSpec[], env: NodeJS.ProcessEnv, base: { dir: string | null }): Promise<CheckOutcome> {
    const key = baselineKey(await this.baseline(feedback));
    const cached = readBaselineCache(BASELINE_CACHE_DIR, key)[spec.name];
    if (cached) return cached;
    base.dir ??= await this.materializeBase(feedback);
    const before = spec.after ? specs.find((s) => s.name === spec.after) : undefined;
    if (before && !existsSync(join(base.dir, "dist/index.html"))) writeBaselineCache(BASELINE_CACHE_DIR, key, before.name, outcomeOf(await runCodeCheck(before, base.dir, env)));
    const outcome = outcomeOf(await runCodeCheck(spec, base.dir, env));
    writeBaselineCache(BASELINE_CACHE_DIR, key, spec.name, outcome);
    return outcome;
  }

  private async materializeBase(feedback: Feedback) {
    const dir = join(this.dir(feedback.id), "base");
    await rm(dir, { recursive: true, force: true });
    const baseline = await this.baseline(feedback);
    for (const [rel, sha] of Object.entries(baseline)) {
      const target = join(dir, rel);
      await mkdir(dirname(target), { recursive: true });
      const mine = join(feedback.worktree, rel);
      if ((await hashFile(mine)) === sha) await copyFile(mine, target);
      else {
        await writeFile(target, await catBlob(this.deps.srcRoot, sha));
      }
    }
    if (existsSync(join(this.deps.srcRoot, "node_modules"))) await symlink(join(this.deps.srcRoot, "node_modules"), join(dir, "node_modules"));
    await gitOps.git(dir, ["init", "-q"]);
    return dir;
  }

  retryChecks(id: string) {
    const feedback = this.get(id);
    if (feedback.status !== "failed" && feedback.status !== "blocked") throw new Error(T.fbErrRetryState);
    if (!canRetryChecks(feedback)) throw new Error(T.fbErrRetryNotChecks);
    if (!existsSync(feedback.worktree) || !existsSync(join(this.dir(id), "baseline.json"))) throw new Error(T.fbErrRetryNoWorktree);
    const agentStatus = this.deps.store.agent(feedback.agentId).status;
    if (this.pipelines.has(id) || agentStatus === "running" || agentStatus === "waiting") throw new Error(T.fbErrRetryBusy);
    this.set(feedback, { blockTries: 0 });
    this.rerunChecks(feedback, true);
    this.deps.agents.notice(feedback.agentId, T.fbRetrying);
    return feedback;
  }

  private rerunChecks(feedback: Feedback, manual: boolean) {
    this.pipelines.add(feedback.id);
    this.set(feedback, { status: "checking", failure: null, checks: [], retrying: manual, fixAttempts: 0 });
    void this.finalize(feedback, true)
      .catch((error) => this.fail(feedback, `${(error as Error).message}`))
      .finally(() => this.pipelines.delete(feedback.id));
  }

  private block(feedback: Feedback, b: { reason: "environment" | "auth"; stage: "checks" | "session"; problem: string; detail?: string }) {
    const tries = feedback.blockTries ?? 0;
    const delay = b.reason === "environment" ? envRetryDelay(tries, this.deps.retryDelaysMs) : null;
    const exhausted = b.reason === "environment" ? delay === null : !authRetriesLeft(tries);
    const detail = b.detail?.trim() ? tail(b.detail) : "";
    if (exhausted) {
      const head = T.fbBlockedGaveUp(b.reason, b.stage, b.problem, tries);
      if (b.stage === "checks" && feedback.checks.length === 0) this.set(feedback, { checks: [{ name: T.fbEnvCheck, ok: false, output: detail || b.problem }] });
      if (b.stage === "session") this.set(feedback, { sessionFailed: true });
      this.fail(feedback, detail ? `${head}\n${detail}` : head);
      return;
    }
    const head = b.reason === "auth" ? T.fbBlockedAuth : T.fbBlockedWait(b.stage, b.problem);
    const nextRetryAt = delay === null ? null : new Date(Date.now() + delay).toISOString();
    this.set(feedback, { status: "blocked", blocked: { reason: b.reason, stage: b.stage, nextRetryAt }, failure: detail ? `${head}\n${detail}` : head, ...(tries > 0 ? { seen: true } : {}) });
    if (tries === 0) this.deps.agents.notice(feedback.agentId, head, detail || undefined);
    this.arm(feedback);
  }

  private arm(feedback: Feedback) {
    this.disarm(feedback.id);
    const b = feedback.blocked;
    if (feedback.status !== "blocked" || !b) return;
    if (b.reason === "auth") {
      this.armAuthWatch();
      return;
    }
    const wait = Math.max(0, Date.parse(b.nextRetryAt ?? "") - Date.now()) || 0;
    const timer = setTimeout(() => {
      this.blockTimers.delete(feedback.id);
      void this.resumeBlocked(feedback);
    }, wait);
    timer.unref();
    this.blockTimers.set(feedback.id, timer);
  }

  private disarm(id: string) {
    const timer = this.blockTimers.get(id);
    if (timer) clearTimeout(timer);
    this.blockTimers.delete(id);
  }

  private async resumeBlocked(feedback: Feedback) {
    const b = feedback.blocked;
    if (feedback.status !== "blocked" || !b || this.pipelines.has(feedback.id) || !this.items.has(feedback.id)) return;
    try {
      this.deps.store.agent(feedback.agentId);
    } catch {
      return;
    }
    this.set(feedback, { blockTries: (feedback.blockTries ?? 0) + 1 });
    try {
      if (b.stage === "session") {
        if (b.reason === "auth") this.deps.agents.notice(feedback.agentId, T.fbAuthResumed);
        await this.runAgain(feedback.id, true);
        return;
      }
      if (!existsSync(feedback.worktree) || !existsSync(join(this.dir(feedback.id), "baseline.json"))) throw new Error(T.fbErrRetryNoWorktree);
      if (b.reason === "environment") await this.checkEnv(true);
      this.rerunChecks(feedback, false);
    } catch (error) {
      this.fail(feedback, `${(error as Error).message}`);
    }
  }

  private armAuthWatch() {
    if (this.authTimer) return;
    this.authTimer = setInterval(() => void this.checkAuthNow(false), this.deps.authProbeMs ?? AUTH_PROBE_MS);
    this.authTimer.unref();
  }

  private authWaiting() {
    return this.list().filter((f) => f.status === "blocked" && f.blocked?.reason === "auth");
  }

  async checkAuthNow(restored: boolean) {
    const waiting = this.authWaiting();
    if (waiting.length === 0 || this.probing) {
      if (waiting.length === 0 && this.authTimer) this.stopAuthWatch();
      return;
    }
    this.probing = true;
    try {
      if (restored || (await (this.deps.authProbe ?? probeClaudeAuth)())) for (const feedback of waiting) await this.resumeBlocked(feedback);
    } finally {
      this.probing = false;
      if (this.authWaiting().length === 0) this.stopAuthWatch();
    }
  }

  authRestored() {
    void this.checkAuthNow(true);
  }

  private stopAuthWatch() {
    if (this.authTimer) clearInterval(this.authTimer);
    this.authTimer = null;
  }

  private async preflight(specs: CheckSpec[]): Promise<{ env: NodeJS.ProcessEnv; missing: string | null }> {
    let env = await this.checkEnv();
    let missing = firstMissing(specs, env.PATH);
    if (missing) {
      env = await this.checkEnv(true);
      missing = firstMissing(specs, env.PATH);
    }
    return { env, missing };
  }

  private async syncSource(feedback: Feedback, mode: SyncMode = { reset: false, landed: false }): Promise<SyncResult> {
    const src = this.deps.srcRoot;
    const baseline = await this.baseline(feedback);
    const listed = new Set((await gitOps.git(src, ["ls-files", "-co", "--exclude-standard", "-z"])).split("\0").filter(Boolean));
    const result: SyncResult = { conflicts: [], reset: [] };
    let dirty = false;
    const adopt: { rel: string; file: string }[] = [];
    const scratch = join(this.dir(feedback.id), "merge");
    try {
      for (const rel of listed) {
        const from = join(src, rel);
        if (!existsSync(from) || !lstatSync(from).isFile()) continue;
        const known = baseline[rel] ?? null;
        const theirs = await hashFile(from);
        if (theirs === known) continue;
        const mine = join(feedback.worktree, rel);
        const mineHash = await hashFile(mine);
        if (mineHash === known) {
          await mkdir(dirname(mine), { recursive: true });
          await copyFile(from, mine);
          adopt.push({ rel, file: from });
        } else if (mineHash === theirs) adopt.push({ rel, file: from });
        else if (mode.landed) {
          await this.setAside(feedback, rel, known, mineHash);
          await mkdir(dirname(mine), { recursive: true });
          await copyFile(from, mine);
          adopt.push({ rel, file: from });
          result.reset.push({ rel, reason: T.fbConflictLanded });
        } else {
          const merged = await this.mergeBoth(known, mineHash, from, mine, scratch, adopt.length);
          if ("reason" in merged && mode.reset) {
            await this.setAside(feedback, rel, known, mineHash);
            await mkdir(dirname(mine), { recursive: true });
            await copyFile(from, mine);
            adopt.push({ rel, file: from });
            result.reset.push({ rel, reason: merged.reason });
          } else if ("reason" in merged) result.conflicts.push({ rel, reason: merged.reason });
          else {
            await writeFile(mine, merged.content);
            adopt.push({ rel, file: merged.theirsCopy });
          }
        }
      }
      for (const [rel, known] of Object.entries(baseline)) {
        if (listed.has(rel) || existsSync(join(src, rel))) continue;
        const mineHash = await hashFile(join(feedback.worktree, rel));
        if (mineHash === null || mineHash === known) continue;
        if (mode.reset || mode.landed) {
          await this.setAside(feedback, rel, known, mineHash);
          await rm(join(feedback.worktree, rel), { force: true });
          delete baseline[rel];
          dirty = true;
          result.reset.push({ rel, reason: mode.landed ? T.fbConflictLanded : T.fbConflictMainDeleted });
        } else result.conflicts.push({ rel, reason: T.fbConflictMainDeleted });
      }
      if (adopt.length) {
        const hashes = await hashObjects(src, adopt.map((a) => a.file));
        adopt.forEach((a, i) => (baseline[a.rel] = hashes[i]));
        dirty = true;
      }
      if (dirty) {
        const file = join(this.dir(feedback.id), "baseline.json");
        await writeFile(`${file}.${process.pid}.tmp`, JSON.stringify(baseline));
        await rename(`${file}.${process.pid}.tmp`, file);
      }
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
    return result;
  }

  private async setAside(feedback: Feedback, rel: string, known: string | null, mineHash: string | null) {
    const dir = this.dir(feedback.id);
    const mine = join(dir, DROPPED, rel);
    const from = join(dir, DROPPED_FROM, rel);
    await mkdir(dirname(mine), { recursive: true });
    await mkdir(dirname(from), { recursive: true });
    if (mineHash !== null) await copyFile(join(feedback.worktree, rel), mine);
    else await rm(mine, { force: true });
    if (known) await writeFile(from, await catBlob(this.deps.srcRoot, known));
    else await rm(from, { force: true });
  }

  private async mergeBoth(known: string | null, mineHash: string | null, from: string, mine: string, scratch: string, index: number): Promise<{ content: Buffer; theirsCopy: string } | { reason: string }> {
    if (known === null) return { reason: T.fbConflictBothNew };
    if (mineHash === null) return { reason: T.fbConflictFeedbackDeleted };
    const [base, ours, theirs] = await Promise.all([catBlob(this.deps.srcRoot, known), readFile(mine), readFile(from)]);
    if ([base, ours, theirs].some((data) => data.includes(0))) return { reason: T.fbConflictBinary };
    await mkdir(scratch, { recursive: true });
    const files = { ours: join(scratch, "ours"), base: join(scratch, "base"), theirs: join(scratch, `theirs-${index}`) };
    await Promise.all([writeFile(files.ours, ours), writeFile(files.base, base), writeFile(files.theirs, theirs)]);
    try {
      const { stdout } = await execFileAsync("git", ["merge-file", "-p", "-L", "feedback", "-L", "start", "-L", "main", files.ours, files.base, files.theirs], { maxBuffer: 64 * 1024 * 1024, encoding: "buffer" });
      return { content: stdout, theirsCopy: files.theirs };
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      return { reason: typeof code === "number" && code > 0 && code < 128 ? T.fbConflictSameLines : T.fbConflictMergeFailed };
    }
  }

  private async apply(feedback: Feedback) {
    if (!(await this.applyOnce(feedback))) return;
    // The main folder moved on while this waited for the restart: merge it in, check again, then apply.
    this.pipelines.add(feedback.id);
    try {
      await this.finalize(feedback, true, true);
    } finally {
      this.pipelines.delete(feedback.id);
    }
  }

  private async applyOnce(feedback: Feedback): Promise<string[] | null> {
    if (this.applying) throw new Error(T.fbErrBusyApply);
    this.applying = true;
    try {
      const src = this.deps.srcRoot;
      const dir = this.dir(feedback.id);
      const baseline = await this.baseline(feedback);
      const changes = await this.diffWorktree(feedback);
      const conflicts: string[] = [];
      for (const change of changes) {
        const current = await hashFile(join(src, change.rel));
        if (current !== (baseline[change.rel] ?? null)) conflicts.push(`${change.rel} (${current === null ? T.fbConflictMainDeleted : T.fbConflictAgain})`);
      }
      if (conflicts.length) return conflicts;

      const manifest: Manifest = { appliedAt: new Date().toISOString(), files: [], hadDist: existsSync(join(src, "dist")), hadDistElectron: existsSync(join(src, "dist-electron")) };
      for (const change of changes) {
        const target = join(src, change.rel);
        const existed = existsSync(target);
        if (existed) {
          await mkdir(dirname(join(dir, "backup", change.rel)), { recursive: true });
          await copyFile(target, join(dir, "backup", change.rel));
        }
        manifest.files.push({ rel: change.rel, existed, applied: change.status === "D" ? null : await hashFile(join(feedback.worktree, change.rel)) });
      }
      await rm(join(dir, "backup-dist"), { recursive: true, force: true });
      await rm(join(dir, "backup-dist-electron"), { recursive: true, force: true });
      if (manifest.hadDist) await cp(join(src, "dist"), join(dir, "backup-dist"), { recursive: true });
      if (manifest.hadDistElectron) await cp(join(src, "dist-electron"), join(dir, "backup-dist-electron"), { recursive: true });
      await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));

      for (const change of changes) {
        const target = join(src, change.rel);
        if (change.status === "D") await rm(target, { force: true });
        else {
          await mkdir(dirname(target), { recursive: true });
          await copyFile(join(feedback.worktree, change.rel), target);
        }
      }
      await swapDir(join(feedback.worktree, "dist"), join(src, "dist"));
      if (existsSync(join(feedback.worktree, "dist-electron"))) await swapDir(join(feedback.worktree, "dist-electron"), join(src, "dist-electron"));
      await this.deps.distSwapped?.();

      writeFileSync(join(FEEDBACK_DIR, "live-dist"), "");
      const summary = feedback.summary ?? feedback.text.slice(0, 80);
      this.set(feedback, { status: "applied", failure: null, summary, restartRequested: false });
      this.deps.agents.notice(feedback.agentId, T.fbApplied(summary, ignoredOf(feedback.checks)), undefined, foldOf(feedback.checks));
      if (!feedback.needsRestart) this.deps.emit({ type: "reload", restarting: false });
      return null;
    } finally {
      this.applying = false;
    }
  }

  async revert(id: string) {
    const feedback = this.get(id);
    if (feedback.status !== "applied") throw new Error(T.fbErrNotApplied);
    if (this.applying) throw new Error(T.fbErrBusyApply);
    this.applying = true;
    try {
      const src = this.deps.srcRoot;
      const dir = this.dir(id);
      if (existsSync(join(dir, BACKUP_PRUNED))) throw new Error(T.fbErrBackupPruned);
      const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")) as Manifest;
      const newer = this.list().find((f) => f.id !== id && f.status === "applied" && this.appliedAt(f) > manifest.appliedAt);
      if (newer) throw new Error(T.fbErrNewerApplied(newer.id));
      const conflicts: string[] = [];
      for (const file of manifest.files) {
        if ((await hashFile(join(src, file.rel))) !== file.applied) conflicts.push(file.rel);
      }
      if (conflicts.length) throw new Error(T.fbErrRevertConflict(conflicts.join("\n")));

      for (const file of manifest.files) {
        const target = join(src, file.rel);
        if (file.existed) {
          await mkdir(dirname(target), { recursive: true });
          await copyFile(join(dir, "backup", file.rel), target);
        } else await rm(target, { force: true });
      }
      if (manifest.hadDist) await swapDir(join(dir, "backup-dist"), join(src, "dist"));
      if (manifest.hadDistElectron) await swapDir(join(dir, "backup-dist-electron"), join(src, "dist-electron"));
      await this.deps.distSwapped?.();
      this.set(feedback, { status: "reverted", seen: !feedback.needsRestart, restartPending: feedback.needsRestart });
      this.deps.agents.notice(feedback.agentId, feedback.needsRestart ? T.fbRestartNeeded : T.fbReverted);
      if (!feedback.needsRestart) this.deps.emit({ type: "reload", restarting: false, immediate: true });
      return feedback;
    } finally {
      this.applying = false;
    }
  }

  private appliedAt(feedback: Feedback) {
    try {
      return (JSON.parse(readFileSync(join(this.dir(feedback.id), "manifest.json"), "utf8")) as Manifest).appliedAt;
    } catch {
      return "";
    }
  }

  requestRestart(id: string) {
    const feedback = this.get(id);
    if (feedback.status !== "awaitingRestart" && !feedback.restartPending) throw new Error(T.fbErrNotApplied);
    this.set(feedback, { restartRequested: true });
    this.pollRestart(feedback);
    return feedback;
  }

  private pollRestart(feedback: Feedback) {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    if (!feedback.restartRequested) return;
    if (this.deps.busyCount() > 0 || this.applying) {
      this.restartTimer = setTimeout(() => this.pollRestart(feedback), 1000);
      return;
    }
    void (async () => {
      try {
        if (feedback.status === "awaitingRestart") await this.apply(feedback);
        if (feedback.status === "applied" || feedback.restartPending) {
          const outcome = this.deps.restart();
          const deferred = !!outcome && outcome.deferred;
          this.set(feedback, { restartRequested: deferred, restartPending: feedback.restartPending && deferred });
        }
      } catch (error) {
        this.fail(feedback, (error as Error).message);
      }
    })();
  }

  async changes(feedbackId: string): Promise<ChangedFile[]> {
    const feedback = this.get(feedbackId);
    if (!existsSync(feedback.worktree)) return [];
    const changes = await this.diffWorktree(feedback);
    const files: ChangedFile[] = [];
    for (const change of changes) {
      const path = join(feedback.worktree, change.rel);
      const original = (await this.original(feedbackId, change.rel)) ?? "";
      const originalFile = join(this.dir(feedbackId), "original", change.rel);
      await mkdir(dirname(originalFile), { recursive: true });
      await writeFile(originalFile, original);
      const { additions, deletions } = await numstat(originalFile, change.status === "D" ? "/dev/null" : path);
      files.push({ path, rel: change.rel, status: change.status, additions, deletions });
    }
    return files.sort((a, b) => a.rel.localeCompare(b.rel));
  }

  async original(feedbackId: string, rel: string): Promise<string | null> {
    const sha = (await this.baseline(this.get(feedbackId)))[rel];
    if (!sha) return null;
    return (await catBlob(this.deps.srcRoot, sha)).toString("utf8");
  }

  async removeWorktree(agent: Agent) {
    const feedback = agent.feedbackId ? this.items.get(agent.feedbackId) : null;
    if (!feedback) return;
    if (!feedback.seen && feedback.status !== "awaitingRestart") this.set(feedback, { seen: true });
    await this.dropWorktree(feedback);
  }

  private async dropWorktree(feedback: Feedback): Promise<boolean> {
    const path = feedback.worktree;
    if (path !== this.worktreePath(feedback.id) || !existsSync(path)) return false;
    for (const name of await readdir(path)) if (name !== ".git") await rm(join(path, name), { recursive: true, force: true });
    await gitOps.git(this.deps.srcRoot, ["worktree", "remove", path]);
    await gitOps.git(this.deps.srcRoot, ["worktree", "prune"]);
    await gitOps.git(this.deps.srcRoot, ["branch", "-d", `feedback/${feedback.id}`]).catch(() => undefined);
    await rmdir(dirname(path)).catch(() => undefined);
    await this.dropGenerated(feedback.id);
    return true;
  }

  private async dropGenerated(id: string) {
    for (const name of ["original", DROPPED, DROPPED_FROM, "base"]) await rm(join(this.dir(id), name), { recursive: true, force: true });
  }

  async tidyPlan(override: Partial<RetentionPolicy> = {}, now = Date.now()): Promise<TidyPlan> {
    const policy = withPolicy(override);
    const facts = this.list().map((feedback) => this.retentionFacts(feedback));
    const decided = new Map(planRetention(facts, now, policy).map((entry) => [entry.id, entry]));
    const entries: TidyEntry[] = [];
    for (const feedback of this.list()) {
      const decision = decided.get(feedback.id)!;
      const worktree = decision.action === "worktree" || decision.action === "both";
      const backup = decision.action === "backup" || decision.action === "both";
      const dir = this.dir(feedback.id);
      const sizes = await Promise.all([
        worktree ? dirBytes(feedback.worktree) : 0,
        backup ? Promise.all(BACKUP_DIRS.map((name) => dirBytes(join(dir, name)))).then((list) => list.reduce((a, b) => a + b, 0)) : 0,
        worktree ? Promise.all(["original", DROPPED, DROPPED_FROM, "base"].map((name) => dirBytes(join(dir, name)))).then((list) => list.reduce((a, b) => a + b, 0)) : 0,
      ]);
      entries.push({
        id: feedback.id,
        text: feedback.text.replace(/\s+/g, " ").slice(0, 60),
        status: feedback.status,
        updatedAt: feedback.updatedAt,
        action: decision.action,
        reason: decision.reason,
        worktree: worktree ? feedback.worktree : null,
        worktreeBytes: sizes[0],
        backupBytes: sizes[1],
        generatedBytes: sizes[2],
      });
    }
    const picked = entries.filter((e) => e.action !== "keep");
    return {
      policy,
      now,
      entries,
      totals: {
        feedbacks: entries.length,
        kept: entries.length - picked.length,
        worktrees: entries.filter((e) => e.worktree).length,
        worktreeBytes: entries.reduce((n, e) => n + e.worktreeBytes, 0),
        backups: entries.filter((e) => e.backupBytes > 0).length,
        backupBytes: entries.reduce((n, e) => n + e.backupBytes, 0),
        generatedBytes: entries.reduce((n, e) => n + e.generatedBytes, 0),
        workspaces: entries.filter((e) => e.worktree && this.workspaceIdOf(this.items.get(e.id)!) !== null).length,
      },
    };
  }

  async tidyRun(override: Partial<RetentionPolicy> = {}, now = Date.now()): Promise<TidyResult> {
    if (this.applying) throw new Error(T.fbErrBusyApply);
    const plan = await this.tidyPlan(override, now);
    const result: TidyResult = { worktrees: 0, backups: 0, workspaces: 0, freedBytes: 0, skipped: [], failed: [] };
    for (const entry of plan.entries) {
      if (entry.action === "keep") continue;
      const feedback = this.items.get(entry.id);
      if (!feedback) continue;
      if (protectedReason(this.retentionFacts(feedback)) !== null || this.applying) {
        result.skipped.push(entry.id);
        continue;
      }
      try {
        if (entry.action === "backup" || entry.action === "both") {
          for (const name of BACKUP_DIRS) await rm(join(this.dir(feedback.id), name), { recursive: true, force: true });
          await writeFile(join(this.dir(feedback.id), BACKUP_PRUNED), new Date(now).toISOString());
          result.backups++;
          result.freedBytes += entry.backupBytes;
        }
        if (entry.worktree && (await this.dropWorktree(feedback))) {
          result.worktrees++;
          result.freedBytes += entry.worktreeBytes + entry.generatedBytes;
          const workspaceId = this.workspaceIdOf(feedback);
          if (workspaceId && this.deps.store.archiveWorkspace(workspaceId)) result.workspaces++;
        }
      } catch (error) {
        result.failed.push({ id: feedback.id, error: (error as Error).message });
      }
    }
    if (result.workspaces > 0) this.deps.emit({ type: "workspaces", workspaces: this.deps.store.workspaces });
    return result;
  }

  private workspaceIdOf(feedback: Feedback): string | null {
    try {
      return this.deps.store.agent(feedback.agentId).workspaceId;
    } catch {
      return null;
    }
  }

  private retentionFacts(feedback: Feedback): RetentionFacts {
    const dir = this.dir(feedback.id);
    const agentStatus = (() => {
      try {
        return this.deps.store.agent(feedback.agentId).status;
      } catch {
        return "idle";
      }
    })();
    const applied = Date.parse(this.appliedAt(feedback));
    return {
      id: feedback.id,
      feedback,
      updatedAt: Date.parse(feedback.updatedAt) || 0,
      appliedAt: Number.isFinite(applied) ? applied : null,
      busy: this.pipelines.has(feedback.id) || agentStatus === "running" || agentStatus === "waiting",
      hasWorktree: feedback.worktree === this.worktreePath(feedback.id) && existsSync(feedback.worktree),
      hasBackup: BACKUP_DIRS.some((name) => existsSync(join(dir, name))),
    };
  }

  private dir(id: string) {
    return join(FEEDBACK_DIR, id);
  }

  private worktreePath(id: string) {
    return join(`${this.deps.srcRoot}.worktrees`, `feedback-${id}`);
  }

  private async createWorktree(id: string) {
    const path = this.worktreePath(id);
    if (existsSync(path)) throw new Error(T.errWorktreeExists(path));
    await mkdir(dirname(path), { recursive: true });
    await gitOps.git(this.deps.srcRoot, ["worktree", "add", "--orphan", "-b", `feedback/${id}`, path]);
    return path;
  }

  private async mirror(src: string, worktree: string): Promise<Baseline> {
    const listed = (await gitOps.git(src, ["ls-files", "-co", "--exclude-standard", "-z"])).split("\0").filter(Boolean);
    const rels: string[] = [];
    for (const rel of new Set(listed)) {
      const from = join(src, rel);
      if (!existsSync(from) || !lstatSync(from).isFile()) continue;
      rels.push(rel);
      await mkdir(dirname(join(worktree, rel)), { recursive: true });
      await copyFile(from, join(worktree, rel));
    }
    if (existsSync(join(src, "node_modules"))) await symlink(join(src, "node_modules"), join(worktree, "node_modules"));
    const out = await hashObjects(src, rels.map((r) => join(src, r)));
    const baseline: Baseline = {};
    rels.forEach((rel, i) => (baseline[rel] = out[i]));
    return baseline;
  }

  private async baseline(feedback: Feedback): Promise<Baseline> {
    return JSON.parse(await readFile(join(this.dir(feedback.id), "baseline.json"), "utf8")) as Baseline;
  }

  private async diffWorktree(feedback: Feedback): Promise<{ rel: string; status: ChangedFile["status"] }[]> {
    const baseline = await this.baseline(feedback);
    const current = new Map<string, string>();
    const walk = async (dir: string) => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        const rel = relative(feedback.worktree, full);
        if (SKIP_ANY.has(entry.name) || (!rel.includes(sep) && SKIP_TOP.has(entry.name))) continue;
        if (entry.isDirectory()) await walk(full);
        else if (entry.isFile()) current.set(rel, await hashFileStrict(full));
      }
    };
    await walk(feedback.worktree);
    const changes: { rel: string; status: ChangedFile["status"] }[] = [];
    for (const [rel, sha] of current) {
      if (!(rel in baseline)) changes.push({ rel, status: "A" });
      else if (baseline[rel] !== sha) changes.push({ rel, status: "M" });
    }
    for (const rel of Object.keys(baseline)) if (!current.has(rel)) changes.push({ rel, status: "D" });
    return changes;
  }

  private questionOf(feedback: Feedback): string | null {
    const items = this.deps.store.timeline(feedback.agentId);
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (item.kind === "user") return null;
      if (item.kind !== "assistant" || !item.text.trim()) continue;
      const reply = parseFeedbackReply(item.text);
      if (!reply.question) return null;
      return reply.text.length > MAX_QUESTION ? `${reply.text.slice(0, MAX_QUESTION - 1).trimEnd()}…` : reply.text;
    }
    return null;
  }

  private summaryOf(feedback: Feedback) {
    const reply = summarySource(this.deps.store.timeline(feedback.agentId), T.fbIsFixShown);
    const first = reply === null ? "" : (parseFeedbackReply(reply).text.split("\n").find((l) => l.trim()) ?? "");
    const sentence = first.replace(/^[#>*\s-]+/, "").replace(/[*`]/g, "").trim().split(/(?<=[.!?])\s/)[0] ?? "";
    if (sentence) return sentence.length > 90 ? `${sentence.slice(0, 89).trimEnd()}…` : sentence;
    return feedback.text.slice(0, 80);
  }

  private async checkEnv(force = false): Promise<NodeJS.ProcessEnv> {
    if (this.deps.readEnv) return this.deps.readEnv(force);
    await loginShellPath({ force });
    return { ...stripAppEnv(process.env), PATH: withLoginPath(process.env.PATH) };
  }

  private fail(feedback: Feedback, failure: string, fold?: { label: string; text: string }) {
    const [head, ...rest] = failure.split("\n");
    let detail = rest.join("\n").trim();
    if (detail.length > MAX_OUTPUT) detail = `…${detail.slice(-MAX_OUTPUT)}`;
    const repeat = feedback.failureNotice?.head === head ? feedback.failureNotice : null;
    const itemId = this.deps.agents.notice(feedback.agentId, head, detail || undefined, fold, repeat?.itemId ?? undefined);
    this.set(feedback, { status: "failed", failure: detail ? `${head}\n${detail}` : head, failureNotice: { head, itemId: itemId ?? null }, ...(repeat ? { seen: feedback.seen } : {}) });
  }

  private set(feedback: Feedback, patch: Partial<Feedback>) {
    Object.assign(feedback, patch, { updatedAt: new Date().toISOString() });
    if (patch.status && patch.status !== "checking") feedback.retrying = false;
    if (patch.status && patch.status !== "running" && patch.status !== "checking" && patch.status !== "fixing") feedback.seen = patch.seen ?? false;
    if (patch.status && patch.status !== "failed" && !isInterruptible(patch.status) && patch.interrupted === undefined) feedback.interrupted = false;
    if (patch.status && patch.status !== "failed" && patch.conflict === undefined) feedback.conflict = false;
    if (patch.status && patch.status !== "fixing") feedback.reapplying = false;
    if (patch.status && !FAIL_KEEP.has(patch.status) && patch.failureNotice === undefined) feedback.failureNotice = null;
    if (patch.status && patch.status !== "blocked") {
      if (patch.blocked === undefined) feedback.blocked = null;
      this.disarm(feedback.id);
      if (BLOCK_RESET.has(patch.status) && patch.blockTries === undefined) feedback.blockTries = 0;
    }
    this.save(feedback);
  }

  private save(feedback: Feedback) {
    const file = join(this.dir(feedback.id), "state.json");
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(feedback, null, 2));
    renameSync(tmp, file);
    this.deps.emit({ type: "feedback", feedback });
  }
}

const BACKUP_DIRS = ["backup", "backup-dist", "backup-dist-electron"];
const BACKUP_PRUNED = "backup-pruned";

async function dirBytes(path: string): Promise<number> {
  let info;
  try {
    info = await lstat(path);
  } catch {
    return 0;
  }
  if (!info.isDirectory()) return info.size;
  let total = 0;
  for (const name of await readdir(path).catch(() => [])) total += await dirBytes(join(path, name));
  return total;
}

const FAIL_KEEP = new Set(["running", "checking", "fixing", "failed"]);
const BLOCK_RESET = new Set(["applied", "reverted", "noChanges", "needsInput", "awaitingRestart", "resolved", "dismissed"]);

function lastSessionError(timeline: TimelineItem[]): { text: string; auth: boolean } | null {
  for (let i = timeline.length - 1; i >= 0; i--) {
    const item = timeline[i];
    if (item.kind === "error") return { text: item.text, auth: item.auth };
  }
  return null;
}

function blockOf(kind: FailureKind, output: string): { reason: "environment" | "auth"; problem: string; detail: string } {
  if (kind === "auth") return { reason: "auth", problem: T.fbBlockedAuth, detail: output };
  const tool = missingTool(output);
  const problem = kind === "network" ? T.fbProblemNetwork : tool ? T.fbProblemTool(tool) : T.fbProblemStart;
  return { reason: "environment", problem, detail: output };
}

function requiredTools(specs: CheckSpec[]): string[] {
  const names = new Set(specs.map((s) => s.command));
  if (specs.some((s) => s.kind === "tests" || ["npm", "npx", "node"].includes(s.command))) names.add("node");
  return [...names];
}

function firstMissing(specs: CheckSpec[], path: string | undefined): string | null {
  return requiredTools(specs).find((name) => !findExecutable(name, path)) ?? null;
}

async function probeClaudeAuth(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(claudeBin(), ["auth", "status"], { env: claudeEnv(), timeout: 15_000 });
    return (JSON.parse(stdout) as { loggedIn?: boolean }).loggedIn === true;
  } catch {
    return false;
  }
}

const SYSTEM_PROMPT = [
  "You change the UI code of the Lodestar app (React, Vite, Tailwind, a Node daemon) to match one piece of feedback.",
  "Your working directory is a private copy of the source (a git worktree). You may edit only files under web/, server/, shared/ and electron/. Never edit docs/, web/tokens.css (generated), package.json, the lockfile or any config. Never commit, push or stash.",
  "Read design-system/README.md and the component card that matches the element before changing styling. Use only design-system tokens: CSS variables from web/tokens.css, the Tailwind classes defined in web/tailwind.css, and the existing classes in web/styles.css. No raw px (except 1px borders), no hex or rgb colors, no spacing classes outside the eight steps.",
  "User-facing text stays in English and lives in web/strings.ts or server/strings.ts.",
  "Make the smallest change that satisfies the feedback. When you are done, run `npx tsc -p tsconfig.json --noEmit` and `npm run lint:tokens` and fix what they report. If either reports an error, fix it yourself and run it again until it is clean. Do not stop to report an error.",
  "Talk to the user in the language they write in (Korean for this user). The English rule above applies only to UI text you put in the code.",
  "Your last message of each turn must be exactly one sentence under 80 characters, in the user's language, that says what changed (or answers their follow-up), with no other text. It is shown to the user as the summary.",
  "Never ask the user a question and never stop to wait for an answer. If the feedback is vague, pick the most reasonable interpretation, make the change, and say in the one-sentence summary what you assumed. If something fails (a check, an edit, a command), work out the cause and fix it yourself instead of giving up.",
].join("\n");

export function composePrompt(feedback: Feedback, dir: string) {
  const e = feedback.element;
  const isRegion = e?.kind === "region";
  const windowShot = feedback.windowScreenshot ? `- Screenshot of the whole window: ${join(dir, WINDOW_PNG)} (read it with the Read tool to see what the user was looking at)` : "- Whole-window screenshot: not attached";
  const lines = e
    ? [
        `Feedback: ${feedback.text}`,
        "",
        isRegion ? "The user selected a screen region in the running app. The component and DOM path describe the surrounding element:" : "The user picked this element in the running app:",
        `- Component: ${e.component ?? "unknown"} (<${e.tag}>)`,
        `- Source: ${e.sources.length ? e.sources.join(", ") : "unknown"} (line numbers are from the running build, so search nearby)`,
        `- Size: ${e.width}x${e.height}`,
        `- DOM path: ${e.domPath}`,
        e.text ? `- Text: ${e.text}` : null,
        `- Computed style: ${Object.entries(e.styles).map(([k, v]) => `${k}: ${v}`).join("; ")}`,
        feedback.screenshot ? `- Screenshot of the ${isRegion ? "selected region" : "element"}: ${join(dir, "element.png")} (read it to see what the user selected)` : `- Screenshot: not available${feedback.screenshotNote ? ` (${feedback.screenshotNote})` : ""}`,
        ...(feedback.windowScreenshot ? ["", "The screen when the feedback was sent:", ...(feedback.screen ? screenLines(feedback.screen) : []), windowShot] : []),
        "",
        "Change the source so the feedback is satisfied, within the design-system tokens.",
      ]
    : [
        `Feedback: ${feedback.text}`,
        "",
        "The user did not pick an element. Work out which part of the app they mean from the feedback text and the screen when it was sent, then find that code.",
        ...(feedback.screen ? screenLines(feedback.screen) : ["- Screen state: not available"]),
        windowShot,
        "",
        `Change the source so the feedback is satisfied, within the design-system tokens. If the feedback is vague, choose the most reasonable interpretation and make the change. Do not ask the user anything.`,
      ];
  return lines.filter((l) => l !== null).join("\n");
}

export function chipsOf(element: ElementInfo | null, thumb: string | null): UserAttachment[] {
  const chips: UserAttachment[] = [];
  if (thumb) chips.push({ kind: "screenshot", label: "Window screenshot", thumb });
  if (element) chips.push(elementChip(element));
  return chips;
}

function decodePng(base64: string | null | undefined) {
  if (!base64) return null;
  const png = Buffer.from(base64, "base64");
  if (png.length > MAX_SCREENSHOT_BYTES || png.subarray(1, 4).toString("latin1") !== "PNG") throw new Error(T.fbErrBadScreenshot);
  return png;
}

function elementChip(element: ElementInfo): UserAttachment {
  const match = /^(.*?):(\d+)(?::\d+)?$/.exec(element.sources[0] ?? "");
  const label = element.kind === "region" ? `Region ${element.width}×${element.height}` : element.component ?? `<${element.tag}>`;
  return { kind: "element", label, path: match ? match[1] : (element.sources[0] ?? null), line: match ? Number(match[2]) : null };
}

function isInside(root: string, path: string) {
  const rel = relative(root, resolve(root, path));
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep));
}

async function hashFile(file: string): Promise<string | null> {
  try {
    const st = await lstat(file);
    if (!st.isFile()) return null;
    const data = await readFile(file);
    return createHash("sha1").update(`blob ${data.length}\0`).update(data).digest("hex");
  } catch {
    return null;
  }
}

async function hashFileStrict(file: string): Promise<string> {
  const data = await readFile(file);
  return createHash("sha1").update(`blob ${data.length}\0`).update(data).digest("hex");
}

async function catBlob(cwd: string, sha: string): Promise<Buffer> {
  const { stdout } = await execFileAsync("git", ["cat-file", "blob", sha], { cwd, maxBuffer: 64 * 1024 * 1024, encoding: "buffer" });
  return stdout;
}

async function hashObjects(cwd: string, files: string[]): Promise<string[]> {
  if (!files.length) return [];
  return new Promise((resolvePromise, reject) => {
    const child = execFile("git", ["hash-object", "-w", "--stdin-paths"], { cwd, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolvePromise(stdout.split("\n").filter(Boolean));
    });
    child.stdin?.end(files.join("\n") + "\n");
  });
}

async function numstat(before: string, after: string) {
  try {
    await execFileAsync("git", [...gitOps.GIT_PATH_FLAGS, "diff", "--no-index", "--numstat", "--", before, after], { maxBuffer: 16 * 1024 * 1024 });
    return { additions: 0, deletions: 0 };
  } catch (error) {
    const stdout = String((error as { stdout?: string }).stdout ?? "");
    const [a, d] = stdout.split("\t");
    return { additions: Number(a) || 0, deletions: Number(d) || 0 };
  }
}

async function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeout: number) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, { cwd, env, timeout, maxBuffer: 32 * 1024 * 1024 });
    return { ok: true, output: tail(`${stdout}${stderr}`), full: `${stdout}${stderr}` };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; message: string; killed?: boolean; code?: string | number; syscall?: string };
    const full = `${e.stdout ?? ""}${e.stderr ?? ""}` || e.message;
    return { ok: false, output: tail(full), full, code: e.code ?? null, syscall: e.syscall ?? null };
  }
}

type CheckRun = { ok: boolean; output: string; failures: CheckFailure[]; kind?: FailureKind };

async function runCheck(spec: CheckSpec, cwd: string, env: NodeJS.ProcessEnv): Promise<CheckRun> {
  if (spec.kind === "tests") return runTests(spec, cwd, env);
  const result = await run(spec.command, spec.args, cwd, env, spec.timeoutMs);
  if (result.ok) return { ok: true, output: result.output, failures: [] };
  return { ok: false, output: result.output, failures: spec.kind === "tsc" ? tscFailures(result.full) : plainFailures(spec.name, result.full), kind: classifyFailure({ code: result.code, syscall: result.syscall, text: result.full }) };
}

async function runCodeCheck(spec: CheckSpec, cwd: string, env: NodeJS.ProcessEnv): Promise<CheckRun> {
  const result = await runCheck(spec, cwd, env);
  if (result.kind && result.kind !== "code") throw new Error(`${spec.name} could not run here (${result.kind}): ${result.output.split("\n")[0]}`);
  return result;
}

async function runTests(spec: CheckSpec, cwd: string, env: NodeJS.ProcessEnv): Promise<CheckRun> {
  let script = "";
  try {
    script = (JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as { scripts?: { test?: string } }).scripts?.test ?? "";
  } catch {
    script = "";
  }
  const parts = script.split("&&").map((p) => p.trim()).filter(Boolean);
  if (!parts.length) {
    const result = await run(spec.command, spec.args, cwd, env, spec.timeoutMs);
    return { ok: result.ok, output: result.output, failures: result.ok ? [] : testFailures(spec.name, result.full), kind: result.ok ? undefined : classifyFailure({ code: result.code, syscall: result.syscall, text: result.full }) };
  }
  const withBin = { ...env, PATH: `${join(cwd, "node_modules/.bin")}:${env.PATH ?? ""}` };
  const deadline = Date.now() + spec.timeoutMs;
  const failures: CheckFailure[] = [];
  let full = "";
  let kind: FailureKind | undefined;
  for (const part of parts) {
    const left = deadline - Date.now();
    if (left <= 0) {
      failures.push({ key: `${part}: not run, time limit`, text: `${part}: not run, time limit` });
      break;
    }
    const result = await run("sh", ["-c", part], cwd, withBin, left);
    full += `$ ${part}\n${result.full}\n`;
    if (!result.ok) {
      failures.push(...testFailures(part, result.full, knownTestNames(cwd, part)));
      const partKind = classifyFailure({ code: result.code, syscall: result.syscall, text: "" });
      if (partKind !== "code") kind ??= partKind;
    }
  }
  return { ok: failures.length === 0, output: tail(full), failures, kind };
}

function knownTestNames(cwd: string, command: string): string[] {
  const file = /\btest\/[\w.-]+\.ts\b/.exec(command)?.[0];
  if (!file) return [];
  try {
    return quotedStrings(readFileSync(join(cwd, file), "utf8"));
  } catch {
    return [];
  }
}

function outcomeOf(result: CheckRun): CheckOutcome {
  return { ok: result.ok, failures: result.failures, output: result.output };
}

function ignoredOf(checks: FeedbackCheck[]) {
  return checks.reduce((sum, c) => sum + (c.ignored ?? 0), 0);
}

function foldOf(checks: FeedbackCheck[]) {
  const parts = checks.filter((c) => c.ignored && c.baseline).map((c) => `${c.name}\n${c.baseline}`);
  return parts.length ? { label: T.fbBaselineLabel, text: parts.join("\n\n") } : undefined;
}

let lane: Promise<unknown> = Promise.resolve();
function exclusive<T>(work: () => Promise<T>): Promise<T> {
  const next = lane.then(work, work);
  lane = next.catch(() => undefined);
  return next;
}

function tail(text: string) {
  const clean = text.replace(/\u001b\[[0-9;]*m/g, "").trim();
  return clean.length > MAX_OUTPUT ? `…${clean.slice(-MAX_OUTPUT)}` : clean;
}

async function swapDir(from: string, to: string) {
  const next = `${to}.next`;
  const old = `${to}.old`;
  await rm(next, { recursive: true, force: true });
  await rm(old, { recursive: true, force: true });
  await cp(from, next, { recursive: true });
  if (existsSync(to)) await rename(to, old);
  await rename(next, to);
  await rm(old, { recursive: true, force: true });
}
