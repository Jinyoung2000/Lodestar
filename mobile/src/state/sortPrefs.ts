import type { SessionSort } from "@shared/protocol";
import { PROJECT_SORTS, type ProjectSort } from "../logic/workspaces";
import type { Cache } from "./store";

export type SortPrefs = {
  projects: { sort: ProjectSort; order: string[] };
  sessions: Record<string, SessionSort>;
  collapsed: string[];
};

export const SORT_PREFS_KEY = "pref:sort";
export const EMPTY_SORT_PREFS: SortPrefs = { projects: { sort: "activity", order: [] }, sessions: {}, collapsed: [] };

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

  async load() {
    try {
      this.state = parseSortPrefs(await this.cache.get(SORT_PREFS_KEY));
    } catch {
      this.state = EMPTY_SORT_PREFS;
    }
    this.emit();
  }

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

  toggleGroup(key: string) {
    const { collapsed } = this.state;
    this.update({ ...this.state, collapsed: collapsed.includes(key) ? collapsed.filter((id) => id !== key) : [...collapsed, key] });
  }

  private update(next: SortPrefs) {
    this.state = next;
    this.emit();
    const text = JSON.stringify({ v: 1, ...next });
    this.writing = this.writing.then(() => this.cache.set(SORT_PREFS_KEY, text)).catch(() => {});
  }

  private emit() {
    for (const listener of this.listeners) listener();
  }
}

export function parseSortPrefs(raw: string | null): SortPrefs {
  if (!raw) return EMPTY_SORT_PREFS;
  try {
    const data = JSON.parse(raw) as { projects?: { sort?: unknown; order?: unknown }; sessions?: unknown; collapsed?: unknown };
    const sort = PROJECT_SORTS.find((s) => s === data.projects?.sort) ?? "activity";
    const order = Array.isArray(data.projects?.order) ? [...new Set(data.projects.order.filter((id): id is string => typeof id === "string"))] : [];
    const sessions: Record<string, SessionSort> = {};
    if (data.sessions && typeof data.sessions === "object") {
      for (const [id, value] of Object.entries(data.sessions)) if (value === "created" || value === "updated") sessions[id] = value;
    }
    const collapsed = Array.isArray(data.collapsed) ? [...new Set(data.collapsed.filter((id): id is string => typeof id === "string"))] : [];
    return { projects: { sort, order }, sessions, collapsed };
  } catch {
    return EMPTY_SORT_PREFS;
  }
}
