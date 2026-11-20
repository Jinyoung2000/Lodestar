import { confirmDialog } from "./ConfirmDialog";
import { checkAllDisks } from "./editorDocs";
import { advanceAfterRemoval, cursorRowIndex, dismissHits, runSearchView } from "./findInFiles";
import { rpc } from "./rpc";
import { fileRequestsOf, replacementOf, settleReplace } from "./searchReplaceModel";
import { currentModel, getSearchUi, setSearchUi } from "./searchState";
import { hitsUnder, visibleRows, type SearchHit, type TreeNode } from "./searchTree";
import { runIsCurrent } from "./searchViewModel";
import { SV, confirmReplaceAll, replacedAll } from "./searchViewStrings";
import { flash, getState, searchWorkspaceOf } from "./store";
import { S } from "./strings";

// Search 뷰의 Replace(일치 하나), Replace All in File(파일 행), Replace All(위젯, 확인 창을 거친다). 파일은 데몬의 search.replace 가 쓴다.
// 에디터에서 저장하지 않은 편집이 있는 파일은 건드리지 않고 건너뛴다(버퍼와 디스크의 위치가 어긋나 있을 수 있다).

export async function replaceNode(node: TreeNode) {
  const at = cursorRowIndex() === -1 ? visibleRows(currentModel().nodes, getSearchUi().collapsed).findIndex((row) => row.node.key === node.key) : cursorRowIndex();
  const done = await replaceHits(hitsUnder(node));
  // 바뀐 행이 빠지면 다음 행이 선택되고 일치 행이면 그 바꾸기 미리보기가 열린다
  if (done && done.replaced.length > 0) advanceAfterRemoval(at);
  return done;
}

export async function replaceHits(hits: readonly SearchHit[]): Promise<{ replaced: SearchHit[]; files: number } | null> {
  const state = getState();
  const workspaceId = searchWorkspaceOf(state);
  if (!workspaceId || hits.length === 0) return null;
  const view = state.searchView;
  const run = state.searchRun;
  // 결과는 그 검색을 돌린 폴더 기준 경로라 다른 폴더에는 쓰지 않는다
  if (!runIsCurrent(run, workspaceId)) return null;
  // 입력의 검색어나 옵션이 결과를 낸 검색과 달라졌으면(아직 다시 검색하지 않음) 옛 결과를 새 패턴으로 바꾸지 않고 다시 검색한다
  if (run.query !== view.query || run.toggles.regex !== view.regex || run.toggles.matchCase !== view.matchCase || run.toggles.wholeWord !== view.wholeWord) {
    void runSearchView();
    return null;
  }
  const smartCase = getSearchUi().settings.smartCase;
  const dirty = dirtyPaths(workspaceId);
  const writable = hits.filter((hit) => !dirty.has(hit.path));
  if (writable.length < hits.length) flash(SV.skippedUnsaved(new Set(hits.filter((hit) => dirty.has(hit.path)).map((hit) => hit.path)).size), "warning");
  if (writable.length === 0) return null;
  try {
    const { results } = await rpc.call("search.replace", { workspaceId, files: fileRequestsOf(writable, (hit) => replacementOf(hit, view, smartCase)) });
    const settled = settleReplace(writable, results);
    dismissHits(settled.replaced);
    checkAllDisks();
    if (settled.conflicts.length > 0 || settled.failed.length > 0) setSearchUi({ note: SV.conflict });
    return { replaced: settled.replaced, files: new Set(settled.replaced.map((hit) => hit.path)).size };
  } catch (error) {
    flash((error as Error).message, "error");
    return null;
  }
}

// 위젯의 Replace All: 확인 창(Replace All, "Replace N occurrences across M files with 'x'?")에서 Replace 를 눌러야 쓴다.
export async function replaceAll() {
  const model = currentModel();
  if (model.hitCount === 0) return;
  const text = getState().searchView.replaceText;
  const choice = await confirmDialog({ title: SV.replaceAllTitle, detail: confirmReplaceAll(model.hitCount, model.fileCount, text), buttons: [S.cancel, SV.replaceButton], primary: 1 });
  if (choice !== 1) return;
  // 확인 창이 떠 있는 동안 새 검색 결과가 왔거나 바꿀 글이 바뀌었으면 확인한 것과 다르니 쓰지 않는다
  if (currentModel() !== model || getState().searchView.replaceText !== text) return;
  const done = await replaceHits(model.nodes.flatMap(hitsUnder));
  if (done && done.replaced.length > 0 && getSearchUi().note === null) setSearchUi({ note: replacedAll(done.replaced.length, done.files, text) });
}

// 에디터에서 고치는 중(저장 안 함)인 파일 경로들
function dirtyPaths(workspaceId: string): Set<string> {
  const { tabs, dirtyTabs } = getState();
  return new Set(tabs.filter((t) => t.kind === "file" && t.workspaceId === workspaceId && dirtyTabs[t.key]).map((t) => (t as { path: string }).path));
}

// 충돌 안내의 "Search again" 링크
export function searchAgain() {
  setSearchUi({ note: null });
  void runSearchView();
}
