import type { Workspace } from "../shared/protocol";
import { DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from "./ui/dropdown-menu";
import { FOLDERS_SCOPE } from "../shared/sessionOrder";
import { resetFolderOrder, resetSessionOrder } from "./sessionReorder";
import { toggleGroupCollapsed } from "./sessionListState";
import { openInVSCode, startDraft, useStore } from "./store";
import { S } from "./strings";
import { agentsInFolder, copyFolderPath, locateFolder, markFolderDone, markFolderRead, removeFolderFromList, revealFolder, startWorktreeSession } from "./workspaceActions";

// 사이드바 폴더 묶음 머리의 메뉴. 우클릭, 머리의 ... 버튼, Shift+F10 이 같은 메뉴를 연다.
// 모양은 세션 행 메뉴(SessionMenu)와 같다: 행 높이와 글자 크기는 .session-menu 가 정하고 아이콘은 없다.
export function GroupMenu({ workspace, groupId, resetScopes, collapsed, missing }: { workspace: Workspace; groupId: string; resetScopes: string[]; collapsed: boolean; missing: boolean }) {
  const agents = useStore((s) => s.agents);
  const customOrder = useStore((s) => resetScopes.some((scope) => (s.sessionOrders[scope]?.length ?? 0) > 0));
  // 폴더 머리를 끌어 정한 폴더 순서(Folder Order = Manual)가 저장돼 있을 때만 되돌리기를 보인다
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

// 고정, 완료, 채팅 묶음 머리의 메뉴. 손으로 정한 순서를 기본 정렬로 되돌리는 항목 하나뿐이다.
export function GroupOrderMenu({ resetScopes }: { resetScopes: string[] }) {
  return (
    <DropdownMenuContent align="start" className="session-menu" data-menu="group">
      <DropdownMenuItem onSelect={() => resetSessionOrder(resetScopes)}>{S.resetOrder}</DropdownMenuItem>
    </DropdownMenuContent>
  );
}
