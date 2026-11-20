import { syntaxTree } from "@codemirror/language";
import { EditorState, Prec, type Extension, type Range } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import type { EditorOptions } from "../shared/editorOptions";
import type { OptionContext } from "./editorBase";
import { cursorExtension } from "./editorCursor";
import { editingExtension } from "./editorEditing";
import { indentExtension } from "./editorIndent";
import { scrollExtension } from "./editorScroll";
import { selectionExtension } from "./editorSelection";

// 메모 편집기의 글 쓰는 모양. 코드 에디터(web/Editor.tsx)의 바탕은 그대로 쓰되, 본문은 앱 UI 글꼴(비례폭)과 읽기 편한 크기,
// 마크다운은 제목 크기, 목록, 인용, 굵게, 기울임, 링크를 렌더 비슷하게 꾸미는 장식(기호는 남긴다)으로 보인다. 코드 블록과 인라인 코드만 고정폭이다.

// 코드 에디터 설정 중 글 쓰기에 맞는 것만 가져온다: 커서, 선택, 스크롤, 들여쓰기, 편집 동작.
// 줄 번호, 접기, 미니맵, 개요 눈금자, 현재 줄 테두리, 괄호 자동 닫기, 괄호 색은 글에 방해라 뺀다. 줄 바꿈은 항상 켠다(EditorView.lineWrapping).
export function noteOptionExtensions(options: EditorOptions, context: OptionContext): Extension {
  return [
    EditorView.lineWrapping,
    cursorExtension(options, context),
    selectionExtension(options, context),
    scrollExtension({ ...options, scrollBeyondLastLine: false }, context),
    indentExtension(options, context),
    editingExtension(options, context),
  ];
}

// 줄 전체에 거는 장식: 제목(h1~h3, 그 아래 단계는 h3), 첫 줄, 인용, 코드 블록 줄
// 글자에 거는 장식: 굵게, 기울임, 인라인 코드, 링크, 마크다운 기호(#, -, >, *, `, [ ])
const MARK_NODES = new Set(["HeaderMark", "ListMark", "QuoteMark", "EmphasisMark", "CodeMark", "LinkMark", "TaskMarker", "CodeInfo"]);

const lineDeco = (cls: string) => Decoration.line({ class: cls });
const markDeco = (cls: string) => Decoration.mark({ class: cls });

function buildDecorations(state: EditorState, view: EditorView): DecorationSet {
  const out: Range<Decoration>[] = [];
  const doc = state.doc;
  // 줄마다 한 번만 거는 줄 장식(같은 줄에 여러 노드가 닿아도 겹치지 않게)
  const lined = new Set<string>();
  const line = (pos: number, cls: string) => {
    const key = `${pos}:${cls}`;
    if (lined.has(key)) return;
    lined.add(key);
    out.push(lineDeco(cls).range(pos));
  };
  const lines = (from: number, to: number, cls: string) => {
    for (let n = doc.lineAt(from).number; n <= doc.lineAt(Math.min(to, doc.length)).number; n++) line(doc.line(n).from, cls);
  };
  let firstLineBlock = false;
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter(node) {
        const name = node.name;
        const heading = /^ATXHeading([1-6])$/.exec(name);
        if (heading) {
          line(doc.lineAt(node.from).from, `cm-note-h${Math.min(Number(heading[1]), 3)}`);
          if (doc.lineAt(node.from).number === 1) firstLineBlock = true;
        } else if (name === "SetextHeading1" || name === "SetextHeading2") {
          line(doc.lineAt(node.from).from, name === "SetextHeading1" ? "cm-note-h1" : "cm-note-h2");
          if (doc.lineAt(node.from).number === 1) firstLineBlock = true;
        } else if (name === "Blockquote") {
          lines(node.from, node.to, "cm-note-quote");
          if (doc.lineAt(node.from).number === 1) firstLineBlock = true;
        } else if (name === "FencedCode") {
          lines(node.from, node.to, "cm-note-fence");
          if (doc.lineAt(node.from).number === 1) firstLineBlock = true;
        } else if (name === "StrongEmphasis") out.push(markDeco("cm-note-strong").range(node.from, node.to));
        else if (name === "Emphasis") out.push(markDeco("cm-note-em").range(node.from, node.to));
        else if (name === "InlineCode") out.push(markDeco("cm-note-code").range(node.from, node.to));
        else if (name === "Link" || name === "Image") out.push(markDeco("cm-note-link").range(node.from, node.to));
        else if (name === "URL") out.push(markDeco("cm-note-url").range(node.from, node.to));
        else if (MARK_NODES.has(name) && node.to > node.from) out.push(markDeco("cm-note-mark").range(node.from, node.to));
      },
    });
  }
  // 제목 줄: 첫 줄이 제목, 목록, 인용, 코드 블록이 아니면 마크다운 기호가 없어도 조금 크게 보인다.
  if (!firstLineBlock && doc.length > 0 && view.visibleRanges.some((r) => r.from === 0)) {
    const first = doc.line(1);
    if (!/^\s*([-*+]\s|\d+[.)]\s|```)/.test(first.text)) out.push(lineDeco("cm-note-title").range(first.from));
  }
  return Decoration.set(out, true);
}

const noteMarkdownPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view.state, view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged || syntaxTree(update.startState) !== syntaxTree(update.state)) this.decorations = buildDecorations(update.state, update.view);
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

// 선택자를 한 단계 더 구체적으로(&.cm-editor) 써서 코드 에디터의 editorTheme 보다 순서와 상관없이 이긴다.
const noteTheme = EditorView.theme({
  "&.cm-editor": { backgroundColor: "var(--editor-bg)" },
  "&.cm-editor.cm-focused": { outline: "none" },
  "&.cm-editor .cm-scroller": {
    fontFamily: "var(--font-sans)",
    fontSize: "var(--text-body)",
    lineHeight: "var(--leading-body)",
    fontWeight: "var(--weight-body)",
    fontVariantLigatures: "normal",
    fontFeatureSettings: "normal",
    letterSpacing: "var(--ui-letter-spacing, -0.02em)",
  },
  // 읽기 좋은 폭(--size-notes-text)으로 가운데 정렬하고 좌우에 여백을 둔다.
  // 좌우 여백은 .cm-content 가 아니라 모든 .cm-line 에 같은 값으로 준다: CodeMirror 의 선택 배경이 첫 줄의 padding 으로 줄 가장자리를 계산해서, 여백이 content 에 있거나 줄마다 다르면 선택이 여백까지 번진다.
  "&.cm-editor .cm-content": { boxSizing: "border-box", flexGrow: "0", width: "100%", maxWidth: "var(--size-notes-text)", margin: "0 auto", padding: "var(--space-6) 0" },
  "&.cm-editor .cm-line": { padding: "0 var(--space-6)" },
  "&.cm-editor .cm-placeholder": { color: "var(--fg-subtle)" },
  // 첫 줄. 제목 줄 규칙이 먼저 오고 마크다운 제목 규칙이 뒤에 와서 이긴다.
  "&.cm-editor .cm-line.cm-note-title": { fontSize: "1.25em", fontWeight: "var(--weight-title)", lineHeight: "1.4", color: "var(--fg-strong)" },
  "&.cm-editor .cm-line.cm-note-h1": { fontSize: "1.6em", fontWeight: "var(--weight-title)", lineHeight: "1.35", color: "var(--fg-strong)", paddingTop: "var(--space-2)" },
  "&.cm-editor .cm-line.cm-note-h2": { fontSize: "1.35em", fontWeight: "var(--weight-title)", lineHeight: "1.35", color: "var(--fg-strong)", paddingTop: "var(--space-1)" },
  "&.cm-editor .cm-line.cm-note-h3": { fontSize: "1.15em", fontWeight: "var(--weight-title)", lineHeight: "1.4", color: "var(--fg-strong)" },
  // 인용 막대와 코드 블록 배경은 줄 padding 을 건드리지 않도록 배경 그림으로 그린다(막대는 글자 왼쪽 --space-3, 코드 배경은 줄 양쪽에서 --space-3 안쪽).
  "&.cm-editor .cm-line.cm-note-quote": {
    color: "var(--fg-muted)",
    backgroundImage: "linear-gradient(var(--border), var(--border))",
    backgroundRepeat: "no-repeat",
    backgroundSize: "var(--space-0_5) 100%",
    backgroundPosition: "var(--space-3) 0",
  },
  "&.cm-editor .cm-line.cm-note-fence": {
    fontFamily: "var(--editor-font-family)",
    fontSize: "var(--text-code)",
    lineHeight: "var(--leading-code)",
    letterSpacing: "0",
    backgroundImage: "linear-gradient(var(--code-block-bg), var(--code-block-bg))",
    backgroundRepeat: "no-repeat",
    backgroundSize: "calc(100% - 2 * var(--space-3)) 100%",
    backgroundPosition: "var(--space-3) 0",
  },
  // 마크다운 기호는 흐리게, 본문 구문 색은 코드 에디터의 파랑, 초록 대신 본문 색을 쓴다(코드 블록 안의 구문 색은 그대로).
  "&.cm-editor .cm-note-mark": { color: "var(--fg-subtle)", fontWeight: "var(--weight-body)" },
  "&.cm-editor .cm-line .cm-syn-md-heading, &.cm-editor .cm-line .cm-syn-md-strong, &.cm-editor .cm-line .cm-syn-md-emphasis, &.cm-editor .cm-line .cm-syn-md-quote": { color: "inherit" },
  "&.cm-editor .cm-line .cm-syn-md-heading": { fontWeight: "inherit" },
  "&.cm-editor .cm-line .cm-syn-md-code": { color: "inherit" },
  "&.cm-editor .cm-note-strong": { fontWeight: "var(--weight-title)", color: "var(--fg-strong)" },
  "&.cm-editor .cm-note-em": { fontStyle: "italic" },
  "&.cm-editor .cm-note-code": { fontFamily: "var(--font-mono)", fontSize: "var(--text-code-inline)", backgroundColor: "var(--code-block-bg)", borderRadius: "var(--radius-sm)", padding: "0 var(--space-1)", letterSpacing: "0" },
  "&.cm-editor .cm-note-link": { color: "var(--accent-text)" },
  "&.cm-editor .cm-note-url": { color: "var(--fg-subtle)", textDecoration: "underline" },
  // 코드 블록 줄 안의 글자는 코드 글꼴이고, 인라인 코드 장식이 겹쳐 붙지 않는다.
  "&.cm-editor .cm-line.cm-note-fence .cm-note-mark": { color: "var(--fg-subtle)" },
});

export const noteStyle: Extension = [Prec.low(noteMarkdownPlugin), noteTheme];
