import { LSPPlugin } from "@codemirror/lsp-client";
import type { EditorView } from "@codemirror/view";
import { toTarget, uriToPath, viewFor } from "./lsp";
import { buildPreview, collectEdits, type WorkspaceEdit } from "./renameModel";
import { rpc } from "./rpc";
import { fileTabKey, getState } from "./store";
import { S } from "./strings";

export async function previewWorkspaceEdit(view: EditorView, plugin: LSPPlugin, edit: WorkspaceEdit, label: string): Promise<WorkspaceEdit | null> {
  const { perUri, fileOps } = collectEdits(edit);
  if (fileOps) throw new Error(S.quickFixFileOps);
  const texts = new Map<string, string | null>();
  await Promise.all([...perUri.keys()].map(async (uri) => texts.set(uri, await textOf(view, plugin, uri))));
  const { files } = buildPreview(edit, (uri) => texts.get(uri) ?? null);
  const workspaceId = getState().activeWorkspaceId ?? "";
  const names = new Map(files.map((file) => [file.uri, toTarget(uriToPath(file.uri), workspaceId).path]));
  const { openRenamePreview } = await import("./RenamePreview");
  return openRenamePreview({ files, label, names, bounds: view.dom.getBoundingClientRect() });
}

async function textOf(view: EditorView, plugin: LSPPlugin, uri: string) {
  if (uri === plugin.uri) return view.state.doc.toString();
  const target = toTarget(uriToPath(uri), getState().activeWorkspaceId ?? "");
  const open = viewFor(fileTabKey(target.workspaceId, target.path));
  if (open) return open.state.doc.toString();
  try {
    const { text } = await rpc.call("files.read", { workspaceId: target.workspaceId, path: target.path });
    return text;
  } catch {
    return null;
  }
}
