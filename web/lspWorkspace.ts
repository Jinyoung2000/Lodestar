import { LSPPlugin, Workspace, type LSPClient, type WorkspaceFile } from "@codemirror/lsp-client";
import type { Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

// 워크스페이스 하나의 LSP 문서 목록. 서버에는 URI 하나가 문서 하나이고, 같은 파일을 보여 주는 보기는 여럿일 수 있다
// (파일 탭이 여러 그룹에 열린 경우, 파일 탭과 diff 의 수정본 쪽이 함께 열린 경우).
// files 의 항목은 그중 먼저 연 보기(view) 하나만 들고, 나머지는 extraViews 에 둔다. 변경은 항목의 view 플러그인에 쌓인 것만 서버에 보내므로,
// 같은 URI 의 보기들은 항상 같은 글이어야 한다. 보기끼리 변경을 흘려 넣는 일은 web/editorDocs.ts 의 docMirror 와 mirrorOnly 가 한다.
export class NavWorkspace extends Workspace {
  files: (WorkspaceFile & { view: EditorView })[] = [];
  private extraViews = new Map<string, EditorView[]>();
  private versions = new Map<string, number>();
  // 가상 문서: 디스크 파일이 아니라 다른 시점의 글(PR 의 head 커밋)을 실제 파일과 같은 URI 로 서버에 연 것. 값은 밀려날 때 부르는 알림.
  private virtual = new Map<string, () => void>();

  constructor(
    client: LSPClient,
    private show: (uri: string) => Promise<EditorView>,
  ) {
    super(client);
  }

  syncFiles() {
    const updates = [];
    for (const file of this.files) {
      const plugin = LSPPlugin.get(file.view);
      if (!plugin || plugin.unsyncedChanges.empty) continue;
      updates.push({ changes: plugin.unsyncedChanges, file, prevDoc: file.doc });
      file.doc = file.view.state.doc;
      file.version = this.nextVersion(file.uri);
      plugin.clear();
      for (const other of this.extraViews.get(file.uri) ?? []) LSPPlugin.get(other)?.clear();
    }
    return updates;
  }

  // 방금 연 문서를 가상 문서로 표시한다. 같은 URI 를 실제 보기(파일 탭)가 나중에 열면 가상 문서를 닫고(didClose) 그 보기가 새로 연다.
  // 서버에는 URI 하나가 글 하나라서, 가상 문서를 둔 채 실제 보기를 보태면 서버 글과 탭 글이 어긋나 위치가 틀어진다.
  markVirtual(uri: string, onEvicted: () => void) {
    this.virtual.set(uri, onEvicted);
  }

  isVirtual(uri: string) {
    return this.virtual.has(uri);
  }

  openFile(uri: string, languageId: string, view: EditorView) {
    const evicted = this.virtual.get(uri);
    if (evicted && this.files.some((f) => f.uri === uri && f.view !== view)) {
      this.virtual.delete(uri);
      this.extraViews.delete(uri);
      this.files = this.files.filter((f) => f.uri !== uri);
      this.client.didClose(uri);
      evicted();
    }
    const existing = this.files.find((f) => f.uri === uri);
    if (existing) {
      if (existing.view !== view) this.extraViews.set(uri, [...(this.extraViews.get(uri) ?? []).filter((v) => v !== view), view]);
      return;
    }
    const file = { uri, languageId, version: this.nextVersion(uri), doc: view.state.doc as Text, view, getView: () => view };
    this.files.push(file);
    this.client.didOpen(file);
  }

  closeFile(uri: string, view?: EditorView) {
    const file = this.files.find((f) => f.uri === uri);
    if (!file) return;
    const extras = this.extraViews.get(uri) ?? [];
    if (view && file.view !== view) {
      this.extraViews.set(uri, extras.filter((v) => v !== view));
      return;
    }
    // 먼저 연 보기가 닫혀도 같은 파일의 다른 보기가 남아 있으면 서버에는 열린 채로 두고 그 보기가 이어받는다
    const [heir, ...rest] = extras.filter((v) => v !== view);
    if (view && heir) {
      file.view = heir;
      file.getView = () => heir;
      this.extraViews.set(uri, rest);
      return;
    }
    this.extraViews.delete(uri);
    this.virtual.delete(uri);
    this.files = this.files.filter((f) => f.uri !== uri);
    this.client.didClose(uri);
  }

  // 이 URI 를 서버에 열어 둔 모든 보기 (먼저 연 보기가 앞). 진단은 이 보기들 전부에 그린다.
  viewsOf(uri: string): EditorView[] {
    const file = this.files.find((f) => f.uri === uri);
    return file ? [file.view, ...(this.extraViews.get(uri) ?? [])] : [];
  }

  displayFile(uri: string) {
    return this.show(uri);
  }

  private nextVersion(uri: string) {
    const version = (this.versions.get(uri) ?? -1) + 1;
    this.versions.set(uri, version);
    return version;
  }
}
