import { groupIdsOf, MAIN_GROUP, normalizeLayout, type EditorLayout } from "./editorGroups";


export type Side = "left" | "right" | "up" | "down";

const horizontal = (side: Side) => side === "left" || side === "right";
const forward = (side: Side) => side === "right" || side === "down";

// 트리에서 id 그룹의 side 쪽 이웃 그룹. side 방향으로 놓인 가장 가까운 상위 분할의 다음 칸에서 id 와 가까운 쪽 첫 그룹을 고른다. 없으면 null.
export function groupInDirection(layout: EditorLayout, id: string, side: Side): string | null {
  const path = pathTo(layout, id);
  if (!path) return null;
  const dir = horizontal(side) ? "row" : "column";
  for (let depth = path.length - 1; depth >= 0; depth--) {
    const { node, index } = path[depth];
    if (node.dir !== dir) continue;
    const next = index + (forward(side) ? 1 : -1);
    if (next < 0 || next >= node.children.length) continue;
    return edgeGroup(node.children[next], side);
  }
  return null;
}

type Step = { node: Extract<EditorLayout, { type: "split" }>; index: number };

function pathTo(layout: EditorLayout, id: string): Step[] | null {
  if (layout.type === "group") return layout.id === id ? [] : null;
  for (let index = 0; index < layout.children.length; index++) {
    const rest = pathTo(layout.children[index], id);
    if (rest) return [{ node: layout, index }, ...rest];
  }
  return null;
}

// 이웃 칸 안에서 들어오는 쪽(side 의 반대편)에 가장 가까운 그룹. 같은 방향 분할이면 첫 또는 마지막 자식, 직각 분할이면 첫 자식(위 또는 왼쪽 끝)이다.
function edgeGroup(node: EditorLayout, side: Side): string {
  if (node.type === "group") return node.id;
  const dir = horizontal(side) ? "row" : "column";
  const child = node.dir === dir ? (forward(side) ? node.children[0] : node.children[node.children.length - 1]) : node.children[0];
  return edgeGroup(child, side);
}

// 화면 읽는 순서의 index 번째 그룹(0부터). 범위 밖이면 null.
export const groupAtIndex = (layout: EditorLayout, index: number): string | null => groupIdsOf(layout)[index] ?? null;

// 두 그룹의 자리를 맞바꾼다. 크기는 자리에 남는다.
export function swapGroups(layout: EditorLayout, a: string, b: string): EditorLayout {
  if (layout.type === "group") return layout.id === a ? { ...layout, id: b } : layout.id === b ? { ...layout, id: a } : layout;
  return { ...layout, children: layout.children.map((c) => swapGroups(c, a, b)) };
}

// Move Editor Group Left, Right, Up, Down: 그 방향 이웃과 자리를 바꾼다. 이웃이 없으면 그대로(null).
export function moveGroup(layout: EditorLayout, id: string, side: Side): EditorLayout | null {
  const other = groupInDirection(layout, id, side);
  return other ? swapGroups(layout, id, other) : null;
}

// 모든 분할의 방향을 뒤집는다(Flip Editor Group Layout). 크기 비율은 그대로.
export function flipLayout(layout: EditorLayout): EditorLayout {
  if (layout.type === "group") return layout;
  return { ...layout, dir: layout.dir === "row" ? "column" : "row", children: layout.children.map(flipLayout) };
}

// 모든 분할의 크기를 같게 한다(Reset Editor Group Sizes).
export function evenLayout(layout: EditorLayout): EditorLayout {
  if (layout.type === "group") return layout;
  const share = 1 / layout.children.length;
  return { ...layout, sizes: layout.children.map(() => share), children: layout.children.map(evenLayout) };
}

// --- 배치 프리셋 ---

export type LayoutPreset = "single" | "twoColumns" | "threeColumns" | "twoRows" | "threeRows" | "grid" | "twoRowsRight" | "twoColumnsBottom";

export const LAYOUT_PRESETS: readonly LayoutPreset[] = ["single", "twoColumns", "threeColumns", "twoRows", "threeRows", "grid", "twoRowsRight", "twoColumnsBottom"];

type Shape = { dir: "row" | "column"; children: (Shape | null)[] } | null;

const SHAPES: Record<LayoutPreset, Shape> = {
  single: null,
  twoColumns: { dir: "row", children: [null, null] },
  threeColumns: { dir: "row", children: [null, null, null] },
  twoRows: { dir: "column", children: [null, null] },
  threeRows: { dir: "column", children: [null, null, null] },
  grid: { dir: "row", children: [{ dir: "column", children: [null, null] }, { dir: "column", children: [null, null] }] },
  twoRowsRight: { dir: "row", children: [null, { dir: "column", children: [null, null] }] },
  twoColumnsBottom: { dir: "column", children: [null, { dir: "row", children: [null, null] }] },
};

const countOf = (shape: Shape): number => (shape === null ? 1 : shape.children.reduce<number>((n, c) => n + countOf(c), 0));
export const presetGroupCount = (preset: LayoutPreset) => countOf(SHAPES[preset]);

export type PresetPlan = {
  layout: EditorLayout;
  // 새 배치의 그룹 id(읽는 순서). 기존 그룹을 먼저 쓰고 모자란 만큼 새 id 를 만든다.
  ids: string[];
  // 새로 만든 빈 그룹
  created: string[];
  // 사라지는 그룹. 이 그룹의 탭은 호출하는 쪽이 mergeInto 로 옮긴다.
  removed: string[];
  mergeInto: string;
};

// 기존 그룹을 읽는 순서대로 새 모양에 채우고, 남는 그룹은 지우며(탭은 마지막 그룹으로 합친다) 모자라면 빈 그룹을 만든다. main 그룹은 지우지 않는다.
export function planPreset(layout: EditorLayout, preset: LayoutPreset, newId: () => string, newSplitId: () => string): PresetPlan {
  const shape = SHAPES[preset];
  const need = countOf(shape);
  const existing = groupIdsOf(layout);
  let kept = existing.slice(0, need);
  if (existing.length > need && !kept.includes(MAIN_GROUP)) kept = [...kept.slice(0, need - 1), MAIN_GROUP];
  const removed = existing.filter((id) => !kept.includes(id));
  const created: string[] = [];
  while (kept.length < need) {
    const id = newId();
    created.push(id);
    kept.push(id);
  }
  const queue = [...kept];
  const build = (s: Shape): EditorLayout => {
    if (s === null) return { type: "group", id: queue.shift()! };
    return { type: "split", id: newSplitId(), dir: s.dir, children: s.children.map(build), sizes: s.children.map(() => 1 / s.children.length) };
  };
  return { layout: normalizeLayout(build(shape)), ids: kept, created, removed, mergeInto: kept[kept.length - 1] };
}

// 활성 그룹을 side 쪽에 새로 만드는 빈 그룹의 자리를 정한다(New Editor Group Right 등). 계산은 splitGroup 이 하므로 여기는 방향만 푼다.
export function splitSpec(side: Side): { dir: "row" | "column"; before: boolean } {
  return { dir: horizontal(side) ? "row" : "column", before: side === "left" || side === "up" };
}

// 한 그룹을 다음 그룹에 합친다(Join Editor Group with Next Group): 다음 그룹이 있으면 [현재, 다음], 없으면 null.
export function nextToJoin(layout: EditorLayout, id: string): string | null {
  const ids = groupIdsOf(layout);
  const index = ids.indexOf(id);
  return index === -1 ? null : (ids[index + 1] ?? null);
}
