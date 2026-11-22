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

const MARK_NODES = new Set(["HeaderMark", "ListMark", "QuoteMark", "EmphasisMark", "CodeMark", "LinkMark", "TaskMarker", "CodeInfo"]);

const lineDeco = (cls: string) => Decoration.line({ class: cls });
const markDeco = (cls: string) => Decoration.mark({ class: cls });

function buildDecorations(state: EditorState, view: EditorView): DecorationSet {
  const out: Range<Decoration>[] = [];
  const doc = state.doc;
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
  "&.cm-editor .cm-content": { boxSizing: "border-box", flexGrow: "0", width: "100%", maxWidth: "var(--size-notes-text)", margin: "0 auto", padding: "var(--space-6) 0" },
  "&.cm-editor .cm-line": { padding: "0 var(--space-6)" },
  "&.cm-editor .cm-placeholder": { color: "var(--fg-subtle)" },
  "&.cm-editor .cm-line.cm-note-title": { fontSize: "1.25em", fontWeight: "var(--weight-title)", lineHeight: "1.4", color: "var(--fg-strong)" },
  "&.cm-editor .cm-line.cm-note-h1": { fontSize: "1.6em", fontWeight: "var(--weight-title)", lineHeight: "1.35", color: "var(--fg-strong)", paddingTop: "var(--space-2)" },
  "&.cm-editor .cm-line.cm-note-h2": { fontSize: "1.35em", fontWeight: "var(--weight-title)", lineHeight: "1.35", color: "var(--fg-strong)", paddingTop: "var(--space-1)" },
  "&.cm-editor .cm-line.cm-note-h3": { fontSize: "1.15em", fontWeight: "var(--weight-title)", lineHeight: "1.4", color: "var(--fg-strong)" },
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
  "&.cm-editor .cm-note-mark": { color: "var(--fg-subtle)", fontWeight: "var(--weight-body)" },
  "&.cm-editor .cm-line .cm-syn-md-heading, &.cm-editor .cm-line .cm-syn-md-strong, &.cm-editor .cm-line .cm-syn-md-emphasis, &.cm-editor .cm-line .cm-syn-md-quote": { color: "inherit" },
  "&.cm-editor .cm-line .cm-syn-md-heading": { fontWeight: "inherit" },
  "&.cm-editor .cm-line .cm-syn-md-code": { color: "inherit" },
  "&.cm-editor .cm-note-strong": { fontWeight: "var(--weight-title)", color: "var(--fg-strong)" },
  "&.cm-editor .cm-note-em": { fontStyle: "italic" },
  "&.cm-editor .cm-note-code": { fontFamily: "var(--font-mono)", fontSize: "var(--text-code-inline)", backgroundColor: "var(--code-block-bg)", borderRadius: "var(--radius-sm)", padding: "0 var(--space-1)", letterSpacing: "0" },
  "&.cm-editor .cm-note-link": { color: "var(--accent-text)" },
  "&.cm-editor .cm-note-url": { color: "var(--fg-subtle)", textDecoration: "underline" },
  "&.cm-editor .cm-line.cm-note-fence .cm-note-mark": { color: "var(--fg-subtle)" },
});

export const noteStyle: Extension = [Prec.low(noteMarkdownPlugin), noteTheme];
