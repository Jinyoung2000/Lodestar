import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { moveBottomTab, useBottomTabOrder, type BottomTab } from "./bottomTabOrder";
import { AutomationEditorHost, AutomationsView, BoardView, FollowUpsView, ImprovementsView, InboxView, NotionView, Overlays, PullRequestView, SettingsView, SideChat, SkillsView, TerminalView } from "./lazyViews";
import { FeedbackLayer } from "./Feedback";
import { ChevronDown, Close, Codicon, Plus, Split, TerminalIcon, Warning } from "./icons";
import { ChordHint } from "./ChordHint";
import { NoticeStack } from "./NoticeStack";
import { ToBoardPopover } from "./ToBoardPopover";
import { LiveAnnouncer } from "./LiveAnnouncer";
import { NotionLinkMenu } from "./NotionLinkMenu";
import { useDockBadge } from "./useDockBadge";
import { countBadge } from "./countBadge";
import { SessionSwitcherView } from "./SessionSwitcherView";
import { ProblemsPanel, useProblemFiles } from "./ProblemsPanel";
import { countProblems } from "./problemsModel";
import { sessionPanelShown } from "./centerPanels";
import { PaneGrid } from "./PaneGrid";
import { panesMinWidth, rightRange, sidebarMax } from "./paneFit";
import { PANE_MIN } from "./paneDrop";
import { PINNED_EDITOR_MIN } from "./pinnedLayout";
import { EffortPicker, ModelPicker } from "./ModelPopover";
import { EditorCenter, TabBodies } from "./EditorArea";
import { EditorStatus } from "./EditorStatus";
import { DaemonBanner } from "./DaemonBanner";
import { Resizer } from "./Resizer";
import { RightPanel } from "./RightPanel";
import { FocusSideBar, useBodyWidth } from "./FocusSideBar";
import { DOCK_MIN, FOCUS_SIDE_MIN, dockFitWidth, dockRange, dockWidth, focusShown, focusSideRange, focusSideWidth } from "./focusLayout";
import { setFocusSideWidth, useFocusSideWidth } from "./focusPrefs";
import { gridPlan, gridVars } from "./layoutConfig";
import { useLayoutConfig } from "./layoutConfigStore";
import { bodyHeight, centerWidth, watchCenterWidth } from "./workbenchGrid";
import { Sidebar } from "./Sidebar";
import { SidebarPeek } from "./SidebarPeek";
import { TitleBar } from "./TitleBar";
import { activeAgentOf } from "./activeAgentOf";
import { handleNotificationAction, type NotificationAction } from "./notifications";
import { IN_ELECTRON, isChordPending, runCommand, runShortcut, type ShortcutEvent } from "./shortcuts";
import { rpc } from "./rpc";
import { addTerminal, closeTerminal, panelWidthKey,setChatDockWidth, setLayout, setPanelWidth, setState, shownTabsOf, splitTerminal, useStore } from "./store";
import { terminalScopeFor, workspaceForTerminal } from "./terminalScope";
import { Button } from "./ui/button";
import { ConfirmHost } from "./ConfirmDialog";
import { visibleCenterView } from "./screenVisibility";
import { S } from "./strings";
import { useCommandKey } from "./commandKeys";

export function App() {
  useDockBadge();
  const overlay = useStore((s) => s.overlay);
  const side = useStore((s) => s.side);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const rightOpen = useStore((s) => s.rightOpen);
  const bottomOpen = useStore((s) => s.bottomOpen);
  const [bottomEverOpened, setBottomEverOpened] = useState(false);
  useEffect(() => {
    if (bottomOpen) setBottomEverOpened(true);
  }, [bottomOpen]);
  const layout = useStore((s) => s.layout);
  const panelWidth = useStore((s) => s.panelWidths[panelWidthKey(s)] ?? null);
  const centerView = useStore((s) => visibleCenterView(s.centerView, s.settings));
  const singleColumn = useStore((s) => visibleCenterView(s.centerView, s.settings) !== "sessions" || s.grid.rows.every((r) => r.ids.length <= 1));
  const editorLayout = useStore((s) => s.layoutMode === "editor");
  const focusSideOpen = useStore((s) => s.focusSideOpen);
  const chatDock = useStore((s) => s.chatDock);
  const chatDockOpen = useStore((s) => s.chatDockOpen);
  const chatDockWidth = useStore((s) => s.chatDockWidth);
  const focusSaved = useFocusSideWidth();
  const bodyWidth = useBodyWidth();
  const layoutConfig = useLayoutConfig();
  const plan = gridPlan(layoutConfig);
  useLayoutEffect(() => {
    document.body.dataset.sidebarSide = layoutConfig.sideBar;
  }, [layoutConfig.sideBar]);
  const shown = focusShown({ editorLayout, sessionsView: centerView === "sessions", chatDock, sideOpen: focusSideOpen, dockOpen: chatDockOpen });
  const dockPx = shown.dock ? dockWidth(chatDockWidth, bodyWidth) : 0;
  useLayoutEffect(() => watchCenterWidth(), [sidebarOpen, focusSideOpen, editorLayout, centerView, layout.sidebarWidth, focusSaved, bodyWidth, layoutConfig.sideBar, rightOpen, chatDock]);
  const editing = useStore((s) => s.layoutMode !== "editor" && shownTabsOf(s).length > 0);
  const singleReserve = editing ? CHAT_EDITING : CHAT_FLOOR;
  const chatReserve = editorLayout ? EDITOR_FLOOR : singleColumn ? singleReserve : CHAT_MIN;
  const rowCols = useStore((s) => s.grid.rows.reduce((most, r) => Math.max(most, r.ids.length), 0));
  const panesReserve = editorLayout ? EDITOR_FLOOR : singleColumn ? singleReserve : panesMinWidth([rowCols]);
  const rightMin = editing && !editorLayout && !singleColumn ? PINNED_EDITOR_MIN : RIGHT_MIN;
  const centerStyle: Record<string, string> = {};
  if (!singleColumn && !editorLayout) centerStyle["--panes-reserve"] = `${panesReserve}px`;

  useEffect(() => {
    document.body.dataset.electron = IN_ELECTRON ? "1" : "";
    const early = new WeakSet<Event>();
    const onKeyDownCapture = (event: globalThis.KeyboardEvent) => {
      if (!isChordPending()) return;
      early.add(event);
      runShortcut(event);
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (!early.has(event)) runShortcut(event);
    };
    const onCommand = (event: Event) => runCommand((event as CustomEvent<string>).detail);
    const onKey = (event: Event) => runShortcut((event as CustomEvent<ShortcutEvent>).detail);
    window.addEventListener("keydown", onKeyDownCapture, true);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("agent-nav:key", onKey);
    window.addEventListener("agent-nav:command", onCommand);
    const onNotification = (event: Event) => handleNotificationAction((event as CustomEvent<NotificationAction>).detail);
    window.addEventListener("agent-nav:notification", onNotification);
    return () => {
      window.removeEventListener("agent-nav:notification", onNotification);
      window.removeEventListener("keydown", onKeyDownCapture, true);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("agent-nav:key", onKey);
      window.removeEventListener("agent-nav:command", onCommand);
    };
  }, []);

  return (
    <div className="app">
      <TitleBar />
      <DaemonBanner />
      <div className="body" data-side={layoutConfig.sideBar} data-panel={layoutConfig.panelAlignment} style={gridVars(layoutConfig)}>
        {shown.side && (
          <>
            <FocusSideBar width={focusSideWidth(focusSaved, bodyWidth, dockPx)} />
            <Resizer
              className="primary-resizer"
              axis="x"
              label={S.resizeFocusSide}
              target=".focus-side"
              direction={plan.primaryDirection}
              min={FOCUS_SIDE_MIN}
              max={() => focusSideRange(document.querySelector(".body")?.getBoundingClientRect().width ?? 0, dockPx).max}
              onSize={setFocusSideWidth}
            />
          </>
        )}
        {!editorLayout && sidebarOpen && (
          <>
            <Sidebar width={layout.sidebarWidth} />
            <Resizer
              className="primary-resizer"
              axis="x"
              label={S.resizeSidebar}
              target=".sidebar"
              direction={plan.primaryDirection}
              min={SIDEBAR_MIN}
              max={() => sidebarMax(document.querySelector(".body")?.getBoundingClientRect().width ?? 0, rightOpen ? rightMin : 0, singleColumn || editorLayout ? chatReserve : PANE_MIN, SIDEBAR_MAX, SIDEBAR_MIN)}
              onSize={(px) => setLayout({ sidebarWidth: px })}
            />
          </>
        )}
        <div className="center-and-bottom">
          <div className="center" data-columns={singleColumn ? "one" : "many"} data-layout={editorLayout ? "editor" : "chat"} data-editing={editing || undefined} style={centerStyle}>
            <PaneGrid hidden={centerView !== "sessions"} />
            {shown.dock && (
              <Resizer
                className="dock-resizer secondary-resizer"
                axis="x"
                label={S.resizeChatDock}
                target=".panes"
                direction={plan.secondaryDirection}
                min={DOCK_MIN}
                max={() => dockRange(centerWidth()).max}
                onSize={(px) => setChatDockWidth(px ?? fitDockWidth())}
              />
            )}
            {editorLayout && <EditorCenter hidden={centerView !== "sessions"} />}
            {centerView === "board" && <BoardView />}
            {centerView === "inbox" && <InboxView />}
            {centerView === "improvements" && <ImprovementsView />}
            {centerView === "pr" && <PullRequestView />}
            {centerView === "notion" && <NotionView />}
            {centerView === "skills" && <SkillsView />}
            {centerView === "automations" && <AutomationsView />}
            {centerView === "followUps" && <FollowUpsView />}
            {side && <SideChat key={side.id} side={side} />}
            {rightOpen && !editorLayout && (
              <>
                <Resizer
                  className="secondary-resizer"
                  hidden={!sessionPanelShown(centerView, rightOpen)}
                  axis="x"
                  label={S.resizeRight}
                  target=".right"
                  direction={plan.secondaryDirection}
                  min={rightMin}
                  max={() =>
                    rightRange({
                      center: centerWidth(),
                      sideChat: 0,
                      panesReserve,
                      squeezeReserve: chatReserve,
                      narrow: rightMin,
                    }).max
                  }
                  onSize={(px) => setPanelWidth(px)}
                />
                <RightPanel hidden={!sessionPanelShown(centerView, rightOpen)} width={panelWidth} />
              </>
            )}
          </div>
          {(bottomOpen || bottomEverOpened) && (
            <>
              {bottomOpen && (
                <Resizer
                  className="bottom-resizer"
                  axis="y"
                  label={S.resizeBottom}
                  target=".bottom"
                  direction={-1}
                  min={BOTTOM_MIN}
                  max={() => bodyHeight() * 0.6}
                  onSize={(px) => setLayout({ bottomHeight: px })}
                />
              )}
              <BottomPanel height={layout.bottomHeight} hidden={!bottomOpen} />
            </>
          )}
          {editorLayout && centerView === "sessions" && <EditorStatus />}
        </div>
      </div>
      {(editorLayout || rightOpen) && <TabBodies />}
      {!editorLayout && <SidebarPeek />}
      <Overlays />
      <SessionSwitcherView />
      <ConfirmHost />
      <AutomationEditorHost />
      {overlay?.kind === "models" && <ModelPicker />}
      {overlay?.kind === "effort" && <EffortPicker />}
      {overlay?.kind === "status" && <SettingsView />}
      <FeedbackLayer />
      <NoticeStack />
      <LiveAnnouncer />
      <NotionLinkMenu />
      <ToBoardPopover />
      <ChordHint />
    </div>
  );
}

function fitDockWidth(): number | null {
  const timeline = document.querySelector<HTMLElement>(".panes .timeline");
  const ctx = document.createElement("canvas").getContext("2d");
  if (!timeline || !ctx) return null;
  const style = getComputedStyle(timeline);
  ctx.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  const pad = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
  return dockFitWidth(ctx.measureText("0").width, pad, centerWidth());
}

const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 400;
const RIGHT_MIN = 300;
const CHAT_MIN = 360;
const CHAT_FLOOR = 300;
const CHAT_EDITING = 440;
const EDITOR_FLOOR = 320;
const BOTTOM_MIN = 120;

const TAB_DRAG_THRESHOLD = 4;

const NO_TERMINALS: { id: string; name: string; dir?: string }[] = [];

function BottomPanel({ height, hidden }: { height: number | null; hidden: boolean }) {
  const bottomKey = useCommandKey("toggleBottom");
  const tab = useStore((s) => s.bottomTab);
  const agent = useStore((s) => activeAgentOf(s.panes, s.activePaneId, s.agents));
  const workspace = useStore((s) => workspaceForTerminal(s));
  const scope = terminalScopeFor(agent, workspace);
  const terminals = useStore((s) => s.terminals[scope.key] ?? NO_TERMINALS);
  const activeTerminal = useStore((s) => s.activeTerminal[scope.key]);
  const split = useStore((s) => s.splitTerminals);
  const [log, setLog] = useState<string[]>([]);
  const problems = countProblems(useProblemFiles());
  const problemTotal = problems.total;
  useEffect(() => {
    if (tab !== "output") return;
    const load = () => void rpc.call("logs.tail", { lines: 300 }).then(setLog);
    load();
    const timer = setInterval(load, 2000);
    return () => clearInterval(timer);
  }, [tab]);
  const needsTerminal = tab === "terminal" && !hidden && terminals.length === 0;
  useEffect(() => {
    if (needsTerminal) addTerminal(scope.key);
  }, [needsTerminal, scope.key]);
  const current = terminals.find((t) => t.id === activeTerminal) ?? terminals[terminals.length - 1];
  const order = useBottomTabOrder();
  const stripRef = useRef<HTMLDivElement>(null);
  const suppressClick = useRef(false);
  const [drag, setDrag] = useState<{ x: number; top: number; height: number } | null>(null);
  function startTabDrag(event: ReactPointerEvent, dragged: BottomTab) {
    if (event.button !== 0) return;
    const startX = event.clientX;
    let moved = false;
    let before: BottomTab | null = null;
    const onMove = (e: PointerEvent) => {
      if (!moved && Math.abs(e.clientX - startX) < TAB_DRAG_THRESHOLD) return;
      moved = true;
      const strip = stripRef.current;
      if (!strip) return;
      const boxes = order.flatMap((key) => {
        const box = strip.querySelector(`.bottom-tab[data-tab="${key}"]`)?.getBoundingClientRect();
        return box ? [{ key, box }] : [];
      });
      const target = boxes.find(({ box }) => e.clientX < box.left + box.width / 2);
      const last = boxes[boxes.length - 1];
      const stripBox = strip.getBoundingClientRect();
      const gap = parseFloat(getComputedStyle(strip).columnGap) || 0;
      before = target?.key ?? null;
      const x = target ? target.box.left - gap / 2 : last ? last.box.right + gap / 2 : stripBox.left;
      setDrag({ x, top: stripBox.top, height: stripBox.height });
    };
    const finish = (commit: boolean) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey, true);
      setDrag(null);
      if (!moved) return;
      suppressClick.current = true;
      requestAnimationFrame(() => (suppressClick.current = false));
      if (commit) moveBottomTab(dragged, before);
    };
    const onUp = () => finish(true);
    const onCancel = () => finish(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !moved) return;
      e.preventDefault();
      e.stopPropagation();
      finish(false);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey, true);
  }
  return (
    <section className="bottom" aria-label={S.bottomPanelAria} hidden={hidden} style={height == null ? undefined : { height }}>
      <div className="bottom-tabs" ref={stripRef}>
        {order.map((key) => (
          <button
            key={key}
            type="button"
            className="bottom-tab"
            data-tab={key}
            data-active={tab === key || undefined}
            onPointerDown={(event) => startTabDrag(event, key)}
            aria-label={key === "output" ? S.output : key === "problems" ? S.problems : S.terminal}
            title={key === "output" ? S.output : key === "problems" ? S.problems : S.terminal}
            onClick={() => !suppressClick.current && setState({ bottomTab: key })}
          >
            {key === "output" ? <Codicon name="output" /> : key === "problems" ? <Warning /> : <TerminalIcon />}
            {key === "problems" && problemTotal > 0 && (
              <span className="bottom-tab-count" title={S.problemsTip(problems.errors, problems.warnings)}>
                {countBadge(problemTotal)}
              </span>
            )}
          </button>
        ))}
        {drag && <div className="tab-drop-mark" style={{ left: drag.x, top: drag.top, height: drag.height }} />}
        <span className="spacer" />
        {tab === "terminal" && (
          <>
            <span className="faint xs mono bottom-terminal-name">{current?.name ?? ""}</span>
            <Button size="icon" aria-label={S.addTerminal} title={S.addTerminal} onClick={() => addTerminal(scope.key)}>
              <Plus />
            </Button>
            <Button size="icon" variant="ghost" aria-label={S.splitTerminal} title={S.splitTerminal} onClick={() => splitTerminal(scope.key)}>
              <Split />
            </Button>
            {split && terminals.length > 1 && (
              <Button size="icon" variant="ghost-on" aria-label={S.unsplitTerminal} title={S.unsplitTerminal} onClick={() => setState({ splitTerminals: false })}>
                <Codicon name="split-horizontal" />
              </Button>
            )}
            <Button size="icon" aria-label={S.clearTerminal} title={S.clearTerminal} onClick={() => runCommand("terminalClear")}>
              <Codicon name="clear-all" />
            </Button>
            {current && (
              <Button size="icon" aria-label={S.closeTerminal} title={S.closeTerminal} onClick={() => closeTerminal(scope.key, current.id)}>
                <Close />
              </Button>
            )}
          </>
        )}
        <Button size="icon" aria-label={S.close} title={S.closePanelKey(bottomKey)} onClick={() => setState({ bottomOpen: false })}>
          <ChevronDown />
        </Button>
      </div>
      <div className="bottom-body">
        {tab === "output" && <pre className="output-log mono">{log.join("\n")}</pre>}
        {tab === "problems" && <ProblemsPanel />}
        {tab === "terminal" && terminals.length === 0 && (
          <div className="empty-hint">
            <Button variant="secondary" size="default" onClick={() => addTerminal(scope.key)}>
              <TerminalIcon /> {S.openTerminalIn(scope.label)}
            </Button>
          </div>
        )}
        {tab === "terminal" && terminals.length > 0 && (
          <>
            <div className={split ? "terminal-grid" : "terminal-host"} style={split ? { gridTemplateColumns: `repeat(${terminals.length}, minmax(0, 1fr))` } : undefined}>
              {terminals.map((t) => (
                <TerminalView key={`${scope.key}:${t.id}`} scopeKey={scope.key} params={t.dir ? { ...scope.params, dir: t.dir } : scope.params} active={split || t.id === current?.id} onExit={() => closeTerminal(scope.key, t.id)} />
              ))}
            </div>
            {!split && terminals.length > 1 && (
              <div className="terminal-list">
                {terminals.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    className="terminal-row"
                    data-active={t.id === current?.id || undefined}
                    onClick={() => setState((s) => ({ activeTerminal: { ...s.activeTerminal, [scope.key]: t.id } }))}
                  >
                    <TerminalIcon size={14} /> {t.name}
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
