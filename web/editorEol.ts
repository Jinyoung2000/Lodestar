import { Compartment, EditorState, type Extension, type TransactionSpec } from "@codemirror/state";
import type { ViewUpdate } from "@codemirror/view";

// 줄끝(EOL). 문서 안의 줄바꿈은 CodeMirror 에서 늘 줄 단위로 나뉘어 있고, 저장할 때 state.sliceDoc 이 state.lineBreak 로 이어 붙인다.
// lineSeparator 를 Compartment 에 담아 두면 줄끝을 바꾸는 것만으로 저장 내용이 달라진다. LF 는 값을 두지 않는다(CodeMirror 기본이 \r\n, \r, \n 을 다 줄바꿈으로 읽는다).
const eolCompartment = new Compartment();

// 파일을 읽을 때 정한 줄끝(CRLF 가 있으면 "\r\n", 아니면 null)으로 만든 확장
export function eolExtension(lineSeparator: string | null): Extension {
  return eolCompartment.of(separatorFor(lineSeparator === "\r\n" ? "\r\n" : "\n"));
}

export function eolOf(state: EditorState): "\n" | "\r\n" {
  return state.lineBreak === "\r\n" ? "\r\n" : "\n";
}

// 줄끝이 바뀌었는지. 글자는 그대로라 docChanged 가 아니므로 에디터가 수정 표시를 다시 계산할 때 쓴다.
export function eolChanged(update: ViewUpdate): boolean {
  return update.startState.lineBreak !== update.state.lineBreak;
}

// 이 보기의 줄끝만 바꾼다. 같은 파일의 다른 보기까지 바꾸는 것은 web/editorViewCommands.ts 의 changeEol.
export function setEol(target: { state: EditorState; dispatch: (spec: TransactionSpec) => void }, eol: "\n" | "\r\n") {
  if (eolOf(target.state) !== eol) target.dispatch({ effects: eolCompartment.reconfigure(separatorFor(eol)) });
}

const separatorFor = (eol: "\n" | "\r\n"): Extension => (eol === "\r\n" ? EditorState.lineSeparator.of("\r\n") : []);
