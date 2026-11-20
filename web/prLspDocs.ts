import { LSPPlugin } from "@codemirror/lsp-client";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { editorTheme } from "./Editor";
import { attachMirrorView, mirrorOnly } from "./editorDocs";
import { lspDocument } from "./editorLsp";
import { absolutePath, fileUri, languageIdFor, lspClient } from "./lsp";
import type { NavWorkspace } from "./lspWorkspace";

// PR diff 가 LSP 에 연 문서. PR diff 는 CodeMirror 가 아니라 patch 의 줄을 그리는 화면이라, 서버와 말하는 쪽은 화면에 붙이지 않은 EditorView(문서 전체를 든 보기)가 맡는다.
// 화면의 글자 위치는 (줄, 열)로 바꿔 이 보기의 위치로 옮기고, 질문은 이 보기의 LSPPlugin 으로 서버에 보낸다. 일반 에디터와 diff 의 수정본 쪽이 쓰는 lspDocument 를 그대로 쓴다.
//   checked-out: 체크아웃된 폴더의 실제 파일. 같은 파일 탭이 열려 있으면 그 탭과 한 문서처럼 변경이 흘러온다(diff 의 수정본 쪽과 같은 장치).
//   commit: 디스크 파일이 아니라 head 커밋의 글. 실제 파일과 같은 URI 로 열어서 import 가 디스크의 다른 파일로 풀린다. 같은 경로를 이미 탭이 열었으면 열지 않는다.

export type PrDocMode = "checked-out" | "commit";

export type PrDoc = {
  workspaceId: string;
  path: string;
  uri: string;
  mode: PrDocMode;
  view: EditorView;
  plugin: LSPPlugin;
  // 같은 경로를 파일 탭이 열어서 서버가 이 문서를 닫았다(commit 일 때만). 이후 위치는 서버와 어긋난다.
  evicted: boolean;
  onEvicted: Set<() => void>;
};

type Entry = { doc: PrDoc; refs: number; detach: () => void };
const docs = new Map<string, Entry>();
const keyOf = (workspaceId: string, path: string) => `${workspaceId}\0${path}`;

export type AcquireResult = { doc: PrDoc } | { doc: null; reason: "language" | "occupied" };

// 문서를 연다. 같은 파일을 이미 열었으면 그 문서를 같이 쓴다(참조 횟수). 돌려받은 release 를 화면이 사라질 때 부른다.
export function acquirePrDoc(input: { workspaceId: string; path: string; mode: PrDocMode; text: string }): AcquireResult & { release: () => void } {
  const { workspaceId, path, mode, text } = input;
  const key = keyOf(workspaceId, path);
  const existing = docs.get(key);
  if (existing) {
    existing.refs++;
    return { doc: existing.doc, release: once(() => releaseEntry(key)) };
  }
  const languageId = languageIdFor(path);
  if (!languageId) return { doc: null, reason: "language", release: () => undefined };
  const absolute = absolutePath(workspaceId, path);
  const uri = fileUri(absolute);
  const workspace = lspClient(workspaceId).workspace as NavWorkspace;
  // commit 은 서버의 글을 바꿔 쓰는 일이다. 실제 보기가 이미 그 URI 를 열었으면 서버 글이 그쪽 것이라 덮지 않는다.
  if (mode === "commit" && workspace.getFile(uri)) return { doc: null, reason: "occupied", release: () => undefined };
  const view = new EditorView({
    state: EditorState.create({ doc: text, extensions: [EditorState.readOnly.of(true), editorTheme, lspDocument(workspaceId, absolute, languageId), ...(mode === "checked-out" ? [mirrorOnly(workspaceId, path)] : [])] }),
  });
  const plugin = LSPPlugin.get(view);
  if (!plugin) {
    view.destroy();
    return { doc: null, reason: "language", release: () => undefined };
  }
  const doc: PrDoc = { workspaceId, path, uri, mode, view, plugin, evicted: false, onEvicted: new Set() };
  if (mode === "commit") {
    workspace.markVirtual(uri, () => {
      doc.evicted = true;
      for (const listener of [...doc.onEvicted]) listener();
    });
  }
  const detach = mode === "checked-out" ? attachMirrorView(workspaceId, path, view) : () => undefined;
  docs.set(key, { doc, refs: 1, detach });
  return { doc, release: once(() => releaseEntry(key)) };
}

function releaseEntry(key: string) {
  const entry = docs.get(key);
  if (!entry || --entry.refs > 0) return;
  docs.delete(key);
  entry.detach();
  // 파괴하면 LSPPlugin 이 workspace.closeFile 을 불러 마지막 보기일 때 didClose 를 보낸다
  entry.doc.view.destroy();
}

function once(fn: () => void) {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    fn();
  };
}

// 이미 연 문서(없으면 null). 참조 목록이 PR 시점의 줄 글을 보일 때 쓴다
export const openPrDoc = (workspaceId: string, path: string): PrDoc | null => docs.get(keyOf(workspaceId, path))?.doc ?? null;

// 이 문서의 (줄, 열)을 문서 위치로. 줄 번호는 1부터. 줄이 없으면 null.
export function docPosition(doc: PrDoc, line: number, column: number): number | null {
  const text = doc.view.state.doc;
  if (line < 1 || line > text.lines) return null;
  const at = text.line(line);
  return at.from + Math.min(column, at.length);
}
