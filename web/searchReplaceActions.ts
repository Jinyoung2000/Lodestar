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
import { searchTargetOf } from "./searchRoots";
import { S } from "./strings";

export async function replaceNode(node: TreeNode) {
  const at = cursorRowIndex() === -1 ? visibleRows(currentModel().nodes, getSearchUi().collapsed).findIndex((row) => row.node.key === node.key) : cursorRowIndex();
  const done = await replaceHits(hitsUnder(node));
  if (done && done.replaced.length > 0) advanceAfterRemoval(at);
  return done;
}

export async function replaceHits(hits: readonly SearchHit[]): Promise<{ replaced: SearchHit[]; files: number } | null> {
  const state = getState();
  const workspaceId = searchWorkspaceOf(state);
  if (!workspaceId || hits.length === 0) return null;
  const view = state.searchView;
  const run = state.searchRun;
  if (!runIsCurrent(run, workspaceId)) return null;
  if (run.query !== view.query || run.toggles.regex !== view.regex || run.toggles.matchCase !== view.matchCase || run.toggles.wholeWord !== view.wholeWord) {
    void runSearchView();
    return null;
  }
  const smartCase = getSearchUi().settings.smartCase;
  const groups = new Map<string, { hit: SearchHit; rel: SearchHit }[]>();
  for (const hit of hits) {
    const target = searchTargetOf(hit.path);
    if (!target) continue;
    const list = groups.get(target.workspaceId) ?? [];
    list.push({ hit, rel: { ...hit, path: target.path } });
    groups.set(target.workspaceId, list);
  }
  const dirtyOf = new Map([...groups.keys()].map((id) => [id, dirtyPaths(id)]));
  const isDirty = (id: string, rel: SearchHit) => dirtyOf.get(id)?.has(rel.path) === true;
  const skipped = [...groups].flatMap(([id, list]) => list.filter((entry) => isDirty(id, entry.rel)).map((entry) => entry.hit.path));
  if (skipped.length > 0) flash(SV.skippedUnsaved(new Set(skipped).size), "warning");
  const writable = [...groups].flatMap(([id, list]) => list.filter((entry) => !isDirty(id, entry.rel)).map((entry) => ({ id, ...entry })));
  if (writable.length === 0) return null;
  try {
    const results = (
      await Promise.all(
        [...groups.keys()].map(async (id) => {
          const mine = writable.filter((entry) => entry.id === id);
          if (mine.length === 0) return [];
          const back = new Map(mine.map((entry) => [entry.rel.path, entry.hit.path]));
          const response = await rpc.call("search.replace", { workspaceId: id, files: fileRequestsOf(mine.map((entry) => entry.rel), (hit) => replacementOf(hit, view, smartCase)) });
          return response.results.map((result) => ({ ...result, path: back.get(result.path) ?? result.path }));
        }),
      )
    ).flat();
    const settled = settleReplace(writable.map((entry) => entry.hit), results);
    dismissHits(settled.replaced);
    checkAllDisks();
    if (settled.conflicts.length > 0 || settled.failed.length > 0) setSearchUi({ note: SV.conflict });
    return { replaced: settled.replaced, files: new Set(settled.replaced.map((hit) => hit.path)).size };
  } catch (error) {
    flash((error as Error).message, "error");
    return null;
  }
}

export async function replaceAll() {
  const model = currentModel();
  if (model.hitCount === 0) return;
  const text = getState().searchView.replaceText;
  const choice = await confirmDialog({ title: SV.replaceAllTitle, detail: confirmReplaceAll(model.hitCount, model.fileCount, text), buttons: [S.cancel, SV.replaceButton], primary: 1 });
  if (choice !== 1) return;
  if (currentModel() !== model || getState().searchView.replaceText !== text) return;
  const done = await replaceHits(model.nodes.flatMap(hitsUnder));
  if (done && done.replaced.length > 0 && getSearchUi().note === null) setSearchUi({ note: replacedAll(done.replaced.length, done.files, text) });
}

function dirtyPaths(workspaceId: string): Set<string> {
  const { tabs, dirtyTabs } = getState();
  return new Set(tabs.filter((t) => t.kind === "file" && t.workspaceId === workspaceId && dirtyTabs[t.key]).map((t) => (t as { path: string }).path));
}

export function searchAgain() {
  setSearchUi({ note: null });
  void runSearchView();
}
