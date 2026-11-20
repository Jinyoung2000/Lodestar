import { Chunk, MergeView, uncollapseUnchanged } from "@codemirror/merge";
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
import { S } from "./strings";

// 마운트한 diff 하나를 다루는 손잡이. inline 이든 split 이든 FileDiff 는 이것만 본다.
export type DiffHandle = {
  // 지금 화면의 현재 쪽(파일) 본문
  text: () => string;
  measure: () => void;
  // DIFFFB: 현재 쪽의 그 줄이 보이게 스크롤한다(접힌 구간이면 펼친다).
  reveal: (line: number) => void;
  // LSP 가 붙은 수정본 쪽 보기(오른쪽 클릭 메뉴의 대상). LSP 가 없으면 null.
  lspView: EditorView | null;
  destroy: () => void;
};

// DIFFFB: 현재 쪽 편집기에서 줄 하나를 보이게 한다.
export function revealLine(view: EditorView, line: number) {
  const doc = view.state.doc;
  const at = doc.line(Math.min(Math.max(line, 1), doc.lines)).from;
  view.dispatch({ effects: [uncollapseUnchanged.of(at), EditorView.scrollIntoView(at, { y: "center" })] });
}

export type DiffHooks = {
  // 현재 쪽 본문이 바뀜 (Undo). 호출한 쪽이 디스크에 쓴다. reverted 는 덩어리 Undo 로 바뀐 경우다.
  onText: (text: string, reverted: boolean) => void;
  // 기준 쪽 본문이 바뀜 (Keep). 호출한 쪽이 데몬에 저장한다.
  onOriginal: (text: string) => void;
  // 기준과 현재가 같아졌는지
  onResolved: (resolved: boolean) => void;
};

// 바뀌지 않은 구간 접기. 줄 수는 inline, split 이 같다.
export const COLLAPSE_UNCHANGED = { margin: 3, minSize: 6 };

// 읽기 전용 코드 보기에 공통으로 쓰는 확장: 글꼴, 구문 강조, 색은 editorTheme 가 토큰으로 정한다.
// wrap 은 패널 `...` 의 Word Wrap 이다. 켜면 긴 줄을 접어 가로 스크롤을 없앤다.
// feedback 이 있으면 그 편집기의 줄에 피드백을 쌓을 수 있다(DIFFFB). split 은 현재 쪽에만 준다. 기준 쪽 줄은 지금 범위 밖이다.
// lsp 가 있으면 이 편집기(수정본 쪽)에 LSP 를 붙인다(web/diffLsp.ts). 원본 쪽과 승인 카드처럼 다른 글을 보여 주는 편집기에는 주지 않는다.
export function diffCodeExtensions(path: string, wrap = false, feedback?: Parameters<typeof diffFeedbackExtension>[0], lsp?: DiffLspTarget | null): Extension[] {
  return [basicSetup, findWidget(), EditorView.editable.of(false), languageFor(path), editorTheme, diffColors, diffMarks(), emptySides(), editorSyntax({ semantic: !!lsp }), ...(wrap ? [EditorView.lineWrapping] : []), ...(feedback ? [diffFeedbackExtension(feedback)] : []), ...(lsp ? diffLspExtensions(lsp) : [])];
}

// MergeView 와 unifiedMergeView 는 편집기에 .cm-merge-a/.cm-merge-b 를 붙이고 기본 색(연한 초록 줄, 초록 밑줄 그라데이션, 줄 번호 열의 진한 막대)을
// 더 구체적인 선택자로 건다. 같은 구체성으로 diff-* 토큰 색을 다시 덮어 inline 과 split 이 같은 색이 되게 한다. 왼쪽(기준, a)은 삭제 색, 오른쪽(현재, b)은 추가 색.
// inline(unified)은 현재 쪽이라 b 규칙을 쓰고, 삭제된 덩어리(.cm-deletedChunk)는 삭제 색이다.
const diffColors = EditorView.theme({
  "&.cm-merge-a .cm-changedLine": { backgroundColor: "var(--diff-del-bg)" },
  "&.cm-merge-b .cm-changedLine, &.cm-merge-b .cm-inlineChangedLine": { backgroundColor: "var(--diff-add-bg)" },
  "&.cm-merge-a .cm-changedText": { background: "var(--diff-del-gutter)" },
  "&.cm-merge-b .cm-changedText": { background: "var(--diff-add-gutter)" },
  "&.cm-merge-b .cm-deletedChunk": { backgroundColor: "var(--diff-del-bg)" },
  "&.cm-merge-b .cm-deletedChunk .cm-deletedText": { background: "var(--diff-del-gutter)" },
  // 통째 추가, 삭제 줄(web/diffMarks.ts): 줄 배경 위에 글자 배경을 줄 전체 폭으로 한 번 더 깔고, 글자 폭 상자는 지운다.
  "&.cm-merge-a .cm-wholeChangedLine": { backgroundImage: "linear-gradient(var(--diff-del-gutter), var(--diff-del-gutter))" },
  "&.cm-merge-b .cm-wholeChangedLine": { backgroundImage: "linear-gradient(var(--diff-add-gutter), var(--diff-add-gutter))" },
  "&.cm-merge-b .cm-deletedChunk .cm-wholeChangedLine": { backgroundImage: "linear-gradient(var(--diff-del-gutter), var(--diff-del-gutter))" },
  "&.cm-merge-a .cm-wholeChangedLine .cm-changedText, &.cm-merge-b .cm-wholeChangedLine .cm-changedText, &.cm-merge-b .cm-deletedChunk .cm-wholeChangedLine .cm-deletedText": { background: "none" },
  "&.cm-merge-a .cm-changedLineGutter": { background: "var(--diff-del-bg)" },
  "&.cm-merge-b .cm-changedLineGutter": { background: "var(--diff-add-bg)" },
  "&.cm-merge-b .cm-deletedLineGutter": { background: "var(--diff-del-bg)" },
  // 빈 문서 쪽의 가짜 줄(web/diffMarks.ts emptySides)은 칠하지 않고, 기준이 빈 unified 의 삭제 줄 위젯은 내용 없이 버튼만 남긴다.
  "&[data-doc-empty] .cm-changedLine, &[data-doc-empty] .cm-inlineChangedLine": { backgroundColor: "transparent", backgroundImage: "none" },
  "&[data-doc-empty] .cm-changedLineGutter": { background: "transparent" },
  "&[data-base-empty] .cm-deletedChunk .cm-deletedLine": { display: "none" },
  "&[data-base-empty] .cm-deletedChunk": { backgroundColor: "transparent" },
});

// Lucide 의 Check 와 Undo2 경로 그대로. 라이브러리가 버튼 DOM 을 직접 만들게 하는 곳이라 React 아이콘을 쓸 수 없다.
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
  // 라이브러리는 이 칸의 mousedown 을 받아 "기준 내용을 현재에 덮어쓰기" 를 실행한다. 우리 버튼의 mousedown 은 거기까지 올라가지 않게 막는다.
  button.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  // 더블클릭의 두 번째 클릭은 받지 않는다. 덩어리 하나를 처리하면 다음 덩어리의 단추가 같은 자리로 올 수 있다.
  button.addEventListener("click", (e) => e.detail <= 1 && run());
  return button;
}

// 기준(왼쪽)과 현재(오른쪽)를 나란히. 덩어리마다 Keep 과 Undo 가 두 칸 사이 열에 뜬다.
export function mountSplitDiff(parent: HTMLElement, { agentId, path, original, text, hooks, collapse, wrap, lsp }: { agentId: string; path: string; original: string; text: string; hooks: DiffHooks; collapse: boolean; wrap: boolean; lsp: DiffLspTarget | null }): DiffHandle {
  let view: MergeView;
  const apply = (index: number, action: ChunkAction) => {
    const chunk = view.chunks[index];
    if (!chunk) return;
    const edit = chunkEdit(chunk, view.a.state.doc, view.b.state.doc, action, view.b.state.lineBreak);
    (edit.target === "a" ? view.a : view.b).dispatch({ changes: { from: edit.from, to: edit.to, insert: edit.insert }, userEvent: action === "keep" ? "accept" : "revert" });
  };
  // 라이브러리가 이 요소를 만든 직후에 data-chunk 를 붙이므로 눌렀을 때 읽는다.
  const renderControl = () => {
    const box = document.createElement("div");
    box.className = "split-chunk-buttons";
    const run = (action: ChunkAction) => () => apply(Number(box.dataset.chunk), action);
    box.append(iconButton(S.keepChunk, ICON_KEEP, run("keep")), iconButton(S.undoChunk, ICON_UNDO, run("undo")));
    return box;
  };
  // 공백만 다른 줄은 덩어리가 아니므로(DIFF_CONFIG) 덩어리가 없으면 해결된 것이다.
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
          if (!update.docChanged) return;
          if (!isMirroredUpdate(update)) hooks.onText(update.state.doc.toString(), update.transactions.some((tr) => tr.isUserEvent("revert")));
          hooks.onResolved(resolved());
        }),
      ],
    },
    // "a-to-b" 는 라이브러리가 두 칸 사이에 버튼 열을 만들고 덩어리 위치에 맞춰 세우게 하는 설정이다. 눌렀을 때의 동작은 위 apply 가 정한다.
    revertControls: "a-to-b",
    renderRevertControl: renderControl,
    collapseUnchanged: collapse ? COLLAPSE_UNCHANGED : undefined,
    diffConfig: DIFF_CONFIG,
  });
  hooks.onResolved(view.chunks.length === 0);
  const unbind = lsp ? bindDiffView(lsp, view.b) : null;
  return {
    text: () => view.b.state.doc.toString(),
    measure: () => {
      view.a.requestMeasure();
      view.b.requestMeasure();
    },
    reveal: (line) => revealLine(view.b, line),
    lspView: lsp ? view.b : null,
    destroy: () => {
      unbind?.();
      view.destroy();
    },
  };
}
