import { workspaceDirsOfPanes } from "../shared/openPath";
import { rpc } from "./rpc";
import { focusPane, getState, openFile, setLayoutMode, setState, startDraft, type Pane } from "./store";

// OPENFOLDER: 메인 프로세스가 바깥에서 넘겨받은 폴더(open -g -a, Dock 에 끌어 놓기, 실행 인자)를 이 창에서 열 때 부르는 창구.
// window.__agentNav.openFolder 로 노출하고, 메인이 executeJavaScript 로 shownDirs 와 run 을 부른다(electron/main.ts handleOpenRequest).

export type OpenFolderRequest = { dir: string; file: string | null; startSession: boolean };
export type OpenFolderResult = { workspaceId: string; name: string; dir: string; startedSession: boolean; openedFile: string | null };

export const openFolderApi = { shownDirs, layout, run };

// 이 창의 칸이 보여 주는 워크스페이스 폴더. 메인이 "그 폴더를 이미 보여 주는 창" 을 고를 때 읽는다.
function shownDirs(): string[] {
  const s = getState();
  return workspaceDirsOfPanes(s.panes, s.agents, s.workspaces);
}

// 이 창의 배치(chat, editor). 메인은 바깥에서 연 폴더를 Editor 배치로 보던 창에만 다시 보낸다.
function layout(): string {
  return getState().layoutMode;
}

// 폴더를 워크스페이스로 등록하고(이미 있으면 그대로), startSession 이면 그 폴더가 골라진 새 세션 화면을 열고, file 이 있으면 그 파일을 에디터로 연다.
async function run(request: OpenFolderRequest): Promise<OpenFolderResult> {
  const workspace = await rpc.call("workspaces.open", { dir: request.dir });
  await untilKnown(workspace.id);
  if (request.startSession) {
    startNewSessionIn(workspace.id);
    setLayoutMode("editor");
  } else focusPaneOf(workspace.dir);
  if (request.file) openFile({ workspaceId: workspace.id, path: request.file });
  return { workspaceId: workspace.id, name: workspace.name, dir: workspace.dir, startedSession: request.startSession, openedFile: request.file };
}

// 새 세션 화면 하나뿐인 창(새로 연 창)은 그 칸을 바꾸고, 이미 쓰던 창이면 칸을 하나 더 연다(보던 세션을 닫지 않는다).
function startNewSessionIn(workspaceId: string) {
  const { panes } = getState();
  const onlyEmptyDraft = panes.length === 1 && panes[0].kind === "draft" && !panes[0].seed && !panes[0].handoff;
  startDraft(workspaceId, onlyEmptyDraft ? "active" : "new");
}

// 그 폴더를 보여 주는 창으로 다시 왔을 때: 지금 칸이 다른 폴더면 그 폴더를 보여 주는 칸으로 옮긴다(에디터와 파일 목록이 그 폴더를 따라가게).
function focusPaneOf(dir: string) {
  const s = getState();
  const showsDir = (pane: Pane) => workspaceDirsOfPanes([pane], s.agents, s.workspaces).includes(dir);
  const active = s.panes.find((p) => p.id === s.activePaneId);
  if (active && showsDir(active)) return;
  const pane = s.panes.find(showsDir);
  if (pane) focusPane(pane.id);
}

// 서버가 workspaces 이벤트로 알리기 전에 이 창이 새 폴더를 쓰면 폴더 선택이 비어 보인다. 이벤트가 오기를 잠깐 기다리고, 안 오면 목록을 직접 읽는다.
async function untilKnown(workspaceId: string) {
  const known = () => getState().workspaces.some((w) => w.id === workspaceId);
  for (let i = 0; i < 15 && !known(); i++) await new Promise((resolve) => setTimeout(resolve, 100));
  if (!known()) setState({ workspaces: await rpc.call("workspaces.list", {}) });
}
