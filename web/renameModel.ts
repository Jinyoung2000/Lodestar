import type { LspRange } from "./diagnosticsStore";


export type TextEdit = { range: LspRange; newText: string };
export type DocumentChange = { textDocument: { uri: string }; edits: TextEdit[] } | { kind: string };
export type WorkspaceEdit = { changes?: Record<string, TextEdit[]>; documentChanges?: DocumentChange[] };

export function collectEdits(edit: WorkspaceEdit) {
  const perUri = new Map<string, TextEdit[]>();
  for (const [uri, edits] of Object.entries(edit.changes ?? {})) perUri.set(uri, [...(perUri.get(uri) ?? []), ...edits]);
  let fileOps = false;
  for (const change of edit.documentChanges ?? []) {
    if ("edits" in change) perUri.set(change.textDocument.uri, [...(perUri.get(change.textDocument.uri) ?? []), ...change.edits]);
    else fileOps = true;
  }
  return { perUri, fileOps };
}

export function countEdits(edit: WorkspaceEdit) {
  const { perUri } = collectEdits(edit);
  let total = 0;
  for (const edits of perUri.values()) total += edits.length;
  return { edits: total, files: perUri.size };
}

export type PreviewEdit = { id: string; uri: string; line: number; prefix: string; removed: string; inserted: string; suffix: string; edit: TextEdit };
export type PreviewFile = { uri: string; edits: PreviewEdit[] };

export const PREVIEW_PREFIX = 30;
export const PREVIEW_SUFFIX = 50;

const NEWLINE = /\r\n|\n|\r/;

export function buildPreview(edit: WorkspaceEdit, texts: (uri: string) => string | null): { files: PreviewFile[]; fileOps: boolean } {
  const { perUri, fileOps } = collectEdits(edit);
  const files: PreviewFile[] = [];
  for (const uri of [...perUri.keys()].sort()) {
    const text = texts(uri);
    const lines = text === null ? null : text.split(NEWLINE);
    const edits = [...perUri.get(uri)!].sort((a, b) => a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character);
    files.push({
      uri,
      edits: edits.map((item, index) => {
        const { start, end } = item.range;
        const startLine = lines?.[start.line] ?? "";
        const endLine = lines?.[end.line] ?? "";
        const removed = lines === null ? "" : start.line === end.line ? startLine.slice(start.character, end.character) : [startLine.slice(start.character), ...lines.slice(start.line + 1, end.line), endLine.slice(0, end.character)].join("\n");
        return {
          id: `${uri}#${index}`,
          uri,
          line: start.line + 1,
          prefix: startLine.slice(Math.max(0, start.character - PREVIEW_PREFIX), start.character),
          removed,
          inserted: item.newText,
          suffix: endLine.slice(end.character, end.character + PREVIEW_SUFFIX),
          edit: item,
        };
      }),
    });
  }
  return { files, fileOps };
}

export function selectedEdit(files: readonly PreviewFile[], unchecked: ReadonlySet<string>): WorkspaceEdit {
  const changes: Record<string, TextEdit[]> = {};
  for (const file of files) {
    const kept = file.edits.filter((item) => !unchecked.has(item.id)).map((item) => item.edit);
    if (kept.length) changes[file.uri] = kept;
  }
  return { changes };
}

export const visibleBreaks = (text: string) => text.replace(/\r\n|\n|\r/g, "↵");

export function fileState(file: PreviewFile, unchecked: ReadonlySet<string>): "all" | "none" | "some" {
  const off = file.edits.filter((item) => unchecked.has(item.id)).length;
  return off === 0 ? "all" : off === file.edits.length ? "none" : "some";
}
