import type { ModelInfo, PermissionMode, TimelineItem } from "../shared/protocol";
import { countLineChanges } from "../shared/lineDiff";
import { modelNameFromId, versionedDisplayName } from "../shared/modelName";
import { isInternalStep } from "../shared/internalSteps";
import { planText, QUESTION_TOOL, readQuestions } from "../shared/interactive";
import { mainFlow, type ToolItem } from "../shared/subagents";
import { isTaskTool } from "../shared/tasks";

// 대화 타임라인을 화면 단위로 묶는 순수 함수들(React 없음, test/checkpoint.test.ts 가 시험한다).

export type PermissionItem = Extract<TimelineItem, { kind: "permission" }>;
export type UserItem = Extract<TimelineItem, { kind: "user" }>;
export type AssistantItem = Extract<TimelineItem, { kind: "assistant" }>;
export type ResultItem = Extract<TimelineItem, { kind: "result" }>;

// 단계 한 줄. 도구 호출에 승인 요청이 붙어 있으면 한 줄로 합쳐 permission 에 담는다.
export type StepEntry = { item: TimelineItem; permission: PermissionItem | null };

export type Block =
  | { kind: "item"; item: TimelineItem }
  | { kind: "steps"; key: string; items: StepEntry[]; finished: boolean; durationMs: number | null };

// 사용자가 보낸 메시지 하나와 그 응답들. user 가 null 인 턴은 첫 메시지 앞에 있는 항목(옛 기록)이다.
export type Turn = { key: string; user: UserItem | null; blocks: Block[] };

const STEP_KINDS = new Set(["tool", "permission", "thinking"]);

export const isUserTurnStart = (item: TimelineItem): item is UserItem => item.kind === "user" && item.source !== "system";

// groupTurns 를 턴(사용자 메시지부터 다음 사용자 메시지 전까지)마다 따로 부르고, 항목이 하나도 안 바뀐 턴은 지난 결과를 그대로 쓰는 묶개.
// 긴 대화에 응답이 흐를 때 바뀌는 것은 거의 마지막 턴뿐이라, 이벤트마다 대화 전체(수천 항목)를 다시 묶던 비용이 마지막 턴 몫으로 준다(PERF2).
// 결과는 groupTurns(전체)와 같다: 묶음은 턴 경계에서 끊기고, 턴 안 계산(소요 시간, 승인 짝, 숨길 단계)은 그 턴의 항목만 본다.
export function turnGrouper(): (all: TimelineItem[]) => Block[] {
  let last: { items: TimelineItem[]; blocks: Block[] }[] = [];
  return (all) => {
    const next = splitAtTurns(all).map((items, i) => {
      const prev = last[i];
      if (prev && prev.items.length === items.length && prev.items.every((item, k) => item === items[k])) return prev;
      return { items, blocks: groupTurns(items) };
    });
    last = next;
    return next.flatMap((turn) => turn.blocks);
  };
}

function splitAtTurns(all: TimelineItem[]): TimelineItem[][] {
  const turns: TimelineItem[][] = [];
  let start = 0;
  for (let i = 1; i < all.length; i++) {
    if (!isUserTurnStart(all[i])) continue;
    turns.push(all.slice(start, i));
    start = i;
  }
  if (all.length) turns.push(all.slice(start));
  return turns;
}

// 한 턴의 도구 호출들을 "N단계 완료, Xs" 로 접는다. 사용자 메시지부터 다음 사용자 메시지 전까지가 한 턴.
export function groupTurns(all: TimelineItem[]): Block[] {
  // SUB: 서브에이전트가 부른 도구는 그 Agent 호출 행 안에서 보이므로 대화의 단계 목록에서 뺀다
  // fixB: 모델의 준비 동작(ToolSearch, 계획 파일 읽기와 쓰기)도 뺀다. 그 호출의 승인 기록(이미 닫힌 것)도 같이 뺀다.
  const hidden = new Set(all.flatMap((i) => (i.kind === "tool" && isInternalStep(i.name, i.input, i.status) ? [i.id] : [])));
  const items = hidden.size ? mainFlow(all).filter((i) => !(i.kind === "tool" && hidden.has(i.id)) && !(i.kind === "permission" && i.status !== "pending" && i.toolUseId !== undefined && hidden.has(i.toolUseId))) : mainFlow(all);
  // 턴별 result 지속 시간 (접힌 그룹 라벨에 쓴다)
  const durationOf = new Map<number, number | null>();
  let turnStart = 0;
  let turnDuration: number | null = null;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (isUserTurnStart(item)) {
      durationOf.set(turnStart, turnDuration);
      turnStart = i;
      turnDuration = null;
    }
    if (item.kind === "result") turnDuration = (turnDuration ?? 0) + item.durationMs;
  }
  durationOf.set(turnStart, turnDuration);

  // 도구 호출과 그 승인 요청은 같은 호출이다. toolUseId 로 짝을 지어 한 줄로 합친다.
  const toolIds = new Set(items.filter((i) => i.kind === "tool").map((i) => i.id));
  const permissionByTool = new Map<string, PermissionItem>();
  for (const item of items) {
    if (item.kind === "permission" && item.toolUseId && toolIds.has(item.toolUseId)) permissionByTool.set(item.toolUseId, item);
  }

  const blocks: Block[] = [];
  let current: StepEntry[] = [];
  let currentTurn = 0;
  const flush = () => {
    if (!current.length) return;
    const finished = !current.some(({ item: i, permission }) => (i.kind === "tool" && i.status === "running" && permission?.status !== "denied") || (i.kind === "permission" && i.status === "pending") || permission?.status === "pending");
    blocks.push({ kind: "steps", key: current[0].item.id, items: current, finished, durationMs: finished ? (durationOf.get(currentTurn) ?? null) : null });
    current = [];
  };
  turnStart = 0;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (isUserTurnStart(item)) {
      flush();
      turnStart = i;
    }
    if (STEP_KINDS.has(item.kind)) {
      if (item.kind === "permission" && item.toolUseId && permissionByTool.get(item.toolUseId) === item) continue;
      if (!current.length) currentTurn = turnStart;
      current.push({ item, permission: item.kind === "tool" ? (permissionByTool.get(item.id) ?? null) : null });
      continue;
    }
    flush();
    blocks.push({ kind: "item", item });
  }
  flush();
  return blocks;
}

// groupTurns 의 결과를 사용자 메시지 단위로 나눈다. sticky 말풍선, 체크포인트 구분선, 응답 아래 줄이 턴 단위로 붙는다.
export function splitTurns(blocks: Block[]): Turn[] {
  const turns: Turn[] = [];
  for (const block of blocks) {
    if (block.kind === "item" && isUserTurnStart(block.item)) {
      turns.push({ key: block.item.id, user: block.item, blocks: [] });
      continue;
    }
    if (!turns.length) turns.push({ key: "head", user: null, blocks: [] });
    turns[turns.length - 1].blocks.push(block);
  }
  return turns;
}

// 새로 계산한 턴 중 직전 계산과 항목이 모두 같은 것은 이전 객체를 그대로 돌려준다(블록과 단계 묶음도 같은 방식).
// groupTurns 는 호출마다 새 객체를 만들어서, 이걸 거치지 않으면 항목 하나가 바뀔 때마다 모든 턴의 React.memo 가 깨진다.
export function reuseTurns(prev: Turn[], next: Turn[]): Turn[] {
  if (!prev.length) return next;
  const before = new Map(prev.map((turn) => [turn.key, turn]));
  const merged = next.map((turn) => {
    const old = before.get(turn.key);
    return old ? reuseTurn(old, turn) : turn;
  });
  return merged.length === prev.length && merged.every((turn, i) => turn === prev[i]) ? prev : merged;
}

function reuseTurn(old: Turn, next: Turn): Turn {
  const oldBlocks = new Map(old.blocks.map((block) => [blockKey(block), block]));
  const blocks = next.blocks.map((block) => {
    const earlier = oldBlocks.get(blockKey(block));
    return earlier && sameBlock(earlier, block) ? earlier : block;
  });
  return old.user === next.user && blocks.length === old.blocks.length && blocks.every((block, i) => block === old.blocks[i]) ? old : { key: next.key, user: next.user, blocks };
}

const blockKey = (block: Block) => (block.kind === "item" ? block.item.id : `steps:${block.key}`);

function sameBlock(a: Block, b: Block): boolean {
  if (a.kind === "item") return b.kind === "item" && a.item === b.item;
  return b.kind === "steps" && a.finished === b.finished && a.durationMs === b.durationMs && a.items.length === b.items.length && a.items.every((entry, i) => entry.item === b.items[i].item && entry.permission === b.items[i].permission);
}

// 응답 아래 줄과 변경 요약이 붙는 곳: 턴의 마지막 확정 응답과 그 턴의 result.
export function turnFooter(turn: Turn) {
  let assistant: AssistantItem | null = null;
  let result: ResultItem | null = null;
  const texts: string[] = [];
  for (const block of turn.blocks) {
    if (block.kind !== "item") continue;
    if (block.item.kind === "assistant" && !block.item.streaming) {
      assistant = block.item;
      texts.push(block.item.text);
    }
    if (block.item.kind === "result") result = block.item;
  }
  // text 는 복사 버튼이 가져가는 글: 그 턴의 확정 응답 전부
  return { assistant, result, text: texts.join("\n\n") };
}

// Write 가 없던 파일을 새로 만들었는지. 도구 결과 글("File created successfully at: ...")로 안다. 덮어쓴 파일은 "has been updated successfully".
export const createdNewFile = (name: string, output: string | null) => name === "Write" && !!output && output.startsWith("File created successfully");

// 도구 입력에서 센 줄 변경량. 파일을 덮어쓴 Write 는 이전 내용을 몰라서 전부 추가로 센다.
export function toolChanges(name: string, input: Record<string, unknown>): { additions: number; deletions: number } | null {
  const str = (value: unknown) => (typeof value === "string" ? value : null);
  if (name === "Edit") {
    const before = str(input.old_string);
    const after = str(input.new_string);
    return before === null || after === null ? null : countLineChanges(before, after);
  }
  if (name === "MultiEdit" && Array.isArray(input.edits)) {
    const total = { additions: 0, deletions: 0 };
    for (const edit of input.edits as Record<string, unknown>[]) {
      const one = toolChanges("Edit", edit);
      if (!one) continue;
      total.additions += one.additions;
      total.deletions += one.deletions;
    }
    return total;
  }
  if (name === "Write") {
    const content = str(input.content);
    return content === null ? null : countLineChanges("", content);
  }
  return null;
}

// 단계 묶음 라벨 끝에 붙는 변경량. 끝나지 못한 호출(거절, 실패, 중단)은 세지 않는다.
export function stepsChanges(steps: StepEntry[]) {
  const total = { additions: 0, deletions: 0 };
  for (const { item, permission } of steps) {
    if (item.kind !== "tool" || item.status === "error" || permission?.status === "denied") continue;
    const changes = toolChanges(item.name, item.input);
    if (!changes) continue;
    total.additions += changes.additions;
    total.deletions += changes.deletions;
  }
  return total.additions || total.deletions ? total : null;
}

// fix5-2: 승인을 기다리는 단계 뒤에 줄 선 도구 호출. 모델이 호출을 한꺼번에 내도 승인이 필요한 호출은 앞의 승인이 끝나야 실행되므로,
// 앞에 승인 대기가 있고 자기에게 승인 항목이 없는 채 running 인 호출은 아직 시작 전이다(승인이 필요 없는 호출은 바로 끝나서 이 상태로 오래 남지 않는다).
export function queuedStepIds(steps: StepEntry[]): Set<string> {
  const queued = new Set<string>();
  let waiting = false;
  for (const { item, permission } of steps) {
    const own = item.kind === "permission" ? item : permission;
    if (own?.status === "pending") waiting = true;
    else if (waiting && item.kind === "tool" && item.status === "running" && !own) queued.add(item.id);
  }
  return queued;
}

// 지금 하는 단계(진행 중인 마지막 도구 호출). 라벨 "Working: Edit [TS index.ts]" 에 쓴다. 승인 뒤에 줄 선 호출은 아직 하는 중이 아니다.
export function currentStep(steps: StepEntry[]) {
  const queued = queuedStepIds(steps);
  for (let i = steps.length - 1; i >= 0; i--) {
    const { item } = steps[i];
    if (item.kind === "tool" && item.status === "running" && !queued.has(item.id)) return item;
  }
  return null;
}

// "9:11 PM". toLocaleTimeString 은 호출마다 포매터를 새로 만들어 긴 대화에서 사용자 메시지 수만큼 느려지므로 하나를 재사용한다.
const CLOCK = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });

export function formatClock(iso: string | undefined) {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : CLOCK.format(date);
}

// 응답 아래 줄의 모델 표기: "Haiku 4.5 (claude-haiku-4-5-20251001)". 표시 이름은 모델 목록에서, 목록에 없으면 id 에서 만든다. 실제 id 는 항상 같이 적는다.
export function modelLabel(id: string, models: Pick<ModelInfo, "value" | "resolvedModel" | "displayName">[], withId = true) {
  const name = modelName(id, models);
  if (name && name !== id) return withId ? `${name} (${id})` : name;
  return id;
}

// B3: 모델 id 나 값에서 표시 이름("Haiku 5.5"). 모델 목록에 있으면 그 이름(버전이 빠졌으면 붙여서), 없으면 id 에서 만들고 그것도 안 되면 null.
export function modelName(id: string, models: Pick<ModelInfo, "value" | "resolvedModel" | "displayName">[]) {
  const known = models.find((m) => m.value !== "default" && (m.resolvedModel === id || m.value === id));
  return known ? versionedDisplayName(known.displayName, known.resolvedModel ?? (id.startsWith("claude-") ? id : null)) : modelNameFromId(id);
}

// fixB: 질문(AskUserQuestion)과 계획 승인(ExitPlanMode) 단계 한 줄. 승인 항목의 outcome 으로 고른 답과 결정을 보인다.
// state: pending 은 답을 기다림, done 은 답했거나 계획을 승인함, skipped 는 답 없이 넘김이나 계속 계획.
export type InteractiveStep = {
  state: "pending" | "done" | "skipped";
  verb: string;
  detail: string;
  qa: { question: string; answer: string }[];
  plan: string | null;
  note: string | null;
};

type InteractiveLabels = { asked: string; ask: string; skipped: string; planApproved: string; planKept: string; planWaiting: string; feedback: string; after: (mode: PermissionMode) => string };

// toolDone: 도구 호출이 끝났는데 짝이 되는 승인 항목이 없는 경우(승인 기록이 없던 옛 타임라인)는 대기가 아니라 끝난 것으로 본다.
export function interactiveStep(name: string, input: Record<string, unknown>, permission: PermissionItem | null, toolDone: boolean, labels: InteractiveLabels): InteractiveStep {
  const pending = permission?.status === "pending" || (!permission && !toolDone);
  const outcome = permission?.outcome;
  if (name === QUESTION_TOOL) {
    const questions = readQuestions(input);
    const answers = outcome?.answers ?? {};
    const qa = questions.map((q) => ({ question: q.question, answer: answers[q.question] ?? "" })).filter((row) => row.answer !== "");
    const state = pending ? "pending" : qa.length || !permission ? "done" : "skipped";
    return { state, verb: state === "pending" ? labels.ask : state === "done" ? labels.asked : labels.skipped, detail: state === "done" && questions.length > 1 ? `${questions.length} questions` : (questions[0]?.question ?? ""), qa, plan: null, note: null };
  }
  const plan = planText(input);
  const first = (plan ?? "").split("\n").find((line) => line.trim())?.replace(/^#+\s*/, "") ?? "";
  const decision = outcome?.plan;
  if (pending) return { state: "pending", verb: labels.planWaiting, detail: first, qa: [], plan, note: null };
  if (!decision) return { state: "done", verb: labels.planApproved, detail: first, qa: [], plan, note: null };
  if (decision.decision === "approved") return { state: "done", verb: labels.planApproved, detail: first, qa: [], plan, note: labels.after(decision.mode) };
  return { state: "skipped", verb: labels.planKept, detail: first, qa: [], plan, note: decision.feedback ? `${labels.feedback}: ${decision.feedback}` : null };
}

// fix5-2: 시스템이 넣은 사용자 턴(압축 요약, 백그라운드 작업 알림, 훅 피드백)의 한 줄 미리보기와 본문. 내용이 비어 있으면 null 이라 줄을 만들지 않는다.
// 작업 알림은 `<summary>` 태그가 있으면 그 글을 미리보기로 쓰고, 아니면 태그 줄을 건너뛴 첫 줄이다.
export function systemMessageView(text: string): { preview: string; body: string } | null {
  const body = text.trim();
  if (!body) return null;
  const summary = /<summary>([\s\S]*?)<\/summary>/.exec(body)?.[1]?.trim();
  const line = summary ?? body.split("\n").map((l) => l.trim()).find((l) => l && !/^<\/?[\w-]+>$/.test(l)) ?? "";
  return { preview: line.slice(0, 120), body };
}

// fix5-2: 연속된 할 일 도구 호출(TaskCreate, TaskUpdate, TodoWrite) 둘 이상은 한 줄로 접는다. 다른 단계가 사이에 끼면 그 자리마다 따로 접힌다.
// 한 번뿐인 호출, 승인 항목이 붙은 호출, 실패한 호출은 접지 않고 그대로 둔다. 단계 묶음 머리의 숫자는 접은 뒤의 줄 수(펼쳤을 때 보이는 줄)로 센다.
export type StepGroup = { kind: "step"; entry: StepEntry } | { kind: "tasks"; key: string; items: ToolItem[] };

export function foldTaskSteps(steps: StepEntry[]): StepGroup[] {
  const groups: StepGroup[] = [];
  let run: StepEntry[] = [];
  const flush = () => {
    if (run.length > 1) groups.push({ kind: "tasks", key: run[0].item.id, items: run.map((e) => e.item as ToolItem) });
    else groups.push(...run.map((entry) => ({ kind: "step" as const, entry })));
    run = [];
  };
  for (const entry of steps) {
    const { item, permission } = entry;
    if (item.kind === "tool" && isTaskTool(item.name) && !permission && item.status !== "error") {
      run.push(entry);
      continue;
    }
    flush();
    groups.push({ kind: "step", entry });
  }
  flush();
  return groups;
}
