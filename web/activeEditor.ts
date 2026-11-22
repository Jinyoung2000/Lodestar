import { MAIN_GROUP, mainTabs } from "./editorGroups";
import { editorKeyOfMain } from "./floatLayout";
import { focusedViewKey } from "./lsp";
import { activeKeyOfGroup, getState, type State } from "./store";

export function activeEditorKeyOf(s: Pick<State, "tabs" | "activeGroupId" | "activeTabKey" | "groupActive" | "mainEditorKey">): string | null {
  const key = activeKeyOfGroup(s, s.activeGroupId);
  const shown = s.activeGroupId === MAIN_GROUP ? editorKeyOfMain(key, s.mainEditorKey, mainTabs(s.tabs).map((t) => t.key)) : key;
  const tab = shown === null ? undefined : s.tabs.find((t) => t.key === shown);
  return tab && (tab.kind === "file" || tab.kind === "untitled") ? tab.key : null;
}

export function targetEditorKey(): string | null {
  return focusedViewKey() ?? activeEditorKeyOf(getState());
}
