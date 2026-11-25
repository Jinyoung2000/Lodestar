import { LSPPlugin } from "@codemirror/lsp-client";
import type { Extension } from "@codemirror/state";
import { ViewPlugin, type EditorView, type ViewUpdate } from "@codemirror/view";
import { useSyncExternalStore } from "react";
import { mapSymbols } from "./breadcrumbModel";
import { fetchDocumentSymbols, symbolPathAt, type SymbolNode } from "./documentSymbols";

export type BreadcrumbSymbols = { tree: readonly SymbolNode[]; path: readonly SymbolNode[] };

const EMPTY: BreadcrumbSymbols = { tree: [], path: [] };
const states = new Map<string, BreadcrumbSymbols>();
const listeners = new Set<() => void>();

const REFRESH_DELAY_MS = 400;

export function breadcrumbSymbols(key: string): Extension {
  return ViewPlugin.fromClass(
    class {
      timer: ReturnType<typeof setTimeout> | null = null;
      request = 0;
      destroyed = false;

      constructor(private view: EditorView) {
        this.schedule(0);
      }

      update(update: ViewUpdate) {
        const before = states.get(key) ?? EMPTY;
        if (update.docChanged) {
          const tree = mapSymbols(before.tree, update.changes);
          write(key, tree, update.state.selection.main.head);
          this.schedule(REFRESH_DELAY_MS);
        } else if (update.selectionSet) write(key, before.tree, update.state.selection.main.head);
      }

      schedule(delay: number) {
        if (this.destroyed) return;
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => void this.refresh(), delay);
      }

      async refresh() {
        this.timer = null;
        if (this.destroyed || !LSPPlugin.get(this.view)) return;
        const mine = ++this.request;
        const doc = this.view.state.doc;
        const tree = await fetchDocumentSymbols(this.view);
        if (this.destroyed || mine !== this.request) return;
        if (this.view.state.doc !== doc) return this.schedule(REFRESH_DELAY_MS);
        write(key, tree, this.view.state.selection.main.head, true);
      }

      destroy() {
        this.destroyed = true;
        if (this.timer) clearTimeout(this.timer);
        if (states.delete(key)) notify();
      }
    },
  );
}

function write(key: string, tree: readonly SymbolNode[], head: number, fetched = false) {
  const before = states.get(key) ?? EMPTY;
  const path = symbolPathAt(tree, head);
  const same = path.length === before.path.length && path.every((node, i) => node.name === before.path[i]!.name && node.kind === before.path[i]!.kind && node.nameFrom === before.path[i]!.nameFrom);
  states.set(key, same ? { tree, path: before.path } : { tree, path });
  if (!same || fetched || (tree.length === 0) !== (before.tree.length === 0)) notify();
}

const notify = () => {
  for (const listener of listeners) listener();
};

export function useBreadcrumbSymbols(key: string): BreadcrumbSymbols {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => states.get(key) ?? EMPTY,
  );
}

export const currentBreadcrumbSymbols = (key: string): BreadcrumbSymbols => states.get(key) ?? EMPTY;
