import type { Agent, AgentStatus, Workspace } from "../shared/protocol";
import { isImprovementSession } from "./improvementRows";
import { folderName } from "./sessionSearch";
import { openingIndex, stepIndex } from "./tabSwitcherModel";

// ⌃Tab 세션 전환 창(macOS ⌘Tab 과 같은 규칙)의 목록과 키 상태 기계. DOM 과 store 를 모르는 순수 모듈이라 test/sessionswitcher.test.ts 가 그대로 부른다.
// 화면은 web/SessionSwitcherView.tsx, 열고 닫는 흐름은 web/sessionSwitcher.ts.

export const SESSION_SWITCHER_MAX = 12;

// 최근 포커스 순서에 id 를 맨 앞으로 올린다(이미 있으면 옮기고, max 를 넘으면 오래된 쪽을 자른다). 맨 앞이 이미 id 면 같은 배열을 그대로 돌려준다.
export function pushRecent(list: string[], id: string, max: number): string[] {
  if (list[0] === id) return list;
  return [id, ...list.filter((x) => x !== id)].slice(0, max);
}

export type SwitcherSession = {
  id: string;
  title: string;
  folder: string;
  // worktree 세션이면 그 브랜치 이름
  branch: string | null;
  status: AgentStatus;
  unread: boolean;
  // 지금 활성 칸의 세션. 목록 맨 앞에 한 번만 나온다.
  current: boolean;
};

export type SwitcherRowsInput = {
  agents: readonly Agent[];
  workspaces: readonly Workspace[];
  // 최근에 포커스를 둔 세션 id, 최근 것이 앞(store 의 recentAgentIds)
  recentIds: readonly string[];
  // 지금 칸에 열려 있는 세션 id, 칸 읽는 순서
  openIds: readonly string[];
  activeAgentId: string | null;
};

// 현재 세션, 최근 포커스 순서, 칸에 열려 있는데 기록에 없는 세션, 그래도 모자라면 한 번도 연 적 없는 세션을 최근 활동(updatedAt) 순으로 채워 최대 12개.
// 보관한(done) 세션, 지워진 세션, 피드백 개선 세션은 뺀다. 현재 세션은 보관했더라도 맨 앞에 둔다(지금 보고 있는 것이라서).
export function switcherSessions({ agents, workspaces, recentIds, openIds, activeAgentId }: SwitcherRowsInput): SwitcherSession[] {
  const byId = new Map(agents.map((a) => [a.id, a]));
  const known = [...(activeAgentId ? [activeAgentId] : []), ...recentIds, ...openIds];
  // 포커스 기록은 이 브라우저(localStorage)에 남은 것뿐이라, 다른 곳(Board 카드, 모바일, 빠른 입력창)에서 만든 세션은 한 번 열기 전까지 기록에 없다.
  const knownSet = new Set(known);
  const neverOpened = agents.filter((a) => !knownSet.has(a.id)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((a) => a.id);
  const order = [...known, ...neverOpened];
  const seen = new Set<string>();
  const rows: SwitcherSession[] = [];
  for (const id of order) {
    if (seen.has(id)) continue;
    seen.add(id);
    const agent = byId.get(id);
    if (!agent) continue;
    const current = id === activeAgentId;
    if (!current && (agent.done || isImprovementSession(agent))) continue;
    rows.push({ id, title: agent.title, folder: folderName(agent, [...workspaces]), branch: agent.worktree?.branch ?? null, status: agent.status, unread: !!agent.unread, current });
    if (rows.length === SESSION_SWITCHER_MAX) break;
  }
  return rows;
}

export type SwitcherState = {
  rows: SwitcherSession[];
  index: number;
  // 창이 화면에 보이는가. 열린 직후에는 false 이고 잠깐 뒤에 true 가 된다(빨리 누르고 떼면 창이 안 보인다).
  visible: boolean;
  // ⌃ 를 누른 채 쓰는 호출이다. 팔레트로 열면 false 이고 ↑↓ 와 Enter 로 고른다.
  hold: boolean;
};

// 열 때 고르는 행. ⌃Tab 은 직전 세션(둘째), ⌃⇧Tab 은 가장 오래된 세션(마지막)이다. 현재 세션이 목록에 없으면(새 세션 화면) 첫 행이 직전 세션이다.
// 현재 세션만 있는 목록은 갈 곳이 없어 열지 않는다.
export function openSwitcher(rows: SwitcherSession[], direction: 1 | -1, hold: boolean): SwitcherState | null {
  if (!rows.length || (rows.length === 1 && rows[0].current)) return null;
  const first = rows[0].current ? openingIndex(rows.length, "second") : 0;
  return { rows, index: direction === 1 ? first : openingIndex(rows.length, "last"), visible: false, hold };
}

export type SwitcherEvent =
  | { type: "step"; delta: 1 | -1 }
  | { type: "show" }
  | { type: "controlUp" }
  | { type: "enter" }
  | { type: "escape" }
  | { type: "blur" }
  | { type: "pick"; index: number }
  // ⌃ 를 이미 뗐는데 keyup 을 놓친 경우의 보험: ⌃ 없이 눌린 키
  | { type: "keyDown"; ctrlKey: boolean };

export type SwitcherAction = { kind: "commit"; id: string } | { kind: "close" } | null;

// 다음 상태와 컨트롤러가 할 일. commit 은 고른 세션으로 가고, close 는 그냥 닫는다. 상태가 null 이면 창이 닫힌 것이다.
export function reduceSwitcher(state: SwitcherState | null, event: SwitcherEvent): { state: SwitcherState | null; action: SwitcherAction } {
  if (!state) return { state: null, action: null };
  const commit = (index: number) => ({ state: null, action: { kind: "commit" as const, id: state.rows[index]?.id ?? "" } });
  if (event.type === "step") return { state: { ...state, index: stepIndex(state.index, state.rows.length, event.delta) }, action: null };
  if (event.type === "show") return { state: { ...state, visible: true }, action: null };
  if (event.type === "controlUp") return state.hold ? commit(state.index) : { state, action: null };
  if (event.type === "keyDown") return state.hold && !event.ctrlKey ? commit(state.index) : { state, action: null };
  if (event.type === "enter") return commit(state.index);
  if (event.type === "pick") return commit(event.index);
  return { state: null, action: { kind: "close" } };
}
