import { MAIN_GROUP } from "./editorGroups";

export type PreviewableTab = { key: string; group?: string; preview?: boolean };

export type OpenMode = "preview" | "pinned";
export type OpenPlan<T> = {
  tabs: T[];
  // 이번 열기가 자리를 바꿔 끼운 옛 미리보기 탭의 키. 없으면 null.
  replaced: string | null;
  // 새 탭이 목록에 들어왔는가(이미 열려 있던 탭이면 false)
  added: boolean;
};

const groupOf = (tab: PreviewableTab) => tab.group ?? MAIN_GROUP;

// next 를 group 에 연다.
// 이미 어느 그룹에든 열려 있으면 새로 만들지 않는다: pinned 로 열면 그 탭을 고정하고, preview 로 열면 그대로 둔다(고정 탭이 미리보기로 되돌아가지 않는다).
// 새 탭이면 pinned 는 맨 끝에 붙이고, preview 는 그 그룹의 기존 미리보기 탭 자리에 바꿔 끼운다(그룹마다 미리보기 탭은 하나뿐이라 없으면 끝에 붙인다).
export function planOpen<T extends PreviewableTab>(tabs: T[], group: string, next: T, mode: OpenMode): OpenPlan<T> {
  const existing = tabs.find((t) => t.key === next.key);
  if (existing) return { tabs: mode === "pinned" ? pinTab(tabs, next.key) : tabs, replaced: null, added: false };
  const { group: _ignored, preview: _stale, ...rest } = next;
  const placed = { ...rest, ...(group === MAIN_GROUP ? {} : { group }), ...(mode === "preview" ? { preview: true } : {}) } as unknown as T;
  const slot = mode === "preview" ? tabs.findIndex((t) => t.preview === true && groupOf(t) === group) : -1;
  if (slot === -1) return { tabs: [...tabs, placed], replaced: null, added: true };
  const out = [...tabs];
  const replaced = out[slot].key;
  out[slot] = placed;
  return { tabs: out, replaced, added: true };
}

// key 탭의 preview 를 뗀다. 미리보기가 아니면 같은 배열 객체를 돌려준다.
export function pinTab<T extends PreviewableTab>(tabs: T[], key: string): T[] {
  if (!tabs.some((t) => t.key === key && t.preview)) return tabs;
  return tabs.map((t) => {
    if (t.key !== key) return t;
    const { preview: _gone, ...rest } = t;
    return rest as T;
  });
}

export const isPreview = (tab: PreviewableTab | undefined) => tab?.preview === true;
