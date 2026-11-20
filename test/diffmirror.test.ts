// 같은 URI 를 여러 보기가 열 때의 문서 관리: 파일 탭과 diff 의 수정본 쪽이 한 문서처럼 서버(LSP)에 보이는지.
// 확인: didOpen 은 URI 당 한 번, 서버에 보낼 변경은 먼저 연 보기 하나에 쌓인 것, 먼저 연 보기가 닫혀도 서버 문서는 유지되고 다음 보기가 이어받음, 마지막 보기가 닫혀야 didClose,
//       진단을 그릴 보기 목록, 다른 보기에서 흘러온 변경은 diff 가 디스크에 쓰지 않음, diff 안의 변경(덩어리 Undo)은 탭으로 흘러가 서버 쪽에 한 번만 쌓임.
// 실행: npm test
import { ChangeSet, EditorState, Transaction, type TransactionSpec } from "@codemirror/state";
import type { LSPClient } from "@codemirror/lsp-client";
import type { EditorView } from "@codemirror/view";
import { NavWorkspace } from "../web/lspWorkspace";
import { forwardUpdate, isMirroredUpdate, shouldForward, type MirrorHost, type MirrorUpdate } from "../web/viewMirror";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed++;
};
const same = (name: string, got: unknown, want: unknown) => check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

// LSPPlugin 대신 보기마다 아직 서버에 안 보낸 변경만 들고 있는 가짜. LSPPlugin.get(view) 는 view.plugin(...) 을 부른다.
class FakeView implements MirrorHost {
  state: EditorState;
  unsynced: ChangeSet;
  constructor(
    doc: string,
    private group: FakeView[],
    private onUpdate?: (update: MirrorUpdate) => void,
  ) {
    this.state = EditorState.create({ doc });
    this.unsynced = ChangeSet.empty(this.state.doc.length);
  }
  plugin() {
    return { unsyncedChanges: this.unsynced, clear: () => (this.unsynced = ChangeSet.empty(this.state.doc.length)) };
  }
  dispatch(...specs: (TransactionSpec | Transaction)[]) {
    const first = specs[0];
    const tr = first instanceof Transaction ? first : this.state.update(...(specs as TransactionSpec[]));
    const startState = this.state;
    this.state = tr.state;
    if (tr.docChanged) this.unsynced = this.unsynced.compose(tr.changes);
    const update: MirrorUpdate = { docChanged: tr.docChanged, startState, state: tr.state, changes: tr.changes, transactions: [tr] };
    this.onUpdate?.(update);
    if (!shouldForward(update)) return;
    forwardUpdate(
      update,
      this.group.filter((view) => view !== this).map((host) => ({ host, keepsHistory: false })),
    );
  }
  get text() {
    return this.state.doc.toString();
  }
}

const asView = (view: FakeView) => view as unknown as EditorView;

function setup() {
  const calls: string[] = [];
  const client = { didOpen: (file: { uri: string }) => calls.push(`didOpen ${file.uri}`), didClose: (uri: string) => calls.push(`didClose ${uri}`) } as unknown as LSPClient;
  const workspace = new NavWorkspace(client, async () => {
    throw new Error("not used");
  });
  return { calls, workspace };
}

const URI = "file:///repo/src/app.ts";

{
  const { calls, workspace } = setup();
  const group: FakeView[] = [];
  const tab = new FakeView("const a = 1;\n", group);
  const diff = new FakeView("const a = 1;\n", group);
  group.push(tab, diff);
  workspace.openFile(URI, "typescript", asView(tab));
  workspace.openFile(URI, "typescript", asView(diff));
  same("the server opens the document once for two views", calls, [`didOpen ${URI}`]);
  same("both views are known, the first one leading", workspace.viewsOf(URI).map((view) => (view === asView(tab) ? "tab" : "diff")), ["tab", "diff"]);
  same("an unknown uri has no views", workspace.viewsOf("file:///none.ts"), []);
  same("the version starts at 0", workspace.getFile(URI)?.version, 0);

  // 탭에서 친 글은 diff 에도 흘러가고, 서버에 보낼 변경은 먼저 연 보기(탭)에만 쌓인다
  tab.dispatch({ changes: { from: 11, insert: "2" }, userEvent: "input.type" });
  same("typing in the tab reaches the diff", [tab.text, diff.text], ["const a = 12;\n", "const a = 12;\n"]);
  const first = workspace.syncFiles();
  same("one update is sent for the file", first.length, 1);
  same("the update carries the typed change", first[0].file.doc.toString(), "const a = 12;\n");
  same("the version moves forward", workspace.getFile(URI)?.version, 1);
  same("a second sync has nothing to send", workspace.syncFiles().length, 0);
  same("the other view's pending changes were cleared too", diff.plugin().unsyncedChanges.empty, true);

  // diff 안의 변경(덩어리 Undo)도 탭으로 흘러가므로 서버 문서와 세 곳이 같은 글이다
  diff.dispatch({ changes: { from: 0, to: 5 }, userEvent: "revert" });
  same("an undo inside the diff reaches the tab", [tab.text, diff.text], [" a = 12;\n", " a = 12;\n"]);
  same("the server sees the undo once, through the first view", workspace.syncFiles().length, 1);
  same("closing the diff does not close the server document", (workspace.closeFile(URI, asView(diff)), calls), [`didOpen ${URI}`]);
  same("only the tab is left", workspace.viewsOf(URI).length, 1);
  workspace.closeFile(URI, asView(tab));
  same("closing the last view closes it on the server", calls, [`didOpen ${URI}`, `didClose ${URI}`]);
  same("nothing is left", workspace.viewsOf(URI), []);
}

{
  // 먼저 연 보기가 닫히면 diff 가 이어받아 서버에는 열린 채로 남고, 이후 변경은 이어받은 보기를 통해 간다
  const { calls, workspace } = setup();
  const group: FakeView[] = [];
  const tab = new FakeView("x", group);
  const diff = new FakeView("x", group);
  group.push(tab, diff);
  workspace.openFile(URI, "typescript", asView(tab));
  workspace.openFile(URI, "typescript", asView(diff));
  workspace.closeFile(URI, asView(tab));
  same("the diff takes over, no didClose", calls, [`didOpen ${URI}`]);
  check("the diff leads now", workspace.viewsOf(URI).length === 1 && workspace.viewsOf(URI)[0] === asView(diff));
  group.splice(0, 1);
  diff.dispatch({ changes: { from: 1, insert: "y" } });
  const updates = workspace.syncFiles();
  same("a change in the heir is sent", updates.map((u) => u.file.doc.toString()), ["xy"]);
  // 같은 파일을 다시 열면(diff 를 다시 만들 때) 서버에는 새로 열린다
  workspace.closeFile(URI, asView(diff));
  const again = new FakeView("xy", []);
  workspace.openFile(URI, "typescript", asView(again));
  same("a reopened view opens the document again", calls, [`didOpen ${URI}`, `didClose ${URI}`, `didOpen ${URI}`]);
  same("the version keeps counting up across reopen", workspace.getFile(URI)?.version, 2);
}

{
  // 같은 보기를 두 번 등록해도 목록에 한 번만 든다
  const { workspace } = setup();
  const tab = new FakeView("x", []);
  workspace.openFile(URI, "typescript", asView(tab));
  workspace.openFile(URI, "typescript", asView(tab));
  same("the same view twice is one view", workspace.viewsOf(URI).length, 1);
  const diff = new FakeView("x", []);
  workspace.openFile(URI, "typescript", asView(diff));
  workspace.openFile(URI, "typescript", asView(diff));
  same("a second view twice is still two views", workspace.viewsOf(URI).length, 2);
}

{
  // 다른 보기에서 흘러온 변경은 diff 가 디스크에 쓰지 않고, diff 자신의 변경만 쓴다
  const written: string[] = [];
  const group: FakeView[] = [];
  const tab = new FakeView("hello", group);
  const diff = new FakeView("hello", group, (update) => {
    if (update.docChanged && !isMirroredUpdate(update)) written.push(update.state.doc.toString());
  });
  group.push(tab, diff);
  tab.dispatch({ changes: { from: 5, insert: " (unsaved)" }, userEvent: "input.type" });
  same("the diff follows the tab's unsaved edit", diff.text, "hello (unsaved)");
  same("the diff did not write it to disk", written, []);
  diff.dispatch({ changes: { from: 0, to: 5, insert: "HELLO" }, userEvent: "revert" });
  same("the diff's own undo is written", written, ["HELLO (unsaved)"]);
  same("and it reaches the tab", tab.text, "HELLO (unsaved)");
  // 글이 어긋나 있으면(변경을 놓친 경우) 통째로 맞추고, 그 교체도 흘러온 것으로 본다
  const lone = new FakeView("old text", []);
  const wrote: string[] = [];
  const drifted = new FakeView("stale", [lone], (update) => {
    if (update.docChanged && !isMirroredUpdate(update)) wrote.push("written");
  });
  forwardUpdate(
    { docChanged: true, startState: EditorState.create({ doc: "a" }), state: EditorState.create({ doc: "fresh content" }), changes: ChangeSet.of({ from: 0, insert: "b" }, 1), transactions: [] },
    [{ host: drifted, keepsHistory: false }],
  );
  same("a drifted view is replaced whole", drifted.text, "fresh content");
  same("the whole-document replace is not written either", wrote, []);
}

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("diffmirror ok");
