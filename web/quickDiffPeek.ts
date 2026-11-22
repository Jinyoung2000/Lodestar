import { Chunk, unifiedMergeView } from "@codemirror/merge";
import { EditorState, Prec, type Extension, type Text } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import type { QuickDiff } from "./changeGutter";
import { diffMarks, QUICK_DIFF_CONFIG, visibleLineCount } from "./diffMarks";
import { editorSyntax } from "./editorSyntax";
import { splitPath } from "./peekModel";
import { currentZone, hideZone, showZone, zoneExtension, type ZoneParts } from "./peekZone";
import { S } from "./strings";


export type QuickDiffOptions = { path: string; previewExtensions: Extension[] };

const CONTEXT_LINES = 3;
let counter = 0;

export function quickDiff(options: QuickDiffOptions): QuickDiff {
  return { extension: quickDiffExtension(), open: (view, base, line) => showQuickDiff(view, base, line, options) };
}

function quickDiffExtension(): Extension {
  return [zoneExtension(), Prec.high(keymap.of([{ key: "Escape", run: (view) => isQuickDiffOpen(view) && hideZone(view) }]))];
}

function isQuickDiffOpen(view: EditorView) {
  return !!currentZone(view)?.className.includes("cm-quickdiff");
}

function chunkLines(chunk: Chunk, current: Text) {
  const first = current.lineAt(Math.min(chunk.fromB, current.length)).number;
  return { first, last: first + Math.max(visibleLineCount(chunk, "b", current), 1) - 1 };
}

function showQuickDiff(view: EditorView, base: Text, line: number, options: QuickDiffOptions) {
  const current = view.state.doc;
  const chunks = Chunk.build(base, current, QUICK_DIFF_CONFIG);
  if (!chunks.length) return;
  const index = Math.max(chunks.findIndex((chunk) => line <= chunkLines(chunk, current).last), 0);
  openAt(view, base, chunks, index, options);
}

function openAt(view: EditorView, base: Text, chunks: readonly Chunk[], index: number, options: QuickDiffOptions) {
  const chunk = chunks[index];
  const current = view.state.doc;
  const { last } = chunkLines(chunk, current);
  const anchor = current.line(last).from;
  const size = visibleLineCount(chunk, "a", base) + visibleLineCount(chunk, "b", current);
  showZone(view, {
    id: 2_000_000 + ++counter,
    anchor,
    arrowAt: anchor,
    lines: Math.min(Math.max(size + CONTEXT_LINES * 2 + 2, 8), 20),
    className: "cm-quickdiff",
    mount: (parts) => mountQuickDiff(parts, view, base, chunks, index, options),
  });
  view.dispatch({ effects: EditorView.scrollIntoView(anchor, { y: "nearest", yMargin: 40 }) });
  view.focus();
}

function mountQuickDiff(parts: ZoneParts, view: EditorView, base: Text, chunks: readonly Chunk[], index: number, options: QuickDiffOptions) {
  const name = document.createElement("span");
  name.className = "cm-zone-name";
  name.textContent = splitPath(options.path).name;
  const meta = document.createElement("span");
  meta.className = "cm-zone-dir";
  meta.textContent = S.quickDiffCount(index + 1, chunks.length);
  parts.title.append(name, meta);

  const step = (delta: 1 | -1) => openAt(view, base, chunks, (index + delta + chunks.length) % chunks.length, options);
  const button = (codicon: string, label: string, run: () => void) => {
    const node = document.createElement("button");
    node.type = "button";
    node.className = "cm-zone-action";
    node.title = label;
    node.setAttribute("aria-label", label);
    const glyph = document.createElement("span");
    glyph.className = `codicon codicon-${codicon}`;
    node.append(glyph);
    node.addEventListener("mousedown", (event) => event.preventDefault());
    node.addEventListener("click", () => {
      run();
      view.focus();
    });
    parts.actions.append(node);
  };
  button("arrow-down", S.nextChange, () => step(1));
  button("arrow-up", S.previousChange, () => step(-1));
  button("close", S.close, () => hideZone(view));

  const host = document.createElement("div");
  host.className = "cm-peek-preview cm-quickdiff-body";
  parts.body.append(host);
  const current = view.state.doc;
  const first = chunkLines(chunks[index], current).first;
  const preview = new EditorView({
    parent: host,
    state: EditorState.create({
      doc: current,
      extensions: [
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
        keymap.of([{ key: "Escape", run: () => hideZone(view) }]),
        ...options.previewExtensions,
        editorSyntax({ semantic: false }),
        unifiedMergeView({ original: base, mergeControls: false, gutter: true, diffConfig: QUICK_DIFF_CONFIG }),
        diffMarks(),
      ],
    }),
  });
  let scrolled = false;
  parts.onLayout(() => {
    if (scrolled) return;
    scrolled = true;
    const top = current.line(Math.max(first - CONTEXT_LINES, 1)).from;
    preview.dispatch({ effects: EditorView.scrollIntoView(top, { y: "start" }) });
  });
  return () => preview.destroy();
}
