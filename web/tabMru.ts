import { neighborAfterClose } from "./editorGroups";
export type TabMru = Record<string, readonly string[]>;

const MAX = 50;

export function touchTab(mru: TabMru, group: string, key: string): TabMru {
  const list = mru[group] ?? [];
  if (list[list.length - 1] === key) return mru;
  return { ...mru, [group]: [...list.filter((k) => k !== key), key].slice(-MAX) };
}

// 활성 탭이 바뀐 순간을 기록한다. 이전 활성 탭이 아직 목록에 없으면(처음 열린 Changes 같은) 먼저 넣어 두어야 닫을 때 돌아갈 곳이 된다.
export function noteActive(mru: TabMru, prev: { group: string; key: string | null }, next: { group: string; key: string | null }): TabMru {
  let out = mru;
  if (prev.key && !(out[prev.group] ?? []).includes(prev.key)) out = touchTab(out, prev.group, prev.key);
  if (next.key) out = touchTab(out, next.group, next.key);
  if (prev.key && !(out[ALL_GROUPS] ?? []).includes(prev.key)) out = touchTab(out, ALL_GROUPS, prev.key);
  if (next.key) out = touchTab(out, ALL_GROUPS, next.key);
  return out;
}

// 그룹 id 와 겹치지 않는 예약 키. recentAfterClose 는 닫는 그룹의 목록만 읽어 영향이 없다.
export const ALL_GROUPS = "*";

// 닫는 탭을 뺀 가장 최근 활성 탭. available 은 그룹에 지금 있는 탭 키(고정 탭 포함)다. 없으면 null.
export function recentAfterClose(mru: TabMru, group: string, closing: string, available: readonly string[]): string | null {
  const list = mru[group] ?? [];
  for (let i = list.length - 1; i >= 0; i--) if (list[i] !== closing && available.includes(list[i])) return list[i];
  return null;
}

// 활성 탭을 닫았을 때 대신 활성이 될 탭: 그 그룹에서 직전에 활성이던 에디터 탭, 없으면 이웃 탭, 그것도 없으면 fallback(main 그룹이 보던 고정 탭, 다른 그룹은 null).
// 고정 탭(Changes, Files)은 에디터 탭이 열려 있는 동안 활성이 되지 않으므로(web/floatLayout.ts normalizeTabs) 후보에 넣지 않는다.
export function pickAfterClose(mru: TabMru, group: string, closing: string, siblings: readonly string[], fallback: string | null): string | null {
  return recentAfterClose(mru, group, closing, siblings) ?? neighborAfterClose(siblings, closing) ?? fallback;
}
