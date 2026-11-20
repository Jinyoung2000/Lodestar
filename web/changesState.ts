import { useSyncExternalStore } from "react";
import { defaultChangeScope, type Agent, type ChangedFile, type ChangeScope, type ShellNote } from "../shared/protocol";

// B4: 변경 패널이 세션마다 고른 범위와 선택한 파일, 파일 목록 열 표시. store.ts 의 State 와 따로 둔 작은 저장소다.
// 범위가 세션의 기본 범위(defaultChangeScope)와 다를 때만 scoped 에 그 범위의 변경 목록을 들고 있고, 기본 범위는 store 의 gitChanges 를 그대로 쓴다.
export type ScopedChanges = { scope: ChangeScope; includeOutside: boolean; base: string | null; files: ChangedFile[]; outsideCount?: number; shellNote?: ShellNote };

type ChangesViewState = {
  scope: Record<string, ChangeScope>;
  scoped: Record<string, ScopedChanges>;
  // "Show changes outside this folder": 모노레포에서 세션의 작업 폴더 밖 변경도 보일지. 기본은 끔(세션 폴더 안만).
  showOutside: Record<string, boolean>;
  // 목록에서 고른 파일 경로(절대). nonce 가 바뀔 때마다 패널이 그 섹션으로 스크롤한다.
  selected: Record<string, { path: string; nonce: number } | null>;
  listOpen: boolean;
  // 파일 목록 열 폭(px). null 이면 기본 폭(--size-changes-list).
  listWidth: number | null;
  // 패널 `...` 메뉴가 바꾸는 보기 설정. 모든 세션에 같이 적용된다.
  // allCollapsed 가 바뀔 때마다 collapseNonce 도 올라서, 카드가 자기 접힘 상태를 그 값으로 덮어쓴다(그 뒤에 카드를 따로 펴고 접는 것은 자유).
  allCollapsed: boolean;
  collapseNonce: number;
  wordWrap: boolean;
  // 파일 목록을 폴더 트리로 보일지(View as Tree). 기본은 평평한 목록이다.
  treeView: boolean;
  // 패널이 파일 카드가 보이는 넓은 상태인지. 탭줄 `...` 메뉴가 항목을 고르는 데 쓴다.
  wide: boolean;
  // Editor 배치의 왼쪽 Changes 뷰(파일 목록만 보이는 상태)에서 목록 아래 Checks 구역이 펼쳐져 있는지. 기본은 접힘.
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

// 렌더 밖에서 지금 상태를 읽는다(단위 시험과 이벤트 처리기용).
export const getChangesView = () => state;

export function useChangesView<T>(select: (s: ChangesViewState) => T): T {
  return useSyncExternalStore(subscribe, () => select(state));
}

export const getChangesScope = (agent: Agent): ChangeScope => state.scope[agent.id] ?? defaultChangeScope(agent);
export const getScoped = (agentId: string) => state.scoped[agentId];
export const getShowOutside = (agentId: string) => state.showOutside[agentId] === true;

// 패널이 지금 그려야 할 변경 목록. 기본 범위이고 폴더 밖을 안 보이면 store 의 gitChanges 를, 그 밖에는 따로 받아 둔 목록(범위와 폴더 밖 포함 여부가 같은 것)을 쓴다. 아직 못 받았으면 undefined.
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
