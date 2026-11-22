import { createPortal } from "react-dom";
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { BrowserTabView } from "./BrowserTab";
import { tabTooltip } from "./browserUrl";
import { CardDetail } from "./CardDetail";
import { setChangesListOpen, setTreeView, setWordWrap, useChangesView } from "./changesState";
import { ChangesPanel, ChatChanges, WIDE_MIN } from "./ChangesPanel";
import { ChangesBadge } from "./ChangesBadge";
import { ChatTabView } from "./ChatDock";
import { DraftChanges } from "./DraftChanges";
import { editorGitWorkspaceOf } from "./editorChat";
import { DiffTab } from "./DiffView";
import { ScmDiffView } from "./ScmDiffView";
import { type EditorLayout, groupIdsOf, MAIN_GROUP, mainTabs, tabsOfGroup } from "./editorGroups";
import { closable } from "./editorTabs";
import { DiffTabActions, diffScopeLabel, EmptyGroup, GroupMoreMenu, tabName } from "./EditorGroupExtras";
import { RecentEditors } from "./RecentEditors";
import { scrollMemory } from "./scrollKeep";
import { moveEditorToGroup } from "./editorMove";
import { closeInGroup, setSticky, toggleMaximizeGroup } from "./groupActions";
import { editorKeyOfMain, sideKeyOf } from "./floatLayout";
import { requestCloseTab, useDocFlags } from "./editorDocs";
import "./fileView.css";
import "./tabStrip.css";
import { Editor } from "./Editor";
import { EditorStatus } from "./EditorStatus";
import { FV } from "./fileViewStrings";
import { stripScrollTarget } from "./tabStrip";
import { FilesRoots } from "./FilesRoots";
import { isMultiRoot } from "./sessionFolders";
import { FilesTab } from "./FilesTab";
import { Close, Codicon, Diff, FilesIcon, ListIcon, Maximize, Minimize, More, Plus } from "./icons";
import { stretchedMin } from "./paneFit";
import { edgeGroupOf, nextPinnedState, PINNED_MIN, pinnedRange, pinnedShown, pinnedWidth, presentationOf, snapDrawerWidth, type PinnedPresentation, type PinnedSide } from "./pinnedLayout";
import { setPinnedCollapsed, setPinnedDrawer, setPinnedWidth, usePinned } from "./pinnedPanel";
import { QuickAsk } from "./QuickAsk";
import { Resizer } from "./Resizer";
import { PullRequestTab } from "./lazyViews";
import { P } from "./prStrings";
import { M } from "./scmStrings";
import { SearchTabView } from "./SearchTab";
import { ReplacePreviewView } from "./ReplacePreviewView";
import { SearchHeaderActions, SearchView } from "./SearchView";
import { SourceControlTab } from "./SourceControl";
import { activeAgentOf } from "./activeAgentOf";
import { attachFile } from "./attachments";
import { revealFilePath } from "./filesView";
import { rpc } from "./rpc";
import { runCommand } from "./shortcuts";
import { isShown, shownAgentsOf } from "./sessionTabs";
import { beginTabDrag, useTabDrag } from "./tabDrag";
import {
  activeKeyOfGroup,
  closeCard,
  focusGroup,
  inFolder,
  openBrowser,
  openSearch,
  openUntitled,
  pinEditorTab,
  resizeEditorSplit,
  setState,
  shownTabsOf,
  splitEditor,
  toggleSearchDetails,
  useStore,
  flash,
  type Tab,
} from "./store";
import { S } from "./strings";
import { FileTypeIcon } from "./FileTypeIcon";
import { Button } from "./ui/button";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "./ui/dropdown-menu";
import { hint } from "./hint";
import { useCommandKey } from "./commandKeys";

type AreaProps = { narrow: boolean; maximized: boolean; onMaximize: () => void; mode: "all" | "editors" };
type TabMenu = { key: string | null; group: string; x: number; y: number; bar?: boolean };

export function EditorArea({ narrow, maximized, onMaximize, mode = "all" }: Omit<AreaProps, "mode"> & { mode?: AreaProps["mode"] }) {
  const layout = useStore((s) => s.editorLayout);
  const editorCentered = useStore((s) => s.layoutMode === "editor");
  const [menu, setMenu] = useState<TabMenu | null>(null);
  return (
    <div className="editor-area">
      <LayoutNode node={layout} area={{ narrow, maximized, onMaximize, mode }} onMenu={setMenu} />
      {!editorCentered && <EditorStatus />}
      <TabContextMenu menu={menu} onClose={() => setMenu(null)} />
      <DragOverlay />
      <RecentEditors />
    </div>
  );
}

function LayoutNode({ node, area, onMenu }: { node: EditorLayout; area: AreaProps; onMenu: (menu: TabMenu) => void }) {
  if (node.type === "group") return <EditorGroup id={node.id} area={area} onMenu={onMenu} />;
  return <EditorSplit node={node} area={area} onMenu={onMenu} />;
}

function EditorSplit({ node, area, onMenu }: { node: Extract<EditorLayout, { type: "split" }>; area: AreaProps; onMenu: (menu: TabMenu) => void }) {
  const [setRoot, width] = useElementWidth();
  const maximized = useStore((s) => s.maximizedGroup);
  const keeps = maximized ? node.children.findIndex((child) => groupIdsOf(child).includes(maximized)) : -1;
  const groupMin = node.dir === "row" ? stretchedMin(GROUP_MIN, width, [node.children.length]) : undefined;
  return (
    <div className="editor-split" ref={setRoot} data-dir={node.dir} data-split={node.id} style={groupMin === undefined ? undefined : ({ "--group-min": `${groupMin}px` } as CSSProperties)}>
      {node.children.map((child, index) => (
        <SplitCell key={child.type === "group" ? child.id : child.id} node={node} index={index} keeps={keeps}>
          <LayoutNode node={child} area={area} onMenu={onMenu} />
        </SplitCell>
      ))}
    </div>
  );
}

function SplitCell({ node, index, keeps, children }: { node: Extract<EditorLayout, { type: "split" }>; index: number; keeps: number; children: React.ReactNode }) {
  const collapsed = keeps !== -1 && index !== keeps;
  return (
    <>
      {index > 0 && <SplitSash node={node} index={index - 1} hidden={keeps !== -1} />}
      <div className="editor-split-cell" data-collapsed={collapsed || undefined} style={{ flex: `${node.sizes[index]} 1 0` }}>
        {children}
      </div>
    </>
  );
}

const GROUP_MIN = 120;

function SplitSash({ node, index, hidden }: { node: Extract<EditorLayout, { type: "split" }>; index: number; hidden: boolean }) {
  const [active, setActive] = useState(false);
  const horizontal = node.dir === "row";
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const parent = event.currentTarget.parentElement;
    if (!parent || event.button !== 0) return;
    const cells = Array.from(parent.querySelectorAll<HTMLElement>(":scope > .editor-split-cell"));
    const px = cells.map((cell) => (horizontal ? cell.getBoundingClientRect().width : cell.getBoundingClientRect().height));
    const total = px.reduce((a, b) => a + b, 0);
    const pair = px[index] + px[index + 1];
    if (cells.length !== node.sizes.length || pair < GROUP_MIN * 2 || total <= 0) return;
    const start = horizontal ? event.clientX : event.clientY;
    const startFirst = px[index];
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
    }
    setActive(true);
    const move = (e: PointerEvent) => {
      const first = Math.min(Math.max(startFirst + ((horizontal ? e.clientX : e.clientY) - start), GROUP_MIN), pair - GROUP_MIN);
      const next = px.slice();
      next[index] = first;
      next[index + 1] = pair - first;
      resizeEditorSplit(node.id, next.map((n) => n / total));
    };
    const up = () => {
      setActive(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const reset = () => {
    const share = 1 / node.sizes.length;
    resizeEditorSplit(node.id, node.sizes.map(() => share));
  };
  return <div className="resizer" hidden={hidden} role="separator" aria-label={S.resizeEditorGroups} aria-orientation={horizontal ? "vertical" : "horizontal"} data-axis={horizontal ? "x" : "y"} data-active={active || undefined} onPointerDown={onPointerDown} onDoubleClick={reset} />;
}

function EditorGroup({ id, area, onMenu }: { id: string; area: AreaProps; onMenu: (menu: TabMenu) => void }) {
  const focused = useStore((s) => s.activeGroupId === id);
  const activeKey = useStore((s) => (area.mode === "editors" ? editorKeyOfGroup(s, id) : activeKeyOfGroup(s, id)));
  const groupRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = groupRef.current;
    if (!element) return;
    const onPointerDown = () => focusGroup(id);
    element.addEventListener("pointerdown", onPointerDown, true);
    return () => element.removeEventListener("pointerdown", onPointerDown, true);
  }, [id]);
  return (
    <div ref={groupRef} className="editor-group" data-group={id} data-focused={focused || undefined} role="group" aria-label={S.editorGroupAria}>
      <GroupStrip id={id} activeKey={activeKey} area={area} onMenu={onMenu} />
      <GroupBody id={id} activeKey={activeKey} mode={area.mode} />
    </div>
  );
}

function GroupStrip({ id, activeKey, area, onMenu }: { id: string; activeKey: string | null; area: AreaProps; onMenu: (menu: TabMenu) => void }) {
  const editorsOnly = area.mode === "editors";
  const main = id === MAIN_GROUP && !editorsOnly;
  const tabs = useStore((s) => s.tabs);
  const agents = useStore((s) => shownAgentsOf(s));
  const filesIndex = useStore((s) => s.filesIndex);
  const selectedCardId = useStore((s) => s.selectedCardId);
  const all = tabs.filter((t) => (t.group ?? MAIN_GROUP) === id);
  const mine = all.filter((t) => isShown(t, agents));
  const before = main ? all.slice(0, filesIndex).filter((t) => isShown(t, agents)) : [];
  const after = main ? all.slice(filesIndex).filter((t) => isShown(t, agents)) : mine;
  const menuFor = (tab: Tab) => (x: number, y: number) => onMenu({ key: tab.key, group: id, x, y });
  const searchTabKey = mine.find((t) => t.key === activeKey && t.kind === "search")?.key ?? null;
  const strip = useStripScroll(activeKey);
  return (
    <div
      className="tabs"
      role="tablist"
      data-tab-strip={id}
      ref={strip}
      onContextMenu={(e) => {
        if (e.target !== e.currentTarget) return;
        e.preventDefault();
        onMenu({ key: mine.some((t) => t.key === activeKey) ? activeKey : null, group: id, x: e.clientX, y: e.clientY, bar: true });
      }}
      onDoubleClick={(e) => e.target === e.currentTarget && toggleMaximizeGroup(id)}
    >
      <PanelActions group={id} edge="left" />
      {main && (
        <div className="tab" data-active={activeKey === "changes" || undefined} data-tab-key="changes">
          <button type="button" role="tab" className="tab-label" title={S.changesTab} onClick={() => setState({ activeTabKey: "changes" })}>
            <Diff size={14} />
            {S.changesTab}
            <ChangesBadge />
          </button>
        </div>
      )}
      {before.map((tab) => (
        <TabItem key={tab.key} tab={tab} activeKey={activeKey} onMenu={menuFor(tab)} />
      ))}
      {main && (
        <div className="tab" data-active={activeKey === "files" || undefined} data-tab-key="files">
          <button type="button" role="tab" className="tab-label" title={S.filesTab} onClick={() => setState({ activeTabKey: "files" })}>
            <FilesIcon size={14} />
            {S.filesTab}
          </button>
        </div>
      )}
      {main && selectedCardId && (
        <div className="tab" data-active={activeKey === "card" || undefined} data-kind="card" data-tab-key="card">
          <button type="button" role="tab" className="tab-label" onClick={() => setState({ activeTabKey: "card" })}>
            {S.cardDetail}
          </button>
          <Button size="icon" className="tab-close" aria-label={S.closeCard} title={S.closeCard} onClick={() => closeCard()}>
            <Close size={14} />
          </Button>
        </div>
      )}
      {after.map((tab) => (
        <TabItem key={tab.key} tab={tab} activeKey={activeKey} onMenu={menuFor(tab)} />
      ))}
      <AddTabMenu group={id} />
      <div className="tabs-tail">
        {main && <MainActions changesTab={activeKey === "changes"} narrow={area.narrow} maximized={area.maximized} onMaximize={area.onMaximize} />}
        {searchTabKey && <SearchDetailsButton tabKey={searchTabKey} />}
        <DiffTabActions activeKey={activeKey} />
        <SplitButton group={id} activeKey={activeKey} />
        {!(main && activeKey === "changes") && <GroupMoreMenu group={id} activeKey={activeKey} />}
        {main && !area.narrow && <ListToggle changesTab={activeKey === "changes"} />}
        <PanelActions group={id} edge="right" />
      </div>
    </div>
  );
}

function ClosePanelButton() {
  const rightKey = useCommandKey("toggleRight");
  return (
    <Button size="icon" aria-label={S.close} title={S.closeSidePanel(rightKey)} onClick={() => setState({ rightOpen: false })}>
      <Close />
    </Button>
  );
}

function PanelActions({ group, edge }: { group: string; edge: PinnedSide }) {
  const pinned = useContext(PinnedContext);
  const layout = useStore((s) => s.editorLayout);
  if (!pinned || edgeGroupOf(layout, edge) !== group) return null;
  const show = !pinned.shown && pinned.side === edge;
  const panelEnd = edge === "right";
  return (
    <>
      {panelEnd && (
        <Button size="icon" aria-label={pinned.maximized ? S.restorePanel : S.maximizePanel} title={pinned.maximized ? S.restorePanel : S.maximizePanel} onClick={pinned.onMaximize}>
          {pinned.maximized ? <Minimize /> : <Maximize />}
        </Button>
      )}
      {show && (
        <Button size="icon" className="pinned-toggle" aria-label={S.showPinned} title={S.showPinned} onClick={pinned.toggle}>
          <Codicon name={pinned.side === "right" ? "layout-sidebar-right" : "layout-sidebar-left"} />
        </Button>
      )}
      {panelEnd && !pinned.shown && <ClosePanelButton />}
    </>
  );
}

function AddTabMenu({ group }: { group: string }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="icon" className="tabs-add" aria-label={S.addTab} title={S.addTab} onPointerDown={() => focusGroup(group)}>
          <Plus />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuItem onSelect={() => openBrowser()}>{S.addTabBrowser}</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => openSearch()}>
          {S.addTabSearch}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => openUntitled()}>{S.addTabNewFile}</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => runCommand("newFilePath")}>{S.newFilePath}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function useStripScroll(activeKey: string | null) {
  const strip = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = strip.current;
    const tail = element?.querySelector<HTMLElement>(":scope > .tabs-tail");
    if (!element || !tail) return;
    const fit = () => {
      element.style.scrollPaddingRight = `${tail.offsetWidth}px`;
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(tail);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!activeKey) return;
    const tail = strip.current?.querySelector<HTMLElement>(":scope > .tabs-tail");
    if (strip.current && tail) strip.current.style.scrollPaddingRight = `${tail.offsetWidth}px`;
    const element = strip.current;
    if (!element) return;
    const align = () => {
      const items = Array.from(element.querySelectorAll<HTMLElement>(":scope > .tab[data-tab-key]"));
      const base = element.getBoundingClientRect().left - element.scrollLeft;
      const boxes = items.map((item) => {
        const rect = item.getBoundingClientRect();
        return { left: rect.left - base, right: rect.right - base };
      });
      const next = stripScrollTarget({ scrollLeft: element.scrollLeft, width: element.clientWidth, padRight: element.querySelector<HTMLElement>(":scope > .tabs-tail")?.offsetWidth ?? 0, tabs: boxes, active: items.findIndex((item) => item.dataset.tabKey === activeKey) });
      const natural = element.scrollWidth - element.clientWidth - (Number.parseFloat(element.style.getPropertyValue("--tabs-extra")) || 0);
      const extra = Math.max(0, Math.ceil(next - natural));
      element.style.setProperty("--tabs-extra", `${extra}px`);
      if (Math.abs(next - element.scrollLeft) > 0.5) element.scrollTo({ left: next, behavior: "instant" });
    };
    align();
    const frame = requestAnimationFrame(() => requestAnimationFrame(align));
    let resizeFrame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(align);
    });
    observer.observe(element);
    return () => {
      cancelAnimationFrame(frame);
      cancelAnimationFrame(resizeFrame);
      observer.disconnect();
    };
  }, [activeKey]);
  return strip;
}

function SearchDetailsButton({ tabKey }: { tabKey: string }) {
  const detailsKey = useCommandKey("searchDetails");
  return (
    <Button size="icon" aria-label={S.toggleDetailsKey(detailsKey)} title={S.toggleDetailsKey(detailsKey)} onClick={() => toggleSearchDetails(tabKey)}>
      <Codicon name="list-flat" />
    </Button>
  );
}

function SplitButton({ group, activeKey }: { group: string; activeKey: string | null }) {
  const splitKey = useCommandKey("splitEditorRight");
  const tabs = useStore((s) => s.tabs);
  const movable = tabs.some((t) => t.key === activeKey && (t.group ?? MAIN_GROUP) === group);
  return (
    <Button
      size="icon"
      aria-label={S.splitEditorRightKey(splitKey)}
      title={S.splitEditorRightKey(splitKey)}
      disabled={!movable}
      onClick={(e) => {
        if (activeKey) splitEditor(e.altKey ? "column" : "row", activeKey);
      }}
    >
      <Codicon name="split-horizontal" />
    </Button>
  );
}

function TabItem({ tab, activeKey, onMenu }: { tab: Tab; activeKey: string | null; onMenu: (x: number, y: number) => void }) {
  const closeKey = useCommandKey("close");
  const dragging = useTabDrag()?.key === tab.key;
  const dirty = useStore((s) => !!s.dirtyTabs[tab.key]);
  const deleted = !!useDocFlags(tab.key).deleted;
  const select = () => setState({ activeTabKey: tab.key });
  const chatTitle = useStore((s) => (tab.kind === "chat" ? s.agents.find((a) => a.id === tab.agentId)?.title : undefined));
  const name = chatTitle || tabName(tab);
  const title = tab.kind === "search" ? S.searchTabTitle(tab.query) : tab.kind === "pr" ? P.tabTitle(tab.repo, tab.number) : tab.kind === "browser" ? tabTooltip(tab.title, tab.url) : tab.kind === "untitled" || tab.kind === "chat" ? name : tab.kind === "diff" || (tab.kind === "scm" && tab.section === "uncommitted") ? `${tab.path} (${diffScopeLabel(tab)})` : tab.kind === "scm" ? M.scmTabTitle(tab.section === "staged" ? "staged" : "changes", tab.path) : tab.path;
  const closeLabel = tab.kind === "file" || tab.kind === "diff" || tab.kind === "scm" || tab.kind === "replace" ? tab.path : name;
  const fileName = tab.kind === "search" || tab.kind === "browser" || tab.kind === "untitled" || tab.kind === "pr" || tab.kind === "chat" ? name : tab.path.slice(tab.path.lastIndexOf("/") + 1);
  return (
    <div
      className="tab"
      data-active={tab.key === activeKey || undefined}
      data-kind={tab.kind}
      data-editor-tab=""
      data-tab-key={tab.key}
      data-dirty={dirty || undefined}
      data-deleted={deleted || undefined}
      data-preview={("preview" in tab && tab.preview) || undefined}
      data-sticky={tab.sticky || undefined}
      data-dragging={dragging || undefined}
      onDoubleClick={() => pinEditorTab(tab.key)}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(e.clientX, e.clientY);
      }}
      onAuxClick={(e) => {
        if (e.button === 1) {
          e.preventDefault();
          void requestCloseTab(tab.key);
        }
      }}
    >
      <button type="button" role="tab" className={`tab-label${tab.kind === "file" || tab.kind === "diff" || tab.kind === "scm" || tab.kind === "untitled" || tab.kind === "replace" ? " mono" : ""}`} title={deleted ? `${title} ${FV.deletedSuffix}. ${FV.deletedTip}` : title} onClick={select} onPointerDown={(e) => beginTabDrag(e, tab.key, name)}>
        {tab.kind === "search" && <Codicon name="search" />}
        {tab.kind === "browser" && <Codicon name="globe" />}
        {tab.kind === "pr" && <Codicon name="git-pull-request" />}
        {tab.kind === "chat" && <Codicon name="comment-discussion" />}
        {(tab.kind === "file" || tab.kind === "diff" || tab.kind === "scm" || tab.kind === "untitled" || tab.kind === "replace") && <FileTypeIcon name={fileName} />}
        {deleted ? <span className="tab-name-deleted">{name}</span> : name}
        {deleted && <span className="tab-deleted">{FV.deletedSuffix}</span>}
      </button>
      {tab.sticky ? (
        <Button size="icon" className="tab-close tab-pin" aria-label={S.unpinTab} title={S.unpinTab} onClick={() => setSticky(tab.key, false)}>
          <Codicon name="pinned" />
        </Button>
      ) : (
        <Button size="icon" className="tab-close" aria-label={S.closeTab(closeLabel)} title={dirty ? `${S.tabDirty}. ${S.closeTabKey(closeKey)}` : S.closeTabKey(closeKey)} onClick={() => void requestCloseTab(tab.key)}>
          <Close />
          <span className="tab-dot" aria-hidden="true" />
        </Button>
      )}
    </div>
  );
}

function TabContextMenu({ menu, onClose }: { menu: TabMenu | null; onClose: () => void }) {
  const tabs = useStore((s) => s.tabs);
  const dirtyTabs = useStore((s) => s.dirtyTabs);
  const activePaneId = useStore((s) => s.activePaneId);
  const panes = useStore((s) => s.panes);
  const workspaces = useStore((s) => s.workspaces);
  const tab = menu?.key ? tabs.find((t) => t.key === menu.key) : undefined;
  if (!menu || (menu.key && !tab)) return null;
  const inGroup = shownTabsOf({ tabs, panes }).filter((t) => (t.group ?? MAIN_GROUP) === menu.group);
  const others = tab ? closable(inGroup, inGroup.filter((t) => t.key !== tab.key).map((t) => t.key)) : [];
  const index = tab ? inGroup.findIndex((t) => t.key === tab.key) : -1;
  const right = closable(inGroup, inGroup.slice(index + 1).map((t) => t.key));
  const saved = closable(inGroup, inGroup.filter((t) => !dirtyTabs[t.key]).map((t) => t.key));
  const path = tab && (tab.kind === "file" || tab.kind === "diff") ? tab.path : null;
  const workspaceId = tab && "workspaceId" in tab ? tab.workspaceId : "";
  const workspaceDir = workspaces.find((w) => w.id === workspaceId)?.dir ?? "";
  const copy = (text: string) => {
    void navigator.clipboard.writeText(text).then(() => hint(S.copied, undefined, { check: true }));
  };
  const split = (dir: "row" | "column", before: boolean) => tab && splitEditor(dir, tab.key, before);
  return (
    <DropdownMenu open onOpenChange={(open) => !open && onClose()}>
      <DropdownMenuTrigger asChild>
        <button type="button" className="menu-anchor" style={{ left: menu.x, top: menu.y }} tabIndex={-1} aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" data-testid="tab-menu">
        {tab && !menu.bar && (
          <>
            <DropdownMenuItem onSelect={() => void requestCloseTab(tab.key)}>
              {S.close}
              <span className="faint xs menu-hint">⌘W</span>
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!others.length} onSelect={() => void closeInGroup(menu.group, "others", tab.key)}>
              {S.closeOtherTabs}
              <span className="faint xs menu-hint">⌥⌘T</span>
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!right.length} onSelect={() => void closeInGroup(menu.group, "right", tab.key)}>
              {S.closeTabsToRight}
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!saved.length} onSelect={() => void closeInGroup(menu.group, "saved")}>
              {S.closeSavedTabs}
              <span className="faint xs menu-hint">⌘K U</span>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void closeInGroup(menu.group, "all")}>
              {S.closeAllTabs}
              <span className="faint xs menu-hint">⌘K W</span>
            </DropdownMenuItem>
            {path && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => copy(path.startsWith("/") ? path : `${workspaceDir}/${path}`)}>{S.copyTabPath}</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => copy(path)}>{S.copyTabRelativePath}</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => copy(path.split("/").join(" > "))}>{S.copyBreadcrumbsPath}</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem disabled={tab.kind !== "file" || !activePaneId} onSelect={() => attachFile(activePaneId, workspaceId, path)}>
                  {S.addFileToChat}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  disabled={tab.kind !== "file" || path.startsWith("/")}
                  onSelect={() => {
                    void rpc.call("files.reveal", { workspaceId, path }).catch((e: Error) => flash(S.revealEntryFailed(e.message), "error"));
                  }}
                >
                  {S.revealInFinder}
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={tab.kind !== "file" || path.startsWith("/")}
                  onSelect={() => {
                    revealFilePath(workspaceId, path);
                    setState({ activeTabKey: "files" });
                  }}
                >
                  {S.revealInExplorerView}
                </DropdownMenuItem>
              </>
            )}
            <DropdownMenuSeparator />
            {"preview" in tab && tab.preview && (
              <DropdownMenuItem onSelect={() => pinEditorTab(tab.key)}>
                {S.keepOpen}
                <span className="faint xs menu-hint">⌘K Enter</span>
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onSelect={() => setSticky(tab.key, !tab.sticky)}>
              {tab.sticky ? S.unpinTab : S.pinTab}
              <span className="faint xs menu-hint">⌘K ⇧Enter</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => split("row", false)}>
              {S.splitRight}
              <span className="faint xs menu-hint">⌘\</span>
            </DropdownMenuItem>
          </>
        )}
        {tab && !menu.bar && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>{S.splitAndMove}</DropdownMenuSubTrigger>
            <DropdownMenuSubContent data-testid="split-move-menu">
              <DropdownMenuItem onSelect={() => split("column", true)}>{S.splitUp}</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => split("column", false)}>{S.splitDown}</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => split("row", true)}>{S.splitLeft}</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => split("row", false)}>{S.splitRight}</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => moveEditorToGroup("up", tab.key)}>{S.moveAbove}</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => moveEditorToGroup("down", tab.key)}>{S.moveBelow}</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => moveEditorToGroup("left", tab.key)}>{S.moveLeft}</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => moveEditorToGroup("right", tab.key)}>{S.moveRight}</DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}
        {menu.bar && (
          <>
            <DropdownMenuItem disabled={!tab} onSelect={() => split("column", true)}>
              {S.splitUp}
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!tab} onSelect={() => split("column", false)}>
              {S.splitDown}
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!tab} onSelect={() => split("row", true)}>
              {S.splitLeft}
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!tab} onSelect={() => split("row", false)}>
              {S.splitRight}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function MainActions({ changesTab, searchTab = false, narrow, maximized, onMaximize, maximize = !narrow }: { changesTab: boolean; searchTab?: boolean; narrow: boolean; maximized: boolean; onMaximize: () => void; maximize?: boolean }) {
  const wide = useChangesView((s) => s.wide);
  const wordWrap = useChangesView((s) => s.wordWrap);
  const treeView = useChangesView((s) => s.treeView);
  return (
    <>
      {searchTab && <SearchHeaderActions />}
      {changesTab && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="icon" aria-label={S.morePanelActions} title={S.morePanelActions}>
              <More />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {wide && (
              <>
                <DropdownMenuCheckboxItem checked={wordWrap} onCheckedChange={setWordWrap}>
                  {S.wordWrap}
                </DropdownMenuCheckboxItem>
                <DropdownMenuSeparator />
              </>
            )}
            <DropdownMenuItem onSelect={() => setTreeView(!treeView)}>{treeView ? S.viewAsList : S.viewAsTree}</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {maximize && (
        <Button size="icon" aria-label={maximized ? S.restorePanel : S.maximizePanel} title={maximized ? S.restorePanel : S.maximizePanel} onClick={onMaximize}>
          {maximized ? <Minimize /> : <Maximize />}
        </Button>
      )}
    </>
  );
}

function ListToggle({ changesTab }: { changesTab: boolean }) {
  const listOpen = useChangesView((s) => s.listOpen);
  if (!changesTab) return null;
  return (
    <Button size="icon" variant={listOpen ? "ghost-on" : "ghost"} aria-label={S.toggleFileList} aria-pressed={listOpen} title={S.toggleFileList} onClick={() => setChangesListOpen(!listOpen)}>
      <ListIcon />
    </Button>
  );
}

const bodies = new Map<string, HTMLElement>();
const bodyListeners = new Set<() => void>();

function registerBody(id: string, element: HTMLElement | null) {
  if (element) bodies.set(id, element);
  else bodies.delete(id);
  for (const listener of bodyListeners) listener();
}

function useGroupBody(id: string) {
  return useSyncExternalStore(
    (listener) => {
      bodyListeners.add(listener);
      return () => bodyListeners.delete(listener);
    },
    () => bodies.get(id) ?? null,
  );
}

function GroupBody({ id, activeKey, mode }: { id: string; activeKey: string | null; mode: AreaProps["mode"] }) {
  const ref = useCallback((element: HTMLDivElement | null) => registerBody(id, element), [id]);
  const empty = useStore((s) => !(id === MAIN_GROUP && mode === "all") && !tabsOfGroup(shownTabsOf(s), id).length && !(id === MAIN_GROUP && mainTabs(shownTabsOf(s)).length));
  return (
    <div className="right-body" ref={ref} data-group-body={id}>
      {id === MAIN_GROUP && mode === "all" && <PinnedBodies activeKey={activeKey} />}
      {empty && <EmptyGroup group={id} />}
    </div>
  );
}

export function editorKeyOfGroup(s: Parameters<typeof activeKeyOfGroup>[0] & { mainEditorKey: string | null }, group: string): string | null {
  const key = activeKeyOfGroup(s, group);
  if (group !== MAIN_GROUP) return key;
  return editorKeyOfMain(key, s.mainEditorKey, mainTabs(s.tabs).map((t) => t.key));
}

export function EditorCenter({ hidden }: { hidden: boolean }) {
  const quick = useStore((s) => s.quick);
  return (
    <section className="editor-center" aria-label={S.editorCenterAria} hidden={hidden}>
      <EditorArea narrow={false} maximized={false} onMaximize={() => undefined} mode="editors" />
      {quick && <QuickAsk key={quick.run?.id ?? "draft"} quick={quick} />}
    </section>
  );
}

type PinnedContextValue = { side: PinnedSide; shown: boolean; presentation: PinnedPresentation; maximized: boolean; onMaximize: () => void; toggle: () => void };
const PinnedContext = createContext<PinnedContextValue | null>(null);

export function EditorsWithSide({ maximized, onMaximize }: { maximized: boolean; onMaximize: () => void }) {
  const quick = useStore((s) => s.quick);
  const side = usePinned((s) => s.side);
  const saved = usePinned((s) => s.width);
  const collapsed = usePinned((s) => s.collapsed);
  const drawerOpen = usePinned((s) => s.drawerOpen);
  const [setRoot, panel] = useElementWidth();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const attachRoot = useCallback(
    (element: HTMLDivElement | null) => {
      rootRef.current = element;
      setRoot(element);
    },
    [setRoot],
  );
  const editorLayout = useStore((s) => s.editorLayout);
  const presentation = presentationOf(panel, collapsed);
  const shown = pinnedShown(presentation, drawerOpen);
  const baseWidth = pinnedWidth(panel, saved);
  const [drawerWidth, setDrawerWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const element = rootRef.current;
    if (!element || presentation !== "overlay" || !shown) {
      setDrawerWidth(null);
      return;
    }
    const origin = element.getBoundingClientRect().left;
    const groups = [...element.querySelectorAll<HTMLElement>(".editor-group")].map((group) => {
      const rect = group.getBoundingClientRect();
      return { left: rect.left - origin, right: rect.right - origin };
    });
    const snapped = snapDrawerWidth(panel, baseWidth, side, groups);
    setDrawerWidth(snapped === baseWidth ? null : snapped);
  }, [presentation, shown, panel, baseWidth, side, editorLayout]);
  const width = drawerWidth ?? baseWidth;
  useEffect(() => {
    if (presentation !== "overlay") setPinnedDrawer(false);
  }, [presentation]);
  useEffect(() => {
    if (presentation !== "overlay" || !drawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      setPinnedDrawer(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [presentation, drawerOpen]);
  const toggle = () => {
    const next = nextPinnedState(presentation, collapsed, drawerOpen);
    if (next.collapsed !== collapsed) setPinnedCollapsed(next.collapsed);
    setPinnedDrawer(next.drawerOpen);
  };
  return (
    <PinnedContext.Provider value={{ side, shown, presentation, maximized, onMaximize, toggle }}>
      <div className="right-split" ref={attachRoot} data-presentation={presentation} data-side={side} data-shown={shown || undefined} style={{ "--pinned-w": `${width}px` } as CSSProperties}>
        <div className="right-editors" onPointerDownCapture={() => presentation === "overlay" && drawerOpen && setPinnedDrawer(false)}>
          <EditorArea narrow={false} maximized={maximized} onMaximize={onMaximize} mode="editors" />
          {quick && <QuickAsk key={quick.run?.id ?? "draft"} quick={quick} />}
        </div>
        {presentation === "side" && (
          <Resizer
            axis="x"
            label={S.resizeSideTabs}
            target=".right-pinned"
            direction={side === "right" ? -1 : 1}
            min={PINNED_MIN}
            max={() => pinnedRange(document.querySelector(".right-split")?.getBoundingClientRect().width ?? 0).max}
            onSize={setPinnedWidth}
          />
        )}
        <div className="right-pinned" hidden={!shown}>
          <SideTabs narrow={width < WIDE_MIN} maximized={maximized} onMaximize={onMaximize} />
        </div>
      </div>
    </PinnedContext.Provider>
  );
}

function useElementWidth() {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    if (!element) return;
    const measure = () => setWidth(Math.round(element.getBoundingClientRect().width));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return [setElement, width] as const;
}

export function SideTabs({ narrow, maximized, onMaximize, standalone = false }: { narrow: boolean; maximized: boolean; onMaximize: () => void; standalone?: boolean }) {
  const selectedCardId = useStore((s) => s.selectedCardId);
  const key = useStore((s) => sideKeyOf(s.sideTabKey, !!s.selectedCardId));
  const strip = useStripScroll(key);
  const pinned = useContext(PinnedContext);
  return (
    <>
      <div className="tabs" role="tablist" data-tab-strip="side" ref={strip}>
        <div className="tab" data-active={key === "changes" || undefined} data-tab-key="changes">
          <button type="button" role="tab" className="tab-label" title={S.changesTab} onClick={() => setState({ activeTabKey: "changes" })}>
            <Diff size={14} />
            {S.changesTab}
            <ChangesBadge />
          </button>
        </div>
        <div className="tab" data-active={key === "files" || undefined} data-tab-key="files">
          <button type="button" role="tab" className="tab-label" title={S.filesTab} onClick={() => setState({ activeTabKey: "files" })}>
            <FilesIcon size={14} />
            {S.filesTab}
          </button>
        </div>
        <div className="tab" data-active={key === "scm" || undefined} data-tab-key="scm">
          <button type="button" role="tab" className="tab-label" title={M.tab} onClick={() => setState({ activeTabKey: "scm" })}>
            <Codicon name="source-control" size={14} />
            {M.tab}
          </button>
        </div>
        <div className="tab" data-active={key === "search" || undefined} data-tab-key="search">
          <button type="button" role="tab" className="tab-label" title={S.searchSideTab} onClick={() => setState({ activeTabKey: "search", focusSearchInput: Date.now() })}>
            <Codicon name="search" size={14} />
            {S.searchSideTab}
          </button>
        </div>
        {selectedCardId && (
          <div className="tab" data-active={key === "card" || undefined} data-kind="card" data-tab-key="card">
            <button type="button" role="tab" className="tab-label" onClick={() => setState({ activeTabKey: "card" })}>
              {S.cardDetail}
            </button>
            <Button size="icon" className="tab-close" aria-label={S.closeCard} title={S.closeCard} onClick={() => closeCard()}>
              <Close size={14} />
            </Button>
          </div>
        )}
        {standalone && <AddTabMenu group={MAIN_GROUP} />}
        <div className="tabs-tail">
          <span className="focus-side-actions" data-slot="scm" role="toolbar" aria-label={S.scmTitleActionsAria} hidden={key !== "scm"} />
          <MainActions changesTab={key === "changes"} narrow={narrow} maximized={maximized} onMaximize={onMaximize} maximize={!pinned && !narrow} />
          {!narrow && <ListToggle changesTab={key === "changes"} />}
          {pinned ? (
            <Button size="icon" aria-label={S.hidePinned} title={S.hidePinned} onClick={pinned.toggle}>
              <Close />
            </Button>
          ) : (
            <ClosePanelButton />
          )}
        </div>
      </div>
      <div className="right-body" data-group-body="side">
        <PinnedBodies activeKey={key} withQuick={standalone} />
      </div>
    </>
  );
}

export function PinnedBodies({ activeKey, withQuick = true }: { activeKey: string | null; withQuick?: boolean }) {
  const agent = useStore((s) => activeAgentOf(s.panes, s.activePaneId, s.agents));
  const editorWorkspaceId = useStore((s) => agent && s.editorSessionChangesId === agent.id ? null : editorGitWorkspaceOf(s));
  const draftWorkspaceId = useStore((s) => {
    const pane = s.panes.find((p) => p.id === s.activePaneId);
    return pane?.kind === "draft" ? pane.workspaceId : null;
  });
  const selectedCardId = useStore((s) => s.selectedCardId);
  const quick = useStore((s) => s.quick);
  return (
    <>
      {activeKey === "card" && selectedCardId && <CardDetail />}
      {activeKey === "changes" && <ActiveChanges agent={agent} editorWorkspaceId={editorWorkspaceId} draftWorkspaceId={draftWorkspaceId} />}
      {activeKey === "files" && (agent ? inFolder(agent) ? isMultiRoot(agent) ? <FilesRoots key={agent.id} agent={agent} /> : <FilesTab key={agent.id} workspaceId={agent.workspaceId} agentId={agent.id} /> : null : draftWorkspaceId ? <FilesTab key={draftWorkspaceId} workspaceId={draftWorkspaceId} agentId={null} /> : <div className="empty-hint">{S.openChangesHint}</div>)}
      {activeKey === "scm" && <SourceControlTab />}
      {activeKey === "search" && <SearchView />}
      {withQuick && quick && <QuickAsk key={quick.run?.id ?? "draft"} quick={quick} />}
    </>
  );
}

function ActiveChanges({ agent, editorWorkspaceId, draftWorkspaceId }: { agent: ReturnType<typeof activeAgentOf>; editorWorkspaceId: string | null; draftWorkspaceId: string | null }) {
  if (editorWorkspaceId) return <DraftChanges key={editorWorkspaceId} workspaceId={editorWorkspaceId} openAsDiff />;
  if (agent) return inFolder(agent) ? <ChangesPanel key={agent.id} agent={agent} /> : <ChatChanges />;
  if (draftWorkspaceId) return <DraftChanges key={draftWorkspaceId} workspaceId={draftWorkspaceId} />;
  return <div className="empty-hint">{S.openChangesHint}</div>;
}

export function TabBodies() {
  const tabs = useStore((s) => s.tabs);
  return (
    <>
      {tabs.map((tab) => (
        <TabBody key={tab.key} tab={tab} />
      ))}
    </>
  );
}

function TabBody({ tab }: { tab: Tab }) {
  const group = tab.group ?? MAIN_GROUP;
  const { wrapper, scroll } = useMemo(() => {
    const element = document.createElement("div");
    element.style.display = "contents";
    element.dataset.tabBody = tab.key;
    return { wrapper: element, scroll: scrollMemory(element) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const body = useGroupBody(group);
  useLayoutEffect(() => scroll.watch(), [scroll]);
  useLayoutEffect(() => {
    if (!body || wrapper.parentElement === body) return;
    body.appendChild(wrapper);
    scroll.restore();
  }, [body, wrapper, scroll]);
  useLayoutEffect(() => () => wrapper.remove(), [wrapper]);
  const active = useStore((s) => isShown(tab, shownAgentsOf(s)) && (group === MAIN_GROUP ? editorKeyOfGroup(s, group) : activeKeyOfGroup(s, group)) === tab.key);
  const content = tab.kind === "file" || tab.kind === "untitled" ? <Editor tab={tab} active={active} /> : tab.kind === "browser" ? <BrowserTabView tab={tab} active={active} /> : tab.kind === "search" ? <SearchTabView tab={tab} active={active} /> : tab.kind === "pr" ? <PullRequestTab tab={tab} active={active} /> : tab.kind === "scm" ? <ScmDiffView tab={tab} active={active} /> : tab.kind === "replace" ? <ReplacePreviewView tab={tab} active={active} /> : tab.kind === "chat" ? <ChatTabView agentId={tab.agentId} tabKey={tab.key} active={active} /> : <DiffTab tabKey={tab.key} agentId={tab.agentId} workspaceId={tab.workspaceId} path={tab.path} changeScope={tab.scope} active={active} />;
  return createPortal(content, wrapper);
}

function DragOverlay() {
  const drag = useTabDrag();
  if (!drag) return null;
  const target = drag.target;
  const ghost: CSSProperties = { left: drag.x + 8, top: drag.y + 8 };
  return (
    <>
      <div className="tab-ghost" style={ghost} data-copy={drag.copy || undefined}>
        {drag.label}
      </div>
      {target?.kind === "strip" && <div className="tab-drop-mark" style={{ left: target.x, top: target.top, height: target.height }} />}
      {target?.kind === "edge" && <div className="group-drop-overlay" style={{ left: target.rect.left, top: target.rect.top, width: target.rect.width, height: target.rect.height }} />}
      {target?.kind === "body" && <BodyDropOverlay group={target.group} />}
    </>
  );
}

function BodyDropOverlay({ group }: { group: string }) {
  const body = useGroupBody(group);
  const rect = body?.getBoundingClientRect();
  if (!rect) return null;
  return <div className="group-drop-overlay" style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }} />;
}
