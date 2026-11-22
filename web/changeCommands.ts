import { defaultChangeScope, type ChangedFile, type ChangeScope } from "../shared/protocol";
import { getChangesScope, getSelectedFile } from "./changesState";
import { confirmAction } from "./ConfirmDialog";
import { keepFile, reportSkipped, revertFiles, skippedMessage, undoFile } from "./fileActions";
import { toTarget } from "./lsp";
import { rpc } from "./rpc";
import { baseKeyOf } from "./editorTabs";
import { editorGitWorkspaceOf } from "./editorChat";
import { activeAgent, activeTab, closeTabsLike, diffTabKey, flash, getState, inFolder, openDiff, openFile } from "./store";
import { S } from "./strings";
import { hint } from "./hint";

export const FILE_REVISION_EVENT = "agent-nav:file-revision";

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

export async function keepChangedFile(agentId: string, defaultWorkspaceId: string, path: string) {
  await keepFile(agentId, toTarget(path, defaultWorkspaceId).workspaceId, path);
  window.dispatchEvent(new CustomEvent(FILE_REVISION_EVENT, { detail: { agentId, path } }));
}

export async function keepAllChanges(agentId: string, defaultWorkspaceId: string, files: ChangedFile[]) {
  for (const file of files.filter((f) => !f.outside)) await keepChangedFile(agentId, defaultWorkspaceId, file.path);
}

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

export async function discardChangedFile(agentId: string, path: string, rel: string): Promise<boolean> {
  const original = await originalOf(agentId, path);
  if (original === undefined) return false;
  if (!(await undoFile(agentId, path, rel, original, "discard"))) return false;
  window.dispatchEvent(new CustomEvent(FILE_REVISION_EVENT, { detail: { agentId, path } }));
  closeTabsLike(diffTabKey(agentId, path));
  return true;
}

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
  if (tab?.kind !== "diff" && editorGitWorkspaceOf(state) && (state.sideTabKey !== "changes" || state.editorSessionChangesId !== agent?.id)) {
    hint(S.commandNoSelectedFile);
    return null;
  }
  const path = tab?.kind === "diff" ? tab.path : agent ? getSelectedFile(agent.id) : null;
  const changed = agent && path ? state.gitChanges[agent.id]?.files.find((f) => f.path === path) : undefined;
  if (!agent || !inFolder(agent) || !path || !changed) {
    hint(S.commandNoSelectedFile);
    return null;
  }
  return { agentId: agent.id, workspaceId: toTarget(path, agent.workspaceId).workspaceId, path, rel: changed.rel, diffTabKey: tab?.kind === "diff" ? tab.key : null, diffScope: tab?.kind === "diff" ? tab.scope : null };
}

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
