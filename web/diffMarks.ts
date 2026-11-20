import { Change as ChangeCtor, Chunk, diff, getChunks, getOriginalDoc, mergeViewSiblings, type Change, type DiffConfig } from "@codemirror/merge";
import type { Extension, Text } from "@codemirror/state";
import { RangeSetBuilder } from "@codemirror/state";
import { Decoration, EditorView, GutterMarker, lineNumberWidgetMarker, ViewPlugin, type BlockInfo, type DecorationSet, type ViewUpdate, type WidgetType } from "@codemirror/view";

export type DiffSide = "a" | "b";

// 덩어리의 한 쪽에 줄이 없는지. 문서 끝 뒤의 빈 줄 하나(기준이 빈 파일일 때)도 없는 것으로 본다.
function isEmptySide(chunk: Chunk, side: DiffSide, doc: Text) {
  const from = side === "a" ? chunk.fromA : chunk.fromB;
  const to = side === "a" ? chunk.toA : chunk.toB;
  return from >= to || from >= doc.length;
}

// 덩어리 한쪽에서 실제로 줄로 보이는 줄 수. 빈 문서와 비교하는 덩어리는 라이브러리가 빈 줄 하나를 범위에 넣어도 0 이다(추가 파일의 삭제 줄, 지운 파일의 추가 줄이 0개).
export function visibleLineCount(chunk: Chunk, side: DiffSide, doc: Text): number {
  if (isEmptySide(chunk, side, doc)) return 0;
  const from = side === "a" ? chunk.fromA : chunk.fromB;
  const to = side === "a" ? chunk.toA : chunk.toB;
  return doc.lineAt(Math.min(to, doc.length) - 1 < from ? from : Math.min(to, doc.length) - 1).number - doc.lineAt(from).number + 1;
}

// 덩어리가 통째로 추가인지 삭제인지 그 밖(일부 수정)인지. a 는 기준 문서, b 는 현재 문서.
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

// 키 위치의 변경 목록. 줄마다 서로 다른 글자 하나로 바꾼 두 문자열을 diff 하면 줄 단위 Myers 가 된다(정수 배열용 diff 를 따로 두지 않으려는 것).
// 서로 다른 줄이 한 글자로 담을 수 있는 수(약 6만)를 넘으면 null 로 글자 단위 비교에 맡긴다.
function lineFirstKeyDiff(ka: LineKey, kb: LineKey): Change[] | null {
  const ids = new Map<string, string>();
  const encode = (lines: string[]) => {
    let out = "";
    for (const line of lines) {
      let ch = ids.get(line);
      if (ch === undefined) {
        const id = ids.size;
        // 서로게이트 구간(0xD800~0xDFFF)은 혼자 쓰면 깨진 문자열이 되어 건너뛴다
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
  // 모든 줄이 줄바꿈으로 끝나는 것처럼 키 끝에 "\n" 을 하나 붙인 공간에서 계산한다. 그래야 줄 구간이 늘 "줄들 + \n" 이 된다.
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
    // 한쪽이 비면 줄을 통째로 넣거나 뺀 것, 아니면 그 구간 안을 글자로 비교한다(바뀐 줄 안의 글자 강조)
    const inner = fromA === toA || fromB === toB ? [{ fromA: 0, toA: toA - fromA, fromB: 0, toB: toB - fromB }] : diff(textA.slice(fromA, toA), textB.slice(fromB, toB), { scanLimit: 500 });
    for (const c of inner) out.push(new ChangeCtor(fromA + c.fromA, fromA + c.toA, fromB + c.fromB, fromB + c.toB));
  }
  // 붙인 "\n" 까지 닿은 변경(파일 끝에 줄을 넣거나 뺌)은 한 글자 앞으로 민다. "y\n" 뒤에 "z\n" 을 넣는 것과 "y" 뒤에 "\nz" 를 넣는 것은 같다.
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

// 비교에 쓰는 글(키)과 키 위치를 원래 글 위치로 되돌리는 함수. trim 이면 줄마다 앞뒤 공백을 뗀다.
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

// inline 과 split 이 같은 덩어리를 만들도록 diff 화면은 모두 이 설정을 쓴다. 줄 먼저 비교 + 앞뒤 공백 무시.
export const DIFF_CONFIG: DiffConfig = { scanLimit: 500, override: (a, b) => lineFirstDiff(a, b, true) };
export const QUICK_DIFF_CONFIG: DiffConfig = { scanLimit: 500, override: (a, b) => lineFirstDiff(a, b, false) };

const wholeLine = Decoration.line({ class: "cm-wholeChangedLine" });

// 통째 추가, 삭제 덩어리와 줄바꿈을 넘는 변경의 줄에 cm-wholeChangedLine 을, inline 의 삭제 위젯 줄에 같은 클래스를 단다.
// 색은 diffColors(web/diffSplit.ts)와 editorTheme(web/Editor.tsx)이 정한다.
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
    return null; // unified 가 아닌 편집기(split 의 두 칸)에는 기준 문서 필드가 없다
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
        // split 의 왼쪽 편집기는 오른쪽이 만들어지기 전에 이 확장을 먼저 만들어 옆 문서를 못 읽는다. 한 번 비워 두고 곧 다시 그린다.
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

// 반대쪽 문서: split 은 옆 편집기, inline 은 기준 문서.
function otherDoc(view: EditorView, side: DiffSide): Text | null {
  const siblings = mergeViewSiblings(view);
  if (siblings) return (side === "a" ? siblings.b : siblings.a)?.state.doc ?? null;
  return getOriginalDoc(view.state);
}

// inline 의 삭제 위젯은 라이브러리가 만든 DOM 이라 클래스를 다는 곳이 없다. 위젯이 그려진 뒤 줄 요소에 직접 단다.
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

// 빈 문서와 비교할 때 라이브러리는 빈 쪽의 "줄 하나"를 변경 줄로 센다(내용이 없는 문서도 줄은 하나라서). 그 줄이 새 파일의 "hello" 위에 줄 번호 없는 빨간 빈 줄로, 지운 파일 아래에 초록 빈 줄로 그려진다.
// 편집기에 data-doc-empty(지금 문서가 빔)와 data-base-empty(unified 의 기준 문서가 빔)를 달아 두면 diffColors 의 규칙(web/diffSplit.ts)이 그 줄을 감춘다.
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
          // unified 가 아닌 편집기(split 의 두 칸)에는 기준 문서 필드가 없다
        }
        view.dom.toggleAttribute("data-base-empty", baseEmpty);
      }
    },
  );
}
