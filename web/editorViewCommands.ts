import type { EditorView } from "@codemirror/view";
import { registerEditorCommands } from "./editorCommands";
import { viewsOfSameFile } from "./editorDocs";
import { setEol } from "./editorEol";
import { toggleWordWrap } from "./editorWrap";
import { trimTrailingWhitespace } from "./saveTransforms";

// 상태 표시줄 묶음(EDPARITY C)의 에디터 명령. web/editorBase.ts 가 이 모듈을 가져와 부팅 때 등록된다.

// 같은 파일을 연 모든 보기의 줄끝을 바꾼다. 글자는 그대로라 각 보기의 Editor 가 줄끝 변경을 보고 수정됨 표시를 다시 계산한다.
export function changeEol(view: EditorView, eol: "\n" | "\r\n") {
  for (const target of viewsOfSameFile(view)) setEol(target, eol);
}

registerEditorCommands([
  { id: "toggleWordWrap", title: "View: Toggle Word Wrap", run: toggleWordWrap },
  {
    id: "trimTrailingWhitespace",
    title: "Trim Trailing Whitespace",
    run: (view) => {
      const changes = trimTrailingWhitespace(view.state.doc);
      if (!changes.empty && !view.state.readOnly) view.dispatch({ changes, userEvent: "delete" });
      return true;
    },
  },
]);
