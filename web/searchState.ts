import { useSyncExternalStore } from "react";
import { DEFAULT_SEARCH_SETTINGS, type SearchSettings } from "../shared/searchSettings";
import { rpc } from "./rpc";
import { buildNodes, dismissHits, filesOf, hitCountOf, type FileResult, type TreeNode, type ViewMode } from "./searchTree";
import { runIsCurrent } from "./searchViewModel";
import { getState, searchWorkspaceOf } from "./store";


export type SearchUi = {
  collapsed: ReadonlySet<string>;
  // 지운(Dismiss) 일치의 키. 새 검색을 시작하면 비운다.
  dismissed: ReadonlySet<string>;
  // 포커스가 있는 행(노드 키). 없으면 null.
  cursor: string | null;
  phase: 0 | 1 | 2;
  // Replace All 이 끝난 뒤 요약 줄 자리에 보이는 문구
  note: string | null;
  // 결과를 일부러 지우지 않은 채 한도(search.maxResults)에 닿았다
  limitHit: boolean;
  // 검색이 끝나기 전에 취소됐다
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

// 설정은 검색을 돌릴 때마다 다시 읽는다(데몬이 5초 동안 들고 있다가 settings.json 을 다시 읽는다). 못 읽으면 지금 값을 쓴다.
export async function refreshSearchSettings(): Promise<SearchSettings> {
  try {
    const settings = await rpc.call("search.settings", {});
    setSearchUi({ settings });
    return settings;
  } catch {
    return ui.settings;
  }
}

// --- 결과 모델 ---

export type SearchModel = { files: FileResult[]; nodes: (TreeNode & { kind: "folder" | "file" })[]; mode: ViewMode; hitCount: number; fileCount: number };

const EMPTY_MODEL: SearchModel = { files: [], nodes: [], mode: "list", hitCount: 0, fileCount: 0 };
let cached: { result: object; dismissed: ReadonlySet<string>; mode: ViewMode; order: string; model: SearchModel } | null = null;

export const viewModeOf = (chosen: ViewMode | null, settings: SearchSettings): ViewMode => chosen ?? settings.defaultViewMode;

// store 의 마지막 검색 결과와 지금 폴더, 지운 일치, 보기 방식에서 트리 모델을 만든다. 입력이 같으면 같은 객체를 돌려준다.
// 다른 폴더에서 돌린 결과는 비어 있는 것으로 본다. 결과의 경로는 그 폴더 기준이라 지금 폴더에서 열거나 바꾸면 다른 파일에 닿는다.
export function currentModel(): SearchModel {
  const state = getState();
  const { searchRun, searchView } = state;
  if (!runIsCurrent(searchRun, searchWorkspaceOf(state))) return EMPTY_MODEL;
  const mode = viewModeOf(searchView.viewMode, ui.settings);
  const order = ui.settings.sortOrder;
  if (cached && cached.result === searchRun.result && cached.dismissed === ui.dismissed && cached.mode === mode && cached.order === order) return cached.model;
  const files = dismissHits(filesOf(searchRun.result), ui.dismissed);
  const model: SearchModel = { files, nodes: buildNodes(files, mode, order), mode, hitCount: hitCountOf(files), fileCount: files.length };
  cached = { result: searchRun.result, dismissed: ui.dismissed, mode, order, model };
  return model;
}
