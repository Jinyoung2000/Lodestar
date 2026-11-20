import type { Extension } from "@codemirror/state";
import { EditorView, scrollPastEnd } from "@codemirror/view";
import type { EditorOptions } from "../shared/editorOptions";
import type { OptionContext } from "./editorBase";
import "./editorScroll.css";
import { editorMetrics } from "./editorMetrics";

// 스크롤(editor.scrollBeyondLastLine, scrollBeyondLastColumn, smoothScrolling).
// 마지막 줄 아래로는 마지막 줄이 맨 위까지 올라올 만큼, 가장 긴 줄 오른쪽으로는 설정한 열 수만큼 더 스크롤된다.
// smoothScrolling 은 코드가 부르는 스크롤 이동(줄로 이동, 찾은 곳 보이기)만 부드럽게 한다. 되돌린 스크롤 위치는 바로 가야 하므로 Editor.tsx 가 behavior instant 로 적용한다.
export function scrollExtension(options: EditorOptions, context: OptionContext): Extension {
  void context;
  return [
    options.scrollBeyondLastLine ? scrollPastEnd() : [],
    editorMetrics(),
    EditorView.editorAttributes.of({
      class: options.smoothScrolling ? "cm-vsc-scroll cm-vsc-smooth-scroll" : "cm-vsc-scroll",
      style: `--editor-last-columns:${options.scrollBeyondLastColumn}`,
    }),
  ];
}
