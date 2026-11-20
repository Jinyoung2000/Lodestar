import { foldGutter, foldService } from "@codemirror/language";
import { EditorState, RangeSetBuilder, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { highlightTree } from "@lezer/highlight";
import type { RpcMethods } from "../shared/protocol";
import { editorSyntaxTheme, syntaxHighlighters } from "./editorSyntax";
import { languageIdFor } from "./languageId";
import { languageById, subscribeLanguages } from "./languages";
import { searchSummary } from "./searchText";


export type SearchResult = RpcMethods["files.search"]["result"];

export type DocLine =
  | { kind: "summary" }
  | { kind: "blank" }
  | { kind: "path"; path: string; lastRow: number }
  | { kind: "row"; path: string; line: number; match: boolean; prefix: number };

export type SearchDoc = { text: string; lines: DocLine[] };

export function buildSearchDoc(result: SearchResult): SearchDoc {
  const out: string[] = [searchSummary(result.matches, result.files.length, result.truncated), ""];
  const lines: DocLine[] = [{ kind: "summary" }, { kind: "blank" }];
  result.files.forEach((file, fileIndex) => {
    if (fileIndex > 0) {
      out.push("");
      lines.push({ kind: "blank" });
    }
    const pathAt = out.length;
    out.push(`${file.path}:`);
    lines.push({ kind: "path", path: file.path, lastRow: pathAt + 1 });
    const width = String(file.rows.reduce((max, r) => Math.max(max, r.line), 0)).length;
    file.rows.forEach((row, rowIndex) => {
      // 이어지지 않는 줄 사이는 빈 줄로 나눈다
      if (rowIndex > 0 && row.line !== file.rows[rowIndex - 1].line + 1) {
        out.push("");
        lines.push({ kind: "blank" });
      }
      const head = `  ${String(row.line).padStart(width)}${row.match ? ":" : " "} `;
      out.push(`${head}${row.text}`);
      lines.push({ kind: "row", path: file.path, line: row.line, match: row.match, prefix: head.length });
      (lines[pathAt] as { lastRow: number }).lastRow = out.length;
    });
  });
  return { text: out.join("\n"), lines };
}

// 문서의 줄(1부터)에 해당하는 결과 줄
export const rowAt = (doc: SearchDoc, lineNumber: number): Extract<DocLine, { kind: "row" }> | null => {
  const found = doc.lines[lineNumber - 1];
  return found?.kind === "row" ? found : null;
};

// 파일 경로로 정한 언어(web/languageId.ts)의 구문 색 범위들. 줄 하나씩 읽으므로 여러 줄에 걸친 문법(주석 블록 등)은 칠하지 못하고, 마크다운은 한 줄로는 뜻이 없어 칠하지 않는다.
export function syntaxRanges(path: string, text: string): { from: number; to: number; cls: string }[] {
  const id = languageIdFor(path);
  if (!id || id === "markdown" || !text.trim()) return [];
  const language = languageById(id);
  if (!language) return [];
  const ranges: { from: number; to: number; cls: string }[] = [];
  highlightTree(language.parser.parse(text), syntaxHighlighters, (from, to, cls) => ranges.push({ from, to, cls }));
  return ranges;
}

// 결과 문서의 장식: 경로 밑줄, 줄 번호 흐림, 일치 강조, 줄마다 구문 색, 결과 줄 안내선
function decorations(doc: SearchDoc, pattern: RegExp | null) {
  return (state: EditorState): DecorationSet => {
    const builder = new RangeSetBuilder<Decoration>();
    for (let n = 1; n <= state.doc.lines && n <= doc.lines.length; n++) {
      const info = doc.lines[n - 1];
      const line = state.doc.line(n);
      if (info.kind === "path") {
        builder.add(line.from, line.from, Decoration.line({ class: "cm-search-path-line" }));
        builder.add(line.from, line.to, Decoration.mark({ class: "cm-search-path" }));
      } else if (info.kind === "row") {
        builder.add(line.from, line.from, Decoration.line({ class: info.match ? "cm-search-row cm-search-row-match" : "cm-search-row" }));
        const code = line.text.slice(info.prefix);
        const marks: { from: number; to: number; cls: string; rank: number }[] = [{ from: 0, to: info.prefix, cls: "cm-search-no", rank: 0 }];
        for (const r of syntaxRanges(info.path, code)) marks.push({ from: info.prefix + r.from, to: info.prefix + r.to, cls: r.cls, rank: 1 });
        if (pattern && info.match) {
          pattern.lastIndex = 0;
          for (const m of code.matchAll(pattern)) if (m[0] !== "" && m.index !== undefined) marks.push({ from: info.prefix + m.index, to: info.prefix + m.index + m[0].length, cls: "cm-search-match", rank: 2 });
        }
        // RangeSetBuilder 는 시작 위치 순으로 넣어야 한다
        marks.sort((a, b) => a.from - b.from || a.rank - b.rank || a.to - b.to);
        for (const m of marks) if (m.to > m.from) builder.add(line.from + m.from, line.from + m.to, Decoration.mark({ class: m.cls }));
      }
    }
    return builder.finish();
  };
}

// 편집기 확장. onOpen 은 결과 줄을 한 번 누르면(pinned false, 미리보기 탭) 부르고, 두 번 누르거나 Enter 를 누르면 고정 탭으로(pinned true) 부른다.
// 글을 끌어 선택하는 중이거나 선택이 남은 채의 누름, Shift 와 수정키 누름, 접기 화살표 누름은 열지 않는다.
export type SearchOpen = (row: Extract<DocLine, { kind: "row" }>, column: number, pinned: boolean, side: boolean) => void;
export function searchEditorExtensions(doc: SearchDoc, pattern: RegExp | null, onOpen: SearchOpen): Extension {
  const decorate = decorations(doc, pattern);
  const open = (view: EditorView, pos: number, pinned: boolean, side = false) => {
    const line = view.state.doc.lineAt(pos);
    const row = rowAt(doc, line.number);
    if (!row) return false;
    onOpen(row, Math.max(1, pos - line.from - row.prefix + 1), pinned, side);
    return true;
  };
  // 누른 자리에서 4px 넘게 끌고 놓은 것은 글 선택이라 열지 않는다.
  let down: { x: number; y: number } | null = null;
  return [
    EditorState.readOnly.of(true),
    EditorView.lineWrapping,
    editorSyntaxTheme,
    // 파일 경로 줄에서 그 파일의 결과 줄 전체를 접는다
    foldService.of((state, lineStart) => {
      const number = state.doc.lineAt(lineStart).number;
      const info = doc.lines[number - 1];
      if (info?.kind !== "path" || info.lastRow <= number) return null;
      return { from: state.doc.line(number).to, to: state.doc.line(Math.min(info.lastRow, state.doc.lines)).to };
    }),
    foldGutter({
      markerDOM: (open) => {
        const el = document.createElement("span");
        el.className = `codicon codicon-${open ? "chevron-down" : "chevron-right"}`;
        return el;
      },
    }),
    ViewPlugin.fromClass(
      class {
        decorations: DecorationSet;
        private stale = false;
        private unsubscribe: () => void;
        constructor(view: EditorView) {
          this.decorations = decorate(view.state);
          // 처음 보는 언어는 읽는 동안 색이 없다. 도착하면 장식을 다시 만든다.
          this.unsubscribe = subscribeLanguages(() => {
            this.stale = true;
            view.dispatch({});
          });
        }
        update(update: ViewUpdate) {
          // 문서는 바뀌지 않는다(읽기 전용)
          if (!this.stale) return;
          this.stale = false;
          this.decorations = decorate(update.state);
        }
        destroy() {
          this.unsubscribe();
        }
      },
      { decorations: (v) => v.decorations },
    ),
    EditorView.domEventHandlers({
      mousedown: (event) => {
        down = { x: event.clientX, y: event.clientY };
        return false;
      },
      click: (event, view) => {
        const dragged = down !== null && Math.hypot(event.clientX - down.x, event.clientY - down.y) > 4;
        // ⌥클릭, ⌥⌘클릭: 옆 그룹에 고정 탭으로 연다
        if (!dragged && event.detail === 1 && event.button === 0 && event.altKey && !event.shiftKey && !event.ctrlKey && view.state.selection.main.empty && !(event.target as HTMLElement).closest(".cm-gutters")) {
          const at = view.posAtCoords({ x: event.clientX, y: event.clientY });
          return at !== null && open(view, at, true, true);
        }
        if (dragged || event.detail !== 1 || event.button !== 0 || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey || !view.state.selection.main.empty) return false;
        if ((event.target as HTMLElement).closest(".cm-gutters")) return false;
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        return pos !== null && open(view, pos, false);
      },
      dblclick: (event, view) => {
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        return pos !== null && open(view, pos, true);
      },
      keydown: (event, view) => (event.key === "Enter" && !event.isComposing ? open(view, view.state.selection.main.head, true, event.metaKey || event.ctrlKey) : false),
    }),
  ];
}
