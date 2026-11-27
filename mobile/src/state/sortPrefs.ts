import type { SessionSort } from "@shared/protocol";
import type { Cache } from "./store";

export type ListGrouping = "workspace" | "time";
export type ListView = { grouping: ListGrouping; ordering: SessionSort };

export type SortPrefs = {
  sessions: Record<string, SessionSort>;
  collapsed: string[];
  list: ListView;
};

export const SORT_PREFS_KEY = "pref:sort";
export const DEFAULT_LIST_VIEW: ListView = { grouping: "workspace", ordering: "updated" };
export const EMPTY_SORT_PREFS: SortPrefs = { sessions: {}, collapsed: [], list: DEFAULT_LIST_VIEW };

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

  setSessionSort(workspaceId: string, sort: SessionSort) {
    this.update({ ...this.state, sessions: { ...this.state.sessions, [workspaceId]: sort } });
  }

  setListView(view: Partial<ListView>) {
    this.update({ ...this.state, list: { ...this.state.list, ...view } });
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
    const data = JSON.parse(raw) as { sessions?: unknown; collapsed?: unknown; list?: { grouping?: unknown; ordering?: unknown } };
    const sessions: Record<string, SessionSort> = {};
    if (data.sessions && typeof data.sessions === "object") {
      for (const [id, value] of Object.entries(data.sessions)) if (value === "created" || value === "updated") sessions[id] = value;
    }
    const collapsed = Array.isArray(data.collapsed) ? [...new Set(data.collapsed.filter((id): id is string => typeof id === "string"))] : [];
    const list: ListView = {
      grouping: data.list?.grouping === "time" ? "time" : "workspace",
      ordering: data.list?.ordering === "created" ? "created" : "updated",
    };
    return { sessions, collapsed, list };
  } catch {
    return EMPTY_SORT_PREFS;
  }
}
