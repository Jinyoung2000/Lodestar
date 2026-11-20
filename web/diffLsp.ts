import { LSPPlugin } from "@codemirror/lsp-client";
import { setDiagnostics } from "@codemirror/lint";
import { EditorState, Prec, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { editorTheme } from "./Editor";
import { presetKeys } from "./editorPresetKeys";
import { currentEditorOptions } from "./editorOptions";
import { wordHighlightExtension } from "./editorWordHighlight";
import { attachMirrorView, mirrorOnly, unsavedTextOf } from "./editorDocs";
import { cmdClickDefinition, lspDocument, lspKeys, lspViewExtensions } from "./editorLsp";
import { editorMessage } from "./editorMessage";
import { intellisenseExtension } from "./intellisenseKeys";
import { diagnosticsOf } from "./diagnosticsStore";
import { toViewDiagnostics } from "./diagnosticViews";
import { absolutePath, languageIdFor, registerDiffView } from "./lsp";


export type DiffLspTarget = { workspaceId: string; path: string };

// 수정본이 디스크의 작업 파일일 때만 붙인다. 지워진 파일(exists=false)과 LSP 가 없는 언어는 붙이지 않는다.
export function diffLspTarget(workspaceId: string, path: string, exists: boolean): DiffLspTarget | null {
  return exists && languageIdFor(path) !== null ? { workspaceId, path } : null;
}

// diff 를 만들 때 수정본 쪽의 처음 글. 같은 파일을 연 탭에 저장 안 한 편집이 있으면 그 글이어야 서버가 가진 글(탭의 버퍼)과 같다. 없으면 디스크 글.
export function initialModifiedText(target: DiffLspTarget | null, diskText: string): string {
  return (target && unsavedTextOf(target.workspaceId, target.path)) ?? diskText;
}

export function diffLspExtensions(target: DiffLspTarget): Extension[] {
  const { workspaceId, path } = target;
  return [
    intellisenseExtension,
    presetKeys,
    Prec.highest(keymap.of(lspKeys(workspaceId))),
    lspViewExtensions(workspaceId, editorTheme),
    cmdClickDefinition(workspaceId),
    editorMessage(),
    wordHighlightExtension(currentEditorOptions()),
    EditorState.readOnly.of(true),
    Prec.highest(EditorView.editable.of(true)),
    mirrorOnly(workspaceId, path),
    lspDocument(workspaceId, absolutePath(workspaceId, path), languageIdFor(path)!),
  ];
}

// 만든 보기를 같은 문서 묶음(탭 변경 흘려받기)과 명령 대상 등록부에 넣는다. 돌려주는 함수가 뺀다.
export function bindDiffView(target: DiffLspTarget, view: EditorView): () => void {
  paintKnownDiagnostics(view);
  const detachMirror = attachMirrorView(target.workspaceId, target.path, view);
  const unregister = registerDiffView(target.workspaceId, view);
  return () => {
    detachMirror();
    unregister();
  };
}

// 서버는 진단을 문서가 바뀔 때만 다시 보낸다. 이미 열려 있던 파일에 diff 가 나중에 붙으면 다음 알림까지 밑줄이 없으므로, 마지막으로 받은 진단을 지금 그린다.
function paintKnownDiagnostics(view: EditorView) {
  const plugin = LSPPlugin.get(view);
  const known = plugin ? diagnosticsOf(plugin.uri) : [];
  if (plugin && known.length) view.dispatch(setDiagnostics(view.state, toViewDiagnostics(known, plugin)));
}
