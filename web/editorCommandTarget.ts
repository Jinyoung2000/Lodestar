import { setEditorTarget } from "./editorCommands";
import { diffWorkspaceOf, focusedViewKey, viewFor } from "./lsp";
import { activeTab, getState } from "./store";

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
