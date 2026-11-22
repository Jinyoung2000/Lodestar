import { groupIdsOf, MAIN_GROUP, normalizeLayout, type EditorLayout } from "./editorGroups";


export type Side = "left" | "right" | "up" | "down";

const horizontal = (side: Side) => side === "left" || side === "right";
const forward = (side: Side) => side === "right" || side === "down";

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

function edgeGroup(node: EditorLayout, side: Side): string {
  if (node.type === "group") return node.id;
  const dir = horizontal(side) ? "row" : "column";
  const child = node.dir === dir ? (forward(side) ? node.children[0] : node.children[node.children.length - 1]) : node.children[0];
  return edgeGroup(child, side);
}

export const groupAtIndex = (layout: EditorLayout, index: number): string | null => groupIdsOf(layout)[index] ?? null;

export function swapGroups(layout: EditorLayout, a: string, b: string): EditorLayout {
  if (layout.type === "group") return layout.id === a ? { ...layout, id: b } : layout.id === b ? { ...layout, id: a } : layout;
  return { ...layout, children: layout.children.map((c) => swapGroups(c, a, b)) };
}

export function moveGroup(layout: EditorLayout, id: string, side: Side): EditorLayout | null {
  const other = groupInDirection(layout, id, side);
  return other ? swapGroups(layout, id, other) : null;
}

export function flipLayout(layout: EditorLayout): EditorLayout {
  if (layout.type === "group") return layout;
  return { ...layout, dir: layout.dir === "row" ? "column" : "row", children: layout.children.map(flipLayout) };
}

export function evenLayout(layout: EditorLayout): EditorLayout {
  if (layout.type === "group") return layout;
  const share = 1 / layout.children.length;
  return { ...layout, sizes: layout.children.map(() => share), children: layout.children.map(evenLayout) };
}

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
  ids: string[];
  created: string[];
  removed: string[];
  mergeInto: string;
};

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

export function splitSpec(side: Side): { dir: "row" | "column"; before: boolean } {
  return { dir: horizontal(side) ? "row" : "column", before: side === "left" || side === "up" };
}

export function nextToJoin(layout: EditorLayout, id: string): string | null {
  const ids = groupIdsOf(layout);
  const index = ids.indexOf(id);
  return index === -1 ? null : (ids[index + 1] ?? null);
}
