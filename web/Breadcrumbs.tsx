import { EditorView } from "@codemirror/view";
import { useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import "./breadcrumbs.css";
import "./breadcrumbCommands";
import { BreadcrumbMenu, type MenuClose, type MenuSource } from "./BreadcrumbMenu";
import { crumbsFor, listable, symbolTone, type PickTarget } from "./breadcrumbModel";
import { currentBreadcrumbSymbols, useBreadcrumbSymbols } from "./breadcrumbSymbols";
import { symbolIcon, type SymbolNode } from "./documentSymbols";
import { FileTypeIcon } from "./FileTypeIcon";
import { expandFolders, revealFilePath, setFilesView } from "./filesView";
import { Codicon } from "./icons";
import { viewFor } from "./lsp";
import { openFile, setState } from "./store";
import { S } from "./strings";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./ui/dropdown-menu";

export function Breadcrumbs({ tabKey, workspaceId, path, deleted }: { tabKey: string; workspaceId: string; path: string; deleted: boolean }) {
  const symbols = useBreadcrumbSymbols(tabKey);
  const crumbs = crumbsFor(path, symbols.tree, symbols.path);
  const navRef = useRef<HTMLElement>(null);
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const [context, setContext] = useState<{ path: string; file: boolean; x: number; y: number } | null>(null);
  const closed = useRef<{ index: number; at: number } | null>(null);
  const restore = useRef<ReturnType<EditorView["scrollSnapshot"]> | null>(null);
  const ids = crumbs.map((crumb) => crumb.id).join("\n");

  useLayoutEffect(() => {
    if (navRef.current) navRef.current.scrollLeft = navRef.current.scrollWidth;
  }, [ids]);

  const openMenu = (index: number, pointerX: number | null) => {
    const anchor = navRef.current?.querySelector<HTMLElement>(`[data-index="${index}"]`);
    const source = menuSource(workspaceId, path, tabKey, index);
    if (!anchor || !source) return;
    restore.current = viewFor(tabKey)?.scrollSnapshot() ?? null;
    setMenu({ index, pointerX, source, anchor, name: anchor.textContent ?? "" });
  };

  const closeMenu = (why: MenuClose) => {
    if (!menu) return;
    closed.current = { index: menu.index, at: performance.now() };
    setMenu(null);
    const view = viewFor(tabKey);
    if (why !== "pick" && menu.source.kind === "symbols" && restore.current) view?.dispatch({ effects: restore.current });
    if (why === "escape") view?.focus();
  };

  const pick = (target: PickTarget, side: boolean) => {
    closeMenu("pick");
    if (target.type === "file") openFile({ workspaceId, path: target.path }, { preview: true, side });
    else if (target.type === "symbol") revealSymbol(tabKey, workspaceId, path, target.node, side);
  };

  const preview = (target: PickTarget) => {
    const view = viewFor(tabKey);
    if (view && target.type === "symbol") scrollNearTop(view, target.node.nameFrom);
  };

  const move = (step: -1 | 1) => {
    if (!menu) return;
    const next = menu.index + step;
    if (next < 0 || next >= crumbs.length) return;
    closeMenu("layout");
    navRef.current?.querySelector<HTMLElement>(`[data-index="${next}"]`)?.focus();
    openMenu(next, null);
  };

  const onItemClick = (index: number, event: MouseEvent) => {
    if (menu?.index === index) return closeMenu("layout");
    const recent = closed.current;
    if (recent && recent.index === index && performance.now() - recent.at < 400) return;
    openMenu(index, event.detail === 0 ? null : event.clientX);
  };

  const reveal = (index: number) => {
    const crumb = crumbs[index];
    if (!crumb) return;
    if (crumb.kind === "symbol") revealSymbol(tabKey, workspaceId, path, crumb.node, false);
    else if (crumb.kind === "file") viewFor(tabKey)?.focus();
    else {
      navRef.current?.querySelector<HTMLElement>(`[data-index="${index + 1}"]`)?.focus();
      openMenu(index + 1, null);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const buttons = [...(navRef.current?.querySelectorAll<HTMLElement>("[data-index]") ?? [])];
    const at = buttons.findIndex((button) => button === document.activeElement);
    if (at < 0) return;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      buttons[at + (event.key === "ArrowRight" ? 1 : -1)]?.focus();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      openMenu(at, null);
    } else if (event.key === " " || (event.key === "Enter" && event.metaKey)) {
      event.preventDefault();
      reveal(at);
    } else if (event.key === "Escape") {
      event.preventDefault();
      viewFor(tabKey)?.focus();
    }
  };

  return (
    <>
      <nav
        ref={navRef}
        className="editor-path breadcrumbs"
        aria-label={S.breadcrumbsAria}
        data-deleted={deleted || undefined}
        onKeyDown={onKeyDown}
        onKeyUp={(event) => event.key === " " && event.preventDefault()}
      >
        {crumbs.map((crumb, index) => (
          <button
            key={crumb.id}
            type="button"
            className="breadcrumbs-item"
            data-index={index}
            data-kind={crumb.kind}
            data-selected={menu?.index === index || undefined}
            title={crumb.kind === "symbol" ? undefined : crumb.path}
            aria-haspopup="tree"
            aria-expanded={menu?.index === index}
            onClick={(event) => onItemClick(index, event)}
            onContextMenu={(event) => {
              if (crumb.kind === "symbol") return;
              event.preventDefault();
              setContext({ path: crumb.path, file: crumb.kind === "file", x: event.clientX, y: event.clientY });
            }}
          >
            {crumb.kind === "symbol" && (
              <span className="breadcrumb-symbol" data-tone={symbolTone(crumb.node.kind)}>
                <Codicon name={symbolIcon(crumb.node.kind)} />
              </span>
            )}
            {crumb.kind === "file" && (
              <span className="breadcrumb-symbol">
                <FileTypeIcon name={crumb.label} />
              </span>
            )}
            <span className="breadcrumbs-label">{crumb.label}</span>
            {index < crumbs.length - 1 && <Codicon name="chevron-right" className="breadcrumbs-sep" />}
          </button>
        ))}
      </nav>
      {menu && <BreadcrumbMenu key={menu.index} source={menu.source} anchor={menu.anchor} pointerX={menu.pointerX} name={menu.name} onPick={pick} onPreview={preview} onClose={closeMenu} onMove={move} />}
      {context && <CrumbContextMenu at={context} onClose={() => setContext(null)} onReveal={() => revealInFiles(workspaceId, context.path, context.file)} />}
    </>
  );
}

type OpenMenu = { index: number; pointerX: number | null; source: MenuSource; anchor: HTMLElement; name: string };

function menuSource(workspaceId: string, path: string, tabKey: string, index: number): MenuSource | null {
  const fresh = currentBreadcrumbSymbols(tabKey);
  const crumb = crumbsFor(path, fresh.tree, fresh.path)[index];
  if (!crumb) return null;
  if (crumb.kind === "symbol") return { kind: "symbols", siblings: crumb.siblings, current: crumb.node };
  return listable(path) ? { kind: "files", workspaceId, dir: crumb.dir, current: crumb.path } : null;
}

function revealSymbol(tabKey: string, workspaceId: string, path: string, node: SymbolNode, side: boolean) {
  const view = viewFor(tabKey);
  if (!view) return;
  if (side) {
    const line = view.state.doc.lineAt(node.nameFrom);
    openFile({ workspaceId, path, line: line.number, column: node.nameFrom - line.from + 1 }, { side: true });
    return;
  }
  view.dispatch({ selection: { anchor: node.nameFrom } });
  scrollNearTop(view, node.nameFrom);
  view.focus();
}

function scrollNearTop(view: EditorView, pos: number) {
  const coords = view.coordsAtPos(pos);
  const box = view.scrollDOM.getBoundingClientRect();
  if (coords && coords.top >= box.top && coords.bottom <= box.bottom) return;
  view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: "start", yMargin: view.defaultLineHeight * 3 }) });
}

function revealInFiles(workspaceId: string, path: string, isFile: boolean) {
  if (isFile) revealFilePath(workspaceId, path);
  else {
    expandFolders(workspaceId, path);
    setFilesView(workspaceId, { rootOpen: true, selected: { path, file: false } });
  }
  setState({ activeTabKey: "files" });
}

function CrumbContextMenu({ at, onClose, onReveal }: { at: { x: number; y: number }; onClose: () => void; onReveal: () => void }) {
  return (
    <DropdownMenu open onOpenChange={(open) => !open && onClose()}>
      <DropdownMenuTrigger asChild>
        <button type="button" className="menu-anchor" style={{ left: at.x, top: at.y }} tabIndex={-1} aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" data-testid="breadcrumbs-menu" onCloseAutoFocus={(event) => event.preventDefault()}>
        <DropdownMenuItem onSelect={onReveal}>{S.revealInExplorerView}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
