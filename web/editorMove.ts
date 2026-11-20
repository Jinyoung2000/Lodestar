import { refocusActiveEditor } from "./editorDocs";
import { adjacentGroup, groupOf } from "./editorGroups";
import { groupInDirection } from "./editorLayoutOps";
import { getState, moveTabToGroup, moveTabToNewGroup } from "./store";
import { S } from "./strings";
import { hint } from "./hint";

export type MoveTarget = "previous" | "next" | "up" | "down" | "left" | "right";

export function moveEditorToGroup(target: MoveTarget, tabKey: string | null = getState().activeTabKey) {
  const moved = moveActiveTab(target, tabKey);
  if (moved) refocusActiveEditor();
  return moved;
}

function moveActiveTab(target: MoveTarget, key: string | null) {
  const s = getState();
  const tab = s.tabs.find((t) => t.key === key);
  if (!tab) {
    hint(S.splitNeedsTab);
    return false;
  }
  const source = groupOf(tab);
  if (target === "previous" || target === "next") {
    const other = adjacentGroup(s.editorLayout, source, target === "next" ? 1 : -1);
    if (other) moveTabToGroup(tab.key, other, null);
    else return createBeside(tab.key, source, target === "next" ? "right" : "left");
    return true;
  }
  const other = groupInDirection(s.editorLayout, source, target);
  if (other) moveTabToGroup(tab.key, other, null);
  else return createBeside(tab.key, source, target);
  return true;
}

function createBeside(key: string, source: string, side: "left" | "right" | "up" | "down") {
  const dir = side === "left" || side === "right" ? "row" : "column";
  return moveTabToNewGroup(key, source, dir, side === "left" || side === "up");
}
