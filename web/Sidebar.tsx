import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { canHandOff, startHandoff } from "./handoffActions";
import { createWorktreePr, mergeWorktree } from "./worktreeActions";
import { harnessOf, type Agent, type TimelineItem, type Workspace } from "../shared/protocol";
import { needsReview, QUESTION_TOOL } from "../shared/interactive";
import { displayPath } from "./displayPath";
import { improvementsBusy, needsInputCount, notAppliedCount } from "./improvementRows";
import { releaseToNotify } from "../shared/release";
import { GroupMenu, GroupOrderMenu } from "./GroupMenu";
import { ImportedMark } from "./ImportedBadges";
import { PullRequestsSection } from "./PullRequestsSection";
import { SectionMoveItems } from "./SectionMoveItems";
import { beginSectionDrag, useSectionDrag, useSidebarOrder, type SidebarSection } from "./sidebarOrder";
import { BoardIcon, Chat, Check, ChevronDown, ChevronRight, Close, Codicon, CircleFilled, CircleSmallFilled, CommentDiscussion, DotSpinner, Filter, Folder, FolderCompact, More, NoteIcon, Pin, Plus, ProviderIcon, Search, TreeItemExpanded, WorktreeCompact } from "./icons";
import { RenameInput } from "./RenameInput";
import { useCompactView } from "./compactView";
import { useMissingFolders } from "./missingFolders";
import { moveChatToFolder } from "./sessionFolders";
import { worktreeMenuState } from "./worktreeMenu";
import { rpc } from "./rpc";
import { WorkspacePathInput } from "./WorkspacePathInput";
import { canPickFolder, newProjectInNewSession, openFolderInNewSession } from "./folderOpen";
import { allowPermission, copySessionLink, deleteSession, ensureRowChanges, markRead, setDone, setPinned } from "./sessionActions";
import { FALLBACK_ORDERING, isDefaultView, relativeTime, sidebarLayout, sumChanges, type FolderOrder, type Ordering, type SessionGroup, type SessionRow as Row, type ShowRange } from "./sessionList";
import { expandGroup, resetSessionView, setCollapsedGroups, setSessionView, startRename, toggleGroupCollapsed, toggleGroupExpanded, toggleParentCollapsed, useSessionList } from "./sessionListState";
import { beginSessionDrag } from "./sessionDrag";
import { publishSessionLists, stepFolder, stepSession } from "./sessionReorder";
import { runCommand } from "./shortcuts";
import { boardShown, slackShown } from "./screenVisibility";
import { openPrBesideByUrl } from "./prStore";
import { addTerminal, ensureTimeline, flash, refreshPrs, isTopWorkspace, openAgent, openCard, setState, startDraft, startQuickChat, toggleBoard, toggleImprovements, toggleInbox, toggleNotes,topWorkspaceId, useStore } from "./store";
import { S } from "./strings";
import { useEditPreview } from "./useEditPreview";
import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { useCommandKey, useCommandKeycaps } from "./commandKeys";

type RowMenu = { id: string; at?: { x: number; y: number } };

export function Sidebar({ width }: { width: number | null }) {
  const inboxUnread = useStore((s) => s.inbox?.unread ?? 0);
  const showBoard = useStore((s) => boardShown(s.settings));
  const showSlack = useStore((s) => slackShown(s.settings));
  const reviewUnread = useStore((s) => !!s.review?.unreadDate);
  const workspaces = useStore((s) => s.workspaces);
  const agents = useStore((s) => s.agents);
  const orders = useStore((s) => s.sessionOrders);
  const defaultOrdering = useStore((s) => s.defaults?.sessionSort.value ?? FALLBACK_ORDERING);
  const panes = useStore((s) => s.panes);
  const activePaneId = useStore((s) => s.activePaneId);
  const centerView = useStore((s) => s.centerView);
  const view = useSessionList((s) => s.view);
  const expanded = useSessionList((s) => s.expanded);
  const collapsedGroups = useSessionList((s) => s.collapsedGroups);
  const collapsedParents = useSessionList((s) => s.collapsedParents);
  const sectionOrder = useSidebarOrder();
  const sectionDrag = useSectionDrag();
  const sectionProps = (id: SidebarSection) => ({
    "data-section": id,
    "data-dragging": sectionDrag?.id === id || undefined,
    "data-drop": sectionDrag && sectionDrag.over === id && sectionDrag.id !== id ? sectionDrag.edge : undefined,
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => beginSectionDrag(e, id),
  });
  const [addOpen, setAddOpen] = useState(false);
  const [menu, setMenu] = useState<RowMenu | null>(null);
  const now = useMinuteClock();
  const missingFolders = useMissingFolders();
  const active = panes.find((p) => p.id === activePaneId);
  const activeAgentId = active?.kind === "agent" ? active.agentId : null;

  const top = workspaces.filter(isTopWorkspace);
  const { groups, scopes } = sidebarLayout({
    agents,
    workspaces: top,
    topWorkspaceId,
    view,
    defaultOrdering,
    now,
    collapsedParents: new Set(collapsedParents),
    expandedGroups: new Set(expanded),
    collapsedGroups: new Set(collapsedGroups),
    orders,
  });
  useEffect(() => publishSessionLists(scopes));
  const chatCount = groups.find((g) => g.kind === "chats")?.count ?? 0;
  const previousChatCount = useRef(0);
  useEffect(() => {
    if (chatCount > 0 && previousChatCount.current === 0) expandGroup("chats");
    previousChatCount.current = chatCount;
  }, [chatCount]);
  const allCollapsed = groups.length > 0 && groups.every((g) => collapsedGroups.includes(g.id));
  const boardKey = useCommandKey("board");
  const inboxKey = useCommandKey("inbox");
  const notesKey = useCommandKey("notes");

  return (
    <nav className="sidebar" aria-label={S.sessions} style={width == null ? undefined : { width }}>
      <div className="sidebar-top">
        <button type="button" className="side-item" onClick={() => runCommand("newSession")}>
          <Plus /> {S.newSession}
          <SideKeycaps command="newSession" />
        </button>
        {showBoard && (
          <button type="button" className="side-item" data-active={centerView === "board" || undefined} aria-pressed={centerView === "board"} title={S.boardKey(boardKey)} onClick={() => toggleBoard()}>
            <BoardIcon /> {S.board}
            {reviewUnread && <span className="review-dot" role="img" aria-label={S.reviewUnreadDot} />}
            <SideKeycaps command="board" />
          </button>
        )}
        {showSlack && (
          <button type="button" className="side-item" data-active={centerView === "inbox" || undefined} aria-pressed={centerView === "inbox"} title={S.inboxKey(inboxKey)} onClick={() => toggleInbox()}>
            <Chat /> {S.inbox}
            {inboxUnread > 0 && <span className="inbox-badge" aria-label={`${inboxUnread} unread`}>{inboxUnread}</span>}
            <SideKeycaps command="inbox" />
          </button>
        )}
        <button type="button" className="side-item" data-active={centerView === "notes" || undefined} aria-pressed={centerView === "notes"} title={S.notesKey(notesKey)} onClick={() => toggleNotes()}>
          <NoteIcon /> {S.notes}
          <SideKeycaps command="notes" />
        </button>
        <button type="button" className="side-item" onClick={() => (canPickFolder() ? void openFolderInNewSession() : setAddOpen((v) => !v))}>
          <Plus /> {S.addWorkspace}
          <SideKeycaps command="openFolder" />
        </button>
        <button type="button" className="side-item" onClick={() => void newProjectInNewSession()}>
          <Codicon name="new-folder" /> {S.newProjectSide}
        </button>
        {addOpen && <WorkspacePathInput className="workspace-input" onAdded={() => setAddOpen(false)} onCancel={() => setAddOpen(false)} />}
      </div>
      <div className="sidebar-sections">
        <div className="sidebar-block" style={{ order: sectionOrder.indexOf("pullRequests") }} {...sectionProps("pullRequests")}>
          <PullRequestsSection />
        </div>
        <div className="sidebar-block" data-grow="" style={{ order: sectionOrder.indexOf("sessions") }} {...sectionProps("sessions")}>
          <SessionsHeader customView={!isDefaultView(view, defaultOrdering)} ordering={view.ordering ?? defaultOrdering} allCollapsed={allCollapsed} onToggleAll={() => setCollapsedGroups(allCollapsed ? [] : groups.map((g) => g.id))} />
          <div className="sidebar-list">
        {groups.map((group) => {
          const isCollapsed = collapsedGroups.includes(group.id);
          return (
            <div key={group.id} className="session-group" data-workspace-id={group.workspaceId ?? undefined} data-collapsed={isCollapsed || undefined} data-missing={(group.workspaceId !== null && missingFolders.has(group.workspaceId)) || undefined}>
              <GroupHead
                group={group}
                missing={group.workspaceId !== null && missingFolders.has(group.workspaceId)}
                workspace={workspaces.find((w) => w.id === group.workspaceId)}
                collapsed={isCollapsed}
                onToggle={() => toggleGroupCollapsed(group.id)}
                onNewSession={(e) => (group.kind === "chats" ? startQuickChat(e.altKey ? "new" : "active") : group.workspaceId && startDraft(group.workspaceId, e.altKey ? "new" : "active"))}
              />
              {!isCollapsed && group.kind === "chats" && group.rows.length === 0 && <div className="session-group-empty">{S.noChats}</div>}
              {!isCollapsed && group.kind === "workspace" && group.rows.length === 0 && <div className="session-group-empty">{S.noSessionsInFolder}</div>}
              {!isCollapsed &&
                group.rows.map((row) => (
                  <SessionRow
                    key={row.agent.id}
                    row={row}
                    active={row.agent.id === activeAgentId}
                    menu={menu?.id === row.agent.id ? menu : null}
                    onMenu={setMenu}
                    childrenCollapsed={collapsedParents.includes(row.agent.id)}
                    onToggleChildren={() => toggleParentCollapsed(row.agent.id)}
                    showProject={group.kind === "time" || group.kind === "pinned" || group.kind === "done"}
                  />
                ))}
              {!isCollapsed && group.foldable && (
                <button type="button" className="session-show-more" onClick={() => toggleGroupExpanded(group.id)}>
                  {group.folded ? S.showMore(group.hidden) : S.showLess}
                </button>
              )}
            </div>
          );
        })}
          </div>
        </div>
      </div>
      <ImprovementsEntry />
    </nav>
  );
}

function ReleaseNotice() {
  const on = useStore((s) => s.settings?.notifyNewVersion === true);
  const release = useStore((s) => releaseToNotify(s.release));
  if (!on || !release) return null;
  return (
    <div className="release-notice" data-version={release.version}>
      <button type="button" className="side-item release-notice-open" title={S.releaseNotesTip} onClick={() => window.open(release.url, "_blank", "noopener")}>
        <Codicon name="arrow-circle-up" />
        <span className="release-notice-name">{S.releaseNewVersion(release.version)}</span>
        <span className="release-notice-link">{S.releaseNotes}</span>
      </button>
      <Button size="icon" aria-label={S.releaseDismiss} onClick={() => void rpc.call("release.dismiss", { version: release.version }).then((next) => setState({ release: next }), () => undefined)}>
        <Close size={12} />
      </Button>
    </div>
  );
}

function ImprovementsEntry() {
  const open = useStore((s) => s.centerView === "improvements");
  const count = useStore((s) => notAppliedCount(s.feedbacks, s.agents));
  const waiting = useStore((s) => needsInputCount(s.feedbacks, s.agents));
  const busy = useStore((s) => improvementsBusy(s.feedbacks, s.agents));
  return (
    <div className="sidebar-foot">
      <ReleaseNotice />
      <button type="button" className="side-item" data-active={open || undefined} data-busy={busy || undefined} aria-pressed={open} title={busy ? S.improvementsBusy : S.improvementsKey} onClick={() => toggleImprovements()}>
        {busy ? <DotSpinner state="running" /> : <Codicon name="sparkle" />} {S.improvements}
        {waiting > 0 && (
          <span className="side-waiting" aria-label={S.feedbackWaitingTip(waiting)} title={S.feedbackWaitingTip(waiting)} data-needs-input-count={waiting}>
            <span className="side-waiting-dot" />
            <span>{waiting}</span>
            <span className="side-waiting-word">{S.feedbackWaitingWord}</span>
          </span>
        )}
        {count > 0 && (
          <span className="side-count" aria-label={S.feedbackNotAppliedCount(count)} title={S.feedbackNotAppliedCount(count)} data-not-applied-count={count}>
            <Codicon name="error" size={12} />
            <span>{count}</span>
            <span className="side-count-word">{S.feedbackNotAppliedWord}</span>
          </span>
        )}
      </button>
    </div>
  );
}

function useMinuteClock() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

function SessionsHeader({ customView, ordering, allCollapsed, onToggleAll }: { customView: boolean; ordering: Ordering; allCollapsed: boolean; onToggleAll: () => void }) {
  const view = useSessionList((s) => s.view);
  const [compact, setCompact] = useCompactView();
  const searchKey = useCommandKey("search");
  return (
    <div className="sessions-header">
      <span className="sessions-title">{S.sessions}</span>
      <span className="spacer" />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="icon" variant={customView ? "ghost-on" : "ghost"} aria-label={S.filter} aria-pressed={customView} title={S.sessionsFilterMenu}>
            <Filter />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="session-menu">
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <span className="session-menu-check" />
              {S.ordering}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="session-menu">
              <DropdownMenuRadioGroup value={ordering} onValueChange={(value) => setSessionView({ ordering: value === "updated" ? "updated" : "created" })}>
                <DropdownMenuRadioItem value="created">{S.orderCreated}</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="updated">{S.orderUpdated}</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <span className="session-menu-check" />
              {S.grouping}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="session-menu">
              <DropdownMenuRadioGroup value={view.grouping} onValueChange={(value) => setSessionView({ grouping: value === "time" ? "time" : "workspace" })}>
                <DropdownMenuRadioItem value="time">{S.groupTime}</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="workspace">{S.groupWorkspace}</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          {view.grouping === "workspace" && (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <span className="session-menu-check" />
                {S.folderOrder}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="session-menu">
                <DropdownMenuRadioGroup value={view.folderOrder} onValueChange={(value) => setSessionView({ folderOrder: folderOrderOf(value) })}>
                  <DropdownMenuRadioItem value="recent">{S.folderOrderRecent}</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="name">{S.folderOrderName}</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="manual">{S.folderOrderManual}</DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )}
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <span className="session-menu-check" />
              {S.show}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="session-menu">
              <DropdownMenuRadioGroup value={view.show} onValueChange={(value) => setSessionView({ show: showRangeOf(value) })}>
                <DropdownMenuRadioItem value="recent">{S.showRecent}</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="all">{S.showAll}</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSeparator />
          <DropdownMenuCheckboxItem checked={view.showDone} onCheckedChange={(checked) => setSessionView({ showDone: checked === true })}>
            {S.showDone}
          </DropdownMenuCheckboxItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem className="session-menu-reset" onSelect={() => resetSessionView()}>
            <span className="session-menu-check" />
            {S.resetFilters}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Button size="icon" aria-label={S.sessionsHistory} title={S.sessionsHistory} onClick={() => setState({ overlay: { kind: "search", tab: "sessions" } })}>
        <Codicon name="history" />
      </Button>
      <Button size="icon" aria-label={S.searchAll} title={S.searchAllKey(searchKey)} onClick={() => setState({ overlay: { kind: "search", tab: "all" } })}>
        <Search />
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="icon" aria-label={S.sessionsMore} title={S.sessionsMore}>
            <More />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="session-menu" data-menu="more">
          <DropdownMenuCheckboxItem checked={compact} onCheckedChange={(checked) => setCompact(checked === true)}>
            {S.compactView}
          </DropdownMenuCheckboxItem>
          <DropdownMenuItem onSelect={() => onToggleAll()}>
            <span className="session-menu-check" />
            {allCollapsed ? S.expandAllGroups : S.collapseAllGroups}
          </DropdownMenuItem>
          <SectionMoveItems id="sessions" />
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function showRangeOf(value: string): ShowRange {
  return value === "all" ? "all" : "recent";
}

function folderOrderOf(value: string): FolderOrder {
  return value === "name" || value === "manual" ? value : "recent";
}

function GroupHead({ group, workspace, missing, collapsed, onToggle, onNewSession }: { group: SessionGroup; workspace: Workspace | undefined; missing: boolean; collapsed: boolean; onToggle: () => void; onNewSession: (e: MouseEvent) => void }) {
  const [menu, setMenu] = useState<{ at?: { x: number; y: number } } | null>(null);
  const menuWorkspace = group.kind === "workspace" ? workspace : undefined;
  const customOrder = useStore((s) => group.resetScopes.some((scope) => (s.sessionOrders[scope]?.length ?? 0) > 0));
  const hasMenu = !!menuWorkspace || customOrder;
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if ((e.key === "ArrowUp" || e.key === "ArrowDown") && e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey && group.kind === "workspace" && group.workspaceId) {
      e.preventDefault();
      const id = group.workspaceId;
      if (stepFolder(id, e.key === "ArrowUp" ? -1 : 1, group.name)) requestAnimationFrame(() => document.querySelector<HTMLElement>(`.session-group[data-workspace-id="${CSS.escape(id)}"] .session-group-main`)?.focus());
      return;
    }
    const isMenuKey = e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey && !e.metaKey && !e.altKey && !e.ctrlKey);
    if (!hasMenu || !isMenuKey) return;
    e.preventDefault();
    const box = e.currentTarget.getBoundingClientRect();
    setMenu({ at: { x: box.left + box.height, y: box.bottom } });
  };
  return (
    <div
      className="session-group-head"
      data-kind={group.kind}
      data-collapsed={collapsed || undefined}
      data-has-menu={hasMenu ? "" : undefined}
      data-menu={menu ? "" : undefined}
      title={missing && workspace ? S.folderMissingTip(workspace.dir) : workspace?.dir}
      onContextMenu={(e) => {
        if (!hasMenu) return;
        e.preventDefault();
        setMenu({ at: { x: e.clientX, y: e.clientY } });
      }}
    >
      <button type="button" className="session-group-main" aria-expanded={!collapsed} aria-label={S.groupAria(group.name, group.count)} onClick={onToggle} onKeyDown={onKeyDown} onPointerDown={group.kind === "workspace" && group.workspaceId ? (e) => beginSessionDrag(e, group.workspaceId!, group.name, null, "folder") : undefined}>
        <span className="session-group-icon">{missing ? <Codicon name="warning" /> : <GroupIcon kind={group.kind} />}</span>
        <span className="session-group-name">{group.name}</span>
        <span className="session-group-chevron">{collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}</span>
      </button>
      {hasMenu && (
        <DropdownMenu open={!!menu} onOpenChange={(open) => setMenu(open ? {} : null)}>
          <DropdownMenuTrigger asChild>
            {menu?.at ? (
              <button type="button" className="menu-anchor" style={{ left: menu.at.x, top: menu.at.y }} tabIndex={-1} aria-hidden="true" />
            ) : (
              <Button size="icon" className="session-group-more" aria-label={S.folderMenu(group.name)} title={S.folderMenu(group.name)}>
                <More />
              </Button>
            )}
          </DropdownMenuTrigger>
          {menuWorkspace ? <GroupMenu workspace={menuWorkspace} groupId={group.id} resetScopes={group.resetScopes} collapsed={collapsed} missing={missing} /> : <GroupOrderMenu resetScopes={group.resetScopes} />}
        </DropdownMenu>
      )}
      {(group.kind === "workspace" || group.kind === "chats") && (
        <Button size="icon" className="session-group-new" disabled={missing} aria-label={S.newSessionIn(group.name)} title={group.kind === "chats" ? S.newChatInTitle : S.newSessionInTitle} onClick={onNewSession}>
          <Plus />
        </Button>
      )}
    </div>
  );
}

function GroupIcon({ kind }: { kind: SessionGroup["kind"] }) {
  if (kind === "pinned") return <Codicon name="pinned" />;
  if (kind === "chats") return <CommentDiscussion />;
  if (kind === "time") return <Codicon name="history" />;
  if (kind === "done") return <Codicon name="archive" />;
  return <Folder />;
}

type RowProps = {
  row: Row;
  active: boolean;
  menu: RowMenu | null;
  onMenu: (menu: RowMenu | null) => void;
  childrenCollapsed: boolean;
  onToggleChildren: () => void;
  showProject: boolean;
};

function SessionRow({ row, active, menu, onMenu, childrenCollapsed, onToggleChildren, showProject }: RowProps) {
  const { agent, depth, hasChildren } = row;
  const renaming = useSessionList((s) => s.renaming === agent.id);
  const changes = useStore((s) => s.sessionChanges[agent.id]);
  const pr = useStore((s) => s.prs[agent.id]?.prs[0]);
  const workspace = useStore((s) => s.workspaces.find((w) => w.id === topWorkspaceId(agent.workspaceId)));
  const gitBranch = useStore((s) => s.gitInfo[agent.id]?.branch ?? null);
  const inRepo = useStore((s) => !!s.gitInfo[agent.id]?.repoRoot);
  const isChild = depth > 0;
  const folderCount = agent.workspaceId ? 1 + (agent.extraWorkspaceIds?.length ?? 0) : 0;
  const oneLine = agent.workspaceId === null && agent.status === "idle" && !agent.imported;
  const sum = sumChanges(changes?.files);
  const time = relativeTime(agent.updatedAt, Date.now());
  const project = showProject && !isChild ? (workspace?.name ?? null) : null;
  const branch = agent.worktree?.branch ?? gitBranch;
  const tooltip = [
    `${agent.title} (${harnessOf(agent) === "claude" ? S.tipHarness : S.harnessNames[harnessOf(agent)]})`,
    workspace && `${S.tipWorkspace}: ${displayPath(workspace.dir)}`,
    agent.worktree && `${S.tipWorktree}: ${displayPath(agent.worktree.root)}`,
    branch && `${S.tipBranch}: ${branch}`,
    pr && S.tipPullRequest(pr.number, pr.title),
  ]
    .filter(Boolean)
    .join("\n");

  useEffect(() => {
    if (!agent.done) ensureRowChanges(agent.id);
  }, [agent.id, agent.done]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (renaming) return;
    if (e.key === "F2" && !e.metaKey && !e.altKey && !e.ctrlKey && !e.shiftKey) {
      e.preventDefault();
      startRename(agent.id);
    } else if (e.key === "Backspace" && e.metaKey && !e.altKey && !e.ctrlKey && !e.shiftKey) {
      e.preventDefault();
      setDone(agent, !agent.done);
    } else if ((e.key === "ArrowUp" || e.key === "ArrowDown") && e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey && row.scope) {
      e.preventDefault();
      if (stepSession(row.scope, agent.id, e.key === "ArrowUp" ? -1 : 1, agent.title)) requestAnimationFrame(() => document.querySelector<HTMLElement>(`.session-row[data-id="${CSS.escape(agent.id)}"] .session-item`)?.focus());
    }
  };
  const Main = renaming ? "div" : "button";

  return (
    <div
      className="session-row"
      data-id={agent.id}
      data-scope={row.scope ?? undefined}
      data-depth={depth}
      data-active={active || undefined}
      data-unread={agent.unread || undefined}
      data-pinned={agent.pinned || undefined}
      data-one-line={oneLine || undefined}
      data-menu={menu ? "" : undefined}
      data-state={agent.status}
      data-approval={agent.status === "waiting" || undefined}
    >
      {hasChildren && (
        <button type="button" className="session-twistie" aria-expanded={!childrenCollapsed} aria-label={S.childToggle(agent.title, !childrenCollapsed)} onClick={onToggleChildren}>
          {childrenCollapsed ? <ChevronRight size={12} /> : <TreeItemExpanded size={12} />}
        </button>
      )}
      <Main
        type={renaming ? undefined : "button"}
        className="session-item"
        title={renaming ? undefined : tooltip}
        aria-current={active || undefined}
        onClick={renaming ? undefined : (e: MouseEvent) => openAgent(agent.id, e.altKey ? "new" : "active")}
        onDoubleClick={renaming ? undefined : () => startRename(agent.id)}
        onPointerDown={renaming ? undefined : (e: ReactPointerEvent<HTMLElement>) => beginSessionDrag(e, agent.id, agent.title, row.scope)}
        onContextMenu={(e: MouseEvent) => {
          e.preventDefault();
          onMenu({ id: agent.id, at: { x: e.clientX, y: e.clientY } });
        }}
        onKeyDown={onKeyDown}
      >
        <span className="session-status">
          <StatusIcon agent={agent} pr={pr} />
        </span>
        <span className="session-text">
          <span className="session-title-line">
            <span className="session-harness">
              <ProviderIcon harness={harnessOf(agent)} size={14} />
            </span>
            {renaming ? <RenameInput agent={agent} /> : <span className="session-title">{agent.title}</span>}
            {project && <span className="session-project">{project}</span>}
            <span className="session-time" data-session-time>
              {time}
            </span>
          </span>
          {!oneLine && (
            <span className="session-detail" data-session-detail>
              {!isChild && agent.workspaceId !== null && (
                <>
                  {agent.worktree || inRepo ? <WorktreeCompact size={12} /> : <FolderCompact size={12} />}
                  {project && <span className="session-project-detail">{project}</span>}
                  <SessionSeparator />
                </>
              )}
              {agent.imported && (
                <>
                  <ImportedMark />
                  <SessionSeparator />
                </>
              )}
              {agent.status === "running" && <span>{S.working}</span>}
              {agent.status === "waiting" && (
                <>
                  <span>{S.inputNeeded}</span>
                  <SessionSeparator />
                  <span>{time}</span>
                </>
              )}
              {agent.status === "error" && (
                <>
                  <span>{S.rowError}</span>
                  <SessionSeparator />
                  <span>{time}</span>
                </>
              )}
              {agent.status === "idle" && (
                <>
                  {!isChild && sum.add + sum.del > 0 && (
                    <>
                      <span className="session-changes" aria-label={S.changeCountAria(sum.add, sum.del)}>
                        <span className="session-changes-add">+{sum.add}</span> <span className="session-changes-del">-{sum.del}</span>
                      </span>
                      <SessionSeparator />
                    </>
                  )}
                  <span>{time}</span>
                </>
              )}
              {folderCount > 1 && (
                <>
                  <SessionSeparator />
                  <span className="session-detail-folders">
                    <Codicon name="folder-library" size={12} />
                    {S.folderCount(folderCount)}
                  </span>
                </>
              )}
            </span>
          )}
        </span>
      </Main>
      {agent.status === "waiting" && <InlineApproval agent={agent} />}
      <div className="session-actions">
        {agent.pinned ? (
          <button type="button" className="session-action" data-on aria-label={S.unpin} title={S.unpin} onClick={() => setPinned(agent, false)}>
            <Pin />
          </button>
        ) : (
          <button type="button" className="session-action" data-quick aria-label={S.pin} title={S.pin} onClick={() => setPinned(agent, true)}>
            <Pin />
          </button>
        )}
        <button
          type="button"
          className="session-action"
          data-quick
          aria-label={agent.done ? S.markNotDone : S.markDone}
          title={agent.done ? S.markNotDone : S.markDone}
          onClick={() => setDone(agent, !agent.done)}
        >
          <Check />
        </button>
        <DropdownMenu open={!!menu} onOpenChange={(open) => onMenu(open ? { id: agent.id } : null)}>
          <DropdownMenuTrigger asChild>
            {menu?.at ? (
              <button type="button" className="menu-anchor" style={{ left: menu.at.x, top: menu.at.y }} tabIndex={-1} aria-hidden="true" />
            ) : (
              <button type="button" className="session-action session-more" aria-label={S.sessionMenu} title={S.sessionMenu}>
                <More />
              </button>
            )}
          </DropdownMenuTrigger>
          <SessionMenu agent={agent} />
        </DropdownMenu>
      </div>
    </div>
  );
}

function StatusIcon({ agent, pr }: { agent: Agent; pr: { number: number; title: string } | undefined }) {
  if (agent.status === "running") return <DotSpinner state="running" />;
  if (agent.status === "waiting") return <DotSpinner state="waiting" />;
  if (agent.status === "error") {
    return (
      <span className="session-dot" data-kind="error">
        <Codicon name="error" />
      </span>
    );
  }
  if (agent.unread) {
    return (
      <span className="session-dot" data-kind="unread">
        <CircleFilled />
      </span>
    );
  }
  if (pr) {
    return (
      <span className="session-dot" data-kind="pr">
        <Codicon name="git-pull-request" />
      </span>
    );
  }
  return (
    <span className="session-dot" data-kind="read">
      <CircleSmallFilled />
    </span>
  );
}

function SessionSeparator() {
  return <span className="session-separator" aria-hidden="true" />;
}

function InlineApproval({ agent }: { agent: Agent }) {
  const pending = useStore((s) => s.timelines[agent.id]?.find((i): i is Extract<TimelineItem, { kind: "permission" }> => i.kind === "permission" && i.status === "pending"));
  useEffect(() => {
    ensureTimeline(agent.id);
  }, [agent.id]);
  const preview = useEditPreview(agent.id, pending);
  if (!pending) return null;
  const title = pending.notion ? pending.notion.summary : preview?.isNew ? S.approvalCreateTitle : S.approvalTitle(pending.toolName);
  const asks = needsReview(pending.toolName);
  return (
    <div className="session-approval">
      <span className="session-approval-title">{title}</span>
      <button type="button" className="session-approval-allow" aria-label={asks ? S.approvalAnswerAria(title) : S.allowAria(title)} onClick={() => (asks ? openAgent(agent.id) : allowPermission(agent.id, pending.id))}>
        {asks ? (pending.toolName === QUESTION_TOOL ? S.approvalAnswerRow : S.approvalReviewRow) : S.allowOnce}
      </button>
    </div>
  );
}

function WorktreeItems({ agent, worktree }: { agent: Agent; worktree: NonNullable<Agent["worktree"]> }) {
  const [unmerged, setUnmerged] = useState<number | null>(null);
  const prs = useStore((s) => s.prs[agent.id]?.prs);
  useEffect(() => {
    let alive = true;
    void rpc
      .call("agents.worktreeStatus", { agentId: agent.id })
      .then((status) => alive && setUnmerged(status?.unmerged ?? null))
      .catch(() => undefined);
    void refreshPrs(agent.id);
    return () => {
      alive = false;
    };
  }, [agent.id]);
  const target = worktree.base.replace(/^origin\//, "");
  const { merge, pr } = worktreeMenuState({ branch: worktree.branch, target, unmerged, prs });
  return (
    <>
      <DropdownMenuItem disabled={merge.disabled} title={merge.reason ?? undefined} onSelect={() => void mergeWorktree(agent.id)}>
        {S.mergeMenu(target)}
      </DropdownMenuItem>
      {pr.kind === "open" ? (
        <DropdownMenuItem title={pr.reason} onSelect={() => openPrBesideByUrl(pr.url, agent.id)}>
          {S.prOpenMenu}
        </DropdownMenuItem>
      ) : (
        <DropdownMenuItem disabled={pr.disabled} title={pr.reason ?? undefined} onSelect={() => void createWorktreePr(agent.id)}>
          {S.prMenu}
        </DropdownMenuItem>
      )}
    </>
  );
}

function useBoardCard(agent: Agent) {
  const board = useStore((s) => s.board);
  const linked = board?.cards.find((c) => c.agentIds.includes(agent.id) && c.source?.agentId !== agent.id);
  const addToBoard = async () => {
    const role = agent.status === "running" || agent.status === "waiting" ? "inProgress" : "todo";
    const columnId = board?.columns.find((c) => c.role === role)?.id;
    try {
      const card = await rpc.call("board.createCard", { title: agent.title, workspaceId: agent.workspaceId, agentIds: [agent.id], ...(columnId ? { columnId } : {}) });
      flash(S.addedToBoard);
      openCard(card.id);
    } catch (error) {
      flash(S.boardFailed((error as Error).message));
    }
  };
  return { board, linked, addToBoard };
}

function SessionMenu({ agent }: { agent: Agent }) {
  const { board, linked, addToBoard } = useBoardCard(agent);
  const renaming = useRef(false);
  return (
    <DropdownMenuContent
      align="start"
      className="session-menu"
      data-menu="row"
      onCloseAutoFocus={(e) => {
        if (!renaming.current) return;
        renaming.current = false;
        e.preventDefault();
        startRename(agent.id);
      }}
    >
      <DropdownMenuItem onSelect={() => setPinned(agent, !agent.pinned)}>{agent.pinned ? S.unpin : S.pin}</DropdownMenuItem>
      <DropdownMenuItem onSelect={() => openAgent(agent.id, "new")}>{S.openToSide}</DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        onSelect={() => {
          renaming.current = true;
        }}
      >
        {S.rename}
        <span className="menu-key">F2</span>
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={() => markRead(agent, !!agent.unread)}>{agent.unread ? S.markRead : S.markUnread}</DropdownMenuItem>
      <DropdownMenuItem onSelect={() => setDone(agent, !agent.done)}>
        {agent.done ? S.markNotDone : S.markDone}
        <span className="menu-key">⌘Backspace</span>
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={() => void deleteSession(agent)}>{S.deleteEllipsis}</DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={() => copySessionLink(agent)}>{S.copyLink}</DropdownMenuItem>
      <DropdownMenuItem disabled={!canHandOff(agent)} onSelect={() => startHandoff(agent.id)}>
        {S.handoffMenu}
      </DropdownMenuItem>
      {agent.workspaceId === null && !agent.feedbackId && !agent.imported && <DropdownMenuItem onSelect={() => void moveChatToFolder(agent.id)}>{S.moveToFolderMenu}</DropdownMenuItem>}
      {agent.worktree && (
        <>
          <DropdownMenuSeparator />
          <WorktreeItems agent={agent} worktree={agent.worktree} />
        </>
      )}
      <DropdownMenuSeparator />
      <DropdownMenuItem
        onSelect={() => {
          openAgent(agent.id);
          addTerminal(agent.id);
        }}
      >
        {S.openTerminal}
      </DropdownMenuItem>
      {linked ? (
        <DropdownMenuItem onSelect={() => openCard(linked.id)}>{S.openBoardCard}</DropdownMenuItem>
      ) : (
        <DropdownMenuItem disabled={!board} onSelect={() => void addToBoard()}>
          {S.addToBoard}
        </DropdownMenuItem>
      )}
    </DropdownMenuContent>
  );
}

function SideKeycaps({ command }: { command: string }) {
  const label = useCommandKey(command);
  const caps = useCommandKeycaps(command);
  if (caps.length === 0) return null;
  return (
    <span className="keycaps" aria-label={label ?? undefined}>
      {caps.map((cap, n) => (
        <kbd key={n} className="keycap">
          {cap}
        </kbd>
      ))}
    </span>
  );
}
