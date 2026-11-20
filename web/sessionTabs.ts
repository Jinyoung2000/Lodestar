import { groupOf } from "./editorGroups";
import type { Pane } from "./store";

// 세션에 귀속된 탭의 보임 규칙. store 를 모르는 순수 로직이라 단위 시험이 그대로 부른다(test/sessiontabs.test.ts).
// 귀속되는 것은 PR 탭뿐이다(대화 속 링크로 연 탭). 파일, diff, Browser, Search 탭은 창 전체가 같이 쓴다.
// diff 탭의 agentId 는 어느 세션의 변경과 비교하는지를 가리킬 뿐이라 보임과 무관하다.
// 숨겨진 탭은 state.tabs 에 그대로 있고(본문도 마운트된 채라 상태와 스크롤이 남는다) 탭줄, 전환 목록, 닫기 대상 같은 열거에서만 빠진다.

export type SessionTab = { key: string; kind: string; agentId?: string; group?: string };

// 지금 화면에 칸으로 열려 있는 세션들. 격자에서 칸 포커스만 옮겨도 탭이 깜빡이지 않고, 비활성 칸 대화의 링크로 연 탭도 바로 보인다.
export type ShownAgents = ReadonlySet<string>;

let lastPanes: readonly Pane[] | null = null;
let lastShown: ShownAgents = new Set();

export function shownAgentsOf(s: { panes: readonly Pane[] }): ShownAgents {
  if (s.panes === lastPanes) return lastShown;
  const ids = s.panes.flatMap((p) => (p.kind === "agent" ? [p.agentId] : []));
  const same = ids.length === lastShown.size && ids.every((id) => lastShown.has(id));
  lastPanes = s.panes;
  if (!same) lastShown = new Set(ids);
  return lastShown;
}

// 탭의 주인 세션. 귀속되지 않은 탭이면 null(어느 세션에서나 보인다).
export const ownerOf = (tab: SessionTab): string | null => (tab.kind === "pr" ? (tab.agentId ?? null) : null);

// agents 를 안 주면 거르지 않는다(세션 칸 정보가 없는 호출).
export function isShown(tab: SessionTab, agents?: ShownAgents): boolean {
  const owner = ownerOf(tab);
  return owner === null || agents === undefined || agents.has(owner);
}

let lastTabs: readonly SessionTab[] | null = null;
let lastTabsAgents: ShownAgents | null = null;
let lastTabsOut: readonly SessionTab[] = [];

// 보이는 탭만. 거를 것이 없으면 같은 배열을 돌려주고, 입력이 같으면 같은 결과를 돌려줘서 구독 선택자에 써도 다시 그리지 않는다.
export function shownTabs<T extends SessionTab>(tabs: readonly T[], agents: ShownAgents): T[] {
  if (tabs === lastTabs && agents === lastTabsAgents) return lastTabsOut as T[];
  const out = tabs.every((t) => isShown(t, agents)) ? (tabs as T[]) : tabs.filter((t) => isShown(t, agents));
  lastTabs = tabs;
  lastTabsAgents = agents;
  lastTabsOut = out;
  return out;
}

// 세션이 떠날 때 그 세션 탭을 보던 그룹과 그 탭: 세션 id -> 그룹 id -> 탭 키. 세션으로 돌아오면 그 탭을 다시 활성으로 한다.
export type TabFocus = Record<string, Record<string, string>>;

export type SettleInput = {
  tabs: readonly SessionTab[];
  // main 을 포함한 모든 그룹 id
  groups: readonly string[];
  prevAgents: ShownAgents;
  agents: ShownAgents;
  // 그룹별 활성 탭 키(바뀌기 전, 바뀐 뒤)
  prevActive: Readonly<Record<string, string | null>>;
  active: Readonly<Record<string, string | null>>;
  focus: TabFocus;
  // 이번 갱신이 활성 탭을 직접 정했으면 false: 돌아온 세션의 탭으로 덮어쓰지 않는다
  restore: boolean;
  // 숨겨진 탭 대신 활성이 될 탭(그룹, 숨겨진 키, 그 그룹에서 보이는 키들)
  pick: (group: string, hidden: string, shown: readonly string[]) => string | null;
};

export type SettleResult = { active: Record<string, string | null>; focus: TabFocus };

// 상태가 바뀔 때마다 부른다. 바뀐 것이 없으면 입력의 active, focus 를 그대로 돌려준다(같은 참조).
// 1. 화면에서 사라진 세션: 그 세션의 탭이 그룹의 활성 탭이었으면 기억한다. 아니었으면 그 그룹의 기억을 지운다.
// 2. 화면에 나타난 세션: 기억한 탭이 아직 있으면 그 그룹의 활성 탭으로 되돌린다.
// 3. 어느 그룹이든 숨겨진 탭이 활성이면 그 그룹에서 보이는 탭으로 옮긴다(직전에 보던 탭, 이웃, 없으면 pick 의 fallback).
export function settleSessionTabs(input: SettleInput): SettleResult {
  const { tabs, groups, agents, prevAgents } = input;
  const byKey = new Map(tabs.map((t) => [t.key, t]));
  let focus = input.focus;
  const active = { ...input.active };
  let changed = false;

  for (const agent of prevAgents) {
    if (agents.has(agent)) continue;
    const before = focus[agent] ?? {};
    const mine: Record<string, string> = {};
    for (const group of groups) {
      const key = input.prevActive[group];
      const tab = key ? byKey.get(key) : undefined;
      if (key && tab && ownerOf(tab) === agent && groupOf(tab) === group) mine[group] = key;
    }
    if (!sameRecord(before, mine)) focus = Object.keys(mine).length ? { ...focus, [agent]: mine } : omit(focus, agent);
  }

  if (input.restore) {
    for (const agent of agents) {
      if (prevAgents.has(agent)) continue;
      for (const group of groups) {
        const key = focus[agent]?.[group];
        const tab = key ? byKey.get(key) : undefined;
        if (key && tab && groupOf(tab) === group && isShown(tab, agents) && active[group] !== key) {
          active[group] = key;
          changed = true;
        }
      }
    }
  }

  for (const group of groups) {
    const key = active[group];
    const tab = key ? byKey.get(key) : undefined;
    if (!key || !tab || isShown(tab, agents)) continue;
    const shown = tabs.filter((t) => groupOf(t) === group && isShown(t, agents)).map((t) => t.key);
    active[group] = input.pick(group, key, shown);
    changed = true;
  }

  const same = !changed && groups.every((g) => active[g] === input.active[g]);
  return { active: same ? (input.active as Record<string, string | null>) : active, focus };
}

const sameRecord = (a: Record<string, string>, b: Record<string, string>) => {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
};

function omit(focus: TabFocus, agent: string): TabFocus {
  const { [agent]: _gone, ...rest } = focus;
  return rest;
}

// 지워진 세션의 기억을 뺀다. 같은 객체를 돌려주면 바뀐 것이 없다.
export function pruneTabFocus(focus: TabFocus, alive: ReadonlySet<string>): TabFocus {
  const ids = Object.keys(focus);
  if (ids.every((id) => alive.has(id))) return focus;
  return Object.fromEntries(ids.filter((id) => alive.has(id)).map((id) => [id, focus[id]]));
}

export function dropTabFocus(focus: TabFocus, agentId: string): TabFocus {
  return agentId in focus ? omit(focus, agentId) : focus;
}

// 저장본에서 읽은 값을 거른다. 모양이 깨진 항목은 버린다.
export function sanitizeTabFocus(value: unknown): TabFocus {
  const out: TabFocus = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [agent, groups] of Object.entries(value as Record<string, unknown>)) {
    if (!groups || typeof groups !== "object" || Array.isArray(groups)) continue;
    const mine: Record<string, string> = {};
    for (const [group, key] of Object.entries(groups as Record<string, unknown>)) if (typeof key === "string") mine[group] = key;
    if (Object.keys(mine).length) out[agent] = mine;
  }
  return out;
}
