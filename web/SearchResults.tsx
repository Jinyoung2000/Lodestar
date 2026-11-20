import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type RefObject } from "react";
import { advanceAfterRemoval, cancelSearchView, dismissHits, openHit, openSearchInEditor, runSearchView, setCollapsed, toggleCollapsed } from "./findInFiles";
import { FileTypeIcon, FolderTypeIcon } from "./FileTypeIcon";
import { revealFilePath } from "./filesView";
import { Codicon } from "./icons";
import { hoverActions, searchMenuItems, appendPattern, fileTypePattern, type RowKind, type SearchMenuAction } from "./searchMenu";
import { replaceNode } from "./searchReplaceActions";
import { replacementOf, replaceShown } from "./searchReplaceModel";
import { currentModel, getSearchUi, setSearchUi, useSearchUi, viewModeOf } from "./searchState";
import { SV } from "./searchViewStrings";
import { collapsibleKeys, hitsUnder, lineLabel, previewOf, visibleRows, hitTooltip, type FileResult, type SearchHit, type FileNode, type FolderNode, type HitNode, type TreeNode, type VisibleRow } from "./searchTree";
import { flash, getState, searchWorkspaceOf, setState, updateSearchView, useStore } from "./store";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "./ui/dropdown-menu";


const OVERSCAN = 8;

type Menu = { node: TreeNode; x: number; y: number };

export function SearchResults({ listRef, inputRef }: { listRef: RefObject<HTMLDivElement | null>; inputRef: RefObject<HTMLTextAreaElement | null> }) {
  const run = useStore((s) => s.searchRun);
  const view = useStore((s) => s.searchView);
  const dismissed = useSearchUi((s) => s.dismissed);
  const settings = useSearchUi((s) => s.settings);
  const collapsed = useSearchUi((s) => s.collapsed);
  const cursor = useSearchUi((s) => s.cursor);
  const workspaceId = useStore(searchWorkspaceOf);
  const model = useMemo(() => currentModel(), [run, view.viewMode, dismissed, settings, workspaceId]);
  const rows = useMemo(() => visibleRows(model.nodes, collapsed), [model, collapsed]);
  const tree = viewModeOf(view.viewMode, settings) === "tree";
  const replace = replaceShown(view);
  const [menu, setMenu] = useState<Menu | null>(null);
  const rowHeight = useRowHeight();
  const { top, height } = useScrollWindow(listRef);
  const cursorIndex = rows.findIndex((row) => row.node.key === cursor);

  // 포커스한 행이 화면에 들어오게 스크롤한다
  const reveal = useCursorRevealRequest();
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || cursorIndex === -1 || rowHeight === 0) return;
    const rowTop = cursorIndex * rowHeight;
    if (rowTop < list.scrollTop) list.scrollTop = rowTop;
    else if (rowTop + rowHeight > list.scrollTop + list.clientHeight) list.scrollTop = rowTop + rowHeight - list.clientHeight;
  }, [cursorIndex, rowHeight, reveal, listRef]);

  // 접힌 곳 안의 일치가 포커스를 받으면(F4 등) 그 조상을 펼친다. 포커스가 그대로인데 접힌 경우(Collapse All)에는 펼치지 않는다.
  const lastCursor = useRef<string | null>(null);
  useEffect(() => {
    const moved = lastCursor.current !== cursor;
    lastCursor.current = cursor;
    if (!moved || !cursor || cursorIndex !== -1) return;
    const ancestors = ancestorKeys(model.nodes, cursor);
    if (ancestors.some((key) => collapsed.has(key))) setSearchUi({ collapsed: new Set([...collapsed].filter((key) => !ancestors.includes(key))) });
  }, [cursor, cursorIndex, model, collapsed]);

  const key = (event: KeyboardEvent<HTMLDivElement>) => listKey(event, rows, cursorIndex, inputRef);
  const first = rowHeight === 0 ? 0 : Math.max(0, Math.floor(top / rowHeight) - OVERSCAN);
  const last = rowHeight === 0 ? Math.min(rows.length, 50) : Math.min(rows.length, Math.ceil((top + height) / rowHeight) + OVERSCAN);
  return (
    <div className="sv-results" data-mode={tree ? "tree" : "list"}>
      <div ref={listRef} className="sv-list" role="tree" aria-label={SV.title} tabIndex={0} onKeyDown={key}>
        <div className="sv-list-rows" style={{ height: rows.length * rowHeight }}>
          {rows.slice(first, last).map((row, i) => (
            <Row key={row.node.key} row={row} index={first + i} selected={row.node.key === cursor} replace={replace} tree={tree} onMenu={(x, y) => setMenu({ node: row.node, x, y })} />
          ))}
        </div>
      </div>
      <RowMenu menu={menu} onClose={() => setMenu(null)} hasResults={model.hitCount > 0} replace={replace} />
    </div>
  );
}

// --- 행 ---

function Row({ row, index, selected, replace, tree, onMenu }: { row: VisibleRow; index: number; selected: boolean; replace: boolean; tree: boolean; onMenu: (x: number, y: number) => void }) {
  const { node, depth, expanded } = row;
  const rowHeight = useRowHeight();
  const select = () => setSearchUi({ cursor: node.key });
  const onContext = (event: MouseEvent) => {
    event.preventDefault();
    select();
    onMenu(event.clientX, event.clientY);
  };
  return (
    <div
      className="sv-row"
      role="treeitem"
      aria-level={depth + 1}
      aria-expanded={expanded ?? undefined}
      aria-selected={selected}
      data-kind={node.kind}
      data-selected={selected || undefined}
      style={{ top: index * rowHeight, paddingLeft: `calc(${depth} * var(--size-sv-indent))` }}
      onContextMenu={onContext}
    >
      {Array.from({ length: depth }, (_, level) => (
        <span key={level} className="sv-guide" style={{ left: `calc(var(--size-sv-indent) * ${level + 2})` }} />
      ))}
      {node.kind === "hit" ? <HitRowBody node={node} replace={replace} /> : node.kind === "file" ? <FileRowBody node={node} expanded={expanded === true} tree={tree} replace={replace} /> : <FolderRowBody node={node} expanded={expanded === true} replace={replace} />}
    </div>
  );
}

function Twistie({ expanded, nodeKey, show }: { expanded: boolean; nodeKey: string; show: boolean }) {
  return (
    <span
      className="sv-twistie"
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => {
        if (!show) return;
        e.stopPropagation();
        setSearchUi({ cursor: nodeKey });
        toggleCollapsed(nodeKey);
      }}
    >
      {show && <Codicon name={expanded ? "chevron-down" : "chevron-right"} />}
    </span>
  );
}

function FileRowBody({ node, expanded, tree, replace }: { node: FileNode; expanded: boolean; tree: boolean; replace: boolean }) {
  const onClick = () => {
    setSearchUi({ cursor: node.key });
    toggleCollapsed(node.key);
  };
  return (
    <div className="sv-row-body sv-file" title={node.file.path} onClick={onClick}>
      <Twistie expanded={expanded} nodeKey={node.key} show />
      <FileTypeIcon name={node.file.name} />
      <span className="sv-name">{node.file.name}</span>
      {!tree && node.file.dir !== "" && <span className="sv-desc">{node.file.dir}</span>}
      <span className="sv-spacer" />
      <span className="sv-badge" title={SV.matchBadge(node.hitCount)}>
        {node.hitCount}
      </span>
      <RowActions node={node} replace={replace} />
    </div>
  );
}

function FolderRowBody({ node, expanded, replace }: { node: FolderNode; expanded: boolean; replace: boolean }) {
  const onClick = () => {
    setSearchUi({ cursor: node.key });
    toggleCollapsed(node.key);
  };
  return (
    <div className="sv-row-body sv-folder" title={node.path} onClick={onClick}>
      <Twistie expanded={expanded} nodeKey={node.key} show />
      <FolderTypeIcon name={node.label.slice(node.label.lastIndexOf("/") + 1)} open={expanded} />
      <span className="sv-name">
        {node.label.split("/").map((part, i) => (
          <Fragment key={i}>
            {i > 0 && <span className="sv-label-separator">/</span>}
            {part}
          </Fragment>
        ))}
      </span>
      <span className="sv-spacer" />
      <span className="sv-badge" title={SV.fileBadge(node.fileCount)}>
        {node.hitCount}
      </span>
      <RowActions node={node} replace={replace} />
    </div>
  );
}

function HitRowBody({ node, replace }: { node: HitNode; replace: boolean }) {
  const view = useStore((s) => s.searchView);
  const showLineNumbers = useSearchUi((s) => s.settings.showLineNumbers);
  const smartCase = useSearchUi((s) => s.settings.smartCase);
  const preview = previewOf(node.hit);
  const replacement = replace ? replacementOf(node.hit, view, smartCase) : null;
  // 한 번 누르면 미리보기 탭으로 열고 포커스는 목록에 남는다(75ms 안의 연속 이벤트는 하나로 본다). 두 번 누르면 고정 탭이고 포커스가 에디터로 간다.
  const onClick = (event: MouseEvent) => {
    setSearchUi({ cursor: node.key });
    if (event.detail > 1) return;
    openHit(node.hit, { pinned: false, preserveFocus: true });
  };
  return (
    <div className="sv-row-body sv-hit" title={hitTooltip(node.hit, replacement)} onClick={onClick} onDoubleClick={() => openHit(node.hit, { pinned: true, preserveFocus: false })}>
      <span className="sv-twistie" />
      <span className="sv-line">
        {showLineNumbers && <span className="sv-line-no">{lineLabel(node.hit)}</span>}
        <span className="sv-before">{preview.before}</span>
        <span className="sv-match" data-replace={replacement !== null || undefined}>
          {preview.inside}
        </span>
        {replacement !== null && <span className="sv-replaced">{replacement}</span>}
        <span className="sv-after">{preview.after}</span>
      </span>
      <RowActions node={node} replace={replace} />
    </div>
  );
}

// hover 하면 나오는 단추들: 바꾸기가 펼쳐져 있으면 Replace(파일, 폴더는 Replace All)와 Dismiss, 아니면 Dismiss 하나
function RowActions({ node, replace }: { node: TreeNode; replace: boolean }) {
  const kind: RowKind = node.kind;
  const actions = hoverActions(kind, replace);
  return (
    <span className="sv-actions" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
      {actions.map((action) => {
        const label = action === "dismiss" ? SV.withKey(SV.dismiss, "⌘⌫") : SV.withKey(action === "replace" ? SV.replace : SV.replaceAll, "⇧⌘1");
        return (
          <button key={action} type="button" className="sv-action" aria-label={label} title={label} onClick={() => (action === "dismiss" ? dismissNode(node) : void replaceNode(node))}>
            <Codicon name={action === "dismiss" ? "close" : "replace"} />
          </button>
        );
      })}
    </span>
  );
}

// --- 지우기, 이동 ---

function dismissNode(node: TreeNode) {
  const rows = visibleRows(currentModel().nodes, getSearchUi().collapsed);
  const at = rows.findIndex((row) => row.node.key === node.key);
  dismissHits(hitsUnder(node));
  advanceAfterRemoval(at);
}

function ancestorKeys(nodes: readonly TreeNode[], key: string, path: string[] = []): string[] {
  for (const node of nodes) {
    if (node.key === key) return path;
    if (node.kind !== "hit") {
      const found = ancestorKeys(node.children, key, [...path, node.key]);
      if (found.length > 0 || node.children.some((child) => child.key === key)) return found.length > 0 ? found : [...path, node.key];
    }
  }
  return [];
}

// --- 키보드 ---

function listKey(event: KeyboardEvent<HTMLDivElement>, rows: VisibleRow[], at: number, inputRef: RefObject<HTMLTextAreaElement | null>) {
  const mod = event.metaKey && !event.ctrlKey;
  const move = (index: number) => {
    const row = rows[Math.min(Math.max(index, 0), rows.length - 1)];
    if (!row) return;
    event.preventDefault();
    setSearchUi({ cursor: row.node.key });
    // 화살표 이동은 일치 행이면 미리보기로 열되 포커스는 목록에 둔다
    if (row.node.kind === "hit") openHit(row.node.hit, { pinned: false, preserveFocus: true });
  };
  const current = at === -1 ? null : rows[at];
  if (event.key === "ArrowDown" && !mod) return move(at === -1 ? 0 : at + 1);
  if (event.key === "ArrowUp" && !mod) return move(at === -1 ? rows.length - 1 : at - 1);
  if (event.key === "ArrowUp" && mod) {
    // search.action.focusSearchFromResults: 첫 행에서 ⌘↑ 면 검색 입력으로
    if (at <= 0) {
      event.preventDefault();
      inputRef.current?.focus();
    }
    return;
  }
  if (event.key === "Home") return move(0);
  if (event.key === "End") return move(rows.length - 1);
  if (event.key === "PageDown") return move(at + 10);
  if (event.key === "PageUp") return move(at - 10);
  if (event.key === "Escape") {
    if (getSearchUi().phase !== 0) {
      event.preventDefault();
      cancelSearchView();
      inputRef.current?.focus();
    }
    return;
  }
  if (!current) return;
  const node = current.node;
  if (event.key === "ArrowRight" && node.kind !== "hit") {
    event.preventDefault();
    if (current.expanded) move(at + 1);
    else setCollapsed(node.key, false);
    return;
  }
  if (event.key === "ArrowLeft") {
    event.preventDefault();
    if (node.kind !== "hit" && current.expanded) setCollapsed(node.key, true);
    else {
      const parent = [...rows.slice(0, at)].reverse().find((row) => row.depth < current.depth);
      if (parent) setSearchUi({ cursor: parent.node.key });
    }
    return;
  }
  if ((event.key === "Enter" && !event.metaKey && !event.altKey && !event.shiftKey) || (event.key === "ArrowDown" && mod)) {
    event.preventDefault();
    const side = event.ctrlKey;
    if (node.kind === "hit") openHit(node.hit, { pinned: true, preserveFocus: false, side });
    else if (node.kind === "file" && node.children.length > 0) openHit(node.children[node.children.length - 1].hit, { pinned: true, preserveFocus: false, side });
    else toggleCollapsed(node.key);
    return;
  }
  if (event.key === "Enter" && mod) {
    event.preventDefault();
    openSearchInEditor();
    return;
  }
  if (event.key === "Backspace" && mod) {
    event.preventDefault();
    dismissNode(node);
    return;
  }
  if (mod && event.shiftKey && (event.key === "1" || event.code === "Digit1") && replaceShown(getState().searchView)) {
    event.preventDefault();
    void replaceNode(node);
    return;
  }
  if (mod && event.code === "KeyC" && !event.shiftKey) {
    event.preventDefault();
    runMenuAction(event.altKey ? "copyPath" : "copy", node);
    return;
  }
}

// --- 우클릭 메뉴 ---

function RowMenu({ menu, onClose, hasResults, replace }: { menu: Menu | null; onClose: () => void; hasResults: boolean; replace: boolean }) {
  if (!menu) return null;
  const kind: RowKind = menu.node.kind;
  return (
    <DropdownMenu open onOpenChange={(open) => !open && onClose()}>
      <DropdownMenuTrigger asChild>
        <button type="button" className="menu-anchor" style={{ left: menu.x, top: menu.y }} tabIndex={-1} aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" data-testid="search-menu" onCloseAutoFocus={(e) => e.preventDefault()}>
        {searchMenuItems(kind, { replaceShown: replace, hasResults }).map((item) => (
          <Fragment key={item.action}>
            {item.separatorBefore && <DropdownMenuSeparator />}
            <DropdownMenuItem data-action={item.action} onSelect={() => runMenuAction(item.action, menu.node)}>
              {menuLabel(item.action)}
              {item.key && <span className="faint xs menu-hint">{item.key}</span>}
            </DropdownMenuItem>
          </Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const menuLabel = (action: SearchMenuAction) => ({ replace: SV.replace, replaceAll: SV.replaceAll, dismiss: SV.dismiss, restrictToFolder: SV.restrictToFolder, expandRecursively: SV.expandRecursively, excludeFolder: SV.excludeFolder, excludeFileType: SV.excludeFileType, includeFileType: SV.includeFileType, copy: SV.copy, copyPath: SV.copyPath, copyAll: SV.copyAll, reveal: SV.revealInExplorer })[action];

function runMenuAction(action: SearchMenuAction, node: TreeNode) {
  const state = getState();
  const workspaceId = searchWorkspaceOf(state);
  if (!workspaceId) return;
  const dir = state.workspaces.find((w) => w.id === workspaceId)?.dir ?? "";
  const path = node.kind === "hit" ? node.hit.path : node.kind === "file" ? node.file.path : node.path;
  const refresh = () => {
    updateSearchView({ details: true });
    queueMicrotask(() => void runSearchView());
  };
  switch (action) {
    case "replace":
    case "replaceAll":
      void replaceNode(node);
      return;
    case "dismiss":
      dismissNode(node);
      return;
    case "restrictToFolder":
      updateSearchView({ include: `./${path}` });
      refresh();
      return;
    case "expandRecursively": {
      const keys = new Set(collapsibleKeys([node]));
      setSearchUi({ collapsed: new Set([...getSearchUi().collapsed].filter((key) => !keys.has(key))) });
      return;
    }
    case "excludeFolder":
      updateSearchView({ exclude: appendPattern(state.searchView.exclude, `./${path}`) });
      refresh();
      return;
    case "excludeFileType": {
      const pattern = fileTypePattern(path);
      if (pattern) updateSearchView({ exclude: appendPattern(state.searchView.exclude, pattern) });
      refresh();
      return;
    }
    case "includeFileType": {
      const pattern = fileTypePattern(path);
      if (pattern) updateSearchView({ include: appendPattern(state.searchView.include, pattern) });
      refresh();
      return;
    }
    case "copy":
      copyText(copyOf(node, dir));
      return;
    case "copyPath":
      copyText(`${dir}/${path}`);
      return;
    case "copyAll":
      copyText(currentModel().files.map((file) => copyFile(dir, file)).join("\n"));
      return;
    case "reveal":
      setState({ activeTabKey: "files" });
      revealFilePath(workspaceId, path);
      return;
  }
}

function copyOf(node: TreeNode, dir: string): string {
  if (node.kind === "hit") return hitLine(node.hit);
  if (node.kind === "file") return copyFile(dir, node.file);
  return node.children.map((child) => copyOf(child, dir)).join("\n");
}

const hitLine = (hit: SearchHit) => `${hit.line},${hit.start + 1}: ${hit.text.trim()}`;
const copyFile = (dir: string, file: FileResult) => [`${dir}/${file.path}`, ...file.hits.map((hit) => `  ${hitLine(hit)}`)].join("\n");

function copyText(text: string) {
  void navigator.clipboard.writeText(text).catch(() => flash("Could not copy to the clipboard", "error"));
}

// --- 목록 크기와 스크롤 ---

let cachedRowHeight = 0;

// 토큰 --size-row 의 실제 픽셀. 한 번 읽어 둔다.
function useRowHeight(): number {
  const [height, setHeight] = useState(cachedRowHeight);
  useLayoutEffect(() => {
    if (cachedRowHeight > 0) return;
    const px = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--size-row"));
    cachedRowHeight = Number.isFinite(px) && px > 0 ? px : 22;
    setHeight(cachedRowHeight);
  }, []);
  return height;
}

function useScrollWindow(ref: RefObject<HTMLElement | null>) {
  const [window_, setWindow] = useState({ top: 0, height: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setWindow({ top: el.scrollTop, height: el.clientHeight });
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => {
      el.removeEventListener("scroll", measure);
      observer.disconnect();
    };
  }, [ref]);
  return window_;
}

// ⌘↓ 로 입력에서 결과로 올 때: 포커스한 행이 없으면 첫 행을 잡는다
let revealNonce = 0;
const revealListeners = new Set<() => void>();

export function revealCursor() {
  const model = currentModel();
  const rows = visibleRows(model.nodes, getSearchUi().collapsed);
  if (getSearchUi().cursor === null && rows.length > 0) setSearchUi({ cursor: rows[0].node.key });
  revealNonce++;
  revealListeners.forEach((listener) => listener());
}

function useCursorRevealRequest() {
  const [nonce, setNonce] = useState(revealNonce);
  useEffect(() => {
    const listener = () => setNonce(revealNonce);
    revealListeners.add(listener);
    return () => {
      revealListeners.delete(listener);
    };
  }, []);
  return nonce;
}
