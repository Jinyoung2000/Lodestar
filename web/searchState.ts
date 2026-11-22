import { useSyncExternalStore } from "react";
import { DEFAULT_SEARCH_SETTINGS, type SearchSettings } from "../shared/searchSettings";
import { rpc } from "./rpc";
import { buildNodes, dismissHits, filesOf, hitCountOf, type FileResult, type TreeNode, type ViewMode } from "./searchTree";
import { runIsCurrent } from "./searchViewModel";
import { withRootDirs } from "./searchRoots";
import { getState, searchWorkspaceOf } from "./store";


export type SearchUi = {
  collapsed: ReadonlySet<string>;
  dismissed: ReadonlySet<string>;
  cursor: string | null;
  phase: 0 | 1 | 2;
  note: string | null;
  limitHit: boolean;
  canceled: boolean;
  settings: SearchSettings;
};

const INITIAL: SearchUi = { collapsed: new Set(), dismissed: new Set(), cursor: null, phase: 0, note: null, limitHit: false, canceled: false, settings: DEFAULT_SEARCH_SETTINGS };

let ui: SearchUi = INITIAL;
const listeners = new Set<() => void>();

export const getSearchUi = () => ui;

export function setSearchUi(patch: Partial<SearchUi>) {
  ui = { ...ui, ...patch };
  for (const listener of listeners) listener();
}

export function useSearchUi<T>(select: (state: SearchUi) => T): T {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => select(ui),
  );
}

export async function refreshSearchSettings(): Promise<SearchSettings> {
  try {
    const settings = await rpc.call("search.settings", {});
    setSearchUi({ settings });
    return settings;
  } catch {
    return ui.settings;
  }
}

export type SearchModel = { files: FileResult[]; nodes: (TreeNode & { kind: "folder" | "file" })[]; mode: ViewMode; hitCount: number; fileCount: number };

const EMPTY_MODEL: SearchModel = { files: [], nodes: [], mode: "list", hitCount: 0, fileCount: 0 };
let cached: { result: object; dismissed: ReadonlySet<string>; mode: ViewMode; order: string; model: SearchModel } | null = null;

export const viewModeOf = (chosen: ViewMode | null, settings: SearchSettings): ViewMode => chosen ?? settings.defaultViewMode;

export function currentModel(): SearchModel {
  const state = getState();
  const { searchRun, searchView } = state;
  if (!runIsCurrent(searchRun, searchWorkspaceOf(state))) return EMPTY_MODEL;
  const mode = viewModeOf(searchView.viewMode, ui.settings);
  const order = ui.settings.sortOrder;
  if (cached && cached.result === searchRun.result && cached.dismissed === ui.dismissed && cached.mode === mode && cached.order === order) return cached.model;
  const roots = searchRun.roots;
  const parsed = filesOf(searchRun.result);
  const files = dismissHits(roots ? withRootDirs(parsed) : parsed, ui.dismissed);
  const model: SearchModel = { files, nodes: buildNodes(files, mode, order, roots?.map((r) => r.label)), mode, hitCount: hitCountOf(files), fileCount: files.length };
  cached = { result: searchRun.result, dismissed: ui.dismissed, mode, order, model };
  return model;
}
