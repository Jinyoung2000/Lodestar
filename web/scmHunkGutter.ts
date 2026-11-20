import { RangeSetBuilder, type Extension } from "@codemirror/state";
import { gutter, GutterMarker, type EditorView } from "@codemirror/view";
import type { ScmHunkInfo } from "../shared/scm";

// FIX6B: diff 편집기 왼쪽 열에 hunk 마다 Stage Block 또는 Unstage Block 단추를 놓는다.
// hunk 경계는 git 이 정한 것이라 @codemirror/merge 의 덩어리와 다를 수 있다. 그래서 덩어리 인덱스가 아니라 git hunk 의 새 쪽 줄 번호로 자리를 잡는다.

class HunkMarker extends GutterMarker {
  constructor(
    readonly hunk: ScmHunkInfo,
    readonly label: string,
    readonly icon: string,
    readonly act: (hunk: ScmHunkInfo) => void,
  ) {
    super();
  }

  eq(other: HunkMarker) {
    return other.hunk.hash === this.hunk.hash && other.label === this.label;
  }

  toDOM() {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "scm-hunk-button";
    button.setAttribute("aria-label", this.label);
    button.title = this.label;
    const glyph = document.createElement("span");
    glyph.className = `codicon codicon-${this.icon}`;
    glyph.setAttribute("aria-hidden", "true");
    button.append(glyph);
    // 편집기가 포커스를 잃거나 선택이 바뀌지 않게 한다
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      this.act(this.hunk);
    });
    return button;
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

export function hunkGutter(hunks: readonly ScmHunkInfo[], mode: "stage" | "unstage", label: string, act: (hunk: ScmHunkInfo) => void): Extension {
  const icon = mode === "stage" ? "add" : "remove";
  const spacer = new Spacer();
  return gutter({
    class: "cm-scm-hunk-gutter",
    markers: (view: EditorView) => {
      const builder = new RangeSetBuilder<GutterMarker>();
      const lines = view.state.doc.lines;
      const ordered = hunks.map((hunk) => ({ hunk, line: hunkLine(hunk, lines) })).sort((a, b) => a.line - b.line || a.hunk.index - b.hunk.index);
      for (const { hunk, line } of ordered) builder.add(view.state.doc.line(line).from, view.state.doc.line(line).from, new HunkMarker(hunk, label, icon, act));
      return builder.finish();
    },
    initialSpacer: () => spacer,
  });
}
