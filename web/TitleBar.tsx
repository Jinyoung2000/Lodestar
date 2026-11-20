import { useEffect, useMemo, useState } from "react";
import type { Agent } from "../shared/protocol";
import { AttentionChip } from "./AttentionChip";
import { TitleBranch } from "./TitleBranch";
import { sessionPanelToggleable } from "./centerPanels";
import { FeedbackButton } from "./Feedback";
import { Codicon, FileIcon, FolderCompact, PanelBottom, PanelLeft, PanelRight, Refresh, Sync, VSCodeIcon, WorktreeCompact } from "./icons";
import { rpc } from "./rpc";
import { activeAgentOf } from "./activeAgentOf";
import { chatHiddenInEditor } from "./focusLayout";
import { useLayoutConfig } from "./layoutConfigStore";
import { runCommand } from "./shortcuts";
import { sidebarPeek } from "./peekController";
import { flash, getState, goBackSession, goForwardSession, openBrowser, openInVSCode, refreshGit, setState, topWorkspaceId, useStore, type BrowserTab } from "./store";
import { confirmAction } from "./ConfirmDialog";
import { fetchFlow, pullFlow, pushFlow } from "./gitSync";
import { S } from "./strings";
import { N } from "./notionStrings"; // NOTION2
import { Button } from "./ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "./ui/dropdown-menu";
import { hint } from "./hint";
import { visibleCenterView } from "./screenVisibility";
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
  const info = useStore((s) => (agent ? s.gitInfo[agent.id] : undefined));
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const rightOpen = useStore((s) => s.rightOpen);
  const centerView = useStore((s) => visibleCenterView(s.centerView, s.settings));
  const showRightToggle = sessionPanelToggleable(centerView);
  const bottomOpen = useStore((s) => s.bottomOpen);
  const editorLayout = useStore((s) => s.layoutMode === "editor");
  // FOCUS: Editor 중심에서 왼쪽 단추는 왼쪽 Primary Side Bar, 오른쪽 단추는 오른쪽 대화(패널이나 떠 있는 창)를 여닫는다. 앱 사이드바는 이 배치에 없다.
  const focusSideOpen = useStore((s) => s.focusSideOpen);
  const chatShown = useStore((s) => !chatHiddenInEditor(s));
  const sideRight = useLayoutConfig().sideBar === "right";
  const leftOn = editorLayout ? focusSideOpen : sidebarOpen;
  const rightOn = editorLayout ? chatShown : rightOpen;
  const [busy, setBusy] = useState<"sync" | "fetch" | null>(null);
  // 폴더 없는 새 세션 화면(퀵 챗)이 활성 칸이면 폴더가 없다
  const chatDraft = useStore((s) => s.panes.some((p) => p.id === s.activePaneId && p.kind === "draft" && p.workspaceId === null));
  const project = chatDraft ? undefined : workspaces.find((w) => w.id === (agent ? topWorkspaceId(agent.workspaceId) : activeWorkspaceId));
  // 창 이름(Mission Control, 창 메뉴, ⌘`)을 지금 칸의 프로젝트 폴더 이름으로. Electron 창 제목은 페이지 title 을 따른다. 폴더가 없으면 앱 이름(index.html 의 title).
  const projectName = project?.name ?? null;
  useEffect(() => {
    document.title = projectName ?? APP_TITLE;
  }, [projectName]);

  const autoFetchId = centerView === "sessions" && agent && !agent.feedbackId && info?.upstream ? agent.id : null;
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

  // 동기화: 먼저 fetch 로 원격 상태를 읽고(낡은 숫자로 push 확인만 묻다 거절되지 않게), behind 가 있으면 pull, ahead 가 있으면 push 한다. push 가 낄 때만 확인을 거치고, 강제 옵션은 없다.
  // 갈라졌으면 이유를 말하고 Pull (Merge) 와 Pull (Rebase) 를 고르게 한다(web/gitSync.ts). 충돌이 나면 push 하지 않고 멈춘다.
  const sync = async () => {
    if (!agent || !info || busy) return;
    if (!info.upstream) {
      hint(S.noTrackedRemote);
      return;
    }
    const target = { agentId: agent.id, ...(agent.workspaceId ? { workspaceId: agent.workspaceId } : {}) };
    setBusy("sync");
    try {
      if ((await fetchFlow(target, { quiet: true })) !== "ok") return;
      const fresh = await rpc.call("git.info", { agentId: agent.id });
      setState((s) => ({ gitInfo: { ...s.gitInfo, [agent.id]: fresh } }));
      if (fresh.behind === 0 && fresh.ahead === 0) {
        hint(S.nothingToSync);
        return;
      }
      // 가져오기만 할 때(fast-forward)는 묻지 않는다(사용자: 다이얼로그가 거슬림). 원격으로 보내는 push 가 끼면 확인을 거친다.
      if (fresh.ahead > 0 && !(await confirmAction(S.syncConfirmTitle(fresh.upstream ?? info.upstream, fresh.behind, fresh.ahead), S.syncConfirmButton(fresh.behind, fresh.ahead), S.syncConfirmDetail(fresh.branch, fresh.upstream ?? info.upstream, fresh.behind, fresh.ahead)))) return;
      if (fresh.behind > 0 && (await pullFlow(target, "ff", { quiet: true })) !== "ok") return;
      if (fresh.ahead > 0 && (await pushFlow(target, { quiet: true })) !== "ok") return;
      flash(S.syncDone);
    } catch (error) {
      const message = (error as Error).message;
      flash(message.startsWith("Unknown method") ? S.daemonOutdated : S.syncFailed(message.split("\n").slice(-2).join(" ")));
    } finally {
      await refreshGit(agent.id);
      setBusy(null);
    }
  };
  const fetch = async () => {
    if (!agent || busy) return;
    setBusy("fetch");
    try {
      // 실패는 gitSync 가 이유와 다음 행동 단추와 함께 알린다
      if ((await fetchFlow({ agentId: agent.id, ...(agent.workspaceId ? { workspaceId: agent.workspaceId } : {}) })) !== "ok") return;
      const next = await rpc.call("git.info", { agentId: agent.id });
      setState((s) => ({ gitInfo: { ...s.gitInfo, [agent.id]: next } }));
    } catch (error) {
      const message = (error as Error).message;
      flash(message.startsWith("Unknown method") ? S.daemonOutdated : S.fetchFailed(message.split("\n")[0]));
    } finally {
      setBusy(null);
    }
  };

  return (
    <header className="titlebar">
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
      <div className="titlebar-center flex items-center gap-1">
        <Button size="icon" aria-label={S.back} title={S.titleBackKey(backKeys)} onClick={goBackSession}>
          <Codicon name="arrow-left" />
        </Button>
        <Button size="icon" aria-label={S.forward} title={S.titleForwardKey(forwardKeys)} onClick={goForwardSession}>
          <Codicon name="arrow-right" />
        </Button>
        <CommandCenter agent={agent} folder={project?.name ?? null} branch={info?.branch ?? agent?.worktree?.branch ?? null} inRepo={!!info?.repoRoot} viewName={centerView === "sessions" ? null : CENTER_VIEW_NAME[centerView]} />
        <TitleBranch agent={agent} info={info} sessionsView={centerView === "sessions"} />
        <Button size="icon" aria-label={S.openFile} title={S.openFileKey(openFileKey)} onClick={() => runCommand("quickOpen")}>
          <FileIcon />
        </Button>
        <Button size="icon" aria-label={S.openVSCodeWindow} title={S.openVSCodeWindowKey} disabled={agent ? agent.workspaceId === null : chatDraft || !activeWorkspaceId} onClick={() => void openInVSCode(agent?.id ?? null, activeWorkspaceId)}>
          <VSCodeIcon />
        </Button>
      </div>
      <div className="titlebar-right">
        <AttentionChip />
        {centerView === "sessions" && agent && !agent.feedbackId && info?.repoRoot && (
          <>
            {/* Button README: 화면에 하나뿐인 주요 버튼(Sync). 보낼 것과 받을 것이 있을 때만 주요 버튼이고, 없으면 보조 버튼이다(dogfood 20). 원격 추적 브랜치가 없으면 동기화할 게 없어 Sync 는 없다. 브랜치 이름과 전환은 Command Center 옆 TitleBranch 에 있다. */}
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

// 세션 화면이 아닌 가운데 화면(Board, Mentions, Improvements, PR)의 칩 이름. 이전 세션의 제목과 브랜치를 그대로 두면 그 화면과 상관있는 것처럼 보인다(dogfood 26).
const CENTER_VIEW_NAME = { board: S.board, inbox: S.inbox, improvements: S.improvements, pr: S.pullRequestChip, notion: N.viewName, notes: S.notes, skills: S.skills } as const;

// 가운데 칩. 새 세션 화면은 "New Session" 접두 + 폴더, 세션은 폴더 아이콘(worktree 면 worktree 아이콘) + 폴더(브랜치는 옆의 TitleBranch).
// 갈래 세션은 앞에 세션 제목이 붙는다. 폭이 좁으면 제목이 먼저 말줄임표가 되고 폴더는 끝까지 남는다. 세션 화면이 아니면 화면 이름만 보인다.
function CommandCenter({ agent, folder, branch, inRepo, viewName }: { agent: Agent | null; folder: string | null; branch: string | null; inRepo: boolean; viewName: string | null }) {
  const name = folder ?? S.noWorkspace;
  if (viewName) {
    return (
      <button type="button" className="command-center" title={S.showSessionsViewTip(viewName)} onClick={() => setState({ overlay: { kind: "sessions" } })}>
        <span className="cc-prefix">{viewName}</span>
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


// 제목줄의 Browser 단추(설정 Show In Title Bar: true 는 늘, false 는 안 보임, whenOpen 은 Browser 탭이 열려 있을 때만). 누르면 새 탭을 열거나 열린 탭으로 간다.
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
