import type { RpcMethods } from "../shared/protocol";
import type { SearchSettings } from "../shared/searchSettings";


type Result = RpcMethods["files.search"]["result"];

export type SearchHit = {
  key: string;
  path: string;
  line: number;
  start: number;
  end: number;
  text: string;
  textOffset: number;
};

export type FileResult = { path: string; name: string; dir: string; hits: SearchHit[] };

export type ViewMode = "tree" | "list";

export type TreeNode = FolderNode | FileNode | HitNode;
export type FolderNode = { kind: "folder"; key: string; path: string; label: string; children: (FolderNode | FileNode)[]; hitCount: number; fileCount: number };
export type FileNode = { kind: "file"; key: string; file: FileResult; children: HitNode[]; hitCount: number };
export type HitNode = { kind: "hit"; key: string; hit: SearchHit };

export const hitKey = (path: string, line: number, start: number) => `${path}:${line}:${start}`;
export const fileKey = (path: string) => `file:${path}`;
export const folderKey = (path: string) => `folder:${path}`;

const dirOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));
const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

export function filesOf(result: Result): FileResult[] {
  const files: FileResult[] = [];
  for (const file of result.files) {
    const hits: SearchHit[] = [];
    for (const row of file.rows) {
      if (!row.match) continue;
      const textOffset = row.offset ?? 0;
      for (const range of row.ranges?.length ? row.ranges : [{ start: 0, end: Math.min(1, row.text.length) }]) {
        const start = textOffset + range.start;
        hits.push({ key: hitKey(file.path, row.line, start), path: file.path, line: row.line, start, end: textOffset + range.end, text: row.text, textOffset });
      }
    }
    if (hits.length > 0) files.push({ path: file.path, name: nameOf(file.path), dir: dirOf(file.path), hits });
  }
  return files;
}

export const hitCountOf = (files: readonly FileResult[]) => files.reduce((sum, file) => sum + file.hits.length, 0);


const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function compareFileNames(a: string, b: string): number {
  const result = collator.compare(a, b);
  return result !== 0 ? result : a < b ? -1 : a > b ? 1 : 0;
}

export function comparePaths(a: string, b: string): number {
  const left = a.split("/");
  const right = b.split("/");
  for (let i = 0; ; i++) {
    const leftEnd = i === left.length - 1;
    const rightEnd = i === right.length - 1;
    if (leftEnd && rightEnd) return compareFileNames(left[i], right[i]);
    if (leftEnd) return -1;
    if (rightEnd) return 1;
    const l = left[i].toLowerCase();
    const r = right[i].toLowerCase();
    if (l !== r) return l < r ? -1 : 1;
  }
}

const extensionOf = (name: string) => {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1);
};

export function compareFiles(a: FileResult, b: FileResult, order: SearchSettings["sortOrder"]): number {
  const byDefault = () => comparePaths(a.path, b.path) || compareFileNames(a.name, b.name);
  switch (order) {
    case "countDescending":
      return b.hits.length - a.hits.length || byDefault();
    case "countAscending":
      return a.hits.length - b.hits.length || byDefault();
    case "type":
      return collator.compare(extensionOf(a.name), extensionOf(b.name)) || compareFileNames(a.name, b.name);
    case "fileNames":
      return compareFileNames(a.name, b.name);
    default:
      return byDefault();
  }
}

export function buildNodes(files: readonly FileResult[], mode: ViewMode, order: SearchSettings["sortOrder"] = "default", roots?: readonly string[]): (FolderNode | FileNode)[] {
  if (roots) return rootNodes(files, mode, order, roots);
  const sorted = [...files].sort((a, b) => compareFiles(a, b, order));
  const fileNodes = sorted.map<FileNode>((file) => ({ kind: "file", key: fileKey(file.path), file, hitCount: file.hits.length, children: file.hits.map((hit) => ({ kind: "hit", key: hit.key, hit })) }));
  if (mode === "list") return fileNodes;
  const root: DirBuilder = { name: "", path: "", dirs: new Map(), files: [] };
  fileNodes.forEach((node) => {
    let at = root;
    const segments = node.file.dir ? node.file.dir.split("/") : [];
    segments.forEach((segment, i) => {
      let next = at.dirs.get(segment);
      if (!next) {
        next = { name: segment, path: segments.slice(0, i + 1).join("/"), dirs: new Map(), files: [] };
        at.dirs.set(segment, next);
      }
      at = next;
    });
    at.files.push(node);
  });
  return foldersOf(root, 0, order);
}

function rootNodes(files: readonly FileResult[], mode: ViewMode, order: SearchSettings["sortOrder"], roots: readonly string[]): FolderNode[] {
  return roots.flatMap((label) => {
    const mine = files.filter((file) => file.path.startsWith(`${label}/`));
    if (mine.length === 0) return [];
    const children = buildNodes(mine, mode, order).map((node) => withRootPrefix(node, label));
    return [{ kind: "folder" as const, key: folderKey(label), path: label, label, children, hitCount: children.reduce((sum, child) => sum + child.hitCount, 0), fileCount: mine.length }];
  });
}

function withRootPrefix(node: FolderNode | FileNode, label: string): FolderNode | FileNode {
  if (node.kind === "file") return node;
  const path = `${label}/${node.path}`;
  return { ...node, key: folderKey(path), path, children: node.children.map((child) => withRootPrefix(child, label)) };
}

type DirBuilder = { name: string; path: string; dirs: Map<string, DirBuilder>; files: FileNode[] };

function foldersOf(dir: DirBuilder, depth: number, order: SearchSettings["sortOrder"]): (FolderNode | FileNode)[] {
  const folders = [...dir.dirs.values()].sort((a, b) => compareFileNames(a.name, b.name)).map((child) => folderNode(child, depth + 1, order));
  return [...folders, ...dir.files];
}

function folderNode(dir: DirBuilder, depth: number, order: SearchSettings["sortOrder"]): FolderNode {
  let tail = dir;
  let label = dir.name;
  if (depth > 1) {
    while (tail.files.length === 0 && tail.dirs.size === 1) {
      tail = [...tail.dirs.values()][0];
      label = `${label}/${tail.name}`;
    }
  }
  const children = foldersOf(tail, depth, order);
  return {
    kind: "folder",
    key: folderKey(tail.path),
    path: tail.path,
    label,
    children,
    hitCount: children.reduce((sum, child) => sum + child.hitCount, 0),
    fileCount: children.reduce((sum, child) => sum + (child.kind === "file" ? 1 : child.fileCount), 0),
  };
}

export function initialCollapsed(nodes: readonly TreeNode[], setting: SearchSettings["collapseResults"]): Set<string> {
  const collapsed = new Set<string>();
  const visit = (node: TreeNode) => {
    if (node.kind === "hit") return;
    const count = node.kind === "file" ? node.hitCount : node.hitCount;
    if (setting === "alwaysCollapse" || (setting === "auto" && count > 10)) collapsed.add(node.key);
    node.children.forEach(visit);
  };
  nodes.forEach(visit);
  if (setting !== "alwaysCollapse" && nodes.length === 1 && nodes[0].kind === "file" && nodes[0].hitCount < 50) collapsed.delete(nodes[0].key);
  return collapsed;
}

export const collapsibleKeys = (nodes: readonly TreeNode[]): string[] => nodes.flatMap((node) => (node.kind === "hit" ? [] : [node.key, ...collapsibleKeys(node.children)]));

export type VisibleRow = { node: TreeNode; depth: number; expanded: boolean | null };

export function visibleRows(nodes: readonly TreeNode[], collapsed: ReadonlySet<string>): VisibleRow[] {
  const rows: VisibleRow[] = [];
  const visit = (node: TreeNode, depth: number) => {
    if (node.kind === "hit") {
      rows.push({ node, depth, expanded: null });
      return;
    }
    const expanded = !collapsed.has(node.key);
    rows.push({ node, depth, expanded });
    if (expanded) node.children.forEach((child) => visit(child, depth + 1));
  };
  nodes.forEach((node) => visit(node, 0));
  return rows;
}

export const hasExpanded = (nodes: readonly TreeNode[], collapsed: ReadonlySet<string>) => collapsibleKeys(nodes).some((key) => !collapsed.has(key));

export function orderedHits(nodes: readonly TreeNode[]): SearchHit[] {
  return nodes.flatMap((node): SearchHit[] => (node.kind === "hit" ? [node.hit] : orderedHits(node.children)));
}

export const hitsUnder = (node: TreeNode): SearchHit[] => (node.kind === "hit" ? [node.hit] : orderedHits(node.children));

export function dismissHits(files: readonly FileResult[], dismissed: ReadonlySet<string>): FileResult[] {
  if (dismissed.size === 0) return files as FileResult[];
  return files.flatMap((file) => {
    const hits = file.hits.filter((hit) => !dismissed.has(hit.key));
    return hits.length === 0 ? [] : [hits.length === file.hits.length ? file : { ...file, hits }];
  });
}

const MAX_PREVIEW_CHARS = 250;
const LEAD_CHARS = 26;

export function lcut(text: string, n: number, prefix: string): string {
  const trimmed = text.trimStart();
  if (trimmed.length < n) return trimmed;
  const re = /\b/g;
  let last = 0;
  while (re.test(trimmed) && !(trimmed.length - re.lastIndex < n)) {
    last = re.lastIndex;
    re.lastIndex += 1;
  }
  return last === 0 ? trimmed : prefix + trimmed.slice(last).trimStart();
}

export type HitPreview = { before: string; inside: string; after: string; fullBefore: string };

export function previewOf(hit: SearchHit): HitPreview {
  const start = hit.start - hit.textOffset;
  const end = hit.end - hit.textOffset;
  const fullBefore = hit.text.slice(0, start);
  const before = lcut(fullBefore, LEAD_CHARS, "…");
  const inside = hit.text.slice(start, end).slice(0, Math.max(0, MAX_PREVIEW_CHARS - before.length));
  const after = hit.text.slice(end).slice(0, Math.max(0, MAX_PREVIEW_CHARS - before.length - inside.length));
  return { before, inside, after, fullBefore };
}

export const lineLabel = (hit: SearchHit) => `${hit.line}:`;

export const hitTooltip = (hit: SearchHit, replacement: string | null) => {
  const p = previewOf(hit);
  return `${p.fullBefore}${replacement ?? p.inside}${p.after}`.trim().slice(0, 999);
};
