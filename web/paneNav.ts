// 단축키가 DOM 을 읽어야 하는 동작들: 포커스가 어디 있는지에 따라 ⌘W 가 닫을 것을 고르고, 대화 안에서 말풍선과 승인 카드를 찾는다.
import { requestCloseTab } from "./editorDocs";
import { removeEmptyGroup } from "./groupActions";
import { terminalScopeOf } from "./terminalScope";
import { sessionPanelShown } from "./centerPanels";
import { isPinnedTab } from "./floatLayout";
import { activeAgent, closeTerminal, closeFocusedPane, getState, setState, closeCard, shownTabsOf } from "./store";
import { S } from "./strings";
import { hint } from "./hint";

type Region = "pane" | "right" | "editor" | "bottom";

const regionOf = (el: Element | null): { region: Region; paneId?: string } | null => {
  const cell = el?.closest<HTMLElement>("[data-pane-id]");
  if (cell) return { region: "pane", paneId: cell.dataset.paneId };
  // Chat 배치에서 오른쪽 패널 안의 에디터 그룹(고정 칸 옆). 패널 안이지만 고정 탭이 아니라 에디터 탭에 하는 일이다.
  if (el?.closest(".right-editors")) return { region: "editor" };
  if (el?.closest(".right, .focus-side")) return { region: "right" };
  // Editor 배치에서 가운데를 차지한 에디터 그룹
  if (el?.closest(".editor-center")) return { region: "editor" };
  if (el?.closest(".bottom")) return { region: "bottom" };
  return null;
};

// 입력창이 아닌 곳을 눌러 포커스가 body 로 빠져도 마지막으로 다룬 곳을 기억한다.
let lastRegion: { region: Region; paneId?: string } | null = null;
if (typeof document !== "undefined") {
  const remember = (event: Event) => {
    const found = regionOf(event.target as Element | null);
    if (found) lastRegion = found;
  };
  document.addEventListener("pointerdown", remember, true);
  document.addEventListener("focusin", remember, true);
}

export function closeFocused() {
  const s = getState();
  const found = regionOf(document.activeElement) ?? lastRegion;
  if (found?.region === "right" && sessionPanelShown(s.centerView, s.rightOpen) && closeRightTab(found.region)) return;
  if (found?.region === "editor" && removeEmptyGroup(s.activeGroupId)) return;
  if (found?.region === "editor" && closeRightTab(found.region)) return;
  if (found?.region === "bottom" && s.bottomOpen && s.bottomTab === "terminal") {
    const key = terminalScopeOf(s).key;
    const terminalId = s.activeTerminal[key] || s.terminals[key]?.at(-1)?.id;
    if (terminalId) closeTerminal(key, terminalId);
    return;
  }
  const paneId = found?.region === "pane" && found.paneId && s.panes.some((p) => p.id === found.paneId) ? found.paneId : s.activePaneId;
  if (paneId !== s.activePaneId) setState({ activePaneId: paneId });
  if (!closeFocusedPane(paneId)) void window.agentNavNative?.closeWindow?.();
}

// 오른쪽 패널이나 에디터 그룹에서 닫을 것을 닫는다. 닫았거나 입력 중이라 일부러 건드리지 않았으면 true, 닫을 탭이 없으면 false.
function closeRightTab(region: Region): boolean {
  const s = getState();
  if ((s.layoutMode === "editor" || shownTabsOf(s).length > 0) && region === "right") {
    if (s.sideTabKey === "card" && s.selectedCardId) {
      closeCard();
      return true;
    }
    if (isTyping(document.activeElement)) return true;
    if (!s.activeTabKey || !shownTabsOf(s).some((t) => t.key === s.activeTabKey)) return false;
    void requestCloseTab(s.activeTabKey);
    return true;
  }
  if (s.activeTabKey === "card") {
    closeCard();
    return true;
  }
  if (s.activeTabKey && !isPinnedTab(s.activeTabKey)) {
    void requestCloseTab(s.activeTabKey);
    return true;
  }
  return false;
}

const isTyping = (el: Element | null) => el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || (el instanceof HTMLElement && el.isContentEditable);

const activeCell = () => document.querySelector<HTMLElement>(`[data-pane-id="${getState().activePaneId}"]`);

// ⌥⌘↑, ⌥⌘↓. 활성 칸의 사용자 말풍선 중 현재 스크롤 위치 위, 아래 것으로 바로 옮긴다.
// smooth 는 스크롤 컨테이너에서 조용히 취소되는 함정이 있어 instant 로 한다.
export function scrollToPrompt(direction: "prev" | "next") {
  const timeline = activeCell()?.querySelector<HTMLElement>(".timeline");
  const prompts = timeline ? Array.from(timeline.querySelectorAll<HTMLElement>(".turn-user")) : [];
  if (!timeline || prompts.length === 0) return;
  const offsets = prompts.map((el) => naturalTop(el, timeline));
  const here = timeline.scrollTop;
  const slack = 2;
  const index = direction === "next" ? offsets.findIndex((y) => y > here + slack) : offsets.findLastIndex((y) => y < here - slack);
  if (index < 0) return;
  timeline.scrollTo({ top: offsets[index], behavior: "instant" });
}

// 말풍선(.turn-user)은 sticky 라 스크롤하면 rect 가 붙은 자리(머리 아래 4px)를 가리킨다. 그 값으로 오프셋을 재면 지금 붙은 말풍선이 항상 "아래쪽 것" 으로 잡혀 4px 씩만 움직이므로,
// 턴(.turn) 맨 위에 위에 놓인 형제(체크포인트 구분선)의 높이를 더해 붙기 전의 제자리를 구한다.
function naturalTop(bubble: HTMLElement, timeline: HTMLElement) {
  const turn = bubble.parentElement;
  if (!turn) return bubble.getBoundingClientRect().top - timeline.getBoundingClientRect().top + timeline.scrollTop;
  const gap = parseFloat(getComputedStyle(turn).rowGap) || 0;
  let above = 0;
  for (let el = bubble.previousElementSibling; el; el = el.previousElementSibling) {
    if (getComputedStyle(el).position !== "absolute") above += el.getBoundingClientRect().height + gap;
  }
  return turn.getBoundingClientRect().top - timeline.getBoundingClientRect().top + timeline.scrollTop + above;
}

export function focusApproval() {
  const button = activeCell()?.querySelector<HTMLElement>("[data-approval-primary], .permission-card .permission-actions button");
  if (!button) return false;
  button.scrollIntoView({ block: "nearest", behavior: "instant" });
  button.focus();
  return true;
}

// ⌘/. 입력창의 첨부 선택창을 열어 달라는 요청. 입력창(묶음 3)이 composerAction 을 받아 연다.
export function requestAttachMenu() {
  const s = getState();
  const pane = s.panes.find((p) => p.id === s.activePaneId);
  if (!pane) {
    hint(S.attachMenuUnavailable);
    return;
  }
  setState({ composerAction: { paneId: pane.id, action: "attachMenu", nonce: Date.now() } });
}
