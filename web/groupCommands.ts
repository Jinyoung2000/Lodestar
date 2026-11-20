import type { LayoutPreset, Side } from "./editorLayoutOps";
import { requestCloseTabs } from "./editorDocs";
import { applyLayoutPreset, closeAllGroups, closeGroup, closeInGroup, evenGroupSizes, flipGroupLayout, focusGroupAt, focusGroupSide, joinAll, joinWithNext, moveEditorToEdgeGroup, moveGroupSide, moveTabInGroup, newEmptyGroup, openEditorAtIndex, reopenClosedEditor, setSticky, splitEditorSide, stepEditor, stepEditorInGroup, toggleMaximizeGroup } from "./groupActions";
import { getState, pinEditorTab, shownTabsOf } from "./store";
import { closeSessionSwitcher } from "./sessionSwitcher";
import { cycleTabSwitcher as openTabSwitcher } from "./tabSwitcher";

// CTRLTAB: 세션 전환 창(⌃Tab)과 에디터 탭 전환 창이 동시에 열려 있지 않게 한다. 두 창이 키를 나눠 받으면 ⌃ 를 뗄 때 둘 다 확정된다.
function cycleTabSwitcher(...args: Parameters<typeof openTabSwitcher>) {
  closeSessionSwitcher();
  openTabSwitcher(...args);
}


// 그룹 명령이면 실행하고 true. 아니면 false(호출한 쪽이 이어서 처리한다).
export function runGroupCommand(command: string): boolean {
  if (command.startsWith("focusEditorGroup:")) {
    focusGroupAt(Number(command.slice("focusEditorGroup:".length)));
    return true;
  }
  if (command.startsWith("openEditorAtIndex:")) {
    openEditorAtIndex(Number(command.slice("openEditorAtIndex:".length)));
    return true;
  }
  if (command.startsWith("editorLayout:")) {
    applyLayoutPreset(command.slice("editorLayout:".length) as LayoutPreset);
    return true;
  }
  if (command.startsWith("newGroup:")) {
    newEmptyGroup(command.slice("newGroup:".length) as Side);
    return true;
  }
  const s = getState();
  const group = s.activeGroupId;
  const active = s.activeTabKey;
  switch (command) {
    case "focusLeftEditorGroup":
      focusGroupSide("left");
      return true;
    case "focusRightEditorGroup":
      focusGroupSide("right");
      return true;
    case "focusAboveEditorGroup":
      focusGroupSide("up");
      return true;
    case "focusBelowEditorGroup":
      focusGroupSide("down");
      return true;
    case "moveEditorToFirstGroup":
      moveEditorToEdgeGroup("first");
      return true;
    case "moveEditorToLastGroup":
      moveEditorToEdgeGroup("last");
      return true;
    case "moveEditorGroupLeft":
      moveGroupSide("left");
      return true;
    case "moveEditorGroupRight":
      moveGroupSide("right");
      return true;
    case "moveEditorGroupUp":
      moveGroupSide("up");
      return true;
    case "moveEditorGroupDown":
      moveGroupSide("down");
      return true;
    case "previousEditor":
      stepEditor(-1);
      return true;
    case "nextEditor":
      stepEditor(1);
      return true;
    case "previousEditorInGroup":
      stepEditorInGroup(-1);
      return true;
    case "nextEditorInGroup":
      stepEditorInGroup(1);
      return true;
    case "moveEditorLeftInGroup":
      moveTabInGroup(-1);
      return true;
    case "moveEditorRightInGroup":
      moveTabInGroup(1);
      return true;
    case "lastEditorInGroup":
      openEditorAtIndex(-1);
      return true;
    case "cycleRecentEditor":
      cycleTabSwitcher(1);
      return true;
    case "cycleRecentEditorBack":
      cycleTabSwitcher(-1);
      return true;
    // 키가 없는 명령(명령 팔레트): 팔레트가 닫힌 뒤에 열어야 목록이 키 입력을 받는다. 모든 그룹의 에디터를 최근 순으로 보인다.
    case "quickOpenRecentEditor":
      setTimeout(() => cycleTabSwitcher(1, "all", false), 0);
      return true;
    case "quickOpenOldestEditor":
      setTimeout(() => cycleTabSwitcher(-1, "all", false), 0);
      return true;
    case "closeEditorsInGroup":
      void closeInGroup(group, "all");
      return true;
    case "closeUnmodifiedEditors":
      void closeInGroup(group, "saved");
      return true;
    case "closeOtherEditors":
      void closeInGroup(group, "others", active);
      return true;
    case "closeEditorsToTheRight":
      void closeInGroup(group, "right", active);
      return true;
    case "closeAllEditors":
      void requestCloseTabs(shownTabsOf(s).map((t) => t.key));
      return true;
    case "closeAllGroups":
      void closeAllGroups();
      return true;
    case "closeGroup":
      void closeGroup(group);
      return true;
    case "keepEditor":
      if (active) pinEditorTab(active);
      return true;
    case "pinEditor": {
      const tab = s.tabs.find((t) => t.key === active);
      if (tab) setSticky(tab.key, !tab.sticky);
      return true;
    }
    case "toggleMaximizeEditorGroup":
      toggleMaximizeGroup();
      return true;
    case "flipEditorGroupLayout":
      flipGroupLayout();
      return true;
    case "resetEditorGroupSizes":
      evenGroupSizes();
      return true;
    case "joinTwoGroups":
      joinWithNext();
      return true;
    case "joinAllGroups":
      joinAll();
      return true;
    case "splitEditorUp":
      splitEditorSide("up");
      return true;
    case "splitEditorLeft":
      splitEditorSide("left");
      return true;
    case "reopenClosedEditor":
      reopenClosedEditor();
      return true;
    default:
      return false;
  }
}
