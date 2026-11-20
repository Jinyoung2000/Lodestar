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
import { DiffTab } from "./DiffView";
import { ScmDiffView } from "./ScmDiffView";
import { type EditorLayout, groupIdsOf, MAIN_GROUP, mainTabs, tabsOfGroup } from "./editorGroups";
import { closable } from "./editorTabs";
import { EmptyGroup, GroupMoreMenu, tabName } from "./EditorGroupExtras";
import { RecentEditors } from "./RecentEditors";
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

// 오른쪽 패널의 에디터 영역: 분할 트리(web/editorGroups.ts)대로 에디터 그룹을 그리고, 그룹마다 탭줄과 본문을 가진다.
// main 그룹은 변경, 파일 탭(과 카드, 인박스 상세)이 있는 첫 탭줄이다. 탭 본문은 한 번 만든 뒤 DOM 을 옮겨 그룹 사이를 오가므로(TabBodies) 에디터의 편집 내용과 되돌리기 기록이 그대로 따라간다.

// mode "all" 은 Chat 중심의 오른쪽 패널(고정 탭과 에디터 탭이 한 탭줄), "editors" 는 Editor 중심의 가운데(에디터 탭만, 고정 탭은 오른쪽 SideTabs).
type AreaProps = { narrow: boolean; maximized: boolean; onMaximize: () => void; mode: "all" | "editors" };
// bar 는 탭줄의 빈 곳을 우클릭한 메뉴(Split 계열만). 이때 key 는 그룹의 활성 탭이다.
type TabMenu = { key: string | null; group: string; x: number; y: number; bar?: boolean };

export function EditorArea({ narrow, maximized, onMaximize, mode = "all" }: Omit<AreaProps, "mode"> & { mode?: AreaProps["mode"] }) {
  const layout = useStore((s) => s.editorLayout);
  // Editor 중심에서는 상태 표시줄을 App 이 창 맨 아래(Panel 아래)에 따로 그린다
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

// 가로로 나뉜 그룹들은 GROUP_MIN 아래로 눌리지 않는다. 모자라면 한 화면에 온전히 들어가는 그룹 수만큼 그룹 폭을 키워 칸 영역을 채우고(stretchedMin) 줄이 가로 스크롤되며 경계에 선다(styles.css 의 scroll-snap).
function EditorSplit({ node, area, onMenu }: { node: Extract<EditorLayout, { type: "split" }>; area: AreaProps; onMenu: (menu: TabMenu) => void }) {
  const [setRoot, width] = useElementWidth();
  // 최대화한 그룹이 이 분할 안에 있으면 그 그룹을 품은 칸만 남고 나머지 칸은 접힌다(Toggle Maximize Editor Group).
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

// keeps 는 최대화로 남기는 칸의 자리(없으면 -1). 남기는 칸이 있으면 다른 칸과 그 칸 앞의 경계는 접힌다.
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

// 그룹 사이 경계. 끄는 동안 양옆 두 그룹만 크기를 주고받고 각 그룹은 GROUP_MIN 아래로 줄지 않는다. 더블클릭은 같은 크기로 되돌린다.
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
      // 합성 PointerEvent(검증 창구)는 활성 포인터가 아니라 캡처가 거절된다. window 리스너로 끝까지 따라가므로 없어도 된다.
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
  // 탭 본문은 포털(TabBodies)로 그려져 React 이벤트가 이 요소를 거치지 않는다. 에디터 본문을 눌러도 그룹이 포커스되도록 DOM 이벤트로 받는다.
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

// --- 탭줄 ---

function GroupStrip({ id, activeKey, area, onMenu }: { id: string; activeKey: string | null; area: AreaProps; onMenu: (menu: TabMenu) => void }) {
  const editorsOnly = area.mode === "editors";
  // editors 모드의 main 그룹은 고정 탭 자리가 없는 평범한 에디터 그룹이다(오른쪽 패널이 고정 탭을 갖는다).
  const main = id === MAIN_GROUP && !editorsOnly;
  const tabs = useStore((s) => s.tabs);
  const agents = useStore((s) => shownAgentsOf(s));
  const filesIndex = useStore((s) => s.filesIndex);
  const selectedCardId = useStore((s) => s.selectedCardId);
  // PRTABSESSION: filesIndex 는 숨겨진 탭까지 센 main 그룹 위치다. 나눈 다음에 보이지 않는 세션의 PR 탭을 뺀다.
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

// 고정 칸이 에디터 옆에 있을 때(EditorsWithSide) 맞닿은 그룹의 탭줄에 두는 패널 단추: 패널 최대화와, 고정 칸이 접혀 있거나 서랍이 닫혀 있을 때 다시 펴는 단추.
// 펴는 단추는 고정 칸이 붙은 쪽 끝에 둔다(Right 면 탭줄 오른쪽 끝, Left 면 왼쪽 끝).
// X 는 자기가 놓인 칸만 닫는다. 고정 칸 탭줄의 X 는 고정 칸만 접으므로, 패널 전체를 닫는 X 는 고정 칸이 안 보여 에디터만 남았을 때만 여기 둔다.
function PanelActions({ group, edge }: { group: string; edge: PinnedSide }) {
  const pinned = useContext(PinnedContext);
  const layout = useStore((s) => s.editorLayout);
  if (!pinned || edgeGroupOf(layout, edge) !== group) return null;
  const show = !pinned.shown && pinned.side === edge;
  // 최대화와 패널 닫기는 패널 오른쪽 끝에, 펴는 단추는 고정 칸이 붙은 쪽 끝에 둔다
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

// 탭줄의 + 단추: Browser, Search, 새 파일 탭
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

// 탭이 많아 줄이 넘칠 때 활성 탭이 오른쪽 꼬리 단추(.tabs-tail, sticky)에 가려지지 않게 한다: 꼬리 폭만큼 scroll-padding-right 를 주고 활성 탭을 보이는 곳으로 스크롤한다.
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
    // 활성 탭이 바뀌면 꼬리 단추 수도 바뀌므로(ResizeObserver 는 한 박자 늦다) 스크롤 직전에 폭을 다시 읽는다
    const tail = strip.current?.querySelector<HTMLElement>(":scope > .tabs-tail");
    if (strip.current && tail) strip.current.style.scrollPaddingRight = `${tail.offsetWidth}px`;
    const element = strip.current;
    if (!element) return;
    // 활성 탭이 보이게 하되 왼쪽 끝에 잘린 탭이 남지 않게 탭 경계에 맞춘다(web/tabStrip.ts).
    // 탭이 막 생기거나 포커스가 옮겨 가며 브라우저가 따로 스크롤하는 일이 있어, 레이아웃이 자리 잡은 다음 프레임에 한 번 더 맞춘다.
    const align = () => {
      const items = Array.from(element.querySelectorAll<HTMLElement>(":scope > .tab[data-tab-key]"));
      const base = element.getBoundingClientRect().left - element.scrollLeft;
      const boxes = items.map((item) => {
        const rect = item.getBoundingClientRect();
        return { left: rect.left - base, right: rect.right - base };
      });
      const next = stripScrollTarget({ scrollLeft: element.scrollLeft, width: element.clientWidth, padRight: element.querySelector<HTMLElement>(":scope > .tabs-tail")?.offsetWidth ?? 0, tabs: boxes, active: items.findIndex((item) => item.dataset.tabKey === activeKey) });
      // 마지막 탭들 쪽에서는 다음 탭 경계가 스크롤 끝 너머일 수 있다. 그때만 끝에 빈 자리(--tabs-extra)를 더해 닿을 수 있게 하고, 필요 없으면 거둔다.
      const natural = element.scrollWidth - element.clientWidth - (Number.parseFloat(element.style.getPropertyValue("--tabs-extra")) || 0);
      const extra = Math.max(0, Math.ceil(next - natural));
      element.style.setProperty("--tabs-extra", `${extra}px`);
      if (Math.abs(next - element.scrollLeft) > 0.5) element.scrollTo({ left: next, behavior: "instant" });
    };
    align();
    const frame = requestAnimationFrame(() => requestAnimationFrame(align));
    // 창이나 패널 폭이 바뀌어 탭 줄 폭이 달라져도 같은 규칙으로 다시 맞춘다. 활성 탭이 그대로여도 줄어든 폭에서 왼쪽 끝에 잘린 탭 조각이 남았다(round-5 발견 18, 오른쪽 패널 200px).
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
  // 대화 탭은 세션 제목이 바뀌면 따라간다
  const chatTitle = useStore((s) => (tab.kind === "chat" ? s.agents.find((a) => a.id === tab.agentId)?.title : undefined));
  const name = chatTitle || tabName(tab);
  const title = tab.kind === "search" ? S.searchTabTitle(tab.query) : tab.kind === "pr" ? P.tabTitle(tab.repo, tab.number) : tab.kind === "browser" ? tabTooltip(tab.title, tab.url) : tab.kind === "untitled" || tab.kind === "chat" ? name : tab.kind === "diff" ? `${S.diffTab} ${tab.path}` : tab.kind === "scm" ? M.scmTabTitle(tab.section, tab.path) : tab.path;
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
        {tab.kind === "diff" && <span className="muted">{S.diffTab}</span>}
        {tab.kind === "scm" && <span className="muted">{tab.section === "staged" ? M.sectionStaged : S.diffTab}</span>}
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

// --- 탭 우클릭 메뉴 ---

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

// --- main 그룹의 탭줄 오른쪽 단추 ---

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

// --- 본문 ---

// 그룹 본문 요소 등록부. 탭 본문(TabBody)이 자기 그룹의 본문 요소를 찾아 DOM 을 옮겨 붙인다.
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

// Editor 중심에서 가운데 그룹이 보일 탭. main 그룹이 고정 키를 기억하고 있어도 에디터 탭을 고른다.
export function editorKeyOfGroup(s: Parameters<typeof activeKeyOfGroup>[0] & { mainEditorKey: string | null }, group: string): string | null {
  const key = activeKeyOfGroup(s, group);
  if (group !== MAIN_GROUP) return key;
  return editorKeyOfMain(key, s.mainEditorKey, mainTabs(s.tabs).map((t) => t.key));
}

// --- Editor 중심: 가운데 에디터와 오른쪽 고정 탭 ---

// 가운데 영역 전체. 에디터 그룹이 이 안에서 분할되고, 빠른 질문(⌘I) 창도 여기서 뜬다(오른쪽 패널이 닫혀 있어도 보여야 한다).
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

// Chat 중심에서 에디터 탭이 열려 있을 때의 오른쪽 패널: 에디터 그룹 옆에 고정 탭(Changes, Files)이 한 칸으로 붙는다. 위치는 Settings 의 Changes and Files position(기본 Right).
// 칸은 끌어서 폭을 바꾸고(폭과 접힘은 기억), 접을 수 있다. 패널이 에디터 최소 폭과 칸 최소 폭을 다 못 담을 만큼 좁으면 칸이 에디터 위에 서랍으로 뜬다. 계산은 web/pinnedLayout.ts.
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
  // FIXY: 서랍 옆에 다른 에디터 그룹의 얇은 조각이 남으면 서랍을 그 그룹 가장자리까지 넓혀 가린다
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
  // 서랍은 Esc 로 닫는다
  useEffect(() => {
    if (presentation !== "overlay" || !drawerOpen) return;
    // 서랍 안에서 연 확인 창을 Esc 로 닫을 때(Radix 가 preventDefault 한 Esc) 서랍까지 닫혀 포커스가 BODY 로 가지 않게 한다
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

// 요소 폭을 지켜본다. 처음 그릴 때는 0 이고, 붙는 즉시 잰다.
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

// Editor 중심의 오른쪽 패널 탭줄: Changes, Files, 열린 카드. 에디터 탭은 가운데에 있다.
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
  // 새 세션 화면(고른 폴더가 있는 초안 칸)에서는 Files 탭이 그 폴더의 트리를 보인다
  const draftWorkspaceId = useStore((s) => {
    const pane = s.panes.find((p) => p.id === s.activePaneId);
    return pane?.kind === "draft" ? pane.workspaceId : null;
  });
  const selectedCardId = useStore((s) => s.selectedCardId);
  const quick = useStore((s) => s.quick);
  return (
    <>
      {activeKey === "card" && selectedCardId && <CardDetail />}
      {activeKey === "changes" && (agent ? inFolder(agent) ? <ChangesPanel key={agent.id} agent={agent} /> : <ChatChanges /> : draftWorkspaceId ? <DraftChanges key={draftWorkspaceId} workspaceId={draftWorkspaceId} /> : <div className="empty-hint">{S.openChangesHint}</div>)}
      {activeKey === "files" && (agent ? inFolder(agent) ? <FilesTab key={agent.id} workspaceId={agent.workspaceId} agentId={agent.id} /> : <div className="empty-hint">{S.chatNoFiles}</div> : draftWorkspaceId ? <FilesTab key={draftWorkspaceId} workspaceId={draftWorkspaceId} agentId={null} /> : <div className="empty-hint">{S.openChangesHint}</div>)}
      {activeKey === "scm" && <SourceControlTab />}
      {activeKey === "search" && <SearchView />}
      {withQuick && quick && <QuickAsk key={quick.run?.id ?? "draft"} quick={quick} />}
    </>
  );
}

// 모든 탭의 본문. 탭마다 한 번 만든 요소(display: contents)에 포털로 그리고, 그 요소를 탭이 속한 그룹의 본문에 붙인다.
// 탭을 다른 그룹으로 옮기면 요소만 옮겨 가서 React 트리는 그대로다(에디터가 다시 만들어지지 않는다). Browser 탭의 webview 는 DOM 이 옮겨지면 페이지를 다시 읽는다.
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
  const wrapper = useMemo(() => {
    const element = document.createElement("div");
    element.style.display = "contents";
    element.dataset.tabBody = tab.key;
    return element;
    // 키가 같은 동안 같은 요소를 쓴다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const body = useGroupBody(group);
  useLayoutEffect(() => {
    if (body && wrapper.parentElement !== body) body.appendChild(wrapper);
  }, [body, wrapper]);
  useLayoutEffect(() => () => wrapper.remove(), [wrapper]);
  // 보이지 않는 세션의 PR 탭은 마운트된 채 남지만 활성이 되는 일은 없다
  const active = useStore((s) => isShown(tab, shownAgentsOf(s)) && (group === MAIN_GROUP ? editorKeyOfGroup(s, group) : activeKeyOfGroup(s, group)) === tab.key);
  const content = tab.kind === "file" || tab.kind === "untitled" ? <Editor tab={tab} active={active} /> : tab.kind === "browser" ? <BrowserTabView tab={tab} active={active} /> : tab.kind === "search" ? <SearchTabView tab={tab} active={active} /> : tab.kind === "pr" ? <PullRequestTab tab={tab} active={active} /> : tab.kind === "scm" ? <ScmDiffView tab={tab} active={active} /> : tab.kind === "replace" ? <ReplacePreviewView tab={tab} active={active} /> : tab.kind === "chat" ? <ChatTabView agentId={tab.agentId} tabKey={tab.key} active={active} /> : <DiffTab agentId={tab.agentId} workspaceId={tab.workspaceId} path={tab.path} changeScope={tab.scope} active={active} />;
  return createPortal(content, wrapper);
}

// --- 끄는 동안의 표시 ---

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
