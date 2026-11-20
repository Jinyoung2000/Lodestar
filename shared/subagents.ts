import type { TimelineItem } from "./protocol";
import { sharedPrefix } from "./sharedPrefix";

// SUB: 서버(현황 모으기)와 화면(대화 목록, 칩)이 같이 쓰는 서브에이전트 조각.
export type ToolItem = Extract<TimelineItem, { kind: "tool" }>;

// Agent 호출의 tool_result 가 이 글로 시작하면 서브에이전트를 백그라운드로 띄웠다는 안내일 뿐 결과가 아니다.
export const ASYNC_LAUNCH_PATTERN = /^Async agent launched/i;

export const isAgentTool = (name: string) => name === "Agent" || name === "Task";

// 입력창 위 `N agents running` 칩이 세는 것: 백그라운드로 도는 서브에이전트
export function runningBackground(items: readonly TimelineItem[] | undefined): ToolItem[] {
  return (items ?? []).filter(isRunningBackground);
}

// 지난 배열과 결과로 이어서 고른다. 앞에서부터 같은 항목까지는 지난 결과에서 그 범위에 든 것을 그대로 쓰고, 바뀐 곳부터만 본다.
// 응답이 흐를 때 이벤트마다 긴 대화 전체를 걸러 내던 비용이 바뀐 끝부분 몫으로 준다(PERF2). 지난 결과는 지난 배열의 항목 참조로만 이뤄져 있다(useStoreDerived 의 sameArray).
export function runningBackgroundFrom(items: readonly TimelineItem[] | undefined, prev: { input: readonly TimelineItem[] | undefined; output: ToolItem[] } | null): ToolItem[] {
  if (!items || !prev?.input) return runningBackground(items);
  const before = prev.input;
  const from = sharedPrefix(before, items);
  const kept = prev.output.filter((hit) => {
    const at = before.lastIndexOf(hit);
    return at !== -1 && at < from;
  });
  for (let i = from; i < items.length; i++) if (isRunningBackground(items[i])) kept.push(items[i] as ToolItem);
  return kept;
}

const isRunningBackground = (i: TimelineItem): i is ToolItem => i.kind === "tool" && i.task?.status === "running" && !!i.task.backgrounded && !i.parentToolUseId;

// Agent 호출 하나가 띄운 서브에이전트의 도구 호출들. 타임라인 배열마다 부모 id 별 색인을 한 번만 만들어, Agent 행이 많아도 항목이 바뀔 때 행마다 전체를 훑지 않는다.
const NO_STEPS: ToolItem[] = [];
const stepIndexes = new WeakMap<readonly TimelineItem[], Map<string, ToolItem[]>>();

export function subagentSteps(items: readonly TimelineItem[] | undefined, parentId: string): ToolItem[] {
  if (!items) return NO_STEPS;
  let index = stepIndexes.get(items);
  if (!index) {
    index = new Map();
    for (const item of items) {
      if (item.kind !== "tool" || !item.parentToolUseId) continue;
      const list = index.get(item.parentToolUseId);
      if (list) list.push(item);
      else index.set(item.parentToolUseId, [item]);
    }
    stepIndexes.set(items, index);
  }
  return index.get(parentId) ?? NO_STEPS;
}

// 대화의 단계 목록에 나오지 않는 항목: 서브에이전트가 부른 도구와 그 승인 요청
export function subagentChildIds(items: readonly TimelineItem[]): Set<string> {
  const ids = new Set<string>();
  for (const item of items) if (item.kind === "tool" && item.parentToolUseId) ids.add(item.id);
  return ids;
}

export function mainFlow(items: readonly TimelineItem[]): TimelineItem[] {
  const children = subagentChildIds(items);
  if (!children.size) return items as TimelineItem[];
  return items.filter((i) => !(i.kind === "tool" && i.parentToolUseId) && !(i.kind === "permission" && i.toolUseId && children.has(i.toolUseId)));
}

// fix5-2: 서브에이전트 결과를 하네스가 모델에게 돌려줄 때 붙이는 안내 틀을 걷어 낸다. 사람이 읽을 결과 본문만 남긴다.
// 틀 모양: `[Subagent hand-back] ... The report follows:` 한 문단, 두 칸 들여쓴 본문, `agentId: ... (use SendMessage ...)` 줄, `<usage>...</usage>` 태그.
export type SubagentUsage = { tokens: number | null; toolUses: number | null; durationMs: number | null };

const FRAME_START = /^\s*\[Subagent hand-back\]/;
const FRAME_END = /The report follows:[ \t]*\r?\n?/;
const USAGE_TAG = /<usage>([\s\S]*?)<\/usage>/;
const AGENT_ID_LINE = /^[ \t]*agentId:[^\n]*(?:\n|$)/gm;

export function cleanSubagentOutput(text: string): { text: string; usage: SubagentUsage | null } {
  let body = text;
  if (FRAME_START.test(body)) {
    const end = FRAME_END.exec(body);
    body = end ? body.slice(end.index + end[0].length) : body.replace(/^[^\n]*\n?/, "");
  }
  let usage: SubagentUsage | null = null;
  const tag = USAGE_TAG.exec(body);
  if (tag) {
    const num = (key: string) => {
      const found = new RegExp(`${key}:\\s*(\\d+)`).exec(tag[1]);
      return found ? Number(found[1]) : null;
    };
    usage = { tokens: num("subagent_tokens"), toolUses: num("tool_uses"), durationMs: num("duration_ms") };
    body = body.replace(USAGE_TAG, "");
  }
  body = body.replace(AGENT_ID_LINE, "");
  // 하네스가 본문 줄마다 두 칸을 들여 쓴다. 모든 줄이 그렇다면 되돌린다.
  const lines = body.split("\n");
  const filled = lines.filter((line) => line.trim());
  if (filled.length && filled.every((line) => line.startsWith("  "))) body = lines.map((line) => (line.startsWith("  ") ? line.slice(2) : line)).join("\n");
  return { text: body.trim(), usage };
}
