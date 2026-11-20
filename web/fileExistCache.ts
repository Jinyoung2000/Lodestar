// 대화 속 파일 링크가 가리키는 경로의 존재 여부 캐시. 순수 자료구조라 rpc 와 store 를 모른다(test/filerefresolve.test.ts).

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

  // 파일 목록 배열이 바뀌었으면(refreshFileList 가 새 배열을 넣는다) 그 폴더의 캐시를 버린다. 처음 보는 목록은 버릴 것이 없다.
  syncList(workspaceId: string, list: readonly string[]) {
    const before = this.lists.get(workspaceId);
    this.lists.set(workspaceId, list);
    if (before && before !== list) this.invalidate(workspaceId);
  }

  // 캐시에 든 것이 있었을 때만 버전을 올려 구독자를 깨운다. workspaceId 가 없으면 전부.
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
