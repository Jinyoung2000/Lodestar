import type { Workspace } from "../shared/protocol";
import { DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from "./ui/dropdown-menu";
import { FOLDERS_SCOPE } from "../shared/sessionOrder";
import { resetFolderOrder, resetSessionOrder } from "./sessionReorder";
import { toggleGroupCollapsed } from "./sessionListState";
import { openInVSCode, startDraft, useStore } from "./store";
import { S } from "./strings";
import { agentsInFolder, copyFolderPath, locateFolder, markFolderDone, markFolderRead, removeFolderFromList, revealFolder, startWorktreeSession } from "./workspaceActions";

export function GroupMenu({ workspace, groupId, resetScopes, collapsed, missing }: { workspace: Workspace; groupId: string; resetScopes: string[]; collapsed: boolean; missing: boolean }) {
  const agents = useStore((s) => s.agents);
  const customOrder = useStore((s) => resetScopes.some((scope) => (s.sessionOrders[scope]?.length ?? 0) > 0));
  const folderOrdered = useStore((s) => (s.sessionOrders[FOLDERS_SCOPE]?.length ?? 0) > 0);
  const open = agentsInFolder(agents, workspace.id).filter((a) => !a.feedbackId && !a.done);
  if (missing) {
    return (
      <DropdownMenuContent align="start" className="session-menu" data-menu="group" data-missing="">
        <DropdownMenuItem onSelect={() => void locateFolder(workspace)}>{S.folderLocate}</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => copyFolderPath(workspace.dir)}>{S.folderCopyPath}</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => toggleGroupCollapsed(groupId)}>{collapsed ? S.folderExpand : S.folderCollapse}</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void removeFolderFromList(workspace)}>{S.folderRemoveMissing}</DropdownMenuItem>
      </DropdownMenuContent>
    );
  }
  return (
    <DropdownMenuContent align="start" className="session-menu" data-menu="group">
      <DropdownMenuItem onSelect={() => startDraft(workspace.id)}>{S.folderNewSession}</DropdownMenuItem>
      <DropdownMenuItem onSelect={() => startWorktreeSession(workspace.id)}>{S.folderNewSessionWorktree}</DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={() => revealFolder(workspace.id)}>{S.folderReveal}</DropdownMenuItem>
      <DropdownMenuItem onSelect={() => copyFolderPath(workspace.dir)}>{S.folderCopyPath}</DropdownMenuItem>
      <DropdownMenuItem onSelect={() => void openInVSCode(null, workspace.id)}>{S.openInVSCode}</DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={() => toggleGroupCollapsed(groupId)}>{collapsed ? S.folderExpand : S.folderCollapse}</DropdownMenuItem>
      <DropdownMenuItem disabled={!open.some((a) => a.unread)} onSelect={() => markFolderRead(open)}>
        {S.folderMarkAllRead}
      </DropdownMenuItem>
      <DropdownMenuItem disabled={open.length === 0} onSelect={() => markFolderDone(open)}>
        {S.folderMarkAllDone}
      </DropdownMenuItem>
      <DropdownMenuItem disabled={!customOrder} onSelect={() => resetSessionOrder(resetScopes)}>
        {S.resetOrder}
      </DropdownMenuItem>
      {folderOrdered && <DropdownMenuItem onSelect={() => resetFolderOrder()}>{S.resetFolderOrder}</DropdownMenuItem>}
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={() => void removeFolderFromList(workspace)}>{S.folderRemove}</DropdownMenuItem>
    </DropdownMenuContent>
  );
}

export function GroupOrderMenu({ resetScopes }: { resetScopes: string[] }) {
  return (
    <DropdownMenuContent align="start" className="session-menu" data-menu="group">
      <DropdownMenuItem onSelect={() => resetSessionOrder(resetScopes)}>{S.resetOrder}</DropdownMenuItem>
    </DropdownMenuContent>
  );
}
