import type { Agent, AgentStatus, Workspace } from "../shared/protocol";
import { isImprovementSession } from "./improvementRows";
import { folderName } from "./sessionSearch";
import { openingIndex, stepIndex } from "./tabSwitcherModel";

export const SESSION_SWITCHER_MAX = 12;

export function pushRecent(list: string[], id: string, max: number): string[] {
  if (list[0] === id) return list;
  return [id, ...list.filter((x) => x !== id)].slice(0, max);
}

export type SwitcherSession = {
  id: string;
  title: string;
  folder: string;
  branch: string | null;
  status: AgentStatus;
  unread: boolean;
  current: boolean;
};

export type SwitcherRowsInput = {
  agents: readonly Agent[];
  workspaces: readonly Workspace[];
  recentIds: readonly string[];
  openIds: readonly string[];
  activeAgentId: string | null;
};

export function switcherSessions({ agents, workspaces, recentIds, openIds, activeAgentId }: SwitcherRowsInput): SwitcherSession[] {
  const byId = new Map(agents.map((a) => [a.id, a]));
  const known = [...(activeAgentId ? [activeAgentId] : []), ...recentIds, ...openIds];
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
  visible: boolean;
  hold: boolean;
};

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
  | { type: "keyDown"; ctrlKey: boolean };

export type SwitcherAction = { kind: "commit"; id: string } | { kind: "close" } | null;

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
