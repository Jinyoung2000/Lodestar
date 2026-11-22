import type { Agent } from "../shared/protocol";
import { sessionRef } from "../shared/sessionRef";
import { confirmAction, confirmDialog } from "./ConfirmDialog";
import { rpc } from "./rpc";
import { chatHiddenInEditor } from "./focusLayout";
import { editorGitWorkspaceOf } from "./editorChat";
import { FALLBACK_ORDERING, sidebarLayout } from "./sessionList";
import { expandGroup, getSessionList, startRename } from "./sessionListState";
import { activeAgent, flash, getState, leaveDoneSession, inFolder, isTopWorkspace, openAgent, setState, subscribe, topWorkspaceId } from "./store";
import { S } from "./strings";
import { hint } from "./hint";

export function setPinned(agent: Agent, pinned: boolean) {
  call(rpc.call("agents.setPinned", { agentId: agent.id, pinned }));
  if (pinned) expandGroup("pinned");
}

export function setDone(agent: Agent, done: boolean) {
  call(rpc.call("agents.setDone", { agentId: agent.id, done }));
  if (!done) return;
  leaveDoneSession(agent.id);
  if (!getSessionList().view.showDone) flash(S.markedDone);
}

export function markRead(agent: Agent, read: boolean) {
  if (!read) keepUnread.add(agent.id);
  call(rpc.call("agents.markRead", { agentId: agent.id, read }));
}

export function renameSession(agentId: string, title: string) {
  call(rpc.call("agents.rename", { agentId, title }));
}

export function copySessionLink(agent: Agent) {
  navigator.clipboard.writeText(sessionRef(agent.id)).then(
    () => hint(S.linkCopied, undefined, { check: true }),
    () => flash(S.linkCopyFailed),
  );
}

export function allowPermission(agentId: string, itemId: string) {
  call(rpc.call("agents.respondPermission", { agentId, itemId, decision: "allow" }));
}

export function runSessionShortcut(event: KeyboardEvent) {
  const editable = (event.target as HTMLElement | null)?.closest?.("input, textarea, select, [contenteditable='true'], .cm-editor, .xterm");
  if (editable || (event.target as HTMLElement | null)?.closest?.(".session-row")) return false;
  const isRename = event.key === "F2" && !event.metaKey && !event.altKey && !event.ctrlKey && !event.shiftKey;
  const isDone = event.key === "Backspace" && event.metaKey && !event.altKey && !event.ctrlKey && !event.shiftKey;
  if (!isRename && !isDone) return false;
  const agent = activeAgent();
  if (!agent) return false;
  event.preventDefault();
  if (isRename) startRename(agent.id);
  else setDone(agent, !agent.done);
  return true;
}

const attempted = new Set<string>();
const waiting: string[] = [];
let inFlight = 0;

export function ensureRowChanges(agentId: string) {
  if (attempted.has(agentId) || getState().sessionChanges[agentId] || !inFolder(getState().agents.find((a) => a.id === agentId))) return;
  attempted.add(agentId);
  waiting.push(agentId);
  pump();
}

function pump() {
  while (inFlight < 3 && waiting.length) {
    const agentId = waiting.shift()!;
    inFlight++;
    rpc
      .call("git.changes", { agentId, scope: "session" })
      .then((changes) => setState((s) => ({ sessionChanges: { ...s.sessionChanges, [agentId]: changes } })))
      .catch(() => {})
      .finally(() => {
        inFlight--;
        pump();
      });
  }
}

const keepUnread = new Set<string>();

export function interruptAgent(agentId: string) {
  keepUnread.add(agentId);
  call(rpc.call("agents.interrupt", { agentId }));
}
const readInFlight = new Set<string>();

export function initSessionActions() {
  subscribe(autoMarkRead);
  window.addEventListener("focus", autoMarkRead);
  subscribe(reportOpenAgents);
  subscribe(reportWatchedWorkspaces);
  rpc.onStatus((connected) => {
    if (!connected) return;
    reportedOpen = "";
    reportOpenAgents();
    reportedWatched = "";
    reportWatchedWorkspaces();
  });
}

let reportedWatched = "";

function reportWatchedWorkspaces() {
  const s = getState();
  const ids = new Set<string>();
  if (s.activeWorkspaceId) ids.add(s.activeWorkspaceId);
  const editorWorkspaceId = editorGitWorkspaceOf(s);
  if (editorWorkspaceId) ids.add(editorWorkspaceId);
  for (const pane of s.panes) {
    const agent = pane.kind === "agent" ? s.agents.find((a) => a.id === pane.agentId) : undefined;
    const workspaceId = pane.kind === "agent" ? agent?.workspaceId : pane.workspaceId;
    if (workspaceId) ids.add(workspaceId);
    for (const extra of agent?.extraWorkspaceIds ?? []) ids.add(extra);
  }
  for (const tab of s.tabs) if ("workspaceId" in tab && tab.workspaceId) ids.add(tab.workspaceId);
  const workspaceIds = [...ids].sort();
  const key = workspaceIds.join(",");
  if (key === reportedWatched) return;
  reportedWatched = key;
  rpc.call("workspaces.watch", { workspaceIds }).catch(() => {
    reportedWatched = "";
  });
}

let reportedOpen = "";
let reportedNativeWindow = "";

function reportOpenAgents() {
  const { panes, layoutMode, settings } = getState();
  const agentIds = [...new Set(panes.flatMap((p) => (p.kind === "agent" ? [p.agentId] : [])))].sort();
  const key = agentIds.join(",");
  const nativeKey = `${layoutMode}:${key}`;
  if (settings && nativeKey !== reportedNativeWindow) {
    reportedNativeWindow = nativeKey;
    void window.agentNavNative?.setOpenAgents?.(agentIds, layoutMode).catch(() => {
      reportedNativeWindow = "";
    });
  }
  if (key === reportedOpen) return;
  reportedOpen = key;
  rpc.call("agents.setOpen", { agentIds }).catch(() => {
    reportedOpen = "";
  });
}

function autoMarkRead() {
  const s = getState();
  const seen = new Set<string>();
  if (s.centerView === "sessions" && document.hasFocus() && document.visibilityState === "visible") {
    const shown = s.layoutMode === "editor" ? (chatHiddenInEditor(s) ? [] : s.panes.filter((p) => p.id === s.activePaneId)) : s.panes;
    for (const pane of shown) if (pane.kind === "agent") seen.add(pane.agentId);
  }
  for (const id of keepUnread) if (!seen.has(id)) keepUnread.delete(id);
  for (const agent of s.agents) {
    if (!agent.unread || !seen.has(agent.id) || keepUnread.has(agent.id) || readInFlight.has(agent.id)) continue;
    readInFlight.add(agent.id);
    rpc
      .call("agents.markRead", { agentId: agent.id, read: true })
      .catch(() => {})
      .finally(() => readInFlight.delete(agent.id));
  }
}

function call(promise: Promise<unknown>) {
  promise.catch((error: Error) => flash(S.sessionActionFailed(error.message)));
}

export function openAdjacentSession(delta: 1 | -1) {
  const s = getState();
  const list = getSessionList();
  const { order } = sidebarLayout({
    agents: s.agents,
    workspaces: s.workspaces.filter(isTopWorkspace),
    topWorkspaceId,
    view: list.view,
    defaultOrdering: s.defaults?.sessionSort.value ?? FALLBACK_ORDERING,
    now: Date.now(),
    collapsedParents: new Set(list.collapsedParents),
    expandedGroups: new Set(list.expanded),
    collapsedGroups: new Set(list.collapsedGroups),
    orders: s.sessionOrders,
  });
  const current = activeAgent()?.id;
  const index = current ? order.indexOf(current) : -1;
  const next = order[index < 0 ? (delta === 1 ? 0 : order.length - 1) : index + delta];
  if (next) openAgent(next);
}

export async function deleteSession(agent: Agent) {
  let removeWorktree = false;
  if (agent.worktree) {
    const status = await rpc.call("agents.worktreeStatus", { agentId: agent.id }).catch(() => null);
    const branchNote = status ? `\n\n${S.deleteSessionBranchNote(status.branch, status.base.replace(/^origin\//, ""), status.unmerged)}` : "";
    if (status?.dirty) {
      if (!(await confirmAction(S.deleteSessionTitle, S.deleteButton, `${S.deleteSessionDirtyDetail(status.summary, agent.worktree.root)}${branchNote}`, "warning"))) return;
    } else {
      const risky = status?.unmerged !== 0;
      const choice = await confirmDialog({ title: S.deleteSessionTitle, detail: `${S.deleteSessionWorktreeDetail(agent.worktree.root)}${branchNote}`, buttons: [S.cancel, S.deleteSessionOnlyButton, S.deleteSessionAndWorktreeButton], severity: "warning", ...(risky ? { primary: 1, danger: [2] } : {}) });
      if (choice === null || choice === 0) return;
      removeWorktree = choice === 2;
    }
  } else if (!(await confirmAction(S.deleteSessionTitle, S.deleteButton, S.deleteSessionDetail, "warning"))) return;
  try {
    await rpc.call("agents.remove", { agentId: agent.id, removeWorktree });
    flash(removeWorktree ? S.sessionAndWorktreeDeleted : S.sessionDeleted);
  } catch (error) {
    flash((error as Error).message);
  }
}
