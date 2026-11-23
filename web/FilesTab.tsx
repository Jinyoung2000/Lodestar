import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { createEntry, refreshFileList, validateNewPath } from "./editorDocs";
import { deleteEntries, renameEntry, runFilesAction, type FilesTarget } from "./filesActions";
import { filesKeyAction, filesMenuItems, renamedPath, renameProblem, renameSelection, retargetPath, type FilesMenuAction, type FilesRowKind } from "./filesMenu";
import { expandFolders, setFilesView, toggleFolder, useFilesView, type FilesPicked, type FilesSelected } from "./filesView";
import { ChevronRight, Codicon } from "./icons";
import { FileTypeIcon, FolderTypeIcon } from "./FileTypeIcon";
import { toTarget } from "./lsp";
import { OpenFolderDialog } from "./OpenFolderDialog";
import { canPickFolder, openFolderInNewSession } from "./folderOpen";
import { ensureFiles, openFile, startDraft, useStore } from "./store";
import { useWorkspaceChanges } from "./workspaceChanges";
import { S } from "./strings";
import { Button } from "./ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "./ui/dropdown-menu";

type Node = { name: string; path: string; children: Node[]; file: boolean };
type Status = "A" | "M" | "D" | "R";
type Creating = { dir: string; kind: "file" | "folder" };
type Selected = FilesSelected;
type RowMenu = { path: string; kind: FilesRowKind; x: number; y: number };

export type FilesRoot = { label: string; missing: boolean; header: boolean; onRemove: (() => void) | null };

export function FilesTab({ workspaceId, agentId, root = null }: { workspaceId: string; agentId: string | null; root?: FilesRoot | null }) {
  const files = useStore((s) => s.files[workspaceId]);
  const emptyDirs = useStore((s) => s.emptyDirs[workspaceId]);
  const agentChanged = useStore((s) => (agentId ? s.gitChanges[agentId] : undefined));
  const folderChanged = useWorkspaceChanges(root && !agentId && !root.missing ? workspaceId : null);
  const changed = agentId ? agentChanged : folderChanged ? { files: folderChanged } : undefined;
  const { open, selected, rootOpen, multi } = useFilesView(workspaceId);
  const base = root ? 1 : 0;
  const [rootMenu, setRootMenu] = useState<{ x: number; y: number } | null>(null);
  const setSelected = (next: Selected) => setFilesView(workspaceId, { selected: next });
  const [creating, setCreating] = useState<Creating | null>(null);
  const [menu, setMenu] = useState<RowMenu | null>(null);
  const [openFolder, setOpenFolder] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const canAttach = useStore((s) => !!s.activePaneId);
  const treeRef = useRef<HTMLDivElement>(null);
  const [headSlot, setHeadSlot] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    setHeadSlot(treeRef.current?.closest(".focus-side")?.querySelector<HTMLElement>('.focus-side-actions[data-slot="files"]') ?? null);
  }, []);
  const missing = root?.missing === true;
  useEffect(() => {
    if (!missing) ensureFiles(workspaceId).catch(() => undefined);
  }, [workspaceId, missing]);
  const tree = useMemo(() => buildTree(files ?? [], emptyDirs ?? []), [files, emptyDirs]);
  const { statuses, dirtyDirs } = useMemo(() => {
    const statuses = new Map<string, Status>();
    const dirtyDirs = new Set<string>();
    for (const file of changed?.files ?? []) {
      const target = toTarget(file.path, workspaceId);
      if (target.workspaceId !== workspaceId || target.path.startsWith("..")) continue;
      statuses.set(target.path, file.status);
      const parts = target.path.split("/");
      for (let i = 1; i < parts.length; i++) dirtyDirs.add(parts.slice(0, i).join("/"));
    }
    return { statuses, dirtyDirs };
  }, [changed, workspaceId]);

  const toggle = (path: string) => toggleFolder(workspaceId, path);

  const targetDir = (from: Selected) => (!from ? "" : from.file ? from.path.slice(0, Math.max(from.path.lastIndexOf("/"), 0)) : from.path);
  const startCreate = (kind: "file" | "folder", dir = targetDir(selected)) => {
    setFilesView(workspaceId, { rootOpen: true });
    expandFolders(workspaceId, dir);
    setCreating({ dir, kind });
  };

  const visible = useMemo(() => visibleRows(tree, open), [tree, open]);
  const pick = (node: FilesPicked, e: React.MouseEvent) => {
    if (e.shiftKey && selected) {
      const from = visible.findIndex((row) => row.path === selected.path);
      const to = visible.findIndex((row) => row.path === node.path);
      if (from === -1 || to === -1) return false;
      setFilesView(workspaceId, { selected, multi: visible.slice(Math.min(from, to), Math.max(from, to) + 1) });
      return true;
    }
    if (!e.metaKey && !e.ctrlKey) return false;
    const base = multi.length ? multi : selected ? [selected] : [];
    const next = base.some((row) => row.path === node.path) ? base.filter((row) => row.path !== node.path) : [...base, node];
    setFilesView(workspaceId, { selected: node, multi: next });
    return true;
  };
  const inMulti = (path: string) => multi.length > 1 && multi.some((row) => row.path === path);
  const act = (action: FilesMenuAction, target: FilesTarget) => {
    if (action === "delete" && inMulti(target.path)) void deleteEntries(workspaceId, multi).then((done) => done && setFilesView(workspaceId, { selected: null }));
    else if (action === "newFile" || action === "newFolder") startCreate(action === "newFile" ? "file" : "folder", target.kind === "file" ? target.path.slice(0, Math.max(target.path.lastIndexOf("/"), 0)) : target.path);
    else if (action === "rename") setRenaming(target.path);
    else runFilesAction(action, target);
  };
  const renamed = (from: string, to: string, isFile: boolean) => {
    setRenaming(null);
    if (from === to) return;
    const next = new Set([...open].map((dir) => retargetPath(dir, from, to) ?? dir));
    setFilesView(workspaceId, { open: next, selected: { path: to, file: isFile } });
  };

  const rowProps = { open, statuses, dirtyDirs, onToggle: toggle, workspaceId, selected, multi, onPick: pick, creating, renaming, onSelect: setSelected, onCreateDone: () => setCreating(null), onMenu: setMenu, onAction: act, onRenameDone: () => setRenaming(null), onRenamed: renamed };
  const showHeader = !root || root.header;
  const body = (
    <>
      {!missing && !files && <div className="empty-hint">{S.filesLoading}</div>}
      {files && files.length === 0 && !emptyDirs?.length && !creating && <div className="empty-hint">{S.filesTabEmpty}</div>}
      {creating?.dir === "" && <NewEntryRow workspaceId={workspaceId} dir="" kind={creating.kind} depth={base} onDone={() => setCreating(null)} />}
      {tree.children.map((node) => <TreeRow key={node.path} node={node} depth={base} {...rowProps} />)}
    </>
  );
  if (root) {
    const expanded = rootOpen && !missing;
    return (
      <>
        {showHeader &&
          (headSlot ? (
            createPortal(<FilesHeaderActions onOpenFolder={() => (canPickFolder() ? void openFolderInNewSession() : setOpenFolder(true))} onCreate={startCreate} onRefresh={() => void refreshFileList(workspaceId)} />, headSlot)
          ) : (
            <div className="files-header" role="toolbar" aria-label={S.filesHeaderAria}>
              <span className="spacer" />
              <FilesHeaderActions onOpenFolder={() => (canPickFolder() ? void openFolderInNewSession() : setOpenFolder(true))} onCreate={startCreate} onRefresh={() => void refreshFileList(workspaceId)} />
            </div>
          ))}
        <div ref={treeRef} className="files-tab files-tab-root" role="tree" aria-label={root.label}>
          <div role="group">
            <div className="files-root-wrap">
            <button
              type="button"
              role="treeitem"
              aria-expanded={expanded}
              className="tree-node files-root"
              data-missing={missing || undefined}
              onClick={() => !missing && setFilesView(workspaceId, { rootOpen: !rootOpen })}
              onContextMenu={(e) => {
                if (!root.onRemove) return;
                e.preventDefault();
                setRootMenu({ x: e.clientX, y: e.clientY });
              }}
            >
              <span className="chev" data-collapsed={!expanded || undefined}>
                <ChevronRight size={14} />
              </span>
              <span className="name">{root.label}</span>
              {missing && <span className="files-root-note">{S.folderNotFound}</span>}
            </button>
            {!missing && (
              <span className="files-root-actions">
                <Button size="icon" aria-label={S.filesNewFile} title={S.filesNewFile} onClick={() => startCreate("file", "")}>
                  <Codicon name="new-file" />
                </Button>
                <Button size="icon" aria-label={S.filesNewFolder} title={S.filesNewFolder} onClick={() => startCreate("folder", "")}>
                  <Codicon name="new-folder" />
                </Button>
                <Button size="icon" aria-label={S.filesCollapse} title={S.filesCollapse} onClick={() => setFilesView(workspaceId, { open: new Set() })}>
                  <Codicon name="collapse-all" />
                </Button>
              </span>
            )}
            </div>
            {expanded && body}
          </div>
        </div>
        {rootMenu && root.onRemove && <RootMenu at={rootMenu} onRemove={root.onRemove} onClose={() => setRootMenu(null)} />}
        {openFolder && <OpenFolderDialog onClose={() => setOpenFolder(false)} onOpened={(id) => startDraft(id)} />}
        <TreeMenu menu={menu} canAttach={canAttach} onClose={() => setMenu(null)} onAction={(action) => menu && act(action, { workspaceId, path: menu.path, kind: menu.kind })} />
      </>
    );
  }
  return (
    <>
      {headSlot ? (
        createPortal(<FilesHeaderActions onOpenFolder={() => (canPickFolder() ? void openFolderInNewSession() : setOpenFolder(true))} onCreate={startCreate} onRefresh={() => void refreshFileList(workspaceId)} />, headSlot)
      ) : (
        <div className="files-header" role="toolbar" aria-label={S.filesHeaderAria}>
          <span className="spacer" />
          <FilesHeaderActions onOpenFolder={() => (canPickFolder() ? void openFolderInNewSession() : setOpenFolder(true))} onCreate={startCreate} onRefresh={() => void refreshFileList(workspaceId)} />
        </div>
      )}
      <div ref={treeRef} className="files-tab" role="tree" aria-label={S.filesTreeAria}>
        {!files && <div className="empty-hint">{S.filesLoading}</div>}
        {files && files.length === 0 && !emptyDirs?.length && !creating && <div className="empty-hint">{S.filesTabEmpty}</div>}
        {creating?.dir === "" && <NewEntryRow workspaceId={workspaceId} dir="" kind={creating.kind} depth={0} onDone={() => setCreating(null)} />}
        {tree.children.map((node) => <TreeRow key={node.path} node={node} depth={0} {...rowProps} />)}
      </div>
      {openFolder && <OpenFolderDialog onClose={() => setOpenFolder(false)} onOpened={(id) => startDraft(id)} />}
      <TreeMenu menu={menu} canAttach={canAttach} onClose={() => setMenu(null)} onAction={(action) => menu && act(action, { workspaceId, path: menu.path, kind: menu.kind })} />
    </>
  );
}

function RootMenu({ at, onRemove, onClose }: { at: { x: number; y: number }; onRemove: () => void; onClose: () => void }) {
  return (
    <DropdownMenu open onOpenChange={(open) => !open && onClose()}>
      <DropdownMenuTrigger asChild>
        <button type="button" className="menu-anchor" style={{ left: at.x, top: at.y }} tabIndex={-1} aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" onCloseAutoFocus={(e) => e.preventDefault()}>
        <DropdownMenuItem onSelect={onRemove}>{S.removeFromSession}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function FilesHeaderActions({ onOpenFolder, onCreate, onRefresh }: { onOpenFolder: () => void; onCreate: (kind: "file" | "folder") => void; onRefresh: () => void }) {
  return (
    <>
      <Button size="icon" aria-label={S.filesOpenFolder} title={S.filesOpenFolder} onClick={onOpenFolder}>
        <Codicon name="folder-opened" />
      </Button>
      <Button size="icon" aria-label={S.filesNewFile} title={S.filesNewFile} onClick={() => onCreate("file")}>
        <Codicon name="new-file" />
      </Button>
      <Button size="icon" aria-label={S.filesNewFolder} title={S.filesNewFolder} onClick={() => onCreate("folder")}>
        <Codicon name="new-folder" />
      </Button>
      <Button size="icon" aria-label={S.refresh} title={S.refresh} onClick={onRefresh}>
        <Codicon name="refresh" />
      </Button>
    </>
  );
}

type RowProps = {
  node: Node;
  depth: number;
  open: ReadonlySet<string>;
  statuses: Map<string, Status>;
  dirtyDirs: Set<string>;
  onToggle: (path: string) => void;
  workspaceId: string;
  selected: Selected;
  multi: readonly FilesPicked[];
  onPick: (node: FilesPicked, e: React.MouseEvent) => boolean;
  creating: Creating | null;
  renaming: string | null;
  onSelect: (selected: Selected) => void;
  onCreateDone: () => void;
  onMenu: (menu: RowMenu) => void;
  onAction: (action: FilesMenuAction, target: FilesTarget) => void;
  onRenameDone: () => void;
  onRenamed: (from: string, to: string, isFile: boolean) => void;
};

function TreeRow({ node, depth, open, statuses, dirtyDirs, onToggle, workspaceId, selected, multi, onPick, creating, renaming, onSelect, onCreateDone, onMenu, onAction, onRenameDone, onRenamed }: RowProps) {
  const indent = { paddingLeft: `calc(var(--space-2) + ${depth} * var(--space-3))` };
  const kind: FilesRowKind = node.file ? "file" : "folder";
  const target: FilesTarget = { workspaceId, path: node.path, kind };
  const picked = multi.some((row) => row.path === node.path);
  const contextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    if (!picked) onSelect({ path: node.path, file: node.file });
    onMenu({ path: node.path, kind, x: e.clientX, y: e.clientY });
  };
  const rowKey = (e: ReactKeyboardEvent) => {
    const action = filesKeyAction(e, kind);
    if (!action) return;
    e.preventDefault();
    e.stopPropagation();
    onAction(action, target);
  };
  const expanded = open.has(node.path);
  if (renaming === node.path) return <RenameRow workspaceId={workspaceId} node={node} depth={depth} expanded={expanded} onDone={onRenameDone} onRenamed={onRenamed} />;
  if (node.file) {
    const status = statuses.get(node.path);
    return (
      <button
        type="button"
        role="treeitem"
        className="tree-node"
        data-status={status}
        data-selected={picked || (!multi.length && selected?.file && selected.path === node.path) || undefined}
        style={indent}
        title={node.path}
        onClick={(e) => {
          if (onPick({ path: node.path, file: true }, e)) return;
          onSelect({ path: node.path, file: true });
          if (e.altKey) openFile({ workspaceId, path: node.path }, { side: true });
          else openFile({ workspaceId, path: node.path }, { preview: true });
        }}
        onDoubleClick={(e) => !e.altKey && openFile({ workspaceId, path: node.path })}
        onContextMenu={contextMenu}
        onKeyDown={rowKey}
      >
        <span className="chev" data-spacer aria-hidden="true">
          <ChevronRight size={14} />
        </span>
        <FileTypeIcon name={node.name} />
        <span className="name">{node.name}</span>
        {status && (
          <span className="file-status" data-s={status}>
            {status}
          </span>
        )}
      </button>
    );
  }
  const rowProps = { open, statuses, dirtyDirs, onToggle, workspaceId, selected, multi, onPick, creating, renaming, onSelect, onCreateDone, onMenu, onAction, onRenameDone, onRenamed };
  return (
    <div role="group">
      <button
        type="button"
        role="treeitem"
        aria-expanded={expanded}
        className="tree-node"
        data-dirty={dirtyDirs.has(node.path) || undefined}
        data-selected={picked || (!multi.length && selected && !selected.file && selected.path === node.path) || undefined}
        style={indent}
        onClick={(e) => {
          if (onPick({ path: node.path, file: false }, e)) return;
          onSelect({ path: node.path, file: false });
          onToggle(node.path);
        }}
        onContextMenu={contextMenu}
        onKeyDown={rowKey}
      >
        <span className="chev" data-collapsed={!expanded || undefined}>
          <ChevronRight size={14} />
        </span>
        <FolderTypeIcon name={node.name} open={expanded} />
        <span className="name">{node.name}</span>
      </button>
      {expanded && creating?.dir === node.path && <NewEntryRow workspaceId={workspaceId} dir={node.path} kind={creating.kind} depth={depth + 1} onDone={onCreateDone} />}
      {expanded && node.children.map((child) => <TreeRow key={child.path} node={child} depth={depth + 1} {...rowProps} />)}
    </div>
  );
}

function RenameRow({ workspaceId, node, depth, expanded, onDone, onRenamed }: { workspaceId: string; node: Node; depth: number; expanded: boolean; onDone: () => void; onRenamed: (from: string, to: string, isFile: boolean) => void }) {
  const [value, setValue] = useState(node.name);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const requests = useRef(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const timer = setTimeout(() => {
      input.current?.focus();
      const [from, to] = renameSelection(node.name, node.file);
      input.current?.setSelectionRange(from, to);
    }, 0);
    return () => clearTimeout(timer);
  }, [node.name, node.file]);
  const problemOf = async (name: string) => {
    const bad = renameProblem(name);
    if (bad) return bad === "empty" ? S.newEntryEmpty : S.renameInvalid;
    const to = renamedPath(node.path, name);
    return to === node.path ? null : validateNewPath(workspaceId, to);
  };
  const submit = async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const result = await renameEntry(workspaceId, node.path, value);
      if ("error" in result) setError(result.error);
      else onRenamed(node.path, result.to, node.file);
    } finally {
      busy.current = false;
    }
  };
  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      void submit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onDone();
    }
  };
  return (
    <div className="tree-node" role="treeitem" data-renaming style={{ paddingLeft: `calc(var(--space-2) + ${depth} * var(--space-3))` }}>
      <span className="chev" data-spacer={node.file || undefined} data-collapsed={(!node.file && !expanded) || undefined} aria-hidden="true">
        <ChevronRight size={14} />
      </span>
      {node.file ? <FileTypeIcon name={value} /> : <FolderTypeIcon name={value} open={expanded} />}
      <div className="tree-new-field">
        <input
          className="tree-new-input"
          ref={input}
          aria-label={S.renameEntryAria}
          aria-invalid={error ? true : undefined}
          value={value}
          onChange={(e) => {
            const next = e.target.value;
            setValue(next);
            const request = ++requests.current;
            void problemOf(next).then((problem) => request === requests.current && setError(problem));
          }}
          onKeyDown={onKeyDown}
          onBlur={() => {
            if (!busy.current) onDone();
          }}
        />
        {error && (
          <div className="tree-new-error" role="alert">
            <EntryError message={error} />
          </div>
        )}
      </div>
    </div>
  );
}

function NewEntryRow({ workspaceId, dir, kind, depth, onDone }: { workspaceId: string; dir: string; kind: "file" | "folder"; depth: number; onDone: () => void }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const requests = useRef(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const timer = setTimeout(() => input.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, []);
  const fullPath = (name: string) => (dir ? `${dir}/${name.trim()}` : name.trim());
  const check = async (name: string) => (name.trim() ? validateNewPath(workspaceId, fullPath(name)) : S.newEntryEmpty);
  const submit = async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const problem = await check(value);
      if (problem) {
        setError(problem);
        return;
      }
      if (await createEntry(workspaceId, fullPath(value), kind)) onDone();
    } finally {
      busy.current = false;
    }
  };
  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter") {
      e.preventDefault();
      void submit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onDone();
    }
  };
  return (
    <div className="tree-new" style={{ paddingLeft: `calc(var(--space-2) + ${depth} * var(--space-3))` }}>
      {kind === "folder" ? <FolderTypeIcon name="" /> : <FileTypeIcon name="" />}
      <div className="tree-new-field">
        <input
          className="tree-new-input"
          ref={input}
          aria-label={S.newEntryAria(kind)}
          aria-invalid={error ? true : undefined}
          value={value}
          onChange={(e) => {
            const next = e.target.value;
            setValue(next);
            const request = ++requests.current;
            if (!next.trim()) setError(null);
            else void check(next).then((problem) => request === requests.current && setError(problem));
          }}
          onKeyDown={onKeyDown}
          onBlur={() => {
            if (!busy.current) onDone();
          }}
        />
        {error && (
          <div className="tree-new-error" role="alert">
            <EntryError message={error} />
          </div>
        )}
      </div>
    </div>
  );
}

function EntryError({ message }: { message: string }) {
  if (message.startsWith(S.newEntryExistsPre) && message.endsWith(S.newEntryExistsPost)) {
    return (
      <>
        {S.newEntryExistsPre}
        <b>{message.slice(S.newEntryExistsPre.length, message.length - S.newEntryExistsPost.length)}</b>
        {S.newEntryExistsPost}
      </>
    );
  }
  return <>{message}</>;
}

function TreeMenu({ menu, canAttach, onClose, onAction }: { menu: RowMenu | null; canAttach: boolean; onClose: () => void; onAction: (action: FilesMenuAction) => void }) {
  if (!menu) return null;
  return (
    <DropdownMenu open onOpenChange={(open) => !open && onClose()}>
      <DropdownMenuTrigger asChild>
        <button type="button" className="menu-anchor" style={{ left: menu.x, top: menu.y }} tabIndex={-1} aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" data-testid="files-menu" onCloseAutoFocus={(e) => e.preventDefault()}>
        {filesMenuItems(menu.kind, { canAttach }).map((item) => (
          <Fragment key={item.action}>
            {item.separatorBefore && <DropdownMenuSeparator />}
            <DropdownMenuItem disabled={item.disabled} data-action={item.action} onSelect={() => onAction(item.action)}>
              {S.filesMenuText[item.action]}
              {item.key && <span className="faint xs menu-hint">{item.key}</span>}
            </DropdownMenuItem>
          </Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function visibleRows(tree: Node, open: ReadonlySet<string>): FilesPicked[] {
  const rows: FilesPicked[] = [];
  const walk = (node: Node) => {
    for (const child of node.children) {
      rows.push({ path: child.path, file: child.file });
      if (!child.file && open.has(child.path)) walk(child);
    }
  };
  walk(tree);
  return rows;
}

function buildTree(paths: string[], emptyDirs: string[]): Node {
  const root: Node = { name: "", path: "", children: [], file: false };
  const dirs = new Map<string, Node>([["", root]]);
  const ensureDir = (parts: string[]) => {
    let parent = root;
    for (let i = 0; i < parts.length; i++) {
      const dirPath = parts.slice(0, i + 1).join("/");
      let dir = dirs.get(dirPath);
      if (!dir) {
        dir = { name: parts[i], path: dirPath, children: [], file: false };
        dirs.set(dirPath, dir);
        parent.children.push(dir);
      }
      parent = dir;
    }
    return parent;
  };
  for (const path of paths) {
    const parts = path.split("/");
    ensureDir(parts.slice(0, -1)).children.push({ name: parts[parts.length - 1], path, children: [], file: true });
  }
  for (const dir of emptyDirs) ensureDir(dir.split("/"));
  const sort = (node: Node) => {
    node.children.sort((a, b) => Number(a.file) - Number(b.file) || a.name.localeCompare(b.name));
    node.children.forEach(sort);
  };
  sort(root);
  return root;
}
