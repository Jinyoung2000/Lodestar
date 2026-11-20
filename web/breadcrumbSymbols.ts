import { LSPPlugin } from "@codemirror/lsp-client";
import type { Extension } from "@codemirror/state";
import { ViewPlugin, type EditorView, type ViewUpdate } from "@codemirror/view";
import { useSyncExternalStore } from "react";
import { mapSymbols } from "./breadcrumbModel";
import { fetchDocumentSymbols, symbolPathAt, type SymbolNode } from "./documentSymbols";

// 경로 줄의 심볼 단계(클래스 > 메서드)가 읽는 상태. 탭 키마다 심볼 트리와 커서가 든 심볼의 경로를 들고, 커서가 움직이면 경로만 다시 계산하고 문서가 바뀌면
// 이전 트리를 변경에 맞춰 옮겨 쓰면서(mapSymbols) 입력이 멎은 뒤 서버에 심볼을 다시 묻는다. LSP 가 없는 파일(마크다운 등)은 아무것도 하지 않아 심볼 단계가 없다.
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
        // 서버 연결은 보기를 만든 뒤에 붙는다(확장 목록의 LSP 플러그인). 한 번 미룬 뒤 묻는다.
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
        // 묻는 사이 글이 바뀌었으면 위치가 어긋난 응답이니 버리고 다시 묻는다
        if (this.view.state.doc !== doc) return this.schedule(REFRESH_DELAY_MS);
        write(key, tree, this.view.state.selection.main.head);
      }

      destroy() {
        this.destroyed = true;
        if (this.timer) clearTimeout(this.timer);
        if (states.delete(key)) notify();
      }
    },
  );
}

function write(key: string, tree: readonly SymbolNode[], head: number) {
  const before = states.get(key) ?? EMPTY;
  const path = symbolPathAt(tree, head);
  const same = path.length === before.path.length && path.every((node, i) => node.name === before.path[i]!.name && node.kind === before.path[i]!.kind && node.nameFrom === before.path[i]!.nameFrom);
  // 같은 경로면 이미 그려진 조각을 다시 그리지 않는다(트리만 조용히 바꿔 둔다)
  states.set(key, same ? { tree, path: before.path } : { tree, path });
  if (!same || (tree.length === 0) !== (before.tree.length === 0)) notify();
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

// 목록을 열 때 읽는 최신 상태(훅이 돌려준 값은 트리만 바뀐 갱신을 못 받아 조금 낡을 수 있다)
export const currentBreadcrumbSymbols = (key: string): BreadcrumbSymbols => states.get(key) ?? EMPTY;
