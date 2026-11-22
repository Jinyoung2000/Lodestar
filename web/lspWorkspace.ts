import { LSPPlugin, Workspace, type LSPClient, type WorkspaceFile } from "@codemirror/lsp-client";
import type { Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

export class NavWorkspace extends Workspace {
  files: (WorkspaceFile & { view: EditorView })[] = [];
  private extraViews = new Map<string, EditorView[]>();
  private versions = new Map<string, number>();
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
