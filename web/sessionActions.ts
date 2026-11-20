import type { Agent } from "../shared/protocol";
import { sessionRef } from "../shared/sessionRef";
import { confirmAction, confirmDialog } from "./ConfirmDialog";
import { rpc } from "./rpc";
import { chatHiddenInEditor } from "./focusLayout";
import { FALLBACK_ORDERING, sidebarLayout } from "./sessionList";
import { expandGroup, getSessionList, startRename } from "./sessionListState";
import { activeAgent, flash, getState, inFolder, isTopWorkspace, openAgent, setState, subscribe, topWorkspaceId } from "./store";
import { S } from "./strings";
import { hint } from "./hint";

// B1: 사이드바 세션 행 동작(고정, 완료, 읽음, 이름, 링크 복사, 승인)과 그 단축키(F2, ⌘Backspace), 안 읽음 자동 해제.
// 대화 머리의 `...` 메뉴(묶음 2)도 같은 함수를 부른다.

export function setPinned(agent: Agent, pinned: boolean) {
  call(rpc.call("agents.setPinned", { agentId: agent.id, pinned }));
  // Pinned 묶음은 처음에 접혀 있어서, 고정한 세션이 목록에서 사라진 것처럼 보인다(dogfood 21). 고정하는 순간 펼쳐 그 자리를 보여 준다.
  if (pinned) expandGroup("pinned");
}

export function setDone(agent: Agent, done: boolean) {
  call(rpc.call("agents.setDone", { agentId: agent.id, done }));
  // 완료한 세션은 목록에서 사라진다. 필터 Show Done 이 꺼져 있으면 어디로 갔는지 알려 준다.
  if (done && !getSessionList().view.showDone) flash(S.markedDone);
}

export function markRead(agent: Agent, read: boolean) {
  // 보고 있는 세션을 안 읽음으로 돌리면 자동 읽음이 바로 되돌리지 않도록, 그 세션을 벗어날 때까지 둔다.
  if (!read) keepUnread.add(agent.id);
  call(rpc.call("agents.markRead", { agentId: agent.id, read }));
}

export function renameSession(agentId: string, title: string) {
  call(rpc.call("agents.rename", { agentId, title }));
}

// 다른 세션의 메시지에 붙여 넣는 참조(lodestar://session/<앞 8자>). 보낼 때 서버가 그 세션의 최근 대화를 모델에게 덧붙이고, 대화 속 참조는 눌러서 연다(web/sessionLinks.ts).
export function copySessionLink(agent: Agent) {
  navigator.clipboard.writeText(sessionRef(agent.id)).then(
    () => hint(S.linkCopied, undefined, { check: true }),
    () => flash(S.linkCopyFailed),
  );
}

export function allowPermission(agentId: string, itemId: string) {
  call(rpc.call("agents.respondPermission", { agentId, itemId, decision: "allow" }));
}

// F2 는 보고 있는 세션의 이름 바꾸기, ⌘Backspace 는 완료 처리. 글자를 쓰는 곳(입력창, 에디터, 터미널)에서는 건드리지 않는다.
export function runSessionShortcut(event: KeyboardEvent) {
  const editable = (event.target as HTMLElement | null)?.closest?.("input, textarea, select, [contenteditable='true'], .cm-editor, .xterm");
  // 사이드바 행에 포커스가 있으면 그 행이 자기 키를 처리한다(보고 있는 세션이 아니라 포커스된 행이 대상).
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

// 행이 화면에 보일 때만 변경량(+N -M)을 읽는다. 세션을 열어야만 채워지던 값이라 안 연 세션은 비어 있고, 세션마다 git 을 부르므로 3개씩만 동시에 돈다.
// 한 번 읽은 뒤에는 도구가 파일을 고칠 때마다 store 가 이미 새로 읽는다.
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

// --- 안 읽음 자동 해제 ---
// 서버는 턴이 끝날 때 unread 를 올린다. 그 세션이 칸에 열려 있고 창이 포커스일 때 웹이 agents.markRead 로 내린다.

const keepUnread = new Set<string>();

export function interruptAgent(agentId: string) {
  keepUnread.add(agentId);
  call(rpc.call("agents.interrupt", { agentId }));
}
const readInFlight = new Set<string>();

export function initSessionActions() {
  subscribe(autoMarkRead);
  window.addEventListener("focus", autoMarkRead);
  // FIX3-7: 데몬은 칸에 열려 있는 세션의 프로세스를 유휴로 닫지 않는다. 연결이 새로 이어지면 목록을 다시 보낸다(데몬이 옛 연결의 목록을 잊는다).
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

// FIX4A: 보고 있는 폴더(활성 폴더와 칸에 열린 세션의 폴더)를 데몬에 알린다. 데몬은 그 저장소의 파일 변화를 감시한다.
let reportedWatched = "";

function reportWatchedWorkspaces() {
  const s = getState();
  const ids = new Set<string>();
  if (s.activeWorkspaceId) ids.add(s.activeWorkspaceId);
  for (const pane of s.panes) {
    // FIX6B: 새 세션 화면이 고른 폴더도 본다. 세션 없이 쓰는 Source Control 과 Changes 가 바깥 변화를 받는다.
    const workspaceId = pane.kind === "agent" ? s.agents.find((a) => a.id === pane.agentId)?.workspaceId : pane.workspaceId;
    if (workspaceId) ids.add(workspaceId);
  }
  // FIX6B: 열려 있는 파일, diff 탭의 폴더도 본다. 바깥에서 git 으로 바뀐 파일을 탭이 다시 읽는다.
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

function reportOpenAgents() {
  const agentIds = [...new Set(getState().panes.flatMap((p) => (p.kind === "agent" ? [p.agentId] : [])))].sort();
  const key = agentIds.join(",");
  if (key === reportedOpen) return;
  reportedOpen = key;
  // 데스크톱 앱에는 이 창에 열린 세션도 알린다. 알림을 누르면 그 세션이 열린 창으로 간다.
  void window.agentNavNative?.setOpenAgents?.(agentIds).catch(() => undefined);
  rpc.call("agents.setOpen", { agentIds }).catch(() => {
    reportedOpen = "";
  });
}

function autoMarkRead() {
  const s = getState();
  const seen = new Set<string>();
  if (s.centerView === "sessions" && document.hasFocus() && document.visibilityState === "visible") {
    // Editor 배치에서는 떠 있는 창이나 오른쪽 패널의 세션만 보이고, 알약으로 접히거나 패널이 닫히면 아무것도 읽지 않은 것이다.
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

// Agents: Go to Previous/Next Session(팔레트). 활성 칸에 사이드바에서 바로 위, 아래에 보이는 세션을 연다. 순서는 사이드바가 그리는 것과 같은 sidebarLayout 이 만든다. 끝에서는 멈춘다.
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

// 세션 삭제. worktree 세션이면 worktree 도 지울지 묻고, 변경이 남아 있으면 경고한다. 강제 삭제는 없다.
export async function deleteSession(agent: Agent) {
  let removeWorktree = false;
  if (agent.worktree) {
    const status = await rpc.call("agents.worktreeStatus", { agentId: agent.id }).catch(() => null);
    const branchNote = status ? `\n\n${S.deleteSessionBranchNote(status.branch, status.base.replace(/^origin\//, ""), status.unmerged)}` : "";
    if (status?.dirty) {
      if (!(await confirmAction(S.deleteSessionTitle, S.deleteButton, `${S.deleteSessionDirtyDetail(status.summary, agent.worktree.root)}${branchNote}`, "warning"))) return;
    } else {
      // 아직 합치지 않은 커밋이 있거나 기준 브랜치를 못 찾았으면 Enter 의 기본은 워크트리를 남기는 쪽이고, 워크트리까지 지우는 단추는 위험 표시를 단다.
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
