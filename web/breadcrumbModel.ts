import type { ChangeDesc } from "@codemirror/state";
import type { SymbolNode } from "./documentSymbols";


export type Crumb =
  | { kind: "folder" | "file"; id: string; label: string; path: string; dir: string }
  | { kind: "symbol"; id: string; label: string; node: SymbolNode; siblings: readonly SymbolNode[] };

export function crumbsFor(path: string, tree: readonly SymbolNode[], symbolPath: readonly SymbolNode[]): Crumb[] {
  const parts = path.split("/");
  const crumbs: Crumb[] = parts.map((label, index): Crumb => {
    const target = parts.slice(0, index + 1).join("/");
    return { kind: index === parts.length - 1 ? "file" : "folder", id: target, label: label || "/", path: target, dir: parts.slice(0, index).join("/") };
  });
  symbolPath.forEach((node, index) => {
    crumbs.push({ kind: "symbol", id: `symbol:${index}:${node.name}`, label: node.name, node, siblings: index === 0 ? tree : symbolPath[index - 1]!.children });
  });
  return crumbs;
}

export const listable = (path: string) => !path.startsWith("/") && !path.split("/").includes("..");

export type PickerIcon = { kind: "folder"; name: string } | { kind: "file"; name: string } | { kind: "symbol"; symbolKind: number };
export type PickTarget = { type: "file" | "folder"; path: string } | { type: "symbol"; node: SymbolNode };

export type PickerItem = {
  id: string;
  label: string;
  icon: PickerIcon;
  hasChildren: boolean;
  children: () => PickerItem[];
  target: PickTarget;
};

type DirIndex = Map<string, { dirs: Set<string>; files: string[] }>;
const indexes = new WeakMap<readonly string[], WeakMap<readonly string[], DirIndex>>();

function dirIndexOf(files: readonly string[], emptyDirs: readonly string[]): DirIndex {
  let byEmpty = indexes.get(files);
  if (!byEmpty) indexes.set(files, (byEmpty = new WeakMap()));
  let index = byEmpty.get(emptyDirs);
  if (index) return index;
  index = new Map();
  const entry = (dir: string) => {
    let found = index!.get(dir);
    if (!found) index!.set(dir, (found = { dirs: new Set(), files: [] }));
    return found;
  };
  const addDir = (parts: string[]) => {
    for (let i = 0; i < parts.length; i++) entry(parts.slice(0, i).join("/")).dirs.add(parts.slice(0, i + 1).join("/"));
  };
  for (const path of files) {
    const parts = path.split("/");
    addDir(parts.slice(0, -1));
    entry(parts.slice(0, -1).join("/")).files.push(path);
  }
  for (const dir of emptyDirs) addDir(dir.split("/"));
  byEmpty.set(emptyDirs, index);
  return index;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const lastName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

export function fileItems(files: readonly string[], emptyDirs: readonly string[], dir: string): PickerItem[] {
  const index = dirIndexOf(files, emptyDirs);
  const here = index.get(dir);
  if (!here) return [];
  const folders = [...here.dirs].sort((a, b) => collator.compare(lastName(a), lastName(b)));
  const leaves = [...here.files].sort((a, b) => collator.compare(lastName(a), lastName(b)));
  return [
    ...folders.map((path): PickerItem => ({ id: path, label: lastName(path), icon: { kind: "folder", name: lastName(path) }, hasChildren: true, children: () => fileItems(files, emptyDirs, path), target: { type: "folder", path } })),
    ...leaves.map((path): PickerItem => ({ id: path, label: lastName(path), icon: { kind: "file", name: lastName(path) }, hasChildren: false, children: () => [], target: { type: "file", path } })),
  ];
}

export function symbolItems(nodes: readonly SymbolNode[]): PickerItem[] {
  return nodes.map((node) => ({
    id: symbolId(node),
    label: node.name,
    icon: { kind: "symbol", symbolKind: node.kind },
    hasChildren: node.children.length > 0,
    children: () => symbolItems(node.children),
    target: { type: "symbol", node },
  }));
}

export const symbolId = (node: SymbolNode) => `${node.kind}:${node.name}:${node.nameFrom}`;

export type PickerRow = { item: PickerItem; depth: number; parentId: string | null; expanded: boolean; match: readonly number[] | null };

const FILTER_SCAN_LIMIT = 5000;

export function visibleRows(items: readonly PickerItem[], expanded: ReadonlySet<string>, query = "", filter = false): PickerRow[] {
  const rows: PickerRow[] = [];
  const searching = filter && query !== "";
  let scanned = 0;
  const walk = (list: readonly PickerItem[], depth: number, parentId: string | null): boolean => {
    let kept = false;
    for (const item of list) {
      const match = query ? matchLabel(query, item.label) : null;
      const rowIndex = rows.length;
      const row: PickerRow = { item, depth, parentId, expanded: false, match };
      rows.push(row);
      scanned += 1;
      let childShown = false;
      if (item.hasChildren) {
        const open = expanded.has(item.id);
        if (searching) {
          if (scanned < FILTER_SCAN_LIMIT) childShown = walk(item.children(), depth + 1, item.id);
          row.expanded = childShown;
        } else if (open) {
          walk(item.children(), depth + 1, item.id);
          row.expanded = true;
        }
      }
      if (searching && !match && !childShown) rows.length = rowIndex;
      else kept = true;
    }
    return kept;
  };
  walk(items, 0, null);
  return rows;
}

export function matchLabel(query: string, label: string): number[] | null {
  const q = query.toLowerCase();
  const l = label.toLowerCase();
  if (!q) return null;
  const at = l.indexOf(q);
  if (at >= 0) return Array.from({ length: q.length }, (_, i) => at + i);
  const found: number[] = [];
  let from = 0;
  for (const ch of q) {
    const next = l.indexOf(ch, from);
    if (next < 0) return null;
    found.push(next);
    from = next + 1;
  }
  return found;
}

export function highlightParts(label: string, match: readonly number[] | null): { text: string; hit: boolean }[] {
  if (!match?.length) return [{ text: label, hit: false }];
  const hits = new Set(match);
  const parts: { text: string; hit: boolean }[] = [];
  for (let i = 0; i < label.length; i++) {
    const hit = hits.has(i);
    const last = parts[parts.length - 1];
    if (last && last.hit === hit) last.text += label[i];
    else parts.push({ text: label[i]!, hit });
  }
  return parts;
}

export function matchRowIndex(rows: readonly PickerRow[], from: number, step: -1 | 0 | 1): number {
  if (rows.length === 0) return -1;
  const start = from < 0 ? (step === -1 ? rows.length : -1) : from;
  for (let n = step === 0 ? 0 : 1; n <= rows.length; n++) {
    const index = (((start + (step === -1 ? -n : n)) % rows.length) + rows.length) % rows.length;
    if (rows[index]!.match) return index;
  }
  return -1;
}

export type PickerNav = "down" | "up" | "home" | "end" | "right" | "left" | "pageDown" | "pageUp";

export function navigatePicker(rows: readonly PickerRow[], focusId: string | null, nav: PickerNav, expanded: ReadonlySet<string>, pageSize = 10): { focusId: string | null; expanded: ReadonlySet<string> } {
  if (rows.length === 0) return { focusId, expanded };
  const at = rows.findIndex((row) => row.item.id === focusId);
  const go = (index: number) => ({ focusId: rows[Math.max(0, Math.min(rows.length - 1, index))]!.item.id, expanded });
  if (nav === "home") return go(0);
  if (nav === "end") return go(rows.length - 1);
  if (at < 0) return go(nav === "up" || nav === "pageUp" ? rows.length - 1 : 0);
  const row = rows[at]!;
  if (nav === "down") return go(at + 1);
  if (nav === "up") return go(at - 1);
  if (nav === "pageDown") return go(at + pageSize);
  if (nav === "pageUp") return go(at - pageSize);
  if (nav === "right") {
    if (!row.item.hasChildren) return { focusId, expanded };
    if (!row.expanded) return { focusId, expanded: new Set(expanded).add(row.item.id) };
    return rows[at + 1]?.parentId === row.item.id ? go(at + 1) : { focusId, expanded };
  }
  if (row.expanded) {
    const next = new Set(expanded);
    next.delete(row.item.id);
    return { focusId, expanded: next };
  }
  return row.parentId ? { focusId: row.parentId, expanded } : { focusId, expanded };
}

export const PICKER_ARROW = 8;
export const PICKER_MIN_WIDTH = 240;
export const PICKER_MAX_HEIGHT = 300;
export const PICKER_ROW = 22;
const PICKER_MARGIN = 8;
const PICKER_BOTTOM_GAP = 30;

export type Box = { left: number; top: number; width: number; height: number };

export type PickerPlacement = { left: number; top: number; width: number; maxHeight: number; arrowOffset: number };

export function pickerPlacement(anchor: Box, viewport: { width: number; height: number }, pointerX: number | null): PickerPlacement {
  const usable = viewport.width - PICKER_MARGIN;
  const width = Math.min(usable, Math.max(PICKER_MIN_WIDTH, usable / 4.17));
  const top = anchor.top + anchor.height + PICKER_ARROW;
  let maxHeight = Math.min(viewport.height * 0.7, PICKER_MAX_HEIGHT);
  if (top + maxHeight >= viewport.height) maxHeight = viewport.height - top - PICKER_BOTTOM_GAP;
  let left = anchor.left;
  if (left + width >= usable) left = usable - width;
  let arrow: number;
  if (pointerX !== null) {
    arrow = pointerX - left;
    const limit = width - 2 * PICKER_ARROW;
    if (arrow > limit) {
      left = Math.min(usable - width, left + arrow - limit);
      arrow = limit;
    }
  } else arrow = anchor.left + anchor.width * 0.3 - left;
  return { left, top, width, maxHeight, arrowOffset: Math.max(0, arrow) };
}

export const pickerBodyHeight = (rowCount: number, maxHeight: number) => Math.min(maxHeight - 2 * PICKER_ARROW, rowCount * PICKER_ROW);

export function mapSymbols(nodes: readonly SymbolNode[], changes: ChangeDesc): SymbolNode[] {
  return nodes.map((node) => {
    const from = changes.mapPos(node.from, 1);
    const nameFrom = changes.mapPos(node.nameFrom, 1);
    return {
      ...node,
      from,
      to: Math.max(from, changes.mapPos(node.to, -1)),
      nameFrom,
      nameTo: Math.max(nameFrom, changes.mapPos(node.nameTo, -1)),
      children: mapSymbols(node.children, changes),
    };
  });
}

export type SymbolTone = "class" | "function" | "variable" | "default";

export function symbolTone(kind: number): SymbolTone {
  if (kind === 5 || kind === 10 || kind === 24) return "class";
  if (kind === 6 || kind === 9 || kind === 12) return "function";
  if (kind === 8 || kind === 11 || kind === 13 || kind === 22) return "variable";
  return "default";
}
