import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { createEntry, refreshFileList, validateNewPath } from "./editorDocs";
import { renameEntry, runFilesAction, type FilesTarget } from "./filesActions";
import { filesKeyAction, filesMenuItems, renamedPath, renameProblem, renameSelection, retargetPath, type FilesMenuAction, type FilesRowKind } from "./filesMenu";
import { expandFolders, setFilesView, toggleFolder, useFilesView, type FilesSelected } from "./filesView";
import { ChevronRight, Codicon } from "./icons";
import { FileTypeIcon, FolderTypeIcon } from "./FileTypeIcon";
import { toTarget } from "./lsp";
import { OpenFolderDialog } from "./OpenFolderDialog";
import { ensureFiles, openFile, startDraft, useStore } from "./store";
import { S } from "./strings";
import { Button } from "./ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "./ui/dropdown-menu";

type Node = { name: string; path: string; children: Node[]; file: boolean };
type Status = "A" | "M" | "D" | "R";
// 새 파일, 폴더 이름을 받는 중인 입력: 어느 폴더 아래(빈 문자열은 맨 위)에 무엇을 만드는지
type Creating = { dir: string; kind: "file" | "folder" };
type Selected = FilesSelected;
// path 는 우클릭한 행의 작업 폴더 기준 경로(루트 행은 빈 문자열), kind 는 그 행의 종류
type RowMenu = { path: string; kind: FilesRowKind; x: number; y: number };

// 오른쪽 패널의 Files 탭: 작업 폴더의 전체 파일 트리(폴더가 하나뿐이라 폴더 이름 행은 두지 않는다). 바뀐 파일은 이름 색이 상태를 따르고, 바뀐 파일이 든 폴더 이름은 녹색이다.
// 머리줄의 New File..., New Folder... 와 행 우클릭 메뉴가 고른 폴더(파일이면 그 파일이 든 폴더) 아래에 이름 입력 줄을 열고, Enter 로 만든다.
// 파일을 한 번 누르면 미리보기 탭으로, 더블클릭하면 고정 탭으로 열린다. 행 우클릭 메뉴와 F2(이름 바꾸기) 같은 행 키는 filesMenu.ts, 동작은 filesActions.ts 에 있다.
// 세션이 없는 새 세션 화면에서는 agentId 가 null 이고 고른 폴더의 트리만 보인다.
export function FilesTab({ workspaceId, agentId }: { workspaceId: string; agentId: string | null }) {
  const files = useStore((s) => s.files[workspaceId]);
  const emptyDirs = useStore((s) => s.emptyDirs[workspaceId]);
  const changed = useStore((s) => (agentId ? s.gitChanges[agentId] : undefined));
  const { open, selected } = useFilesView(workspaceId);
  const setSelected = (next: Selected) => setFilesView(workspaceId, { selected: next });
  const [creating, setCreating] = useState<Creating | null>(null);
  const [menu, setMenu] = useState<RowMenu | null>(null);
  // FBREDO: 머리줄의 Open Folder... 가 여는 경로 입력 창
  const [openFolder, setOpenFolder] = useState(false);
  // 이름을 바꾸는 중인 행의 경로
  const [renaming, setRenaming] = useState<string | null>(null);
  const canAttach = useStore((s) => !!s.activePaneId);
  const treeRef = useRef<HTMLDivElement>(null);
  const [headSlot, setHeadSlot] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    setHeadSlot(treeRef.current?.closest(".focus-side")?.querySelector<HTMLElement>(".focus-side-actions") ?? null);
  }, []);
  useEffect(() => {
    ensureFiles(workspaceId);
  }, [workspaceId]);
  const tree = useMemo(() => buildTree(files ?? [], emptyDirs ?? []), [files, emptyDirs]);
  // 변경 파일을 작업 폴더 기준 경로로 바꾼다. 작업 폴더 밖 파일(../ 로 시작)은 트리에 없으니 뺀다.
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

  // 새로 만들 곳: 고른 폴더, 파일을 골랐으면 그 파일이 든 폴더, 아무것도 안 골랐으면 맨 위
  const targetDir = (from: Selected) => (!from ? "" : from.file ? from.path.slice(0, Math.max(from.path.lastIndexOf("/"), 0)) : from.path);
  const startCreate = (kind: "file" | "folder", dir = targetDir(selected)) => {
    setFilesView(workspaceId, { rootOpen: true });
    expandFolders(workspaceId, dir);
    setCreating({ dir, kind });
  };

  // 메뉴 항목과 행 키가 같은 길로 들어온다. 트리 안 입력줄을 여는 셋은 여기서, 나머지는 filesActions 가 한다.
  const act = (action: FilesMenuAction, target: FilesTarget) => {
    if (action === "newFile" || action === "newFolder") startCreate(action === "newFile" ? "file" : "folder", target.kind === "file" ? target.path.slice(0, Math.max(target.path.lastIndexOf("/"), 0)) : target.path);
    else if (action === "rename") setRenaming(target.path);
    else runFilesAction(action, target);
  };
  // 이름 바꾸기가 끝나면 고른 행과 펼친 폴더를 새 경로로 옮긴다
  const renamed = (from: string, to: string, isFile: boolean) => {
    setRenaming(null);
    if (from === to) return;
    const next = new Set([...open].map((dir) => retargetPath(dir, from, to) ?? dir));
    setFilesView(workspaceId, { open: next, selected: { path: to, file: isFile } });
  };

  const rowProps = { open, statuses, dirtyDirs, onToggle: toggle, workspaceId, selected, creating, renaming, onSelect: setSelected, onCreateDone: () => setCreating(null), onMenu: setMenu, onAction: act, onRenameDone: () => setRenaming(null), onRenamed: renamed };
  return (
    <>
      {headSlot ? (
        createPortal(<FilesHeaderActions onOpenFolder={() => setOpenFolder(true)} onCreate={startCreate} onRefresh={() => void refreshFileList(workspaceId)} />, headSlot)
      ) : (
        <div className="files-header" role="toolbar" aria-label={S.filesHeaderAria}>
          <span className="spacer" />
          <FilesHeaderActions onOpenFolder={() => setOpenFolder(true)} onCreate={startCreate} onRefresh={() => void refreshFileList(workspaceId)} />
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
  creating: Creating | null;
  renaming: string | null;
  onSelect: (selected: Selected) => void;
  onCreateDone: () => void;
  onMenu: (menu: RowMenu) => void;
  onAction: (action: FilesMenuAction, target: FilesTarget) => void;
  onRenameDone: () => void;
  onRenamed: (from: string, to: string, isFile: boolean) => void;
};

function TreeRow({ node, depth, open, statuses, dirtyDirs, onToggle, workspaceId, selected, creating, renaming, onSelect, onCreateDone, onMenu, onAction, onRenameDone, onRenamed }: RowProps) {
  const indent = { paddingLeft: `calc(var(--space-2) + ${depth} * var(--space-3))` };
  const kind: FilesRowKind = node.file ? "file" : "folder";
  const target: FilesTarget = { workspaceId, path: node.path, kind };
  const contextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    onSelect({ path: node.path, file: node.file });
    onMenu({ path: node.path, kind, x: e.clientX, y: e.clientY });
  };
  // 행에 포커스가 있을 때 F2, ⌘⌫, ⌥⌘R, ⌥⌘C, ⇧⌥⌘C 를 앱 전역 키보다 먼저 받는다
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
        data-selected={(selected?.file && selected.path === node.path) || undefined}
        style={indent}
        title={node.path}
        onClick={(e) => {
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
  const rowProps = { open, statuses, dirtyDirs, onToggle, workspaceId, selected, creating, renaming, onSelect, onCreateDone, onMenu, onAction, onRenameDone, onRenamed };
  return (
    <div role="group">
      <button
        type="button"
        role="treeitem"
        aria-expanded={expanded}
        className="tree-node"
        data-dirty={dirtyDirs.has(node.path) || undefined}
        data-selected={(selected && !selected.file && selected.path === node.path) || undefined}
        style={indent}
        onClick={() => {
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

// 행 자리에서 이름을 바꾸는 입력줄(F2, 메뉴의 Rename...). 확장자 앞까지 골라 둔다. Enter 로 바꾸고 Esc 나 포커스를 잃으면 취소한다. 이미 있는 이름이면 입력 아래에 오류를 보이고 바꾸지 않는다.
function RenameRow({ workspaceId, node, depth, expanded, onDone, onRenamed }: { workspaceId: string; node: Node; depth: number; expanded: boolean; onDone: () => void; onRenamed: (from: string, to: string, isFile: boolean) => void }) {
  const [value, setValue] = useState(node.name);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const requests = useRef(0);
  const input = useRef<HTMLInputElement>(null);
  // 우클릭 메뉴(Radix)가 닫히는 동안은 포커스를 메뉴 안에 가두고 있어 autoFocus 가 먹지 않는다. 메뉴가 사라진 뒤에 포커스를 주고 이름을 고른다.
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
            // 입력하는 동안에도 이미 있는 이름인지 바로 알린다(늦게 온 이전 응답은 버린다)
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

// 트리 안 인라인 이름 입력. Enter 로 만들고 Esc 나 포커스를 잃으면 취소한다. 이미 있는 이름이면 입력 아래에 오류를 보이고 만들지 않는다.
function NewEntryRow({ workspaceId, dir, kind, depth, onDone }: { workspaceId: string; dir: string; kind: "file" | "folder"; depth: number; onDone: () => void }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const requests = useRef(0);
  const input = useRef<HTMLInputElement>(null);
  // 우클릭 메뉴(Radix)가 닫히는 동안은 포커스를 메뉴 안에 가두고 있어 autoFocus 가 먹지 않는다. 메뉴가 사라진 뒤에 포커스를 준다.
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
            // 입력하는 동안에도 이미 있는 이름인지 바로 알린다(늦게 온 이전 응답은 버린다)
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

// 폴더가 먼저, 이름순. 목록은 git ls-files 라 폴더 항목이 따로 없어서 경로에서 만들고, 파일이 없는 폴더는 emptyDirs 로 더한다.
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
