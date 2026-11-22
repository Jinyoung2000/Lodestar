export type FoldRegion = { start: number; end: number };

export type IndentRegionInput = {
  lineCount: number;
  indentOf: (lineIndex: number) => number;
  offSide: boolean;
  markers?: { start: RegExp; end: RegExp; textOf: (lineIndex: number) => string } | null;
};

type Pending = { indent: number; endAbove: number; line: number };

export function computeIndentRegions(input: IndentRegionInput): FoldRegion[] {
  const { lineCount, indentOf, offSide, markers } = input;
  const found: FoldRegion[] = [];
  const stack: Pending[] = [{ indent: -1, endAbove: lineCount + 1, line: lineCount + 1 }];
  for (let line = lineCount; line > 0; line--) {
    const indent = indentOf(line - 1);
    let previous = stack[stack.length - 1]!;
    if (indent === -1) {
      if (offSide) previous.endAbove = line;
      continue;
    }
    if (markers) {
      const text = markers.textOf(line - 1);
      const isStart = markers.start.test(text);
      const isEnd = !isStart && markers.end.test(text);
      if (isStart) {
        let i = stack.length - 1;
        while (i > 0 && stack[i]!.indent !== -2) i--;
        if (i > 0) {
          stack.length = i + 1;
          previous = stack[i]!;
          found.push({ start: line, end: previous.line });
          previous.line = line;
          previous.indent = indent;
          previous.endAbove = line;
          continue;
        }
      } else if (isEnd) {
        stack.push({ indent: -2, endAbove: line, line });
        continue;
      }
    }
    if (previous.indent > indent) {
      do {
        stack.pop();
        previous = stack[stack.length - 1]!;
      } while (previous.indent > indent);
      const end = previous.endAbove - 1;
      if (end - line >= 1) found.push({ start: line, end });
    }
    if (previous.indent === indent) previous.endAbove = line;
    else stack.push({ indent, endAbove: line, line });
  }
  return found.reverse();
}

export function computeMarkerRegions(lineCount: number, textOf: (lineIndex: number) => string, start: RegExp, end: RegExp): FoldRegion[] {
  const found: FoldRegion[] = [];
  const ends: number[] = [];
  for (let line = lineCount; line > 0; line--) {
    const text = textOf(line - 1);
    if (start.test(text)) {
      const endLine = ends.pop();
      if (endLine !== undefined) found.push({ start: line, end: endLine });
    } else if (end.test(text)) ends.push(line);
  }
  return found.reverse();
}

export type RegionTree = {
  regions: readonly FoldRegion[];
  parent: readonly number[];
};

export function buildRegionTree(input: readonly FoldRegion[]): RegionTree {
  const sorted = [...input].filter((r) => r.end > r.start).sort((a, b) => a.start - b.start || b.end - a.end);
  const regions: FoldRegion[] = [];
  const parent: number[] = [];
  const open: number[] = [];
  for (const region of sorted) {
    while (open.length > 0 && region.start > regions[open[open.length - 1]!]!.end) open.pop();
    const top = open[open.length - 1];
    if (regions.length > 0 && regions[regions.length - 1]!.start === region.start) continue;
    if (top !== undefined && region.end > regions[top]!.end) continue;
    regions.push(region);
    parent.push(top ?? -1);
    open.push(regions.length - 1);
  }
  return { regions, parent };
}

export function regionIndexAt(tree: RegionTree, line: number): number {
  const { regions, parent } = tree;
  let low = 0;
  let high = regions.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (line < regions[mid]!.start) high = mid;
    else low = mid + 1;
  }
  let index = low - 1;
  while (index >= 0) {
    if (line <= regions[index]!.end) return index;
    index = parent[index]!;
  }
  return -1;
}

export function regionsAtLine(tree: RegionTree, line: number, filter?: (index: number, level: number) => boolean): number[] {
  const result: number[] = [];
  let index = regionIndexAt(tree, line);
  let level = 1;
  while (index >= 0) {
    if (!filter || filter(index, level)) result.push(index);
    level++;
    index = tree.parent[index]!;
  }
  return result;
}

const containedBy = (tree: RegionTree, inner: number, outer: number) => {
  const a = tree.regions[inner]!;
  const b = tree.regions[outer]!;
  return a.start >= b.start && a.end <= b.end;
};

export function regionsInside(tree: RegionTree, outer: number | null, filter?: (index: number, level: number) => boolean): number[] {
  const result: number[] = [];
  const first = outer === null ? 0 : outer + 1;
  const endLine = outer === null ? Number.MAX_VALUE : tree.regions[outer]!.end;
  const levelStack: number[] = [];
  for (let i = first; i < tree.regions.length; i++) {
    if (tree.regions[i]!.start >= endLine) break;
    while (levelStack.length > 0 && !containedBy(tree, i, levelStack[levelStack.length - 1]!)) levelStack.pop();
    levelStack.push(i);
    if (!filter || filter(i, levelStack.length)) result.push(i);
  }
  return result;
}

export type PlanInput = { tree: RegionTree; collapsed: (index: number) => boolean };

export function planSetState({ tree, collapsed }: PlanInput, target: boolean, levels: number, lines?: readonly number[]): number[] {
  const result: number[] = [];
  if (lines && lines.length > 0) {
    for (const line of lines) {
      const index = regionIndexAt(tree, line);
      if (index < 0) continue;
      if (collapsed(index) !== target) result.push(index);
      if (levels > 1) result.push(...regionsInside(tree, index, (i, level) => collapsed(i) !== target && level < levels));
    }
  } else {
    result.push(...regionsInside(tree, null, (i, level) => collapsed(i) !== target && level < levels));
  }
  return result;
}

export function planFoldAtLines({ tree, collapsed }: PlanInput, target: boolean, lines: readonly number[]): number[] {
  const result: number[] = [];
  for (const line of lines) {
    const found = regionsAtLine(tree, line, (i) => collapsed(i) !== target);
    if (found.length > 0) result.push(found[0]!);
  }
  return result;
}

export function planToggle({ tree, collapsed }: PlanInput, levels: number, lines: readonly number[]): number[] {
  const result: number[] = [];
  for (const line of lines) {
    const index = regionIndexAt(tree, line);
    if (index < 0) continue;
    const target = !collapsed(index);
    result.push(index);
    if (levels > 1) result.push(...regionsInside(tree, index, (i, level) => collapsed(i) !== target && level < levels));
  }
  return result;
}

export function planLevel({ tree, collapsed }: PlanInput, level: number, target: boolean, lines: readonly number[]): number[] {
  return regionsInside(tree, null, (i, at) => at === level && collapsed(i) !== target && !lines.some((line) => line >= tree.regions[i]!.start && line <= tree.regions[i]!.end));
}

export function planExcept({ tree, collapsed }: PlanInput, target: boolean, lines: readonly number[]): number[] {
  const kept: number[] = [];
  for (const line of lines) {
    const found = regionsAtLine(tree, line);
    if (found.length > 0) kept.push(found[0]!);
  }
  return regionsInside(tree, null, (i) => kept.every((k) => !containedBy(tree, k, i) && !containedBy(tree, i, k)) && collapsed(i) !== target);
}

export function planByStartLine({ tree, collapsed }: PlanInput, target: boolean, matches: (startLine: number) => boolean): number[] {
  const result: number[] = [];
  for (let i = tree.regions.length - 1; i >= 0; i--) {
    if (collapsed(i) !== target && matches(tree.regions[i]!.start)) result.push(i);
  }
  return result;
}

export type ClickModifier = "plain" | "recursive" | "others";

export function planIconClick({ tree, collapsed }: PlanInput, index: number, modifier: ClickModifier): number[] {
  const wasCollapsed = collapsed(index);
  if (modifier === "others") {
    const others = regionsInside(tree, null, (i) => !containedBy(tree, i, index) && !containedBy(tree, index, i));
    const collapsedOnes = others.filter((i) => collapsed(i));
    return collapsedOnes.length === 0 ? others : collapsedOnes;
  }
  const result: number[] = [];
  const recursive = modifier === "recursive";
  if (recursive) for (const i of regionsInside(tree, index)) if (collapsed(i) === wasCollapsed) result.push(i);
  if (wasCollapsed || !recursive || result.length === 0) result.push(index);
  return result;
}

export type RegionMarkers = { start: RegExp; end: RegExp };

const SLASH_REGION: RegionMarkers = { start: /^\s*\/\/\s*#?region\b/, end: /^\s*\/\/\s*#?endregion\b/ };
const CSS_REGION: RegionMarkers = { start: /^\s*\/\*\s*#region\b\s*(.*?)\s*\*\//, end: /^\s*\/\*\s*#endregion\b.*\*\// };
const HTML_REGION: RegionMarkers = { start: /^\s*<!--\s*#region\b.*-->/, end: /^\s*<!--\s*#endregion\b.*-->/ };
const HASH_REGION: RegionMarkers = { start: /^\s*#\s*region\b/, end: /^\s*#\s*endregion\b/ };

const MARKERS_BY_EXTENSION: Record<string, RegionMarkers> = {
  ts: SLASH_REGION,
  tsx: SLASH_REGION,
  mts: SLASH_REGION,
  cts: SLASH_REGION,
  js: SLASH_REGION,
  jsx: SLASH_REGION,
  mjs: SLASH_REGION,
  cjs: SLASH_REGION,
  json: SLASH_REGION,
  jsonc: SLASH_REGION,
  go: SLASH_REGION,
  rs: SLASH_REGION,
  java: { start: /^\s*\/\/\s*(?:(?:#?region\b)|(?:<editor-fold\b))/, end: /^\s*\/\/\s*(?:(?:#?endregion\b)|(?:<\/editor-fold>))/ },
  cs: { start: /^\s*#region\b/, end: /^\s*#endregion\b/ },
  css: CSS_REGION,
  scss: CSS_REGION,
  less: CSS_REGION,
  html: HTML_REGION,
  htm: HTML_REGION,
  xml: HTML_REGION,
  svg: HTML_REGION,
  md: { start: /^\s*<!--\s*#?region\b.*-->/, end: /^\s*<!--\s*#?endregion\b.*-->/ },
  markdown: { start: /^\s*<!--\s*#?region\b.*-->/, end: /^\s*<!--\s*#?endregion\b.*-->/ },
  py: HASH_REGION,
  yml: HASH_REGION,
  yaml: HASH_REGION,
  sh: { start: /^\s*#\s*#?region\b.*/, end: /^\s*#\s*#?endregion\b.*/ },
  bash: { start: /^\s*#\s*#?region\b.*/, end: /^\s*#\s*#?endregion\b.*/ },
  zsh: { start: /^\s*#\s*#?region\b.*/, end: /^\s*#\s*#?endregion\b.*/ },
  sql: { start: /^\s*--\s*#region\b/, end: /^\s*--\s*#endregion\b/ },
};

export function regionMarkersFor(path: string | null): RegionMarkers | null {
  if (!path) return null;
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot < 0 ? null : (MARKERS_BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? null);
}

