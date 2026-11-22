import type { EditorView } from "@codemirror/view";
import { useEffect, useState, type RefObject } from "react";
import { openQuickFix } from "./quickFix";
import { copyTypeAtCursor } from "./typeCopy";
import { findAllReferences, goToDefinition, goToImplementation, goToReferences, peekDefinition, peekImplementation, revealDefinitionAside } from "./peekCommands";
import { S } from "./strings";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./ui/dropdown-menu";

export function LspMenuItems({ view, workspaceId }: { view: () => EditorView | null; workspaceId: string }) {
  const run = (action: (view: EditorView) => unknown) => () => {
    const target = view();
    if (target) void action(target);
  };
  return (
    <>
      <DropdownMenuItem onSelect={run((v) => goToDefinition(v, workspaceId))}>
        {S.goToDefinition}
        <span className="faint xs menu-hint">F12</span>
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={run((v) => revealDefinitionAside(v, workspaceId))}>
        {S.openDefinitionAside}
        <span className="faint xs menu-hint">⌘K F12</span>
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={run((v) => goToImplementation(v, workspaceId))}>
        {S.goToImplementations}
        <span className="faint xs menu-hint">⌘F12</span>
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={run((v) => goToReferences(v, workspaceId))}>
        {S.goToReferences}
        <span className="faint xs menu-hint">⇧F12</span>
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={run((v) => peekDefinition(v, workspaceId))}>
        {S.peekDefinition}
        <span className="faint xs menu-hint">⌥F12</span>
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={run((v) => peekImplementation(v, workspaceId))}>
        {S.peekImplementations}
        <span className="faint xs menu-hint">⇧⌘F12</span>
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={run((v) => findAllReferences(v, workspaceId))}>
        {S.findAllReferences}
        <span className="faint xs menu-hint">⇧⌥F12</span>
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={run((v) => openQuickFix(v))}>
        {S.quickFixAtCursor}
        <span className="faint xs menu-hint">⌘.</span>
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={run((v) => copyTypeAtCursor(v, "type"))}>{S.copyType}</DropdownMenuItem>
      <DropdownMenuItem onSelect={run((v) => copyTypeAtCursor(v, "signature"))}>{S.copySignature}</DropdownMenuItem>
    </>
  );
}

export function DiffContextMenu({ host, lspView, workspaceId }: { host: RefObject<HTMLElement | null>; lspView: () => EditorView | null; workspaceId: string }) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const onContextMenu = (event: MouseEvent) => {
      const view = lspView();
      if (!view || !(event.target instanceof Node) || !view.contentDOM.contains(event.target)) return;
      event.preventDefault();
      setMenu({ x: event.clientX, y: event.clientY });
    };
    element.addEventListener("contextmenu", onContextMenu);
    return () => element.removeEventListener("contextmenu", onContextMenu);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (!menu) return null;
  return (
    <DropdownMenu open onOpenChange={(isOpen) => !isOpen && setMenu(null)}>
      <DropdownMenuTrigger asChild>
        <button type="button" className="menu-anchor" style={{ left: menu.x, top: menu.y }} tabIndex={-1} aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" data-testid="diff-lsp-menu" onCloseAutoFocus={(e) => e.preventDefault()}>
        <LspMenuItems view={lspView} workspaceId={workspaceId} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
