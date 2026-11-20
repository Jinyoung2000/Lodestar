import { setEditorTarget } from "./editorCommands";
import { diffWorkspaceOf, focusedViewKey, viewFor } from "./lsp";
import { activeTab, getState } from "./store";

// 에디터 명령 등록부(web/editorCommands.ts)가 명령을 보낼 에디터와 워크스페이스를 찾는 방법. Editor.tsx 가 import 해서 부팅 때 한 번 넣는다.
setEditorTarget({
  view: () => {
    const key = focusedViewKey();
    if (key) return viewFor(key);
    const tab = activeTab();
    return tab && (tab.kind === "file" || tab.kind === "untitled") ? viewFor(tab.key) : null;
  },
  workspaceIdOf: (view) => {
    const diffWorkspace = diffWorkspaceOf(view);
    if (diffWorkspace) return diffWorkspace;
    for (const tab of getState().tabs) if ((tab.kind === "file" || tab.kind === "untitled") && viewFor(tab.key) === view) return tab.workspaceId;
    return null;
  },
});
