import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Agent, GitInfo } from "../shared/protocol";
import { AttentionChip } from "./AttentionChip";
import { TitleBranch } from "./TitleBranch";
import { sessionPanelToggleable } from "./centerPanels";
import { FeedbackButton } from "./Feedback";
import { Codicon, FileIcon, FolderCompact, PanelBottom, PanelLeft, PanelRight, Refresh, Sync, VSCodeIcon, WorktreeCompact } from "./icons";
import { rpc } from "./rpc";
import { activeAgentOf } from "./activeAgentOf";
import { chatPaneWorkspace, chatProject, editorGitWorkspaceOf } from "./editorChat";
import { chatHiddenInEditor } from "./focusLayout";
import { useLayoutConfig } from "./layoutConfigStore";
import { runCommand } from "./shortcuts";
import { sidebarPeek } from "./peekController";
import { flash, focusPane, getState, goBackSession, goForwardSession, openBrowser, openInVSCode, refreshGit, setState, useStore, type BrowserTab } from "./store";
import { confirmAction } from "./ConfirmDialog";
import { fetchFlow, pullFlow, pushFlow } from "./gitSync";
import { REMOTE_ID } from "./remote";
import { useRemoteHost } from "./remoteHost";
import { S } from "./strings";
import { N } from "./notionStrings";
import { Button } from "./ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "./ui/dropdown-menu";
import { hint } from "./hint";
import { visibleCenterView } from "./screenVisibility";
import { onWorkspaceChanged } from "./workspaceEvents";
import { useCommandKey, useCommandKeys } from "./commandKeys";

const APP_TITLE = document.title;

const AUTO_FETCH_MS = 3 * 60_000;
const lastAutoFetch = new Map<string, number>();

export function TitleBar() {
  const sidebarKey = useCommandKey("toggleSidebar");
  const focusSideKey = useCommandKey("toggleFocusSide");
  const focusChatKey = useCommandKey("toggleFocusChat");
  const rightKey = useCommandKey("toggleRight");
  const bottomKey = useCommandKey("toggleBottom");
  const layoutKey = useCommandKey("toggleLayout");
  const openFileKey = useCommandKey("quickOpen");
  const backKeys = useCommandKeys("sessionBack");
  const forwardKeys = useCommandKeys("sessionForward");
  const agent = useStore((s) => activeAgentOf(s.panes, s.activePaneId, s.agents));
  const workspaces = useStore((s) => s.workspaces);
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  const agentInfo = useStore((s) => (agent ? s.gitInfo[agent.id] : undefined));
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const rightOpen = useStore((s) => s.rightOpen);
  const centerView = useStore((s) => visibleCenterView(s.centerView, s.settings, s.operator));
  const showRightToggle = sessionPanelToggleable(centerView);
  const bottomOpen = useStore((s) => s.bottomOpen);
  const editorLayout = useStore((s) => s.layoutMode === "editor");
  const workspaceId = useStore(editorGitWorkspaceOf);
  const gitWorkspace = workspaces.find((workspace) => workspace.id === workspaceId);
  const [workspaceInfo, reloadWorkspaceInfo] = useWorkspaceGitInfo(gitWorkspace?.id ?? null);
  const info = gitWorkspace ? workspaceInfo : agentInfo;
  const gitTarget = gitWorkspace ? { workspaceId: gitWorkspace.id } : agent ? { agentId: agent.id, ...(agent.workspaceId ? { workspaceId: agent.workspaceId } : {}) } : null;
  const focusSideOpen = useStore((s) => s.focusSideOpen);
  const chatShown = useStore((s) => !chatHiddenInEditor(s));
  const sideRight = useLayoutConfig().sideBar === "right";
  const leftOn = editorLayout ? focusSideOpen : sidebarOpen;
  const rightOn = editorLayout ? chatShown : rightOpen;
  const [busy, setBusy] = useState<"sync" | "fetch" | null>(null);
  const panes = useStore((s) => s.panes);
  const activePaneId = useStore((s) => s.activePaneId);
  const agents = useStore((s) => s.agents);
  const activePane = panes.find((pane) => pane.id === activePaneId);
  const chatDraft = activePane?.kind === "draft" && activePane.workspaceId === null;
  const titleWorkspaceId = activePane ? chatPaneWorkspace(activePane, agents) : activeWorkspaceId;
  const projectId = chatProject(titleWorkspaceId, workspaces);
  const projectName = (workspaces.find((workspace) => workspace.id === projectId) ?? workspaces.find((workspace) => workspace.id === titleWorkspaceId))?.name ?? null;
  const splitProjects = useMemo(() => {
    const list: { paneId: string; id: string; name: string; active: boolean }[] = [];
    for (const pane of panes) {
      const wsId = chatPaneWorkspace(pane, agents);
      const top = chatProject(wsId, workspaces);
      const ws = top ? workspaces.find((w) => w.id === top) : undefined;
      if (!ws) continue;
      const seen = list.find((x) => x.id === ws.id);
      if (seen) seen.active ||= pane.id === activePaneId;
      else list.push({ paneId: pane.id, id: ws.id, name: ws.name, active: pane.id === activePaneId });
    }
    return list;
  }, [panes, activePaneId, agents, workspaces]);
  useEffect(() => {
    document.title = projectName ?? APP_TITLE;
    return () => { document.title = APP_TITLE; };
  }, [projectName]);

  const autoFetchId = centerView === "sessions" && !gitWorkspace && agent && !agent.feedbackId && agentInfo?.upstream ? agent.id : null;
  useEffect(() => {
    if (!autoFetchId) return;
    const tick = () => {
      if (document.visibilityState !== "visible" || Date.now() - (lastAutoFetch.get(autoFetchId) ?? 0) < AUTO_FETCH_MS) return;
      lastAutoFetch.set(autoFetchId, Date.now());
      void rpc
        .call("git.fetch", { agentId: autoFetchId })
        .then((next) => setState((s) => ({ gitInfo: { ...s.gitInfo, [autoFetchId]: next } })))
        .catch(() => undefined);
    };
    tick();
    const timer = setInterval(tick, AUTO_FETCH_MS);
    return () => clearInterval(timer);
  }, [autoFetchId]);

  const refreshTitleGit = async () => {
    if (gitWorkspace) return reloadWorkspaceInfo();
    if (!agent) return;
    const next = await rpc.call("git.info", { agentId: agent.id });
    setState((s) => ({ gitInfo: { ...s.gitInfo, [agent.id]: next } }));
    return next;
  };
  const sync = async () => {
    if (!gitTarget || !info || busy) return;
    if (!info.upstream) {
      hint(S.noTrackedRemote);
      return;
    }
    setBusy("sync");
    try {
      if ((await fetchFlow(gitTarget, { quiet: true })) !== "ok") return;
      const fresh = await refreshTitleGit();
      if (!fresh) return;
      if (fresh.behind === 0 && fresh.ahead === 0) {
        hint(S.nothingToSync);
        return;
      }
      if (fresh.ahead > 0 && !(await confirmAction(S.syncConfirmTitle(fresh.upstream ?? info.upstream, fresh.behind, fresh.ahead), S.syncConfirmButton(fresh.behind, fresh.ahead), S.syncConfirmDetail(fresh.branch, fresh.upstream ?? info.upstream, fresh.behind, fresh.ahead)))) return;
      if (fresh.behind > 0 && (await pullFlow(gitTarget, "ff", { quiet: true })) !== "ok") return;
      if (fresh.ahead > 0 && (await pushFlow(gitTarget, { quiet: true })) !== "ok") return;
      flash(S.syncDone);
    } catch (error) {
      const message = (error as Error).message;
      flash(message.startsWith("Unknown method") ? S.daemonOutdated : S.syncFailed(message.split("\n").slice(-2).join(" ")));
    } finally {
      if (gitWorkspace) await reloadWorkspaceInfo().catch(() => undefined);
      else if (agent) await refreshGit(agent.id);
      setBusy(null);
    }
  };
  const fetch = async () => {
    if (!gitTarget || busy) return;
    setBusy("fetch");
    try {
      if ((await fetchFlow(gitTarget)) !== "ok") return;
      await refreshTitleGit();
    } catch (error) {
      const message = (error as Error).message;
      flash(message.startsWith("Unknown method") ? S.daemonOutdated : S.fetchFailed(message.split("\n")[0]));
    } finally {
      setBusy(null);
    }
  };

  return (
    <header className="titlebar">
      <div className="titlebar-lead">
        <Button
          size="icon"
          variant={leftOn ? "ghost-on" : "ghost"}
          aria-label={S.sidebar}
          title={editorLayout ? (focusSideOpen ? S.hidePrimarySideKey(focusSideKey) : S.showPrimarySideKey(focusSideKey)) : sidebarOpen ? S.hideSidebarKey(sidebarKey) : S.showSidebarKey(sidebarKey)}
          onPointerEnter={(e) => e.pointerType === "mouse" && !getState().sidebarOpen && getState().layoutMode !== "editor" && sidebarPeek.enter("button")}
          onPointerLeave={() => sidebarPeek.leave("button")}
          onClick={() => runCommand("toggleSidebar")}
        >
          {sideRight ? <PanelRight /> : <PanelLeft />}
        </Button>
        {REMOTE_ID && <RemoteChip />}
      </div>
      <div className="titlebar-center flex items-center gap-1">
        <Button size="icon" aria-label={S.back} title={S.titleBackKey(backKeys)} onClick={goBackSession}>
          <Codicon name="arrow-left" />
        </Button>
        <Button size="icon" aria-label={S.forward} title={S.titleForwardKey(forwardKeys)} onClick={goForwardSession}>
          <Codicon name="arrow-right" />
        </Button>
        {!editorLayout && centerView === "sessions" && splitProjects.length > 1 ? (
          <div className="command-center command-center-split" role="group" aria-label={S.splitProjectsAria}>
            {splitProjects.map((p) => (
              <button key={p.id} type="button" className="cc-split-item" aria-pressed={p.active} title={S.focusProjectPaneTip(p.name)} onClick={() => focusPane(p.paneId)}>
                <FolderCompact size={14} />
                <span className="cc-folder">{p.name}</span>
              </button>
            ))}
          </div>
        ) : (
          <CommandCenter agent={agent} folder={projectName} branch={info?.branch ?? (gitWorkspace ? null : agent?.worktree?.branch ?? null)} inRepo={!!info?.repoRoot} viewName={centerView === "sessions" ? null : CENTER_VIEW_NAME[centerView]} />
        )}
        <TitleBranch agent={agent} workspace={gitWorkspace} info={info} sessionsView={centerView === "sessions"} />
        <Button size="icon" aria-label={S.openFile} title={S.openFileKey(openFileKey)} onClick={() => runCommand("quickOpen")}>
          <FileIcon />
        </Button>
        <Button size="icon" aria-label={S.openVSCodeWindow} title={S.openVSCodeWindowKey} disabled={agent ? agent.workspaceId === null : chatDraft || !activeWorkspaceId} onClick={() => void openInVSCode(agent?.id ?? null, activeWorkspaceId)}>
          <VSCodeIcon />
        </Button>
      </div>
      <div className="titlebar-right">
        <AttentionChip />
        {centerView === "sessions" && gitTarget && !agent?.feedbackId && info?.repoRoot && (
          <>
            {info.upstream && (
              <Button variant={info.ahead > 0 || info.behind > 0 ? "primary" : "secondary"} size="sm" aria-busy={busy === "sync"} title={`${info.branch} ↔ ${info.upstream}`} onClick={() => void sync()}>
                <span className={busy === "sync" ? "spin" : "inline-flex"}>
                  <Sync />
                </span>
                <span className="sync-label">{busy === "sync" ? S.syncing : S.syncChanges}</span> {info.ahead > 0 && <span>{info.ahead}↑</span>} {info.behind > 0 && <span>{info.behind}↓</span>}
              </Button>
            )}
            {info.hasRemote && (
              <Button size="icon" aria-label={S.fetch} title={S.fetchTitle} aria-busy={busy === "fetch"} onClick={() => void fetch()}>
                <span className={busy === "fetch" ? "spin" : "inline-flex"}>
                  <Refresh />
                </span>
              </Button>
            )}
          </>
        )}
        <BrowserButton />
        <FeedbackButton />
        <Button size="icon" variant={bottomOpen ? "ghost-on" : "ghost"} aria-label={S.bottomPanel} title={bottomOpen ? S.hidePanelKey(bottomKey) : S.bottomPanelKey(bottomKey)} onClick={() => runCommand("toggleBottom")}>
          <PanelBottom />
        </Button>
        {showRightToggle && (
          <Button size="icon" variant={rightOn ? "ghost-on" : "ghost"} aria-label={editorLayout ? S.chatDockAria : S.rightPanel} title={editorLayout ? (chatShown ? S.hideChatKey(focusChatKey) : S.showChatKey(focusChatKey)) : S.rightPanelKey(rightKey)} onClick={() => runCommand("toggleRight")}>
            {sideRight ? <PanelLeft /> : <PanelRight />}
          </Button>
        )}
        <Button size="icon" variant={editorLayout ? "ghost-on" : "ghost"} aria-label={S.layoutAria} aria-pressed={editorLayout} title={S.toggleLayoutKey(layoutKey)} onClick={() => runCommand("toggleLayout")}>
          <Codicon name="editor-layout" />
        </Button>
        <Button size="icon" variant="ghost" aria-label={S.customizeLayoutAria} title={S.customizeLayoutAria} onClick={() => runCommand("customizeLayout")}>
          <Codicon name="layout" />
        </Button>
      </div>
    </header>
  );
}

function useWorkspaceGitInfo(workspaceId: string | null) {
  const [snapshot, setSnapshot] = useState<{ workspaceId: string; info: GitInfo }>();
  const connected = useStore((s) => s.connected);
  const sequence = useRef(0);
  const refresh = useCallback(async () => {
    if (!workspaceId) return;
    const request = ++sequence.current;
    const info = await rpc.call("git.info", { workspaceId });
    if (request === sequence.current && editorGitWorkspaceOf(getState()) === workspaceId) setSnapshot({ workspaceId, info });
    return info;
  }, [workspaceId]);
  useEffect(() => {
    if (!workspaceId || !connected) return;
    const update = () => void refresh().catch(() => undefined);
    update();
    const unsubscribe = onWorkspaceChanged(workspaceId, update);
    return () => {
      sequence.current++;
      unsubscribe();
    };
  }, [workspaceId, connected, refresh]);
  return [snapshot?.workspaceId === workspaceId ? snapshot.info : undefined, refresh] as const;
}

const CENTER_VIEW_NAME = { board: S.board, inbox: S.inbox, improvements: S.improvements, pr: S.pullRequestChip, notion: N.viewName, skills: S.skills, automations: S.automations, mate: S.assistant.name } as const;

function CommandCenter({ agent, folder, branch, inRepo, viewName }: { agent: Agent | null; folder: string | null; branch: string | null; inRepo: boolean; viewName: string | null }) {
  const name = folder ?? S.noWorkspace;
  if (viewName) {
    return (
      <button type="button" className="command-center" title={S.showSessionsViewTip(viewName, folder)} onClick={() => setState({ overlay: { kind: "sessions" } })}>
        {folder && <span className="cc-folder">{folder}</span>}
        {folder && <span className="cc-dot" />}
        <span className="cc-view">{viewName}</span>
      </button>
    );
  }
  return (
    <button type="button" className="command-center" title={S.showSessionsTip(agent ? null : S.newSessionChip, name, agent ? branch : null)} onClick={() => setState({ overlay: { kind: "sessions" } })}>
      {!agent && <span className="cc-prefix">{S.newSessionChip}</span>}
      {!agent && <span className="cc-dot" />}
      {agent?.forkedFrom && <span className="cc-title">{agent.title}</span>}
      {agent?.forkedFrom && <span className="cc-dot" />}
      {agent?.worktree || (agent && inRepo) ? <WorktreeCompact size={14} /> : <FolderCompact size={14} />}
      <span className="cc-folder">{name}</span>
    </button>
  );
}


function BrowserButton() {
  const mode = useStore((s) => s.settings?.browserShowInTitleBar ?? "whenOpen");
  const allTabs = useStore((s) => s.tabs);
  const tabs = useMemo(() => allTabs.filter((t): t is BrowserTab => t.kind === "browser"), [allTabs]);
  const activeKey = useStore((s) => s.activeTabKey);
  if (mode === false || (mode === "whenOpen" && tabs.length === 0)) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="icon" variant={tabs.some((t) => t.key === activeKey) ? "ghost-on" : "ghost"} aria-label={S.titleBarBrowser} title={S.titleBarBrowser}>
          <Codicon name="globe" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => openBrowser()}>{S.titleBarBrowserNew}</DropdownMenuItem>
        {tabs.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled>{S.titleBarBrowserTabs}</DropdownMenuItem>
            {tabs.map((tab) => (
              <DropdownMenuItem key={tab.key} onSelect={() => setState({ activeTabKey: tab.key, rightOpen: true })}>
                {tab.title || tab.url || S.browserTabTitle}
              </DropdownMenuItem>
            ))}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function RemoteChip() {
  const host = useRemoteHost();
  const connected = useStore((state) => state.connected);
  if (!host) return null;
  return (
    <span className="remote-chip" data-connected={connected} title={S.remoteWindowTip(host.name)}>
      <Codicon name="remote" />
      <span className="remote-chip-name">{host.name}</span>
    </span>
  );
}
