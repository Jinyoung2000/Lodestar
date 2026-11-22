import { useMemo, useRef, useState } from "react";
import type { Agent } from "../shared/protocol";
import { Close, Codicon, Folder } from "./icons";
import { useMissingFolders } from "./missingFolders";
import { Popup } from "./Popup";
import { addFolderToSession, parentDisplay, removeFolderFromSession, sessionRoots, type SessionRoot } from "./sessionFolders";
import { useStore } from "./store";
import { S } from "./strings";

export type FolderChipProps = { agent: Agent; branch: string | null };

export function FolderChip({ agent, branch }: FolderChipProps) {
  const workspaces = useStore((s) => s.workspaces);
  const roots = useMemo(() => sessionRoots(agent, workspaces), [agent, workspaces]);
  const [open, setOpen] = useState(false);
  const chipRef = useRef<HTMLButtonElement>(null);
  if (roots.length < 2) return null;
  return (
    <>
      <button ref={chipRef} type="button" className="chip folders-chip" aria-haspopup="dialog" aria-expanded={open} aria-label={S.foldersChipAria(roots.map((r) => r.label))} title={S.foldersChipTip} onClick={() => setOpen((v) => !v)}>
        <Codicon name="folder-library" size={14} />
        <span className="chip-main">{roots[0].label}</span>
        <span className="chip-extra">+{roots.length - 1}</span>
      </button>
      {open && <FoldersPopover anchor={chipRef.current} agentId={agent.id} roots={roots} branch={branch} onClose={() => setOpen(false)} />}
    </>
  );
}

function FoldersPopover({ anchor, agentId, roots, branch, onClose }: { anchor: HTMLElement | null; agentId: string; roots: SessionRoot[]; branch: string | null; onClose: () => void }) {
  const missingFolders = useMissingFolders();
  return (
    <Popup anchor={anchor} placement="above" label={S.foldersPopoverAria} className="popup-folders" onClose={onClose}>
      <div className="popup-title">{S.foldersHeading}</div>
      <div className="popup-list" role="listbox" aria-label={S.foldersPopoverAria}>
        {roots.map((root) => (
          <RootRow key={root.id} root={root} missing={!root.workspace || missingFolders.has(root.id)} branch={root.primary ? branch : null} onRemove={() => void removeFolderFromSession(agentId, root.id)} />
        ))}
      </div>
      <div className="popup-separator" />
      <button
        type="button"
        className="popup-row"
        onClick={() => {
          onClose();
          void addFolderToSession(agentId);
        }}
      >
        <Codicon name="add" size={14} />
        <span className="popup-row-title">{S.addFolderEllipsis}</span>
      </button>
    </Popup>
  );
}

function RootRow({ root, missing, branch, onRemove }: { root: SessionRoot; missing: boolean; branch: string | null; onRemove: () => void }) {
  const detail = missing || !root.workspace ? S.folderNotFound : root.primary && branch ? null : parentDisplay(root.workspace.dir);
  return (
    <div className="popup-row folders-row" role="option" aria-selected={false} data-missing={missing || undefined} title={root.workspace?.dir}>
      <Folder size={14} />
      <span className="popup-row-title">{root.label}</span>
      {detail !== null ? (
        <span className="popup-row-detail">{detail}</span>
      ) : (
        <span className="popup-row-detail folders-row-branch">
          <Codicon name="git-branch" size={12} />
          {branch}
        </span>
      )}
      {root.primary ? (
        <span className="folder-row-tag">{S.primaryFolder}</span>
      ) : (
        <button type="button" className="popup-row-action" aria-label={S.removeFromSession} title={S.removeFromSession} onClick={onRemove}>
          <Close size={12} />
        </button>
      )}
    </div>
  );
}
