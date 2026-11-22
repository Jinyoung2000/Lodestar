import { requestCloseTab } from "./editorDocs";
import { removeEmptyGroup } from "./groupActions";
import { terminalScopeOf } from "./terminalScope";
import { sessionPanelShown } from "./centerPanels";
import { isPinnedTab } from "./floatLayout";
import { closeTerminal, closeFocusedPane, getState, setState, closeCard, shownTabsOf } from "./store";
import { S } from "./strings";
import { hint } from "./hint";

type Region = "pane" | "right" | "editor" | "bottom";

const regionOf = (el: Element | null): { region: Region; paneId?: string } | null => {
  const cell = el?.closest<HTMLElement>("[data-pane-id]");
  if (cell) return { region: "pane", paneId: cell.dataset.paneId };
  if (el?.closest(".right-editors")) return { region: "editor" };
  if (el?.closest(".right, .focus-side")) return { region: "right" };
  if (el?.closest(".editor-center")) return { region: "editor" };
  if (el?.closest(".bottom")) return { region: "bottom" };
  return null;
};

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

export function requestAttachMenu() {
  const s = getState();
  const pane = s.panes.find((p) => p.id === s.activePaneId);
  if (!pane) {
    hint(S.attachMenuUnavailable);
    return;
  }
  setState({ composerAction: { paneId: pane.id, action: "attachMenu", nonce: Date.now() } });
}

export function stepChatTab(delta: 1 | -1) {
  const lists = [...document.querySelectorAll<HTMLElement>(".editor-chat-tabs")].filter((list) => list.getClientRects().length > 0);
  const list = lists.find((item) => item.closest(".pane")?.contains(document.activeElement)) ?? lists[0];
  const tabs = list ? [...list.querySelectorAll<HTMLButtonElement>("[role=tab]")] : [];
  if (tabs.length < 2) return;
  const index = tabs.findIndex((tab) => tab.getAttribute("aria-selected") === "true");
  tabs[(index + delta + tabs.length) % tabs.length]?.click();
}
