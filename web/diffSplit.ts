import { Chunk, goToNextChunk, goToPreviousChunk, MergeView, uncollapseUnchanged } from "@codemirror/merge";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { chunkEdit, type ChunkAction } from "./diffChunks";
import { editorTheme } from "./Editor";
import { languageFor } from "./languages";
import { chunksToLineChanges } from "../shared/diffFeedback";
import { diffFeedbackExtension } from "./diffFeedbackEditor";
import { DIFF_CONFIG, diffMarks, emptySides } from "./diffMarks";
import { editorSyntax } from "./editorSyntax";
import { bindDiffView, diffLspExtensions, type DiffLspTarget } from "./diffLsp";
import { isMirroredUpdate } from "./viewMirror";
import { findWidget } from "./findWidget";
import { trackHover, watchChunkBoxes } from "./diffGutterHover";
import { chunkPosition, type ChunkPosition } from "./diffChunkHover";
import { S } from "./strings";

export type DiffHandle = {
  text: () => string;
  measure: () => void;
  step: (direction: 1 | -1) => void;
  reveal: (line: number) => void;
  lspView: EditorView | null;
  destroy: () => void;
};

export function revealLine(view: EditorView, line: number) {
  const doc = view.state.doc;
  const at = doc.line(Math.min(Math.max(line, 1), doc.lines)).from;
  view.dispatch({ effects: [uncollapseUnchanged.of(at), EditorView.scrollIntoView(at, { y: "center" })] });
}

export function stepChunk(view: EditorView, direction: 1 | -1) {
  (direction > 0 ? goToNextChunk : goToPreviousChunk)(view);
}

export type DiffHooks = {
  onText: (text: string, reverted: boolean) => void;
  onOriginal: (text: string) => void;
  onResolved: (resolved: boolean) => void;
  onPosition?: (position: ChunkPosition) => void;
};

export const COLLAPSE_UNCHANGED = { margin: 3, minSize: 6 };

export function diffCodeExtensions(path: string, wrap = false, feedback?: Parameters<typeof diffFeedbackExtension>[0], lsp?: DiffLspTarget | null): Extension[] {
  return [basicSetup, findWidget(), EditorView.editable.of(false), languageFor(path), editorTheme, diffColors, diffMarks(), emptySides(), editorSyntax({ semantic: !!lsp }), ...(wrap ? [EditorView.lineWrapping] : []), ...(feedback ? [diffFeedbackExtension(feedback)] : []), ...(lsp ? diffLspExtensions(lsp) : [])];
}

const diffColors = EditorView.theme({
  "&.cm-merge-a .cm-changedLine": { backgroundColor: "var(--diff-del-bg)" },
  "&.cm-merge-b .cm-changedLine, &.cm-merge-b .cm-inlineChangedLine": { backgroundColor: "var(--diff-add-bg)" },
  "&.cm-merge-a .cm-changedText": { background: "var(--diff-del-gutter)" },
  "&.cm-merge-b .cm-changedText": { background: "var(--diff-add-gutter)" },
  "&.cm-merge-b .cm-deletedChunk": { backgroundColor: "var(--diff-del-bg)" },
  "&.cm-merge-b .cm-deletedChunk .cm-deletedText": { background: "var(--diff-del-gutter)" },
  "&.cm-merge-a .cm-wholeChangedLine": { backgroundImage: "linear-gradient(var(--diff-del-gutter), var(--diff-del-gutter))" },
  "&.cm-merge-b .cm-wholeChangedLine": { backgroundImage: "linear-gradient(var(--diff-add-gutter), var(--diff-add-gutter))" },
  "&.cm-merge-b .cm-deletedChunk .cm-wholeChangedLine": { backgroundImage: "linear-gradient(var(--diff-del-gutter), var(--diff-del-gutter))" },
  "&.cm-merge-a .cm-wholeChangedLine .cm-changedText, &.cm-merge-b .cm-wholeChangedLine .cm-changedText, &.cm-merge-b .cm-deletedChunk .cm-wholeChangedLine .cm-deletedText": { background: "none" },
  "&.cm-merge-a .cm-changedLineGutter": { background: "var(--diff-del-bg)" },
  "&.cm-merge-b .cm-changedLineGutter": { background: "var(--diff-add-bg)" },
  "&.cm-merge-b .cm-deletedLineGutter": { background: "var(--diff-del-bg)" },
  "&[data-doc-empty] .cm-changedLine, &[data-doc-empty] .cm-inlineChangedLine": { backgroundColor: "transparent", backgroundImage: "none" },
  "&[data-doc-empty] .cm-changedLineGutter": { background: "transparent" },
  "&[data-base-empty] .cm-deletedChunk .cm-deletedLine": { display: "none" },
  "&[data-base-empty] .cm-deletedChunk": { backgroundColor: "transparent" },
});

const ICON_KEEP = ["M20 6 9 17l-5-5"];
const ICON_UNDO = ["M9 14 4 9l5-5", "M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11"];

function iconButton(label: string, paths: string[], run: () => void) {
  const button = document.createElement("button");
  button.type = "button";
  button.title = label;
  button.setAttribute("aria-label", label);
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [name, value] of Object.entries({ viewBox: "0 0 24 24", width: "14", height: "14", fill: "none", stroke: "currentColor", "stroke-width": "1.5", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) svg.setAttribute(name, value);
  for (const d of paths) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    svg.appendChild(path);
  }
  button.appendChild(svg);
  button.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  button.addEventListener("click", (e) => e.detail <= 1 && run());
  return button;
}

export function mountSplitDiff(parent: HTMLElement, { agentId, path, original, text, hooks, collapse, wrap, lsp }: { agentId: string; path: string; original: string; text: string; hooks: DiffHooks; collapse: boolean; wrap: boolean; lsp: DiffLspTarget | null }): DiffHandle {
  let view: MergeView;
  const apply = (index: number, action: ChunkAction) => {
    const chunk = view.chunks[index];
    if (!chunk) return;
    const edit = chunkEdit(chunk, view.a.state.doc, view.b.state.doc, action, view.b.state.lineBreak);
    (edit.target === "a" ? view.a : view.b).dispatch({ changes: { from: edit.from, to: edit.to, insert: edit.insert }, userEvent: action === "keep" ? "accept" : "revert" });
  };
  const renderControl = () => {
    const box = document.createElement("div");
    box.className = "split-chunk-buttons";
    box.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    const run = (action: ChunkAction) => () => apply(Number(box.dataset.chunk), action);
    const actions = document.createElement("div");
    actions.className = "split-chunk-actions";
    actions.append(iconButton(S.keepChunk, ICON_KEEP, run("keep")), iconButton(S.undoChunk, ICON_UNDO, run("undo")));
    box.append(actions);
    return box;
  };
  const resolved = () => Chunk.build(view.a.state.doc, view.b.state.doc, DIFF_CONFIG).length === 0;
  const code = diffCodeExtensions(path, wrap);
  const codeCurrent = diffCodeExtensions(path, wrap, { agentId, path, diff: () => ({ original: view.a.state.doc.toString(), changes: chunksToLineChanges(view.chunks, view.a.state.doc, view.b.state.doc) }) }, lsp);
  view = new MergeView({
    parent,
    a: {
      doc: original,
      extensions: [
        code,
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          hooks.onOriginal(update.state.doc.toString());
          hooks.onResolved(resolved());
        }),
      ],
    },
    b: {
      doc: text,
      extensions: [
        codeCurrent,
        EditorView.updateListener.of((update) => {
          hooks.onPosition?.(chunkPosition(update.state));
          if (!update.docChanged) return;
          if (!isMirroredUpdate(update)) hooks.onText(update.state.doc.toString(), update.transactions.some((tr) => tr.isUserEvent("revert")));
          hooks.onResolved(resolved());
        }),
      ],
    },
    revertControls: "a-to-b",
    renderRevertControl: renderControl,
    collapseUnchanged: collapse ? COLLAPSE_UNCHANGED : undefined,
    diffConfig: DIFF_CONFIG,
  });
  hooks.onResolved(view.chunks.length === 0);
  hooks.onPosition?.(chunkPosition(view.b.state));
  const unbind = lsp ? bindDiffView(lsp, view.b) : null;
  const unwatch = watchChunkBoxes(view);
  const untrack = trackHover(view.dom, ".cm-merge-revert > .split-chunk-buttons");
  return {
    text: () => view.b.state.doc.toString(),
    measure: () => {
      view.a.requestMeasure();
      view.b.requestMeasure();
    },
    step: (direction) => stepChunk(view.b, direction),
    reveal: (line) => revealLine(view.b, line),
    lspView: lsp ? view.b : null,
    destroy: () => {
      untrack();
      unwatch();
      unbind?.();
      view.destroy();
    },
  };
}
