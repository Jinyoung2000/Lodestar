import { useEffect, useRef, useState } from "react";
import { conflictBlocks, gotoConflict, useConflictCount } from "./conflictMarkers";
import { docView, saveTab } from "./editorDocs";
import { Codicon } from "./icons";
import { rpc } from "./rpc";
import { M } from "./scmStrings";
import { flash, useStore } from "./store";
import { Button } from "./ui/button";
import { reloadWorkspaceChanges } from "./workspaceChanges";
import { onWorkspaceChanged } from "./workspaceEvents";
import { announce } from "./announce";

export function ConflictBar({ tabKey, workspaceId, path }: { tabKey: string; workspaceId: string; path: string }) {
  const count = useConflictCount(tabKey);
  const hadMarkers = useRef(false);
  if (count > 0) hadMarkers.current = true;
  const unmerged = useUnmergedEntry(workspaceId, path, count === 0 && hadMarkers.current);
  const [busy, setBusy] = useState(false);
  const name = path.slice(path.lastIndexOf("/") + 1);

  if (count === 0 && !unmerged) return null;

  const go = (direction: 1 | -1) => {
    const view = docView(tabKey);
    if (view) gotoConflict(view, direction);
  };
  const markResolved = async () => {
    if (!unmerged || busy) return;
    const view = docView(tabKey);
    if (view && conflictBlocks(view.state).length > 0) return;
    setBusy(true);
    try {
      if (!(await saveTab(tabKey))) return;
      await rpc.call("scm.stage", { workspaceId, paths: [unmerged] });
      announce(M.markedResolved(name));
      void reloadWorkspaceChanges(workspaceId);
    } catch (error) {
      flash(M.markResolvedFailed((error as Error).message), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="editor-banner conflict-bar" role="status" data-testid="conflict-bar" data-resolved={count === 0 || undefined}>
      <Codicon name={count > 0 ? "git-merge" : "check"} className="editor-banner-icon" />
      <span className="editor-banner-text">{count > 0 ? M.conflictCount(count) : M.allResolved}</span>
      {count > 0 ? (
        <>
          <Button size="icon" aria-label={M.prevConflict} title={M.prevConflict} onClick={() => go(-1)}>
            <Codicon name="arrow-up" />
          </Button>
          <Button size="icon" aria-label={M.nextConflict} title={M.nextConflict} onClick={() => go(1)}>
            <Codicon name="arrow-down" />
          </Button>
        </>
      ) : (
        <Button size="sm" variant="primary" disabled={busy} onClick={() => void markResolved()}>
          <Codicon name="check" size={14} />
          <span className="editor-banner-label">{M.markResolved}</span>
        </Button>
      )}
    </div>
  );
}

function useUnmergedEntry(workspaceId: string, path: string, enabled: boolean): string | null {
  const [rel, setRel] = useState<string | null>(null);
  const dir = useStore((s) => s.workspaces.find((w) => w.id === workspaceId)?.dir ?? "");
  useEffect(() => {
    if (!enabled) {
      setRel(null);
      return;
    }
    let alive = true;
    const read = () =>
      void rpc
        .call("scm.status", { workspaceId })
        .then((status) => {
          if (!alive) return;
          const wanted = path.startsWith("/") ? (dir && path.startsWith(`${dir}/`) ? path.slice(dir.length + 1) : path) : path;
          const found = status.conflicts.find((e) => e.path === path || e.rel === wanted || e.rel.endsWith(`/${wanted}`));
          setRel(found ? found.rel : null);
        })
        .catch(() => alive && setRel(null));
    read();
    const off = onWorkspaceChanged(workspaceId, read);
    return () => {
      alive = false;
      off();
    };
  }, [enabled, workspaceId, path, dir]);
  return rel;
}
