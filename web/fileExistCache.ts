
export class ExistCache {
  private byWorkspace = new Map<string, Map<string, boolean>>();
  private lists = new Map<string, readonly string[]>();
  private listeners = new Set<() => void>();
  version = 0;

  known(workspaceId: string): ReadonlyMap<string, boolean> {
    let map = this.byWorkspace.get(workspaceId);
    if (!map) {
      map = new Map();
      this.byWorkspace.set(workspaceId, map);
    }
    return map;
  }

  set(workspaceId: string, path: string, exists: boolean) {
    (this.known(workspaceId) as Map<string, boolean>).set(path, exists);
  }

  syncList(workspaceId: string, list: readonly string[]) {
    const before = this.lists.get(workspaceId);
    this.lists.set(workspaceId, list);
    if (before && before !== list) this.invalidate(workspaceId);
  }

  invalidate(workspaceId?: string): boolean {
    const keys = workspaceId === undefined ? [...this.byWorkspace.keys()] : [workspaceId];
    let dropped = false;
    for (const key of keys) {
      const map = this.byWorkspace.get(key);
      if (map && map.size > 0) {
        map.clear();
        dropped = true;
      }
    }
    if (dropped) {
      this.version += 1;
      for (const listener of this.listeners) listener();
    }
    return dropped;
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getVersion = () => this.version;
}
