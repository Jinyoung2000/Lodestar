import type { TimelineItem } from "@shared/protocol";
import type { TimelinePage } from "@shared/mobile";
import { PLAN_TOOL, QUESTION_TOOL } from "./questions";

// 타임라인 항목 목록을 맞추는 순수 함수들. 서버는 항목에 id 를 주고 같은 id 의 갱신을 이벤트로 보내므로, 목록을 id 로 맞추면 놓친 이벤트가 있어도 끝 조각을 다시 받아 복구된다.

export type Tail = { items: TimelineItem[]; hasMore: boolean };

function same(a: TimelineItem, b: TimelineItem): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

// 서버의 끝 조각(page)을 내가 가진 목록(local)에 합친다. hasMore 는 local 맨 앞보다 오래된 항목이 서버에 더 있는지.
// 조각의 첫 항목이 local 에 있으면 그 앞의 캐시는 두고 그 뒤는 서버 것으로 바꾼다. 없으면(오래 떨어져 있어 사이가 비었다) 조각으로 통째로 바꾼다.
// 내용이 같은 항목은 local 의 객체를 그대로 둬서 화면이 다시 그려지지 않는다.
export function mergeTail(local: readonly TimelineItem[], localHasMore: boolean, page: TimelinePage): Tail {
  if (page.total === 0) return { items: [], hasMore: false };
  const first = page.items[0];
  const at = first ? local.findIndex((item) => item.id === first.id) : -1;
  const kept = at === -1 ? [] : local.slice(0, at);
  const byId = new Map(local.map((item) => [item.id, item]));
  const tail = page.items.map((item) => {
    const old = byId.get(item.id);
    return old && same(old, item) ? old : item;
  });
  return { items: [...kept, ...tail], hasMore: at <= 0 ? page.hasMore : localHasMore };
}

// 더 오래된 조각을 앞에 붙인다(이미 있는 id 는 건너뛴다)
export function prependOlder(local: readonly TimelineItem[], page: TimelinePage): Tail {
  const have = new Set(local.map((item) => item.id));
  return { items: [...page.items.filter((item) => !have.has(item.id)), ...local], hasMore: page.hasMore };
}

// 서버의 upsertItem 과 같다: 같은 id 면 바꾸고 없으면 끝에 붙인다. 갱신은 대부분 끝쪽 항목이라 뒤에서부터 찾는다.
export function upsert(items: readonly TimelineItem[], item: TimelineItem): TimelineItem[] {
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].id !== item.id) continue;
    const next = items.slice();
    next[i] = item;
    return next;
  }
  return [...items, item];
}

export function remove(items: readonly TimelineItem[], itemId: string): TimelineItem[] {
  return items.some((item) => item.id === itemId) ? items.filter((item) => item.id !== itemId) : (items as TimelineItem[]);
}

// --- 화면 행 ---

export type UserItem = Extract<TimelineItem, { kind: "user" }>;
export type AssistantItem = Extract<TimelineItem, { kind: "assistant" }>;
export type ToolItem = Extract<TimelineItem, { kind: "tool" }>;
export type ThinkingItem = Extract<TimelineItem, { kind: "thinking" }>;
export type PermissionItem = Extract<TimelineItem, { kind: "permission" }>;
export type NoticeItem = Extract<TimelineItem, { kind: "notice" }>;
export type ErrorItem = Extract<TimelineItem, { kind: "error" }>;
export type Step = ToolItem | ThinkingItem;

export type Row =
  | { type: "user"; key: string; item: UserItem }
  | { type: "assistant"; key: string; item: AssistantItem }
  | { type: "steps"; key: string; steps: Step[]; running: boolean; failed: boolean }
  | { type: "approval"; key: string; item: PermissionItem; tool: ToolItem | null; reviewOnDesktop: boolean }
  | { type: "question"; key: string; item: PermissionItem }
  | { type: "plan"; key: string; item: PermissionItem }
  | { type: "answered"; key: string; item: PermissionItem }
  | { type: "notice"; key: string; text: string; detail?: string }
  | { type: "error"; key: string; item: ErrorItem };

const NOTION_PROPOSE = /^mcp__lodestar_notion__notion_(update_page|create_pages)$/;

// 타임라인 항목을 화면 행으로 바꾼다.
// 1. 연속한 도구 호출과 생각은 한 행(steps)으로 묶는다(펼치면 줄마다 보인다).
// 2. 승인 대기 중인 요청은 그 도구 호출 줄을 대신해 카드가 된다.
// 3. 질문과 계획 승인은 대기 중이면 카드, 끝나면 한 줄 기록이 된다. 허용된 일반 승인은 도구 줄이 이미 있어서 숨긴다.
// 4. 서브에이전트 안쪽 도구 호출(parentToolUseId), 턴 결과, 체크포인트 복원 표시는 폰에서 숨긴다.
export function buildRows(items: readonly TimelineItem[]): Row[] {
  const pendingTool = new Map<string, PermissionItem>();
  for (const item of items) if (item.kind === "permission" && item.status === "pending" && item.toolUseId) pendingTool.set(item.toolUseId, item);
  const toolById = new Map<string, ToolItem>();
  for (const item of items) if (item.kind === "tool") toolById.set(item.id, item);

  const rows: Row[] = [];
  let steps: Step[] = [];
  const flush = () => {
    if (steps.length === 0) return;
    const last = steps[steps.length - 1];
    rows.push({ type: "steps", key: `steps:${steps[0].id}`, steps, running: steps.some((s) => s.kind === "tool" && s.status === "running"), failed: last.kind === "tool" && last.status === "error" });
    steps = [];
  };

  for (const item of items) {
    switch (item.kind) {
      case "tool":
        // 질문과 계획 승인 호출은 전용 카드와 기록 줄이 대신한다
        if (item.name === QUESTION_TOOL || item.name === PLAN_TOOL) break;
        if (item.parentToolUseId) break;
        if (pendingTool.has(item.id)) break;
        steps.push(item);
        break;
      case "thinking":
        if (item.text.trim()) steps.push(item);
        break;
      case "permission": {
        if (item.toolName === QUESTION_TOOL) {
          flush();
          rows.push(item.status === "pending" ? { type: "question", key: item.id, item } : { type: "answered", key: item.id, item });
        } else if (item.toolName === PLAN_TOOL) {
          flush();
          rows.push(item.status === "pending" ? { type: "plan", key: item.id, item } : { type: "answered", key: item.id, item });
        } else if (item.status === "pending") {
          flush();
          rows.push({ type: "approval", key: item.id, item, tool: item.toolUseId ? (toolById.get(item.toolUseId) ?? null) : null, reviewOnDesktop: NOTION_PROPOSE.test(item.toolName) });
        } else if (item.status === "denied") {
          flush();
          rows.push({ type: "notice", key: item.id, text: `Denied ${item.toolName}` });
        }
        break;
      }
      case "user":
        flush();
        if (item.source === "system") rows.push({ type: "notice", key: item.id, text: (item.shown ?? item.text).slice(0, 200) });
        else rows.push({ type: "user", key: item.id, item });
        break;
      case "assistant":
        if (!item.text.trim() && !item.streaming) break;
        flush();
        rows.push({ type: "assistant", key: item.id, item });
        break;
      case "notice":
        flush();
        rows.push({ type: "notice", key: item.id, text: item.text, detail: item.detail });
        break;
      case "error":
        flush();
        rows.push({ type: "error", key: item.id, item });
        break;
      case "result":
      case "restored":
        break;
    }
  }
  flush();
  return rows;
}

// 응답 중에 마지막으로 보이는 행이 "생각 중" 표시를 달아야 하는지: 실행 중인데 아직 어시스턴트 글이 스트리밍되지 않는 때
export function lastIsStreaming(items: readonly TimelineItem[]): boolean {
  const last = items[items.length - 1];
  return last?.kind === "assistant" && last.streaming;
}

// 행 데이터가 같은지(안쪽 항목을 객체 그대로 비교). 서버 갱신으로 바뀐 항목이 없으면 같은 행으로 본다.
export function sameRow(a: Row, b: Row): boolean {
  if (a.type !== b.type || a.key !== b.key) return false;
  switch (a.type) {
    case "steps": {
      const other = b as typeof a;
      return a.running === other.running && a.failed === other.failed && a.steps.length === other.steps.length && a.steps.every((step, i) => step === other.steps[i]);
    }
    case "approval": {
      const other = b as typeof a;
      return a.item === other.item && a.tool === other.tool && a.reviewOnDesktop === other.reviewOnDesktop;
    }
    case "notice": {
      const other = b as typeof a;
      return a.text === other.text && a.detail === other.detail;
    }
    default:
      return a.item === (b as typeof a).item;
  }
}

// 새로 만든 행 목록에서 안 바뀐 행은 이전 객체를 그대로 돌려준다. 스트리밍 중 한 행만 바뀔 때 나머지 행이 다시 그려지지 않는다.
export function stabilizeRows(previous: readonly Row[], next: Row[]): Row[] {
  if (previous.length === 0) return next;
  const byKey = new Map(previous.map((row) => [row.key, row]));
  return next.map((row) => {
    const old = byKey.get(row.key);
    return old && sameRow(old, row) ? old : row;
  });
}
