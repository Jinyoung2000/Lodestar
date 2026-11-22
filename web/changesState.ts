import { useSyncExternalStore } from "react";
import { defaultChangeScope, type Agent, type ChangedFile, type ChangeScope, type ShellNote } from "../shared/protocol";

export type ScopedChanges = { scope: ChangeScope; includeOutside: boolean; base: string | null; files: ChangedFile[]; outsideCount?: number; shellNote?: ShellNote };

type ChangesViewState = {
  scope: Record<string, ChangeScope>;
  scoped: Record<string, ScopedChanges>;
  showOutside: Record<string, boolean>;
  selected: Record<string, { path: string; nonce: number } | null>;
  listOpen: boolean;
  listWidth: number | null;
  allCollapsed: boolean;
  collapseNonce: number;
  wordWrap: boolean;
  treeView: boolean;
  wide: boolean;
  checksOpen: boolean;
};

let state: ChangesViewState = { scope: {}, scoped: {}, showOutside: {}, selected: {}, listOpen: true, listWidth: null, allCollapsed: false, collapseNonce: 0, wordWrap: false, treeView: true, wide: false, checksOpen: false };
const listeners = new Set<() => void>();
let nonce = 0;

function set(patch: (s: ChangesViewState) => Partial<ChangesViewState>) {
  const next = patch(state);
  if (Object.keys(next).length === 0) return;
  state = { ...state, ...next };
  listeners.forEach((l) => l());
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

export const getChangesView = () => state;

export function useChangesView<T>(select: (s: ChangesViewState) => T): T {
  return useSyncExternalStore(subscribe, () => select(state));
}

export const getChangesScope = (agent: Agent): ChangeScope => state.scope[agent.id] ?? defaultChangeScope(agent);
export const getScoped = (agentId: string) => state.scoped[agentId];
export const getShowOutside = (agentId: string) => state.showOutside[agentId] === true;

export function pickChanges<T extends { files: ChangedFile[]; outsideCount?: number; shellNote?: ShellNote }>(agent: Agent, scope: ChangeScope, includeOutside: boolean, scoped: ScopedChanges | undefined, gitChanges: T | undefined): T | ScopedChanges | undefined {
  if (scope === defaultChangeScope(agent) && !includeOutside) return gitChanges;
  return scoped && scoped.scope === scope && scoped.includeOutside === includeOutside ? scoped : undefined;
}

export function storeShowOutside(agentId: string, show: boolean) {
  set((s) => ({ showOutside: { ...s.showOutside, [agentId]: show } }));
}

export function storeChangesScope(agentId: string, scope: ChangeScope) {
  set((s) => ({ scope: { ...s.scope, [agentId]: scope } }));
}

export function storeScopedChanges(agentId: string, scoped: ScopedChanges) {
  set((s) => ({ scoped: { ...s.scoped, [agentId]: scoped } }));
}

export function selectChangedFile(agentId: string, path: string | null) {
  set((s) => ({ selected: { ...s.selected, [agentId]: path ? { path, nonce: ++nonce } : null } }));
}

export const getSelectedFile = (agentId: string) => state.selected[agentId]?.path ?? null;

export function setChangesListOpen(open: boolean) {
  set(() => ({ listOpen: open }));
}

export const setChangesListWidth = (listWidth: number | null) => set((s) => (s.listWidth === listWidth ? {} : { listWidth }));

export function setAllDiffsCollapsed(collapsed: boolean) {
  set((s) => ({ allCollapsed: collapsed, collapseNonce: s.collapseNonce + 1 }));
}

export const setWordWrap = (wordWrap: boolean) => set(() => ({ wordWrap }));
export const setTreeView = (treeView: boolean) => set(() => ({ treeView }));
export const setChangesWide = (wide: boolean) => set((s) => (s.wide === wide ? {} : { wide }));
export const setChecksOpen = (checksOpen: boolean) => set((s) => (s.checksOpen === checksOpen ? {} : { checksOpen }));
