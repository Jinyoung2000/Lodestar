import { useState, type KeyboardEvent } from "react";
import "./outline.css";
import { activeEditorKeyOf } from "./activeEditor";
import { symbolTone } from "./breadcrumbModel";
import { currentBreadcrumbSymbols, useBreadcrumbSymbols } from "./breadcrumbSymbols";
import { symbolIcon, type SymbolNode } from "./documentSymbols";
import { ChevronRight, Codicon } from "./icons";
import { useStore } from "./store";
import { S } from "./strings";
import { revealSymbol } from "./symbolReveal";
import { Button } from "./ui/button";

const OPEN_KEY = "agent-nav:outline-open";

export function OutlineSection() {
  const [open, setOpen] = useState(readOpen);
  const [generation, setGeneration] = useState(0);
  const editorKey = useStore(activeEditorKeyOf);
  const toggle = () => {
    setOpen(!open);
    writeOpen(!open);
  };
  return (
    <section className="outline" data-open={open || undefined} aria-label={S.outline.title}>
      <div className="outline-head">
        <button type="button" className="outline-toggle" aria-expanded={open} onClick={toggle}>
          <span className="outline-chev" data-collapsed={!open || undefined}>
            <ChevronRight />
          </span>
          <span className="outline-title">{S.outline.title}</span>
        </button>
        {open && editorKey && (
          <span className="outline-actions">
            <Button size="icon" aria-label={S.outline.collapseAll} title={S.outline.collapseAll} onClick={() => setGeneration((n) => n + 1)}>
              <Codicon name="collapse-all" />
            </Button>
          </span>
        )}
      </div>
      {open && (editorKey ? <OutlineTree key={`${editorKey}:${generation}`} editorKey={editorKey} startCollapsed={generation > 0} /> : <div className="outline-empty">{S.outline.noEditor}</div>)}
    </section>
  );
}

type Row = { node: SymbolNode; key: string; parent: string | null; depth: number; open: boolean; hasChildren: boolean };

function OutlineTree({ editorKey, startCollapsed }: { editorKey: string; startCollapsed: boolean }) {
  const { tree, path } = useBreadcrumbSymbols(editorKey);
  const tab = useStore((s) => s.tabs.find((t) => t.key === editorKey));
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set(startCollapsed ? parentKeys(currentBreadcrumbSymbols(editorKey).tree) : []));
  const [focusKey, setFocusKey] = useState<string | null>(null);
  if (tree.length === 0) return <div className="outline-empty">{S.outline.unavailable}</div>;
  const rows = rowsOf(tree, collapsed);
  const activeKey = activeKeyOf(tree, path, collapsed);
  const focused = rows.find((row) => row.key === focusKey) ?? rows.find((row) => row.key === activeKey) ?? rows[0]!;

  const toggle = (key: string) => {
    const next = new Set(collapsed);
    if (!next.delete(key)) next.add(key);
    setCollapsed(next);
  };
  const reveal = (row: Row, focus: boolean) => {
    setFocusKey(row.key);
    revealSymbol(editorKey, tab && "workspaceId" in tab ? tab.workspaceId : "", tab && "path" in tab ? tab.path : "", row.node, { focus });
  };
  const moveTo = (row: Row | undefined) => {
    if (!row) return;
    setFocusKey(row.key);
    document.querySelector<HTMLElement>(`.outline-tree [data-key="${CSS.escape(row.key)}"]`)?.focus();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const at = rows.indexOf(focused);
    const actions: Record<string, () => void> = {
      ArrowDown: () => moveTo(rows[at + 1]),
      ArrowUp: () => moveTo(rows[at - 1]),
      Home: () => moveTo(rows[0]),
      End: () => moveTo(rows[rows.length - 1]),
      ArrowRight: () => (focused.hasChildren && !focused.open ? toggle(focused.key) : focused.open && moveTo(rows[at + 1])),
      ArrowLeft: () => (focused.open ? toggle(focused.key) : moveTo(rows.find((row) => row.key === focused.parent))),
      Enter: () => reveal(focused, true),
      " ": () => reveal(focused, false),
    };
    const action = actions[event.key];
    if (!action) return;
    event.preventDefault();
    action();
  };

  return (
    <div className="outline-tree" role="tree" aria-label={S.outline.title} onKeyDown={onKeyDown}>
      {rows.map((row) => (
        <div
          key={row.key}
          ref={row.key === activeKey ? scrollIntoViewIfNeeded : undefined}
          className="tree-node outline-row"
          role="treeitem"
          aria-level={row.depth + 1}
          aria-expanded={row.hasChildren ? row.open : undefined}
          aria-selected={row.key === activeKey}
          data-key={row.key}
          data-selected={row.key === activeKey || undefined}
          tabIndex={row === focused ? 0 : -1}
          style={{ paddingLeft: `calc(var(--space-2) + ${row.depth} * var(--space-3))` }}
          onClick={() => reveal(row, false)}
          onDoubleClick={() => reveal(row, true)}
        >
          <span
            className="chev"
            data-spacer={!row.hasChildren || undefined}
            data-collapsed={(row.hasChildren && !row.open) || undefined}
            onClick={(event) => {
              if (!row.hasChildren) return;
              event.stopPropagation();
              toggle(row.key);
            }}
          >
            <ChevronRight size={14} />
          </span>
          <span className="breadcrumb-symbol" data-tone={symbolTone(row.node.kind)}>
            <Codicon name={symbolIcon(row.node.kind)} />
          </span>
          <span className="name">{row.node.name}</span>
          {row.node.detail && <span className="outline-detail">{row.node.detail}</span>}
        </div>
      ))}
    </div>
  );
}

function scrollIntoViewIfNeeded(element: HTMLElement | null) {
  element?.scrollIntoView({ block: "nearest" });
}

function keyOf(list: readonly SymbolNode[], index: number, parent: string | null) {
  const node = list[index]!;
  const base = `${parent ?? ""}/${node.kind}:${node.name}`;
  const twins = list.slice(0, index).filter((other) => other.kind === node.kind && other.name === node.name).length;
  return twins ? `${base}#${twins}` : base;
}

function rowsOf(tree: readonly SymbolNode[], collapsed: ReadonlySet<string>): Row[] {
  const rows: Row[] = [];
  const walk = (list: readonly SymbolNode[], depth: number, parent: string | null) => {
    list.forEach((node, index) => {
      const key = keyOf(list, index, parent);
      const hasChildren = node.children.length > 0;
      const open = hasChildren && !collapsed.has(key);
      rows.push({ node, key, parent, depth, open, hasChildren });
      if (open) walk(node.children, depth + 1, key);
    });
  };
  walk(tree, 0, null);
  return rows;
}

function parentKeys(tree: readonly SymbolNode[]): string[] {
  const keys: string[] = [];
  const walk = (list: readonly SymbolNode[], parent: string | null) =>
    list.forEach((node, index) => {
      if (node.children.length === 0) return;
      const key = keyOf(list, index, parent);
      keys.push(key);
      walk(node.children, key);
    });
  walk(tree, null);
  return keys;
}

function activeKeyOf(tree: readonly SymbolNode[], path: readonly SymbolNode[], collapsed: ReadonlySet<string>): string | null {
  let list = tree;
  let key: string | null = null;
  for (const step of path) {
    const index = list.findIndex((node) => node.kind === step.kind && node.name === step.name && node.nameFrom === step.nameFrom);
    if (index < 0) break;
    key = keyOf(list, index, key);
    if (collapsed.has(key)) break;
    list = list[index]!.children;
  }
  return key;
}

function readOpen() {
  try {
    return localStorage.getItem(OPEN_KEY) === "1";
  } catch {
    return false;
  }
}

function writeOpen(open: boolean) {
  try {
    localStorage.setItem(OPEN_KEY, open ? "1" : "0");
  } catch {
  }
}
