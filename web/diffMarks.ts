import { Change as ChangeCtor, Chunk, diff, getChunks, getOriginalDoc, mergeViewSiblings, type Change, type DiffConfig } from "@codemirror/merge";
import type { Extension, Text } from "@codemirror/state";
import { RangeSetBuilder } from "@codemirror/state";
import { Decoration, EditorView, GutterMarker, lineNumberWidgetMarker, ViewPlugin, type BlockInfo, type DecorationSet, type ViewUpdate, type WidgetType } from "@codemirror/view";

export type DiffSide = "a" | "b";

function isEmptySide(chunk: Chunk, side: DiffSide, doc: Text) {
  const from = side === "a" ? chunk.fromA : chunk.fromB;
  const to = side === "a" ? chunk.toA : chunk.toB;
  return from >= to || from >= doc.length;
}

export function visibleLineCount(chunk: Chunk, side: DiffSide, doc: Text): number {
  if (isEmptySide(chunk, side, doc)) return 0;
  const from = side === "a" ? chunk.fromA : chunk.fromB;
  const to = side === "a" ? chunk.toA : chunk.toB;
  return doc.lineAt(Math.min(to, doc.length) - 1 < from ? from : Math.min(to, doc.length) - 1).number - doc.lineAt(from).number + 1;
}

export function chunkKind(chunk: Chunk, a: Text, b: Text): "added" | "removed" | "modified" {
  if (isEmptySide(chunk, "a", a)) return "added";
  if (isEmptySide(chunk, "b", b)) return "removed";
  return "modified";
}

export function wholeLines(chunk: Chunk, side: DiffSide, doc: Text, other: Text): number[] {
  if (isEmptySide(chunk, side, doc)) return [];
  const from = side === "a" ? chunk.fromA : chunk.fromB;
  const to = side === "a" ? chunk.toA : chunk.toB;
  const first = doc.lineAt(from).number;
  const last = doc.lineAt(Math.min(to, doc.length) - 1 < from ? from : Math.min(to, doc.length) - 1).number;
  const all = Array.from({ length: last - first + 1 }, (_, i) => i);
  if (isEmptySide(chunk, side === "a" ? "b" : "a", other)) return all;
  return all.filter((i) => {
    const line = doc.line(first + i);
    return chunk.changes.some((c) => {
      const cf = from + (side === "a" ? c.fromA : c.fromB);
      const ct = from + (side === "a" ? c.toA : c.toB);
      return cf <= line.from && ct > line.to;
    });
  });
}

function lineFirstDiff(a: string, b: string, trim: boolean): readonly Change[] {
  const ka = lineKey(a, trim);
  const kb = lineKey(b, trim);
  const keyed = lineFirstKeyDiff(ka, kb) ?? diff(ka.key, kb.key, { scanLimit: 500 });
  return keyed.map((c) => new ChangeCtor(ka.toOriginal(c.fromA), ka.toOriginal(c.toA), kb.toOriginal(c.fromB), kb.toOriginal(c.toB)));
}

type LineKey = ReturnType<typeof lineKey>;

function lineFirstKeyDiff(ka: LineKey, kb: LineKey): Change[] | null {
  const ids = new Map<string, string>();
  const encode = (lines: string[]) => {
    let out = "";
    for (const line of lines) {
      let ch = ids.get(line);
      if (ch === undefined) {
        const id = ids.size;
        const code = id < 0xd800 ? id : id + 0x800;
        if (code > 0xffff) return null;
        ch = String.fromCharCode(code);
        ids.set(line, ch);
      }
      out += ch;
    }
    return out;
  };
  const la = encode(ka.lines);
  const lb = la === null ? null : encode(kb.lines);
  if (la === null || lb === null) return null;
  const textA = ka.key + "\n";
  const textB = kb.key + "\n";
  const startA = (line: number) => (line < ka.lines.length ? ka.keyStart[line] : textA.length);
  const startB = (line: number) => (line < kb.lines.length ? kb.keyStart[line] : textB.length);
  const out: Change[] = [];
  for (const block of diff(la, lb)) {
    const fromA = startA(block.fromA);
    const fromB = startB(block.fromB);
    const toA = startA(block.toA);
    const toB = startB(block.toB);
    const inner = fromA === toA || fromB === toB ? [{ fromA: 0, toA: toA - fromA, fromB: 0, toB: toB - fromB }] : diff(textA.slice(fromA, toA), textB.slice(fromB, toB), { scanLimit: 500 });
    for (const c of inner) out.push(new ChangeCtor(fromA + c.fromA, fromA + c.toA, fromB + c.fromB, fromB + c.toB));
  }
  const lenA = ka.key.length;
  const lenB = kb.key.length;
  const fitted: Change[] = [];
  for (const c of out) {
    if (c.toA <= lenA && c.toB <= lenB) {
      fitted.push(c);
      continue;
    }
    if (c.fromA === 0 || c.fromB === 0 || textA[c.fromA - 1] !== "\n" || textB[c.fromB - 1] !== "\n") return null;
    fitted.push(new ChangeCtor(c.fromA - 1, c.toA - 1, c.fromB - 1, c.toB - 1));
  }
  return fitted.every((c) => c.toA <= lenA && c.toB <= lenB) ? fitted : null;
}

function lineKey(text: string, trim: boolean) {
  const lines = text.split("\n");
  const keyStart: number[] = [];
  const origStart: number[] = [];
  const lead: number[] = [];
  const trimmedLength: number[] = [];
  const keys: string[] = [];
  let key = 0;
  let orig = 0;
  for (const line of lines) {
    const trimmed = trim ? line.trim() : line;
    const lead0 = trim && trimmed ? line.length - line.trimStart().length : 0;
    keyStart.push(key);
    origStart.push(orig);
    lead.push(lead0);
    trimmedLength.push(trimmed.length);
    keys.push(trimmed);
    key += trimmed.length + 1;
    orig += line.length + 1;
  }
  const toOriginal = (pos: number) => {
    let lo = 0;
    let hi = lines.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (keyStart[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    const col = pos - keyStart[lo];
    if (col <= 0) return origStart[lo];
    if (col >= trimmedLength[lo]) return origStart[lo] + lines[lo].length;
    return origStart[lo] + lead[lo] + col;
  };
  return { key: keys.join("\n"), lines: keys, keyStart, toOriginal };
}

export const DIFF_CONFIG: DiffConfig = { scanLimit: 500, override: (a, b) => lineFirstDiff(a, b, true) };
export const QUICK_DIFF_CONFIG: DiffConfig = { scanLimit: 500, override: (a, b) => lineFirstDiff(a, b, false) };

const wholeLine = Decoration.line({ class: "cm-wholeChangedLine" });

export function diffMarks(): Extension {
  return [marksPlugin, lineNumberWidgetMarker.of(deletedNumbers)];
}

class DeletedNumbers extends GutterMarker {
  elementClass = "cm-deletedLineGutter";
  constructor(
    readonly first: number,
    readonly count: number,
  ) {
    super();
  }
  eq(other: DeletedNumbers) {
    return other.first === this.first && other.count === this.count;
  }
  toDOM() {
    const el = document.createElement("div");
    for (let i = 0; i < this.count; i++) el.appendChild(document.createElement("div")).textContent = String(this.first + i);
    return el;
  }
}

function deletedNumbers(view: EditorView, widget: WidgetType, block: BlockInfo): GutterMarker | null {
  const chunk = getChunks(view.state)?.chunks.find((c) => c.fromB === block.from);
  if (!chunk || !(widget as { dom?: HTMLElement | null }).dom?.classList.contains("cm-deletedChunk")) return null;
  let original: Text;
  try {
    original = getOriginalDoc(view.state);
  } catch {
    return null;
  }
  const count = visibleLineCount(chunk, "a", original);
  return count ? new DeletedNumbers(original.lineAt(chunk.fromA).number, count) : null;
}

const marksPlugin = (
  ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      chunks: readonly Chunk[] | null;
      constructor(view: EditorView) {
        const built = build(view);
        this.chunks = built ? (getChunks(view.state)?.chunks ?? null) : null;
        this.decorations = built ?? Decoration.none;
        if (!built) setTimeout(() => view.dom.isConnected && view.dispatch({}));
        mark(view, this.chunks);
      }
      update(update: ViewUpdate) {
        const chunks = getChunks(update.state)?.chunks ?? null;
        if (update.docChanged || chunks !== this.chunks) {
          this.chunks = chunks;
          this.decorations = build(update.view) ?? Decoration.none;
        }
        mark(update.view, chunks);
      }
    },
    { decorations: (plugin) => plugin.decorations },
  )
);

function build(view: EditorView): DecorationSet | null {
  const info = getChunks(view.state);
  const builder = new RangeSetBuilder<Decoration>();
  if (!info) return builder.finish();
  const side: DiffSide = info.side ?? "b";
  const doc = view.state.doc;
  const other = otherDoc(view, side);
  if (!other) return null;
  for (const chunk of info.chunks) {
    const from = side === "a" ? chunk.fromA : chunk.fromB;
    if (isEmptySide(chunk, side, doc)) continue;
    const first = doc.lineAt(from).number;
    for (const i of wholeLines(chunk, side, doc, other)) builder.add(doc.line(first + i).from, doc.line(first + i).from, wholeLine);
  }
  return builder.finish();
}

function otherDoc(view: EditorView, side: DiffSide): Text | null {
  const siblings = mergeViewSiblings(view);
  if (siblings) return (side === "a" ? siblings.b : siblings.a)?.state.doc ?? null;
  return getOriginalDoc(view.state);
}

function mark(view: EditorView, chunks: readonly Chunk[] | null) {
  if (!chunks || mergeViewSiblings(view)) return;
  view.requestMeasure({
    read: () => [...view.contentDOM.querySelectorAll<HTMLElement>(".cm-deletedChunk")],
    write: (widgets) => {
      const original = getOriginalDoc(view.state);
      for (const widget of widgets) {
        const at = view.posAtDOM(widget);
        const chunk = chunks.find((c) => c.fromB === at);
        const lines = widget.querySelectorAll(".cm-deletedLine");
        const fill = new Set(chunk ? wholeLines(chunk, "a", original, view.state.doc) : []);
        lines.forEach((line, i) => line.classList.toggle("cm-wholeChangedLine", fill.has(i)));
      }
    },
  });
}

export function emptySides(): Extension {
  return ViewPlugin.fromClass(
    class {
      constructor(view: EditorView) {
        this.sync(view);
      }
      update(update: ViewUpdate) {
        this.sync(update.view);
      }
      sync(view: EditorView) {
        view.dom.toggleAttribute("data-doc-empty", view.state.doc.length === 0);
        let baseEmpty = false;
        try {
          baseEmpty = getOriginalDoc(view.state).length === 0;
        } catch {
        }
        view.dom.toggleAttribute("data-base-empty", baseEmpty);
      }
    },
  );
}
