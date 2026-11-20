import { groupOf } from "./editorGroups";

// 에디터 탭 목록의 순수 규칙: 같은 파일의 탭이 여러 그룹에 있을 때의 키, 붙박이(sticky) 탭의 자리, 탭 이동. 상태는 web/store.ts 가 들고 이 파일은 값만 다룬다.

// 한 파일의 탭이 둘 이상이면 첫 탭이 `workspaceId:path`, 나머지는 `workspaceId:path#2`, `#3` 이다. 파일 이름에 `#숫자` 가 끝에 오는 경우까지 지우지 않도록 마지막 `#숫자` 한 번만 본다.
export const baseKeyOf = (key: string) => key.replace(/#\d+$/, "");

// 파일 이름을 바꿨을 때 탭의 새 키: 새 기본 키에 옛 키 끝의 #번호를 그대로 붙인다(같은 파일의 다른 그룹 탭끼리 키가 겹치지 않게).
export const renamedKey = (newBase: string, oldKey: string) => `${newBase}${oldKey.slice(baseKeyOf(oldKey).length)}`;

export function uniqueKey(existing: readonly string[], base: string): string {
  const used = new Set(existing);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) if (!used.has(`${base}#${n}`)) return `${base}#${n}`;
}

type Keyed = { key: string; kind: string; group?: string; sticky?: boolean; preview?: boolean };

// 같은 파일(또는 같은 diff)을 가리키는 탭인지. 이름 없는 탭, Browser, Search 탭은 늘 서로 다른 탭이다.
export function sameContent(a: Keyed, b: Keyed): boolean {
  return a.kind === b.kind && DUPLICABLE.has(a.kind) && baseKeyOf(a.key) === baseKeyOf(b.key);
}

// 두 그룹에 복사해서 열 수 있는 탭 종류. 파일과 diff 는 내용이 파일에서 오고, 이름 없는 탭(메모리에만 있는 내용), Browser(webview), Search(결과 상태)는 한 곳에만 둔다.
const DUPLICABLE = new Set(["file", "diff", "scm", "replace"]);
export const isDuplicable = (tab: Pick<Keyed, "kind">) => DUPLICABLE.has(tab.kind);

// 그룹에서 같은 내용의 탭
export function findInGroup<T extends Keyed>(tabs: readonly T[], group: string, like: Keyed): T | undefined {
  return tabs.find((t) => groupOf(t) === group && sameContent(t, like));
}

// --- 붙박이(Pin) 탭 ---

// 붙박이 탭은 그룹 안에서 늘 앞에 모인다. beforeKey 는 놓을 자리 바로 뒤 탭의 키(null 이면 줄 끝)이고, 붙박이가 아닌 탭은 붙박이 구역 안으로, 붙박이 탭은 구역 밖으로 못 들어간다.
export function clampDrop(groupTabs: readonly Keyed[], dragged: Keyed, beforeKey: string | null): string | null {
  const others = groupTabs.filter((t) => t.key !== dragged.key);
  const firstLoose = others.find((t) => !t.sticky)?.key ?? null;
  if (dragged.sticky) {
    const target = beforeKey === null ? undefined : others.find((t) => t.key === beforeKey);
    // 붙박이 탭은 붙박이 탭 앞이거나 첫 일반 탭 앞에만 놓인다
    return !target || !target.sticky ? firstLoose : beforeKey;
  }
  const target = beforeKey === null ? undefined : others.find((t) => t.key === beforeKey);
  return target?.sticky ? firstLoose : beforeKey;
}

// 붙박이로 바꾸거나 푼 뒤 그 탭이 가야 할 자리(그 앞 탭 키). 붙으면 붙박이 구역 끝, 풀리면 붙박이 구역 바로 뒤이니 어느 쪽이든 첫 일반 탭 앞이다. 일반 탭이 없으면 줄 끝(null).
export function stickyAnchor(groupTabs: readonly Keyed[], key: string): string | null {
  return groupTabs.find((t) => t.key !== key && !t.sticky)?.key ?? null;
}

// 닫기 계열 명령(Close Others, Close to the Right, Close Saved, Close All)이 건드릴 키. 붙박이 탭은 빼고, 명령이 가리킨 탭 자신은 includeSelf 로 정한다.
export function closable(tabs: readonly Keyed[], keys: readonly string[]): string[] {
  const sticky = new Set(tabs.filter((t) => t.sticky).map((t) => t.key));
  return keys.filter((k) => !sticky.has(k));
}

// --- 그룹 안 이동 ---

// 활성 탭 기준 이전, 다음 탭 키(끝에서 끝으로 이어진다). 탭이 하나뿐이면 null.
export function stepTab(keys: readonly string[], active: string | null, step: 1 | -1): string | null {
  if (keys.length < 2) return null;
  const index = active === null ? -1 : keys.indexOf(active);
  if (index === -1) return keys[step === 1 ? 0 : keys.length - 1];
  return keys[(index + step + keys.length) % keys.length];
}

// 탭 하나를 그룹 안에서 한 칸 옮길 때 놓을 자리(그 앞 탭 키, null 이면 끝). 붙박이 구역을 넘지 않는다. 옮길 수 없으면 undefined.
export function shiftTarget(groupTabs: readonly Keyed[], key: string, step: 1 | -1): string | null | undefined {
  const index = groupTabs.findIndex((t) => t.key === key);
  if (index === -1) return undefined;
  const tab = groupTabs[index];
  const swapWith = groupTabs[index + step];
  if (!swapWith || !!swapWith.sticky !== !!tab.sticky) return undefined;
  if (step === -1) return swapWith.key;
  return groupTabs[index + 2]?.key ?? null;
}

// MRU 목록(가장 최근이 뒤)을 화면용으로 뒤집어 보인다: 지금 탭이 맨 앞, 그다음이 직전에 보던 탭. 그룹에 없는 키는 빼고, MRU 에 없는 탭은 뒤에 그룹 순서로 붙인다.
export function mruOrder(mru: readonly string[], groupKeys: readonly string[], active: string | null): string[] {
  const live = new Set(groupKeys);
  const recent = [...mru].reverse().filter((k, i, all) => live.has(k) && all.indexOf(k) === i);
  const head = active && live.has(active) ? [active, ...recent.filter((k) => k !== active)] : recent;
  return [...head, ...groupKeys.filter((k) => !head.includes(k))];
}
