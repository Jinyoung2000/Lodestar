import { AUTO_ADD_CONFIDENCE, ANALYSIS_FAILED_LABEL, buildMentionCard, type MentionAnalysisResult } from "../shared/inbox";
import { columnByRole } from "../shared/board";
import type { BoardCard, InboxItem, JudgeInfo, MentionAnalysis, MentionJudgment, Settings, Workspace } from "../shared/protocol";
import type { BoardStore } from "./board";
import type { InboxStore } from "./inbox";
import { analysisBudgetUsd, type AnalysisContext, type AnalysisOutcome } from "./mentionAnalyze";
import { JUDGE_BATCH, toJudgeInput, type JudgeBatchResult, type JudgeInput } from "./mentionJudge";

// 새 멘션 처리의 흐름.
//   가져오기 → judgeNew(): 새 멘션을 haiku 로 판단 (한 번에 묶어서)
//            → 요청이고 confidence 가 기준 이상이면 분석 큐(item.analysis.status = "queued")
//   큐 → drain(): 한 번에 하나씩 sonnet 분석 → 분석 결과로 보드 카드 생성 (실패하면 판단 단계의 제목과 요약으로 카드 + "analysis failed" 라벨)
// 같은 멘션으로 카드를 두 번 만들지 않는 근거: 판단은 item.judgment 가 없을 때만 하고, 카드는 item.cardId 가 없을 때만 만든다.
// 카드를 사람이 지워도 item.cardId 가 남아 있어서 다시 만들지 않는다.

export const MAX_JUDGE_PER_RUN = 30;
export const MAX_FAILURES = 3;
// 한 번의 판단에서 분석 큐에 넣는 최대 수. 넘는 요청은 판단만 남고 카드는 Add to Board 로 만든다.
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
  // true 면 판단과 분석을 하지 않는다(시험 인스턴스, server/mentionGate.ts).
  blocked?: () => boolean;
};

const now = () => new Date().toISOString();

export const isAutoRequest = (j: Pick<MentionJudgment, "isRequest" | "confidence">) => j.isRequest && j.confidence >= AUTO_ADD_CONFIDENCE;

export class MentionPipeline {
  private running: Promise<void> | null = null;

  constructor(private deps: PipelineDeps) {}

  // 앱을 켠 직후: 분석 중이던 항목(앱이 꺼져서 끊긴 것)을 큐로 되돌리고 이어서 돈다.
  resume() {
    for (const item of this.deps.inbox.mentions()) {
      if (item.analysis?.status === "running") this.deps.inbox.update(item.id, (i) => ({ ...i, analysis: { ...i.analysis!, status: "queued", at: now() } }));
    }
    this.kick();
  }

  // --- 판단 ---

  async judgeNew(): Promise<JudgeInfo> {
    const { inbox, settings, judge } = this.deps;
    const info: JudgeInfo = { judged: 0, requests: 0, notRequests: 0, queued: 0, error: null, costUsd: null, turns: null };
    if (this.deps.blocked?.()) return info;
    const fresh = inbox.mentions().filter((i) => !i.judgment && !i.cardId && i.verdict !== "not-request");
    if (!fresh.length) return info;
    // 꺼져 있는 동안 들어온 멘션은 판단하지 않고, 나중에 켜도 소급해서 처리하지 않는다.
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
          // 실패한 항목은 다음 가져오기에서 다시 판단하고, 3번 실패하면 포기한다.
          inbox.update(item.id, (cur) => {
            const failures = (cur.judgeFailures ?? 0) + 1;
            return failures >= MAX_FAILURES ? { ...cur, judgeFailures: failures, judgment: skipped("failed") } : { ...cur, judgeFailures: failures };
          });
          return;
        }
        const cur = inbox.item(item.id);
        // 판단하는 동안 사용자가 이미 카드를 만들었거나 정정했으면 건드리지 않는다.
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

  // --- 분석 큐 ---

  kick() {
    if (this.running || this.deps.blocked?.()) return;
    this.running = this.drain().finally(() => {
      this.running = null;
    });
  }

  get busy() {
    return this.running !== null;
  }

  // 큐가 빌 때까지 기다린다 (시험용).
  async idle() {
    while (this.running) await this.running;
  }

  // 자동 분석은 설정이 켜져 있을 때만. Re-analyze(manual)는 설정과 무관하게 돈다.
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
        // 카드 만들기나 저장이 던지면(보드 카드 수 한도 등) 이 항목을 실패로 남기고 다음 항목으로 간다.
        // 그대로 두면 kick 의 promise 가 처리되지 않은 거부로 데몬을 끝내고, 항목이 running 으로 남아 다시 뜬 뒤 resume 이 같은 분석을 또 돌린다.
        const reason = String(error instanceof Error ? error.message : error).slice(0, 200);
        console.error(`[mentions] analysis failed: ${reason}`);
        try {
          this.deps.inbox.update(next.id, (i) => ({ ...i, analysis: { ...i.analysis, status: "failed", at: now(), error: reason } }));
          this.deps.emitInbox();
        } catch {
          // 항목이 이미 지워졌으면 남길 곳이 없다
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

  // 분석 결과를 카드에 반영하고 항목에 기록한다. 이 함수는 await 없이 끝까지 돌아서, 같은 멘션의 카드가 중복으로 만들어지지 않는다.
  private finish(id: string, result: MentionAnalysisResult | null, analysis: MentionAnalysis) {
    const { inbox, board } = this.deps;
    const item = inbox.item(id);
    const existing = item.cardId ? board.get().cards.find((c) => c.id === item.cardId) : undefined;
    // 분석하는 동안 사용자가 "Not a request" 로 정정했으면 카드를 만들지 않는다.
    if (item.verdict === "not-request" && !existing) {
      inbox.update(id, (i) => ({ ...i, analysis }));
      this.deps.emitInbox();
      return;
    }
    if (existing) {
      // 이미 카드가 있으면(수동 추가, Re-analyze) 분석이 성공했을 때만 내용을 바꾼다. 실패로 사용자가 고친 카드를 덮어쓰지 않는다.
      if (result) this.applyToCard(existing, item, result);
      inbox.update(id, (i) => ({ ...i, analysis }));
    } else {
      const card = this.createCard(item, result, !result);
      inbox.update(id, (i) => ({ ...i, analysis, cardId: card.id, verdict: undefined }));
    }
    this.deps.emitInbox();
  }

  // 멘션의 카드를 만든다. 같은 Slack 링크를 가진 카드가 이미 있으면(저장 도중 끊긴 경우) 그 카드를 쓴다.
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

  // --- 사용자 동작 ---

  // 멘션을 보드 카드로 만든다 (수동 Add to Board). 분석 없이 판단 단계의 제목과 요약으로 만든다. 이미 카드가 있으면 그 카드를 돌려준다.
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

  // "Not a request": 이 멘션으로 만든 카드를 지우고 표시를 바꾼다. 지우는 것은 이 앱의 보드 카드뿐이고 Slack 에는 아무것도 하지 않는다.
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
