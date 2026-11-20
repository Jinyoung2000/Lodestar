// 정렬 설정(이 폰에만 저장): Workspaces 탭의 프로젝트 정렬과 수동 순서, 프로젝트 화면마다 고른 세션 정렬.
// 데몬 RPC 와 데스크톱 설정은 건드리지 않는다. React 에 의존하지 않고(화면은 useSyncExternalStore 로 읽는다), 시험은 메모리 캐시로 돌린다(test/workspaces.test.ts).
import type { SessionSort } from "@shared/protocol";
import { PROJECT_SORTS, type ProjectSort } from "../logic/workspaces";
import type { Cache } from "./store";

// AsyncStorage 에 한 키로 저장하는 모양. 예: {"v":1,"projects":{"sort":"manual","order":["w1","w2"]},"sessions":{"w1":"created"}}
// projects.order 는 수동 순서(워크스페이스 id), sessions 는 워크스페이스 id → 그 프로젝트 화면의 세션 정렬. sessions 에 id 가 없으면 전역 기본값을 쓴다.
export type SortPrefs = {
  projects: { sort: ProjectSort; order: string[] };
  sessions: Record<string, SessionSort>;
};

export const SORT_PREFS_KEY = "pref:sort";
export const EMPTY_SORT_PREFS: SortPrefs = { projects: { sort: "activity", order: [] }, sessions: {} };

export class SortPrefsStore {
  private state: SortPrefs = EMPTY_SORT_PREFS;
  private listeners = new Set<() => void>();
  private writing: Promise<void> = Promise.resolve();

  constructor(private cache: Cache) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getState = () => this.state;

  // 시작할 때 한 번. 읽지 못하거나 모양이 틀리면 기본값으로 시작한다(저장된 값은 다음 변경 때 덮어쓴다).
  async load() {
    try {
      this.state = parseSortPrefs(await this.cache.get(SORT_PREFS_KEY));
    } catch {
      this.state = EMPTY_SORT_PREFS;
    }
    this.emit();
  }

  // 정렬 방식을 바꾼다. 처음 manual 로 바꾸는 거라 저장된 순서가 없으면 지금 화면에 보이는 순서(visibleOrder)를 시작점으로 삼는다.
  setProjectSort(sort: ProjectSort, visibleOrder: readonly string[]) {
    const order = sort === "manual" && this.state.projects.order.length === 0 ? [...visibleOrder] : this.state.projects.order;
    this.update({ ...this.state, projects: { sort, order } });
  }

  setProjectOrder(order: readonly string[]) {
    this.update({ ...this.state, projects: { ...this.state.projects, order: [...new Set(order)] } });
  }

  setSessionSort(workspaceId: string, sort: SessionSort) {
    this.update({ ...this.state, sessions: { ...this.state.sessions, [workspaceId]: sort } });
  }

  private update(next: SortPrefs) {
    this.state = next;
    this.emit();
    const text = JSON.stringify({ v: 1, ...next });
    // 쓰기는 순서대로: 빠르게 연달아 바꿔도 마지막 값이 남는다
    this.writing = this.writing.then(() => this.cache.set(SORT_PREFS_KEY, text)).catch(() => {});
  }

  private emit() {
    for (const listener of this.listeners) listener();
  }
}

export function parseSortPrefs(raw: string | null): SortPrefs {
  if (!raw) return EMPTY_SORT_PREFS;
  try {
    const data = JSON.parse(raw) as { projects?: { sort?: unknown; order?: unknown }; sessions?: unknown };
    const sort = PROJECT_SORTS.find((s) => s === data.projects?.sort) ?? "activity";
    const order = Array.isArray(data.projects?.order) ? [...new Set(data.projects.order.filter((id): id is string => typeof id === "string"))] : [];
    const sessions: Record<string, SessionSort> = {};
    if (data.sessions && typeof data.sessions === "object") {
      for (const [id, value] of Object.entries(data.sessions)) if (value === "created" || value === "updated") sessions[id] = value;
    }
    return { projects: { sort, order }, sessions };
  } catch {
    return EMPTY_SORT_PREFS;
  }
}
