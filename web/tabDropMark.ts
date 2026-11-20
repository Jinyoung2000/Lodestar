import { clampDrop } from "./editorTabs";


export type StripTabBox = { key: string; left: number; right: number; sticky: boolean; editor: boolean };

export type DropMark = { beforeKey: string | null; x: number };

// tabs 는 줄에 보이는 탭을 왼쪽부터(끌고 있는 탭은 뺀다). editor 가 아닌 탭(Changes, Files, Card 같은 고정 칸 탭)은 자리를 가늠하는 데만 쓴다.
// dragged 는 끌고 있는 탭의 붙박이 여부(다른 그룹에서 왔어도 같다), stripLeft 는 탭이 하나도 없는 줄의 선 위치다.
export function dropMarkAt(tabs: readonly StripTabBox[], x: number, dragged: { key: string; sticky: boolean }, stripLeft: number): DropMark {
  // 마우스가 탭 가운데보다 왼쪽에 있는 첫 탭 앞에 놓는다. 없으면 맨 끝
  const raw = tabs.find((t) => x < t.left + (t.right - t.left) / 2)?.key ?? null;
  const editors = tabs.filter((t) => t.editor).map((t) => ({ key: t.key, kind: "file", sticky: t.sticky }));
  // 에디터 탭 사이가 아닌 자리(고정 칸 탭 앞)는 보정하지 않는다
  const clamped = raw !== null && !editors.some((t) => t.key === raw) ? raw : clampDrop(editors, { key: dragged.key, kind: "file", sticky: dragged.sticky }, raw);
  const target = clamped === null ? undefined : tabs.find((t) => t.key === clamped);
  const last = tabs[tabs.length - 1];
  return { beforeKey: clamped, x: target ? target.left : last ? last.right : stripLeft };
}
