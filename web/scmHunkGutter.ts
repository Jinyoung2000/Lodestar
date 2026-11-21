import { RangeSetBuilder, type Extension, type Text } from "@codemirror/state";
import { gutter, GutterMarker, type EditorView } from "@codemirror/view";
import type { ScmHunkInfo } from "../shared/scm";

// FIX6B: diff 편집기 왼쪽 열에 hunk 마다 Stage Block 또는 Unstage Block 단추를 놓는다.
// hunk 경계는 git 이 정한 것이라 @codemirror/merge 의 덩어리와 다를 수 있다. 그래서 덩어리 인덱스가 아니라 git hunk 의 새 쪽 줄 번호로 자리를 잡는다.

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

// 빈 칸이어도 열 폭이 정해지게 하는 자리 표시
class Spacer extends GutterMarker {
  toDOM() {
    const spacer = document.createElement("span");
    spacer.className = "scm-hunk-button";
    return spacer;
  }
}

// 단추를 놓을 줄(1부터): 새 쪽에 줄이 있으면 그 첫 줄, 줄이 없는 삭제 hunk 는 지워진 자리 바로 다음 줄이다. 문서 끝을 넘으면 마지막 줄.
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
