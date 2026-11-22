import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { buildReviewInput, emptyItems, emptyLedger, extractJson, parseReview, REVIEW_LIMITS, REVIEW_SCHEMA, REVIEW_SECTIONS, REVIEW_SYSTEM_PROMPT, reviewDateKey, reviewDue, reviewMarkdown, type MorningReview, type ReviewItem, type ReviewLedger, type ReviewState, type ReviewTrigger } from "../shared/morningReview";
import type { ServerEvent } from "../shared/protocol";
import type { BoardStore } from "./board";
import { claudeBin, claudeEnv, isAuthError } from "./claude";
import { spawnInGroup } from "./processGroups";
import { HOME, type Store } from "./store";
import { T } from "./strings";

export const REVIEW_DIR = join(HOME, "reviews");
const TIMEOUT_MS = 180_000;
const TICK_MS = 60_000;
const FIRST_TICK_MS = 5_000;
const FALLBACK_MODEL = "sonnet";
const MAX_TURNS = 4;

export type ReviewModelRequest = { prompt: string; model: string | undefined; signal: AbortSignal };
export type ReviewModelResult = { structured: unknown; text: string; costUsd: number | null };
export type ReviewModelRun = (request: ReviewModelRequest) => Promise<ReviewModelResult>;

type ReviewStoreView = Pick<Store, "settings" | "agents" | "workspaces" | "timeline">;
type ReviewBoardView = Pick<BoardStore, "get" | "moveCard">;

export type ReviewDeps = {
  store: ReviewStoreView;
  board: ReviewBoardView;
  emit: (event: ServerEvent) => void;
  boardChanged: () => void;
  autoBlocked?: () => boolean;
  modelName?: () => string | undefined;
  model?: ReviewModelRun;
  now?: () => Date;
  dir?: string;
};

export class MorningReviewService {
  private reviews: MorningReview[] = [];
  private ledger: ReviewLedger = emptyLedger();
  private running = false;
  private startedAt: string | null = null;
  private error: string | null = null;
  private timers: NodeJS.Timeout[] = [];

  constructor(private deps: ReviewDeps) {
    mkdirSync(this.dir, { recursive: true });
    this.ledger = this.loadLedger();
    this.reviews = this.loadReviews();
  }

  private get dir() {
    return this.deps.dir ?? REVIEW_DIR;
  }

  private now() {
    return this.deps.now ? this.deps.now() : new Date();
  }

  state(): ReviewState {
    return { running: this.running, startedAt: this.startedAt, error: this.error, reviews: this.reviews, unreadDate: this.ledger.unreadDate };
  }

  start() {
    const first = setTimeout(() => this.tick(), FIRST_TICK_MS);
    const every = setInterval(() => this.tick(), TICK_MS);
    first.unref();
    every.unref();
    this.timers.push(first, every);
  }

  stop() {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
  }

  tick() {
    if (this.running || this.deps.autoBlocked?.()) return;
    const settings = this.deps.store.settings;
    const trigger = reviewDue(this.now(), { enabled: settings.morningReviewEnabled !== false, time: settings.morningReviewTime }, this.ledger);
    if (trigger) void this.run(trigger);
  }

  async run(trigger: ReviewTrigger): Promise<ReviewState> {
    if (this.running) throw new Error(T.errReviewRunning);
    const now = this.now();
    const date = reviewDateKey(now);
    this.running = true;
    this.startedAt = now.toISOString();
    this.error = null;
    if (trigger !== "manual") {
      this.ledger = { ...this.ledger, attemptDate: date, attempts: (this.ledger.attemptDate === date ? this.ledger.attempts : 0) + 1, lastAttemptAt: now.getTime() };
      this.saveLedger();
    }
    this.publish();
    try {
      const review = await this.build(now, date, trigger);
      this.keep(review);
      this.ledger = { ...this.ledger, lastDate: date, attemptDate: null, attempts: 0, lastAttemptAt: null, unreadDate: trigger !== "manual" && !review.empty ? date : this.ledger.unreadDate === date ? null : this.ledger.unreadDate };
      this.saveLedger();
      const counts = REVIEW_SECTIONS.map((s) => `${s}=${review.items[s].length}`).join(" ");
      console.log(`[review] ${trigger} ${date} cards=${review.cardCount} sessions=${review.sessionCount} ${review.empty ? `empty=${review.empty}` : counts} cost=$${(review.costUsd ?? 0).toFixed(4)}`);
    } catch (error) {
      const text = String(error instanceof Error ? error.message : error).slice(0, 400);
      this.error = isAuthError(text) ? T.reloginHint(text) : text;
      console.error(`[review] ${trigger} failed: ${text}`);
    } finally {
      this.running = false;
      this.startedAt = null;
      this.publish();
    }
    return this.state();
  }

  private async build(now: Date, date: string, trigger: ReviewTrigger): Promise<MorningReview> {
    const { store, board } = this.deps;
    const input = buildReviewInput({ board: board.get(), agents: store.agents, workspaces: store.workspaces, timeline: (id) => store.timeline(id), now });
    const base = { date, generatedAt: now.toISOString(), trigger, cardCount: input.cardCount, sessionCount: input.sessionCount };
    if (input.empty) return { ...base, model: null, empty: input.empty, summary: "", items: emptyItems(), costUsd: null };

    const model = this.deps.modelName?.() ?? FALLBACK_MODEL;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
    let result: ReviewModelResult;
    try {
      result = await (this.deps.model ?? runReviewModel)({ prompt: input.prompt, model, signal: abort.signal });
    } catch (error) {
      if (abort.signal.aborted) throw new Error(T.errReviewTimeout);
      throw error;
    } finally {
      clearTimeout(timer);
    }
    const parsed = parseReview(result.structured ?? result.text, input, board.get(), store.agents);
    if (!parsed.summary && REVIEW_SECTIONS.every((s) => parsed.items[s].length === 0)) throw new Error(T.errReviewEmpty);
    return { ...base, model, empty: null, summary: parsed.summary, items: parsed.items, costUsd: result.costUsd };
  }

  apply(date: string, cardIds: string[] | null): { review: ReviewState; applied: number; skipped: number } {
    const review = this.reviews.find((r) => r.date === date);
    if (!review) throw new Error(T.errReviewUnknown);
    const wanted = cardIds === null ? null : new Set(cardIds);
    let applied = 0;
    let skipped = 0;
    let changedBoard = false;
    const finished: ReviewItem[] = review.items.finished.map((item) => {
      const move = item.move;
      if (!move || move.applied || !item.cardId || (wanted && !wanted.has(item.cardId))) return item;
      const current = this.deps.board.get();
      const card = current.cards.find((c) => c.id === item.cardId);
      if (!card || !current.columns.some((c) => c.id === move.toColumnId)) {
        skipped++;
        return item;
      }
      if (card.columnId === move.toColumnId) return { ...item, move: { ...move, applied: true } };
      if (card.columnId !== move.fromColumnId) {
        skipped++;
        return item;
      }
      this.deps.board.moveCard(card.id, move.toColumnId, Number.MAX_SAFE_INTEGER);
      changedBoard = true;
      applied++;
      return { ...item, move: { ...move, applied: true } };
    });
    this.keep({ ...review, items: { ...review.items, finished } });
    if (changedBoard) this.deps.boardChanged();
    this.publish();
    return { review: this.state(), applied, skipped };
  }

  markSeen(date: string): ReviewState {
    if (this.ledger.unreadDate === date) {
      this.ledger = { ...this.ledger, unreadDate: null };
      this.saveLedger();
      this.publish();
    }
    return this.state();
  }

  private publish() {
    this.deps.emit({ type: "review", review: this.state() });
  }

  private keep(review: MorningReview) {
    const others = this.reviews.filter((r) => r.date !== review.date);
    this.reviews = [review, ...others].sort((a, b) => b.date.localeCompare(a.date)).slice(0, REVIEW_LIMITS.keepDays);
    writeAtomic(join(this.dir, `${review.date}.json`), JSON.stringify(review, null, 2));
    writeAtomic(join(this.dir, `${review.date}.md`), reviewMarkdown(review));
  }

  private loadReviews(): MorningReview[] {
    const files = readdirSync(this.dir).filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name)).sort().reverse();
    const out: MorningReview[] = [];
    for (const name of files) {
      if (out.length >= REVIEW_LIMITS.keepDays) break;
      try {
        const review = sanitizeReview(JSON.parse(readFileSync(join(this.dir, name), "utf8")), name.slice(0, 10));
        if (review) out.push(review);
      } catch {
      }
    }
    return out;
  }

  private loadLedger(): ReviewLedger {
    const file = join(this.dir, "state.json");
    if (!existsSync(file)) return emptyLedger();
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<ReviewLedger>;
      const str = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
      return {
        lastDate: str(raw.lastDate),
        attemptDate: str(raw.attemptDate),
        attempts: Number.isInteger(raw.attempts) && (raw.attempts as number) >= 0 ? (raw.attempts as number) : 0,
        lastAttemptAt: typeof raw.lastAttemptAt === "number" && Number.isFinite(raw.lastAttemptAt) ? raw.lastAttemptAt : null,
        unreadDate: str(raw.unreadDate),
      };
    } catch {
      return emptyLedger();
    }
  }

  private saveLedger() {
    writeAtomic(join(this.dir, "state.json"), JSON.stringify(this.ledger, null, 2));
  }
}

function writeAtomic(path: string, text: string) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

export function sanitizeReview(raw: unknown, date: string): MorningReview | null {
  const r = raw as Partial<MorningReview> | null;
  if (!r || typeof r !== "object" || r.date !== date || typeof r.generatedAt !== "string") return null;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const items = emptyItems();
  for (const section of REVIEW_SECTIONS) {
    const list = Array.isArray(r.items?.[section]) ? (r.items![section] as unknown[]) : [];
    for (const rawItem of list) {
      const i = rawItem as Partial<ReviewItem> | null;
      if (!i || typeof i !== "object" || (typeof i.cardId !== "string" && typeof i.agentId !== "string")) continue;
      const m = i.move;
      items[section].push({
        cardId: typeof i.cardId === "string" ? i.cardId : null,
        agentId: typeof i.agentId === "string" ? i.agentId : null,
        title: str(i.title),
        ...(typeof i.column === "string" ? { column: i.column } : {}),
        note: str(i.note),
        ...(m && typeof m === "object" && typeof m.fromColumnId === "string" && typeof m.toColumnId === "string" ? { move: { fromColumnId: m.fromColumnId, toColumnId: m.toColumnId, toColumnName: str(m.toColumnName), applied: m.applied === true } } : {}),
        ...(typeof i.idleDays === "number" ? { idleDays: i.idleDays } : {}),
      });
    }
  }
  const trigger = r.trigger === "scheduled" || r.trigger === "catchup" || r.trigger === "manual" ? r.trigger : "manual";
  return {
    date,
    generatedAt: r.generatedAt,
    trigger,
    model: typeof r.model === "string" ? r.model : null,
    empty: r.empty === "noCards" || r.empty === "allDone" ? r.empty : null,
    summary: str(r.summary),
    items,
    cardCount: typeof r.cardCount === "number" ? r.cardCount : 0,
    sessionCount: typeof r.sessionCount === "number" ? r.sessionCount : 0,
    costUsd: typeof r.costUsd === "number" ? r.costUsd : null,
  };
}

export async function runReviewModel(request: ReviewModelRequest): Promise<ReviewModelResult> {
  const q = query({
    prompt: request.prompt,
    options: {
      cwd: HOME,
      env: claudeEnv(),
      model: request.model,
      maxTurns: MAX_TURNS,
      thinking: { type: "disabled" },
      tools: [],
      allowedTools: [],
      permissionMode: "dontAsk",
      settingSources: [],
      strictMcpConfig: true,
      mcpServers: {},
      systemPrompt: REVIEW_SYSTEM_PROMPT,
      outputFormat: { type: "json_schema", schema: REVIEW_SCHEMA as unknown as Record<string, unknown> },
      persistSession: false,
      includePartialMessages: false,
      pathToClaudeCodeExecutable: claudeBin(),
      spawnClaudeCodeProcess: spawnInGroup,
      abortController: abortOf(request.signal),
    },
  });
  let structured: unknown = null;
  let text = "";
  let costUsd: number | null = null;
  let failure: string | null = null;
  try {
    for await (const message of q) {
      if (message.type !== "result") continue;
      costUsd = message.total_cost_usd ?? null;
      if (message.subtype === "success" && !message.is_error) {
        structured = message.structured_output ?? null;
        text = message.result;
      } else failure = message.subtype === "success" ? message.result : message.subtype;
    }
  } catch (error) {
    if (failure === null) throw error;
  } finally {
    q.close();
  }
  if (failure) {
    console.error(`[review] model result: ${failure}`);
    throw new Error(reviewFailureText(failure));
  }
  if (structured === null && extractJson(text) === null) throw new Error(T.errReviewEmpty);
  return { structured, text, costUsd };
}

export const reviewFailureText = (failure: string) => (/^error_[a-z_]+$/.test(failure) ? T.errReviewModel : failure);

function abortOf(signal: AbortSignal): AbortController {
  const controller = new AbortController();
  if (signal.aborted) controller.abort();
  else signal.addEventListener("abort", () => controller.abort(), { once: true });
  return controller;
}
