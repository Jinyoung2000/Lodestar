import { AUTO_ADD_CONFIDENCE, ANALYSIS_FAILED_LABEL, buildMentionCard, type MentionAnalysisResult } from "../shared/inbox";
import { columnByRole } from "../shared/board";
import type { BoardCard, InboxItem, JudgeInfo, MentionAnalysis, MentionJudgment, Settings, Workspace } from "../shared/protocol";
import type { BoardStore } from "./board";
import type { InboxStore } from "./inbox";
import { analysisBudgetUsd, type AnalysisContext, type AnalysisOutcome } from "./mentionAnalyze";
import { JUDGE_BATCH, toJudgeInput, type JudgeBatchResult, type JudgeInput } from "./mentionJudge";

export const MAX_JUDGE_PER_RUN = 30;
export const MAX_FAILURES = 3;
export const MAX_QUEUE_PER_RUN = Number(process.env.AGENT_NAV_ANALYSIS_QUEUE_MAX ?? 8);

export type JudgeFn = (batch: JudgeInput[]) => Promise<JudgeBatchResult>;
export type AnalyzeFn = (item: InboxItem, ctx: AnalysisContext) => Promise<AnalysisOutcome>;

export type PipelineDeps = {
  inbox: InboxStore;
  board: BoardStore;
  settings: () => Settings;
  workspaces: () => Workspace[];
  judge: JudgeFn;
  analyze: AnalyzeFn;
  emitInbox: () => void;
  emitBoard: () => void;
  blocked?: () => boolean;
};

const now = () => new Date().toISOString();

export const isAutoRequest = (j: Pick<MentionJudgment, "isRequest" | "confidence">) => j.isRequest && j.confidence >= AUTO_ADD_CONFIDENCE;

export class MentionPipeline {
  private running: Promise<void> | null = null;

  constructor(private deps: PipelineDeps) {}

  resume() {
    for (const item of this.deps.inbox.mentions()) {
      if (item.analysis?.status === "running") this.deps.inbox.update(item.id, (i) => ({ ...i, analysis: { ...i.analysis!, status: "queued", at: now() } }));
    }
    this.kick();
  }

  async judgeNew(): Promise<JudgeInfo> {
    const { inbox, settings, judge } = this.deps;
    const info: JudgeInfo = { judged: 0, requests: 0, notRequests: 0, queued: 0, error: null, costUsd: null, turns: null };
    if (this.deps.blocked?.()) return info;
    const fresh = inbox.mentions().filter((i) => !i.judgment && !i.cardId && i.verdict !== "not-request");
    if (!fresh.length) return info;
    if (!settings().autoAddRequests) {
      for (const item of fresh) inbox.update(item.id, (i) => ({ ...i, judgment: skipped("off") }));
      return info;
    }
    const targets = [...fresh].sort((a, b) => a.time.localeCompare(b.time)).slice(0, MAX_JUDGE_PER_RUN);
    let queued = 0;
    for (let at = 0; at < targets.length; at += JUDGE_BATCH) {
      const batch = targets.slice(at, at + JUDGE_BATCH);
      let results: (Pick<MentionJudgment, "isRequest" | "confidence" | "title" | "summary"> | null)[] = batch.map(() => null);
      try {
        const out = await judge(batch.map((item, i) => toJudgeInput(item, i + 1)));
        results = out.results;
        info.costUsd = (info.costUsd ?? 0) + (out.costUsd ?? 0);
        info.turns = (info.turns ?? 0) + (out.turns ?? 0);
      } catch (error) {
        info.error = String(error instanceof Error ? error.message : error).slice(0, 200);
      }
      batch.forEach((item, i) => {
        const result = results[i];
        if (!result) {
          inbox.update(item.id, (cur) => {
            const failures = (cur.judgeFailures ?? 0) + 1;
            return failures >= MAX_FAILURES ? { ...cur, judgeFailures: failures, judgment: skipped("failed") } : { ...cur, judgeFailures: failures };
          });
          return;
        }
        const cur = inbox.item(item.id);
        if (cur.judgment || cur.cardId || cur.verdict) return;
        const judgment: MentionJudgment = { at: now(), ...result };
        const queue = isAutoRequest(judgment) && queued < MAX_QUEUE_PER_RUN;
        if (queue) queued++;
        inbox.update(item.id, (i) => ({ ...i, judgment, ...(queue ? { analysis: { status: "queued" as const, at: now() } } : {}) }));
        info.judged++;
        if (result.isRequest) info.requests++;
        else info.notRequests++;
      });
    }
    info.queued = queued;
    this.deps.emitInbox();
    this.kick();
    return info;
  }

  kick() {
    if (this.running || this.deps.blocked?.()) return;
    this.running = this.drain().finally(() => {
      this.running = null;
    });
  }

  get busy() {
    return this.running !== null;
  }

  async idle() {
    while (this.running) await this.running;
  }

  private nextQueued(): InboxItem | null {
    const auto = this.deps.settings().autoAddRequests;
    const queued = this.deps.inbox.mentions().filter((i) => i.analysis?.status === "queued" && (auto || i.analysis.manual));
    return queued.sort((a, b) => a.analysis!.at.localeCompare(b.analysis!.at))[0] ?? null;
  }

  private async drain() {
    for (let next = this.nextQueued(); next; next = this.nextQueued()) {
      try {
        await this.analyzeOne(next);
      } catch (error) {
        const reason = String(error instanceof Error ? error.message : error).slice(0, 200);
        console.error(`[mentions] analysis failed: ${reason}`);
        try {
          this.deps.inbox.update(next.id, (i) => ({ ...i, analysis: { ...i.analysis, status: "failed", at: now(), error: reason } }));
          this.deps.emitInbox();
        } catch {
        }
      }
    }
  }

  private async analyzeOne(item: InboxItem) {
    const { inbox, settings, workspaces, analyze } = this.deps;
    const manual = item.analysis?.manual;
    const model = settings().mentionAnalysisModel || "sonnet";
    this.setAnalysis(item.id, { status: "running", at: now(), manual, model });
    const all = workspaces();
    const projects = all.filter((w) => !w.parentId && !w.feedback).map((w) => ({ id: w.id, name: w.name, dir: w.dir }));
    const ctx: AnalysisContext = { model, maxBudgetUsd: analysisBudgetUsd(model, settings().mentionAnalysisBudgetUsd), workspaces: projects, roots: [...new Set(all.map((w) => w.dir))] };
    let outcome: AnalysisOutcome;
    try {
      outcome = await analyze(inbox.item(item.id), ctx);
    } catch (error) {
      outcome = { result: null, error: String(error instanceof Error ? error.message : error).slice(0, 200), costUsd: null, turns: null, tools: [] };
    }
    const { result } = outcome;
    const analysis: MentionAnalysis = {
      status: result ? "done" : "failed",
      at: now(),
      manual,
      model,
      costUsd: outcome.costUsd,
      turns: outcome.turns,
      tools: outcome.tools,
      error: result ? null : outcome.error,
      ...(result ? { stats: { steps: result.steps.length, files: result.relatedFiles.length, questions: result.openQuestions.length, links: result.links.length } } : {}),
    };
    this.finish(item.id, result, analysis);
    console.log(`[mentions] analysis ${analysis.status} model=${model} turns=${outcome.turns ?? "?"} cost=$${(outcome.costUsd ?? 0).toFixed(4)} tools=${outcome.tools.length}${result ? ` steps=${analysis.stats!.steps} files=${analysis.stats!.files} questions=${analysis.stats!.questions}` : ` error=${outcome.error}`}`);
  }

  private setAnalysis(id: string, analysis: MentionAnalysis) {
    this.deps.inbox.update(id, (i) => ({ ...i, analysis }));
    this.deps.emitInbox();
  }

  private finish(id: string, result: MentionAnalysisResult | null, analysis: MentionAnalysis) {
    const { inbox, board } = this.deps;
    const item = inbox.item(id);
    const existing = item.cardId ? board.get().cards.find((c) => c.id === item.cardId) : undefined;
    if (item.verdict === "not-request" && !existing) {
      inbox.update(id, (i) => ({ ...i, analysis }));
      this.deps.emitInbox();
      return;
    }
    if (existing) {
      if (result) this.applyToCard(existing, item, result);
      inbox.update(id, (i) => ({ ...i, analysis }));
    } else {
      const card = this.createCard(item, result, !result);
      inbox.update(id, (i) => ({ ...i, analysis, cardId: card.id, verdict: undefined }));
    }
    this.deps.emitInbox();
  }

  createCard(item: InboxItem, analysis: MentionAnalysisResult | null, analysisFailed: boolean, workspaceId?: string | null): BoardCard {
    const { board } = this.deps;
    const duplicate = item.permalink ? board.get().cards.find((c) => c.links.some((l) => l.url === item.permalink)) : undefined;
    if (duplicate) return duplicate;
    const built = buildMentionCard(item, { judgment: item.judgment && !item.judgment.skipped ? item.judgment : null, analysis, analysisFailed, teamId: this.deps.settings().slackTeamId });
    const columnId = (columnByRole(board.get(), "todo") ?? board.get().columns[0]).id;
    const cardWorkspace = built.workspaceId ?? workspaceId ?? null;
    const card = board.createCard({ title: built.title, body: built.body, labels: built.labels, links: built.links, columnId, ...(cardWorkspace ? { workspaceId: cardWorkspace } : {}) });
    this.deps.emitBoard();
    return card;
  }

  private applyToCard(card: BoardCard, item: InboxItem, result: MentionAnalysisResult) {
    const { board } = this.deps;
    const built = buildMentionCard(item, { judgment: item.judgment && !item.judgment.skipped ? item.judgment : null, analysis: result, teamId: this.deps.settings().slackTeamId });
    const labels = [...card.labels.filter((l) => l !== ANALYSIS_FAILED_LABEL), ...built.labels.filter((l) => !card.labels.includes(l) && l !== ANALYSIS_FAILED_LABEL)];
    const links = [...built.links, ...card.links.filter((l) => !built.links.some((b) => b.url === l.url))].slice(0, 20);
    board.updateCard(card.id, { title: built.title, body: built.body, labels, links, ...(built.workspaceId ? { workspaceId: built.workspaceId } : {}) });
    this.deps.emitBoard();
  }

  addToBoard(id: string, workspaceId: string | null): { item: InboxItem; card: BoardCard } {
    const { inbox, board } = this.deps;
    const item = inbox.item(id);
    const existing = item.cardId ? board.get().cards.find((c) => c.id === item.cardId) : undefined;
    if (existing) return { item, card: existing };
    const card = this.createCard(item, null, false, workspaceId);
    const saved = inbox.update(id, (i) => ({ ...i, cardId: card.id, verdict: undefined }));
    this.deps.emitInbox();
    return { item: saved, card };
  }

  notRequest(id: string) {
    const { inbox, board } = this.deps;
    const item = inbox.item(id);
    if (item.cardId && board.get().cards.some((c) => c.id === item.cardId)) {
      board.deleteCard(item.cardId);
      this.deps.emitBoard();
    }
    inbox.update(id, (i) => ({ ...i, cardId: null, verdict: "not-request", analysis: i.analysis?.status === "queued" ? undefined : i.analysis }));
    this.deps.emitInbox();
  }

  reanalyze(id: string) {
    const { inbox } = this.deps;
    const item = inbox.item(id);
    if (item.analysis?.status === "queued" || item.analysis?.status === "running") return;
    inbox.update(id, (i) => ({ ...i, verdict: undefined, analysis: { status: "queued", at: now(), manual: true } }));
    this.deps.emitInbox();
    this.kick();
  }
}

const skipped = (why: "off" | "failed"): MentionJudgment => ({ at: now(), skipped: why, isRequest: false, confidence: 0, title: "", summary: "" });
