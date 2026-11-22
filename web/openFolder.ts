import { containingDir, fileUnder, type OpenPosition, workspaceDirsOfPanes } from "../shared/openPath";
import { rpc } from "./rpc";
import { focusPane, getState, openFile, setLayoutMode, setState, startDraft, takePickFolderOnStart, type Pane } from "./store";

export type OpenFolderRequest = { dir: string; file: string | null; startSession: boolean; position?: OpenPosition };
export type OpenFolderResult = { workspaceId: string; name: string; dir: string; startedSession: boolean; openedFile: string | null };

export const openFolderApi = { shownDirs, layout, run };

function shownDirs(): string[] {
  const s = getState();
  return workspaceDirsOfPanes(s.panes, s.agents, s.workspaces);
}

function layout(): string {
  return getState().layoutMode;
}

async function run(incoming: OpenFolderRequest): Promise<OpenFolderResult> {
  takePickFolderOnStart();
  const request = insideKnownWorkspace(incoming);
  const workspace = await rpc.call("workspaces.open", { dir: request.dir });
  await untilKnown(workspace.id);
  if (request.startSession) {
    startNewSessionIn(workspace.id);
    setLayoutMode("editor");
  } else focusPaneOf(workspace.dir);
  if (request.file) openFile({ workspaceId: workspace.id, path: request.file, ...(request.position ?? {}) });
  return { workspaceId: workspace.id, name: workspace.name, dir: workspace.dir, startedSession: request.startSession, openedFile: request.file };
}

function insideKnownWorkspace(request: OpenFolderRequest): OpenFolderRequest {
  if (!request.file) return request;
  const owner = containingDir(request.dir, getState().workspaces.map((w) => w.dir));
  return owner ? { ...request, dir: owner, file: fileUnder(owner, request.dir, request.file) } : request;
}

function startNewSessionIn(workspaceId: string) {
  const { panes } = getState();
  const onlyEmptyDraft = panes.length === 1 && panes[0].kind === "draft" && !panes[0].seed && !panes[0].handoff;
  startDraft(workspaceId, onlyEmptyDraft ? "active" : "new");
}

function focusPaneOf(dir: string) {
  const s = getState();
  const showsDir = (pane: Pane) => workspaceDirsOfPanes([pane], s.agents, s.workspaces).includes(dir);
  const active = s.panes.find((p) => p.id === s.activePaneId);
  if (active && showsDir(active)) return;
  const pane = s.panes.find(showsDir);
  if (pane) focusPane(pane.id);
}

async function untilKnown(workspaceId: string) {
  const known = () => getState().workspaces.some((w) => w.id === workspaceId);
  for (let i = 0; i < 15 && !known(); i++) await new Promise((resolve) => setTimeout(resolve, 100));
  if (!known()) setState({ workspaces: await rpc.call("workspaces.list", {}) });
}
