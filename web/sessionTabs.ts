import { groupOf } from "./editorGroups";
import type { Pane } from "./store";

export type SessionTab = { key: string; kind: string; agentId?: string; group?: string };

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

export const ownerOf = (tab: SessionTab): string | null => (tab.kind === "pr" ? (tab.agentId ?? null) : null);

export function isShown(tab: SessionTab, agents?: ShownAgents): boolean {
  const owner = ownerOf(tab);
  return owner === null || agents === undefined || agents.has(owner);
}

let lastTabs: readonly SessionTab[] | null = null;
let lastTabsAgents: ShownAgents | null = null;
let lastTabsOut: readonly SessionTab[] = [];

export function shownTabs<T extends SessionTab>(tabs: readonly T[], agents: ShownAgents): T[] {
  if (tabs === lastTabs && agents === lastTabsAgents) return lastTabsOut as T[];
  const out = tabs.every((t) => isShown(t, agents)) ? (tabs as T[]) : tabs.filter((t) => isShown(t, agents));
  lastTabs = tabs;
  lastTabsAgents = agents;
  lastTabsOut = out;
  return out;
}

export type TabFocus = Record<string, Record<string, string>>;

export type SettleInput = {
  tabs: readonly SessionTab[];
  groups: readonly string[];
  prevAgents: ShownAgents;
  agents: ShownAgents;
  prevActive: Readonly<Record<string, string | null>>;
  active: Readonly<Record<string, string | null>>;
  focus: TabFocus;
  restore: boolean;
  pick: (group: string, hidden: string, shown: readonly string[]) => string | null;
};

export type SettleResult = { active: Record<string, string | null>; focus: TabFocus };

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

export function pruneTabFocus(focus: TabFocus, alive: ReadonlySet<string>): TabFocus {
  const ids = Object.keys(focus);
  if (ids.every((id) => alive.has(id))) return focus;
  return Object.fromEntries(ids.filter((id) => alive.has(id)).map((id) => [id, focus[id]]));
}

export function dropTabFocus(focus: TabFocus, agentId: string): TabFocus {
  return agentId in focus ? omit(focus, agentId) : focus;
}

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
