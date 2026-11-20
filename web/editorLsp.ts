import { type Extension } from "@codemirror/state";
import { EditorView, type KeyBinding } from "@codemirror/view";
import { definitionLink } from "./definitionLink";
import { hoverSpace } from "./hoverSpace";
import { intellisenseKeymap } from "./intellisenseKeys";
import { languageFor } from "./languages";
import { fileUri, goBack, goForward, lspClient } from "./lsp";
import { findAllReferences, goToDefinition, goToImplementation, goToReferences, peekDefinition, peekImplementation } from "./peekCommands";
import { peekExtension } from "./peekView";

// 파일 하나를 보여 주는 CodeMirror 보기에 LSP 탐색을 붙이는 묶음. 일반 에디터(web/Editor.tsx)와 diff 의 수정본 쪽(web/diffLsp.ts)이 같은 것을 쓴다.
// hover 와 ⌘ 정의 링크(definitionLink), peek 띠, 정의, 참조 키, 자동완성과 시그니처 키, ⌘클릭 정의 이동.
// 서버와의 문서 연결은 lspDocument 가 따로 맡는다. 이 보기의 글이 서버가 가진 글과 같아야 한다.

export function lspKeys(workspaceId: string): KeyBinding[] {
  return [
    { key: "F12", run: (view) => (void goToDefinition(view, workspaceId), true) },
    { key: "Shift-F12", run: (view) => (void goToReferences(view, workspaceId), true) },
    { key: "Mod-F12", run: (view) => (void goToImplementation(view, workspaceId), true) },
    { key: "Alt-F12", run: (view) => (void peekDefinition(view, workspaceId), true) },
    { key: "Shift-Mod-F12", run: (view) => (void peekImplementation(view, workspaceId), true) },
    { key: "Shift-Alt-F12", run: (view) => (void findAllReferences(view, workspaceId), true) },
    { key: "Ctrl--", run: () => (goBack(), true) },
    { key: "Ctrl-Shift--", run: () => (goForward(), true) },
    ...intellisenseKeymap,
  ];
}

export function cmdClickDefinition(workspaceId: string): Extension {
  return EditorView.domEventHandlers({
    mousedown(event, view) {
      if (!(event.metaKey || event.ctrlKey) || event.button !== 0) return false;
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos == null) return false;
      event.preventDefault();
      view.dispatch({ selection: { anchor: pos } });
      void goToDefinition(view, workspaceId, event.altKey);
      return true;
    },
  });
}

// previewTheme 은 peek 안의 미리보기 에디터가 쓰는 테마(Editor.tsx 의 editorTheme). 이 모듈이 Editor.tsx 를 가져오면 순환이 되어 받는다.
export function lspViewExtensions(workspaceId: string, previewTheme: Extension): Extension[] {
  return [definitionLink(workspaceId), hoverSpace(), peekExtension({ workspaceId, previewExtensions: (previewPath) => [previewTheme, languageFor(previewPath)] })];
}

// 서버에 이 URI 의 문서를 열고 변경을 동기화하는 플러그인(진단, semantic 색, 자동완성 소스도 이 클라이언트의 확장이 같이 붙는다)
export function lspDocument(workspaceId: string, absolutePath: string, languageId: string): Extension {
  return lspClient(workspaceId).plugin(fileUri(absolutePath), languageId);
}
