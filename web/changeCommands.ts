import { defaultChangeScope, type ChangedFile, type ChangeScope } from "../shared/protocol";
import { getChangesScope, getSelectedFile } from "./changesState";
import { confirmAction } from "./ConfirmDialog";
import { keepFile, reportSkipped, revertFiles, skippedMessage, undoFile } from "./fileActions";
import { toTarget } from "./lsp";
import { rpc } from "./rpc";
import { baseKeyOf } from "./editorTabs";
import { activeAgent, activeTab, closeTabsLike, diffTabKey, flash, getState, inFolder, openDiff, openFile } from "./store";
import { S } from "./strings";
import { hint } from "./hint";

export const FILE_REVISION_EVENT = "agent-nav:file-revision";

// diffScope: diff 탭에서 부른 명령이면 그 탭이 비교하는 범위(탭에 범위가 없으면 undefined, 세션의 기본 범위). 변경 패널 목록에서 부르면 null 이고 패널의 범위를 쓴다.
type Target = { agentId: string; workspaceId: string; path: string; rel: string; diffTabKey: string | null; diffScope: ChangeScope | undefined | null };

export async function keepSelectedFile() {
  const target = selectedTarget();
  if (!target) return;
  await keepFile(target.agentId, target.workspaceId, target.path).catch((e: Error) => flash(e.message));
  finish(target);
}

export async function undoSelectedFile() {
  const target = selectedTarget();
  if (!target) return;
  const original = await originalOf(target.agentId, target.path, target.diffScope);
  if (original === undefined) return;
  if (await undoFile(target.agentId, target.path, target.rel, original)) finish(target);
}

// 변경 목록 행과 카드 머리의 Keep: 지금 디스크 내용을 그 파일의 기준으로 삼는다. 열려 있는 카드는 새 기준으로 다시 만든다.
export async function keepChangedFile(agentId: string, defaultWorkspaceId: string, path: string) {
  await keepFile(agentId, toTarget(path, defaultWorkspaceId).workspaceId, path);
  window.dispatchEvent(new CustomEvent(FILE_REVISION_EVENT, { detail: { agentId, path } }));
}

// 변경 패널 머리의 Keep All 과 Undo All. 작업 폴더 밖 파일(보기만 됨)은 건드리지 않는다.
export async function keepAllChanges(agentId: string, defaultWorkspaceId: string, files: ChangedFile[]) {
  for (const file of files.filter((f) => !f.outside)) await keepChangedFile(agentId, defaultWorkspaceId, file.path);
}

// 서버가 에이전트의 마지막 쓰기 뒤 바뀐 파일을 가려 건너뛴다(FIX4A). 확인 창은 실제로 되돌려질 파일 이름을 보인다.
export async function undoAllChanges(agentId: string, files: ChangedFile[]) {
  const candidates = files.filter((f) => !f.outside && f.status !== "R");
  if (candidates.length === 0) return;
  const check = await rpc.call("changes.checkUndo", { agentId, paths: candidates.map((f) => f.path) });
  const relOf = (path: string) => candidates.find((f) => f.path === path)?.rel ?? path;
  if (check.allowed.length === 0) {
    reportSkipped(agentId, check.skipped, relOf);
    return;
  }
  const targets = candidates.filter((f) => check.allowed.includes(f.path));
  const originals: { file: ChangedFile; original: string | null }[] = [];
  for (const file of targets) {
    const original = await originalOf(agentId, file.path);
    if (original === undefined) return;
    originals.push({ file, original });
  }
  const skippedNote = check.skipped.length > 0 ? `\n\n${skippedMessage(check.skipped)}:\n${S.undoFileList(check.skipped.map((s) => relOf(s.path)))}` : "";
  const detail = `${S.undoFileList(targets.map((f) => f.rel))}${skippedNote}`;
  if (!(await confirmAction(S.undoAllFilesConfirm(targets.length, originals.filter((o) => o.original === null).length), S.undoAllButton, detail, "warning"))) return;
  const reverted = await revertFiles(agentId, originals.map(({ file, original }) => ({ path: file.path, text: original })), relOf);
  for (const path of reverted) {
    window.dispatchEvent(new CustomEvent(FILE_REVISION_EVENT, { detail: { agentId, path } }));
    closeTabsLike(diffTabKey(agentId, path));
  }
}

// R4FIX: 변경 목록 행의 Discard Changes. 팔레트의 Undo All 과 같은 길(변경 범위의 기준 내용으로 되돌리기, 새 파일은 확인 뒤 휴지통)이고 확인 창 문구만 다르다.
// 되돌렸으면 true. 그 파일의 diff 탭은 닫고 열려 있는 카드는 새 기준으로 다시 만든다.
export async function discardChangedFile(agentId: string, path: string, rel: string): Promise<boolean> {
  const original = await originalOf(agentId, path);
  if (original === undefined) return false;
  if (!(await undoFile(agentId, path, rel, original, "discard"))) return false;
  window.dispatchEvent(new CustomEvent(FILE_REVISION_EVENT, { detail: { agentId, path } }));
  closeTabsLike(diffTabKey(agentId, path));
  return true;
}

// R4FIX: 변경 목록 행의 Open File. 지워진 파일은 열 파일이 없으니 diff 탭으로, 나머지는 에디터 탭으로(고정 탭) 연다.
// defaultWorkspaceId 는 세션의 작업 폴더다(파일이 다른 폴더에 있으면 toTarget 이 그 폴더로 바꾼다).
export function openChangedFile(agentId: string, defaultWorkspaceId: string, file: { path: string; status: string }) {
  const target = toTarget(file.path, defaultWorkspaceId);
  if (file.status === "D") openDiff(agentId, target.workspaceId, file.path);
  else openFile(target);
}

function finish(target: Target) {
  window.dispatchEvent(new CustomEvent(FILE_REVISION_EVENT, { detail: { agentId: target.agentId, path: target.path } }));
  if (target.diffTabKey) closeTabsLike(baseKeyOf(target.diffTabKey));
}

function selectedTarget(): Target | null {
  const tab = activeTab();
  const state = getState();
  const agent = tab?.kind === "diff" ? state.agents.find((a) => a.id === tab.agentId) : activeAgent();
  const path = tab?.kind === "diff" ? tab.path : agent ? getSelectedFile(agent.id) : null;
  const changed = agent && path ? state.gitChanges[agent.id]?.files.find((f) => f.path === path) : undefined;
  if (!agent || !inFolder(agent) || !path || !changed) {
    hint(S.commandNoSelectedFile);
    return null;
  }
  return { agentId: agent.id, workspaceId: toTarget(path, agent.workspaceId).workspaceId, path, rel: changed.rel, diffTabKey: tab?.kind === "diff" ? tab.key : null, diffScope: tab?.kind === "diff" ? tab.scope : null };
}

// 화면이 보여 주는 기준과 같은 내용(web/DiffView.tsx useOriginal 과 같은 규칙): 유지로 앞당긴 기준은 기본 범위, Branch, Session 에만 쓰고,
// Uncommitted 와 Last Turn 은 늘 그 범위의 git 기준이다. 새 파일이면 null. 기준을 못 읽으면 undefined.
// diffScope 가 null 이면 변경 패널의 범위, 아니면 diff 탭의 범위(undefined 는 세션의 기본 범위)다.
async function originalOf(agentId: string, path: string, diffScope: ChangeScope | undefined | null = null): Promise<string | null | undefined> {
  const state = getState();
  const agent = state.agents.find((a) => a.id === agentId);
  const scope = diffScope === null ? (agent ? getChangesScope(agent) : undefined) : diffScope;
  const keptApplies = !scope || !agent || scope === defaultChangeScope(agent) || scope === "branch" || scope === "session";
  const kept = keptApplies ? state.changes[agentId]?.find((c) => c.path === path) : undefined;
  if (kept) return kept.original;
  if (!agent) return undefined;
  return rpc
    .call("git.original", { agentId, path, scope })
    .then(({ text }) => text)
    .catch((e: Error) => {
      flash(e.message);
      return undefined;
    });
}
