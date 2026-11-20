import { MAIN_GROUP, mainTabs } from "./editorGroups";
import { editorKeyOfMain } from "./floatLayout";
import { focusedViewKey } from "./lsp";
import { activeKeyOfGroup, getState, type State } from "./store";

// 활성 그룹이 보여 주는 텍스트 에디터(파일 탭이나 이름 없는 탭)의 탭 키. 상태 표시줄과 줄로 이동, 심볼로 이동이 대상으로 삼는다.
// Editor 중심 배치에서는 activeTabKey 가 고정 탭("changes")이어도 가운데에는 마지막 에디터 탭이 보이므로 EditorArea 와 같은 규칙(editorKeyOfMain)으로 고른다.
export function activeEditorKeyOf(s: Pick<State, "tabs" | "activeGroupId" | "activeTabKey" | "groupActive" | "mainEditorKey">): string | null {
  const key = activeKeyOfGroup(s, s.activeGroupId);
  const shown = s.activeGroupId === MAIN_GROUP ? editorKeyOfMain(key, s.mainEditorKey, mainTabs(s.tabs).map((t) => t.key)) : key;
  const tab = shown === null ? undefined : s.tabs.find((t) => t.key === shown);
  return tab && (tab.kind === "file" || tab.kind === "untitled") ? tab.key : null;
}

// 명령을 받을 에디터 탭 키: 키보드 포커스가 있는 에디터, 없으면 활성 에디터. 입력창이 포커스를 가져가기 전에 부른다.
export function targetEditorKey(): string | null {
  return focusedViewKey() ?? activeEditorKeyOf(getState());
}
