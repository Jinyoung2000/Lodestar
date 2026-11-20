import { useEffect, useLayoutEffect, useState } from "react";
import { BoardView, ImprovementsView, InboxView, NotesView, NotionView, Overlays, PullRequestView, SettingsView, SideChat, SkillsView, TerminalView } from "./lazyViews";
import { FeedbackLayer } from "./Feedback";
import { ChevronDown, Close, Codicon, Plus, Split, TerminalIcon } from "./icons";
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
import { EffortPicker, ModelPicker } from "./Pickers";
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

export function App() {
  useDockBadge();
  const overlay = useStore((s) => s.overlay);
  const side = useStore((s) => s.side);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const rightOpen = useStore((s) => s.rightOpen);
  const bottomOpen = useStore((s) => s.bottomOpen);
  // 한 번 연 아래 패널은 닫아도 숨기기만 한다. 언마운트하면 안의 터미널 프로세스가 끊긴다.
  const [bottomEverOpened, setBottomEverOpened] = useState(false);
  useEffect(() => {
    if (bottomOpen) setBottomEverOpened(true);
  }, [bottomOpen]);
  const layout = useStore((s) => s.layout);
  const panelWidth = useStore((s) => s.panelWidths[panelWidthKey(s)] ?? null);
  // 설정을 읽기 전이거나 숨긴 화면(Board, Slack)이 저장돼 있으면 세션 화면으로 그린다(store 가 설정을 읽은 뒤 상태도 맞춘다).
  const centerView = useStore((s) => visibleCenterView(s.centerView, s.settings));
  const singleColumn = useStore((s) => visibleCenterView(s.centerView, s.settings) !== "sessions" || s.grid.rows.every((r) => r.ids.length <= 1));
  // Editor 중심에서는 가운데가 에디터라서 오른쪽 패널이 에디터를 EDITOR_FLOOR 까지 줄이며 넓어진다.
  const editorLayout = useStore((s) => s.layoutMode === "editor");
  // FOCUS: Editor 중심은 앱 사이드바와 오른쪽 패널 대신 왼쪽 Activity Bar 와 사이드바, 오른쪽 대화 패널을 쓴다(web/focusLayout.ts focusShown).
  const focusSideOpen = useStore((s) => s.focusSideOpen);
  const chatDock = useStore((s) => s.chatDock);
  const chatDockOpen = useStore((s) => s.chatDockOpen);
  const chatDockWidth = useStore((s) => s.chatDockWidth);
  const focusSaved = useFocusSideWidth();
  const bodyWidth = useBodyWidth();
  // Customize Layout: Primary Side Bar 위치와 Panel 정렬이 작업 영역(.body) 격자의 어느 칸에 무엇이 앉는지 정한다(web/layoutConfig.ts gridPlan).
  const layoutConfig = useLayoutConfig();
  const plan = gridPlan(layoutConfig);
  // 미리보기 패널(SidebarPeek)은 body 밖에 있어서 사이드바 위치를 body 속성으로 알린다
  useLayoutEffect(() => {
    document.body.dataset.sidebarSide = layoutConfig.sideBar;
  }, [layoutConfig.sideBar]);
  const shown = focusShown({ editorLayout, sessionsView: centerView === "sessions", chatDock, sideOpen: focusSideOpen, dockOpen: chatDockOpen });
  const dockPx = shown.dock ? dockWidth(chatDockWidth, bodyWidth) : 0;
  // --center-w 를 쓰는 요소(오른쪽 패널, 도킹한 대화 패널)가 생기고 사라질 때도 다시 건다.
  useLayoutEffect(() => watchCenterWidth(), [sidebarOpen, focusSideOpen, editorLayout, centerView, layout.sidebarWidth, focusSaved, bodyWidth, layoutConfig.sideBar, rightOpen, chatDock]);
  // FIXY: Chat 중심에서 에디터 탭이 열려 있으면 대화 칸이 한 열이어도 CHAT_EDITING 아래로 줄지 않는다(대화 > 에디터 > 고정 칸 순). 모자라면 오른쪽 패널이 더 넓어지지 않고 고정 칸이 먼저 줄거나 서랍이 된다.
  const editing = useStore((s) => s.layoutMode !== "editor" && shownTabsOf(s).length > 0);
  const singleReserve = editing ? CHAT_EDITING : CHAT_FLOOR;
  const chatReserve = editorLayout ? EDITOR_FLOOR : singleColumn ? singleReserve : CHAT_MIN;
  // PANEMIN: 칸이 여러 열이면 오른쪽 패널은 칸 수 x 최소 폭 합까지만 칸 영역을 양보받는다(styles.css 의 --panes-reserve). 그 아래로는 칸 영역이 스크롤된다.
  const rowCols = useStore((s) => s.grid.rows.reduce((most, r) => Math.max(most, r.ids.length), 0));
  const panesReserve = editorLayout ? EDITOR_FLOOR : singleColumn ? singleReserve : panesMinWidth([rowCols]);
  // 칸이 여러 열이고 에디터 탭이 열려 있으면 오른쪽 패널은 에디터 최소 폭에서 멈춘다(styles.css `.center[data-columns="many"][data-editing] .right` 와 같은 값)
  const rightMin = editing && !editorLayout && !singleColumn ? PINNED_EDITOR_MIN : RIGHT_MIN;
  const centerStyle: Record<string, string> = {};
  if (!singleColumn && !editorLayout) centerStyle["--panes-reserve"] = `${panesReserve}px`;

  useEffect(() => {
    document.body.dataset.electron = IN_ELECTRON ? "1" : "";
    // chord 의 두 번째 키가 에디터가 쓰는 키(Enter, 방향키)여도 에디터보다 먼저 받아야 한다. 에디터(CodeMirror)는 자기 요소에서 keydown 을 먼저 처리해 줄바꿈이나 커서 이동이 같이 일어난다.
    // chord 를 기다리는 동안만 캡처 단계에서 처리하고, 같은 이벤트를 버블 단계에서 다시 처리하지 않는다.
    const early = new WeakSet<Event>();
    const onKeyDownCapture = (event: globalThis.KeyboardEvent) => {
      if (!isChordPending()) return;
      early.add(event);
      runShortcut(event);
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (!early.has(event)) runShortcut(event);
    };
    // Electron 메뉴에서 고른 항목은 window 이벤트로 넘어온다.
    const onCommand = (event: Event) => runCommand((event as CustomEvent<string>).detail);
    // Electron 은 메뉴 가속키와 겹치는 키(⌘\, ⌘W 등)를 페이지에 주지 않고 메인 프로세스가 가로채 이 이벤트로 넘긴다. 같은 표와 chord 상태 기계로 처리한다.
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
            {/* 보드로 바꿔도 세션 칸은 지우지 않고 숨긴다. 입력창에 쓰던 글과 스크롤이 돌아오면 그대로 있다. */}
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
            {centerView === "notes" && <NotesView />}
            {centerView === "skills" && <SkillsView />}
            {/* 곁다리 대화는 오른쪽 아래에 떠 있는 창이라 칸과 패널의 폭을 쓰지 않는다. */}
            {side && <SideChat key={side.id} side={side} />}
            {/* 세션 오른쪽 패널은 세션 화면 것이다. 보드, 멘션, PR 화면에서는 지우지 않고 숨긴다(안의 Browser 탭 webview 가 다시 읽히지 않도록). */}
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
      {/* 탭 본문은 한 곳에 계속 두어야 Chat 과 Editor 배치를 오가도 에디터가 다시 만들어지지 않는다. 오른쪽 패널이 닫힌 Chat 배치에서는 지금처럼 만들지 않는다. */}
      {(editorLayout || rightOpen) && <TabBodies />}
      {!editorLayout && <SidebarPeek />}
      <Overlays />
      <SessionSwitcherView />
      <ConfirmHost />
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

// 대화 패널 경계선 더블클릭: 대화 본문 글자 크기에 맞는 최소 폭으로 맞춘다. 대화 열을 못 찾으면 기본 폭(null)이다.
function fitDockWidth(): number | null {
  const timeline = document.querySelector<HTMLElement>(".panes .timeline");
  const ctx = document.createElement("canvas").getContext("2d");
  if (!timeline || !ctx) return null;
  const style = getComputedStyle(timeline);
  ctx.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  const pad = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
  return dockFitWidth(ctx.measureText("0").width, pad, centerWidth());
}

// 패널 크기 한계 (HANDOFF-v3 수용 기준: 사이드바 200~400, 오른쪽 320~, 아래는 본문의 60% 까지). 토큰에 없는 값이라 ACCEPTANCE-v3 "변경 제안" 에 적었다.
const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 400;
const RIGHT_MIN = 300;
const CHAT_MIN = 360; // --size-chat-min
const CHAT_FLOOR = 300; // --size-chat-floor
const CHAT_EDITING = 440; // --size-chat-editing
const EDITOR_FLOOR = 320; // --size-float-min-width
const BOTTOM_MIN = 120;

// --- 아래 패널: Output | Terminal ---

const NO_TERMINALS: { id: string; name: string; dir?: string }[] = [];

function BottomPanel({ height, hidden }: { height: number | null; hidden: boolean }) {
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
  // 터미널 탭이 보이는데 이 범위에 터미널이 없으면 바로 하나 연다(빈 안내 대신 셸이 기본으로 뜬다). 마지막 터미널을 닫으면 패널이 닫혀 다시 뜨지 않는다.
  const needsTerminal = tab === "terminal" && !hidden && terminals.length === 0;
  useEffect(() => {
    if (needsTerminal) addTerminal(scope.key);
  }, [needsTerminal, scope.key]);
  const current = terminals.find((t) => t.id === activeTerminal) ?? terminals[terminals.length - 1];
  return (
    <section className="bottom" aria-label={S.bottomPanelAria} hidden={hidden} style={height == null ? undefined : { height }}>
      <div className="bottom-tabs">
        <button type="button" className="bottom-tab" data-active={tab === "output" || undefined} onClick={() => setState({ bottomTab: "output" })}>
          {S.output}
        </button>
        <button type="button" className="bottom-tab" data-active={tab === "problems" || undefined} onClick={() => setState({ bottomTab: "problems" })}>
          {S.problems}
          {problemTotal > 0 && (
            <span className="bottom-tab-count" title={S.problemsTip(problems.errors, problems.warnings)}>
              {countBadge(problemTotal)}
            </span>
          )}
        </button>
        <button type="button" className="bottom-tab" data-active={tab === "terminal" || undefined} onClick={() => setState({ bottomTab: "terminal" })}>
          {S.terminal}
        </button>
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
        <Button size="icon" aria-label={S.close} title={S.closePanelKey} onClick={() => setState({ bottomOpen: false })}>
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
