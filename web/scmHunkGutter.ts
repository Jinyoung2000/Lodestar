import { RangeSetBuilder, type Extension, type Text } from "@codemirror/state";
import { gutter, GutterMarker, type EditorView } from "@codemirror/view";
import type { ScmHunkInfo } from "../shared/scm";

export type HunkButton = { label: string; icon: string; act: (hunk: ScmHunkInfo) => void };

export function hunkActionButton(button: HunkButton, hunk: () => ScmHunkInfo | null): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.className = "scm-hunk-button";
  element.setAttribute("aria-label", button.label);
  element.title = button.label;
  const glyph = document.createElement("span");
  glyph.className = `codicon codicon-${button.icon}`;
  glyph.setAttribute("aria-hidden", "true");
  element.append(glyph);
  element.addEventListener("mousedown", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  element.addEventListener("click", (event) => {
    event.stopPropagation();
    if (event.detail > 1) return;
    const target = hunk();
    if (target) button.act(target);
  });
  return element;
}

class HunkMarker extends GutterMarker {
  constructor(
    readonly hunk: ScmHunkInfo,
    readonly buttons: readonly HunkButton[],
  ) {
    super();
  }

  eq(other: HunkMarker) {
    return other.hunk.hash === this.hunk.hash && other.buttons === this.buttons;
  }

  toDOM(view: EditorView) {
    const mark = document.createElement("div");
    mark.className = "scm-hunk-mark";
    const lines = view.state.doc.lines;
    const first = view.state.doc.line(hunkLine(this.hunk, lines));
    const last = view.state.doc.line(Math.min(first.number + Math.max(this.hunk.newLines, 1) - 1, lines));
    mark.style.height = `${view.lineBlockAt(last.from).bottom - view.lineBlockAt(first.from).top}px`;
    const box = document.createElement("div");
    box.className = "scm-hunk-actions";
    box.append(...this.buttons.map((button) => hunkActionButton(button, () => this.hunk)));
    mark.append(box);
    return mark;
  }
}

class Spacer extends GutterMarker {
  toDOM() {
    const spacer = document.createElement("span");
    spacer.className = "scm-hunk-button";
    return spacer;
  }
}

export function hunkLine(hunk: ScmHunkInfo, lineCount: number): number {
  const wanted = hunk.newLines > 0 ? hunk.newStart : hunk.newStart + 1;
  return Math.min(Math.max(wanted, 1), Math.max(lineCount, 1));
}

export function hunkGutter(hunks: readonly ScmHunkInfo[], buttons: readonly HunkButton[]): Extension {
  const spacer = new Spacer();
  return gutter({
    class: "cm-scm-hunk-gutter",
    markers: (view: EditorView) => {
      const builder = new RangeSetBuilder<GutterMarker>();
      const lines = view.state.doc.lines;
      const ordered = hunks.map((hunk) => ({ hunk, line: hunkLine(hunk, lines) })).sort((a, b) => a.line - b.line || a.hunk.index - b.hunk.index);
      for (const { hunk, line } of ordered) builder.add(view.state.doc.line(line).from, view.state.doc.line(line).from, new HunkMarker(hunk, buttons));
      return builder.finish();
    },
    initialSpacer: () => spacer,
  });
}

export type LineRange = { from: number; to: number };

function overlaps(a: LineRange, b: LineRange) {
  return a.from < Math.max(b.to, b.from + 1) && b.from < Math.max(a.to, a.from + 1);
}

export function hunkForLines(hunks: readonly ScmHunkInfo[], oldLines: LineRange, newLines: LineRange): ScmHunkInfo | null {
  return (
    hunks.find((hunk) => hunk.newLines > 0 && overlaps({ from: hunk.newStart, to: hunk.newStart + hunk.newLines }, newLines)) ??
    hunks.find((hunk) => hunk.oldLines > 0 && overlaps({ from: hunk.oldStart, to: hunk.oldStart + hunk.oldLines }, oldLines)) ??
    null
  );
}

export function chunkLines(doc: Text, from: number, to: number): LineRange {
  const start = doc.lineAt(Math.min(from, doc.length)).number;
  if (to <= from) return { from: start, to: start };
  return { from: start, to: doc.lineAt(Math.min(to - 1, doc.length)).number + 1 };
}
