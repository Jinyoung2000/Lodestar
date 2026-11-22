import { watch, type FSWatcher } from "node:fs";

const DEBOUNCE_MS = 400;
const MIN_GAP_MS = 1000;

export function ignoredPath(rel: string): boolean {
  const parts = rel.split("/");
  if (parts[0] === ".git") {
    const second = parts[1];
    if (second === "index" || second === "HEAD" || second === "MERGE_HEAD" || second === "REBASE_HEAD" || second === "CHERRY_PICK_HEAD" || second === "rebase-merge" || second === "rebase-apply") return parts.length > 2;
    if (second === "refs") return rel.endsWith(".lock");
    return true;
  }
  return parts.includes("node_modules") || parts.includes(".DS_Store") || rel.endsWith(".swp") || rel.endsWith("~");
}

type Entry = { watcher: FSWatcher; clients: Set<unknown>; timer: ReturnType<typeof setTimeout> | null; lastEmit: number; events: number; emits: number };

const GIT_DIR_KEY = "\0gitdir";

export function createWorkspaceWatch(onChange: (dir: string) => void, options: { debounceMs?: number; minGapMs?: number; watchFn?: typeof watch } = {}) {
  const debounceMs = options.debounceMs ?? DEBOUNCE_MS;
  const minGapMs = options.minGapMs ?? MIN_GAP_MS;
  const open = options.watchFn ?? watch;
  const entries = new Map<string, Entry>();
  const gitDirs = new Map<string, string>();
  const byClient = new Map<unknown, Set<string>>();
  const totals = { events: 0, ignored: 0, emits: 0 };

  const schedule = (dir: string, entry: Entry) => {
    if (entry.timer) clearTimeout(entry.timer);
    const wait = Math.max(debounceMs, entry.lastEmit + minGapMs - Date.now());
    entry.timer = setTimeout(() => {
      entry.timer = null;
      entry.lastEmit = Date.now();
      entry.emits++;
      totals.emits++;
      onChange(dir);
    }, wait);
    entry.timer.unref();
  };

  const start = (key: string): Entry | null => {
    const gitDirOnly = key.endsWith(GIT_DIR_KEY);
    const dir = gitDirOnly ? key.slice(0, -GIT_DIR_KEY.length) : key;
    try {
      const entry: Entry = { watcher: null as unknown as FSWatcher, clients: new Set(), timer: null, lastEmit: 0, events: 0, emits: 0 };
      entry.watcher = open(gitDirs.get(key) ?? dir, { recursive: !gitDirOnly }, (_event, name) => {
        totals.events++;
        if (gitDirOnly ? name !== "HEAD" : name && ignoredPath(String(name))) {
          totals.ignored++;
          return;
        }
        entry.events++;
        schedule(dir, entry);
      });
      entry.watcher.on("error", () => stop(key));
      entry.watcher.unref();
      entries.set(key, entry);
      return entry;
    } catch (error) {
      console.error("[watch] cannot watch", dir, (error as Error).message);
      return null;
    }
  };

  const stop = (dir: string) => {
    const entry = entries.get(dir);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.watcher.close();
    entries.delete(dir);
  };

  const release = (client: unknown, dir: string) => {
    const entry = entries.get(dir);
    if (!entry) return;
    entry.clients.delete(client);
    if (entry.clients.size === 0) stop(dir);
  };

  return {
    setClient(client: unknown, dirs: string[], linkedGitDirs: Record<string, string> = {}) {
      const keys = dirs.flatMap((dir) => (linkedGitDirs[dir] ? [dir, `${dir}${GIT_DIR_KEY}`] : [dir]));
      for (const dir of dirs) if (linkedGitDirs[dir]) gitDirs.set(`${dir}${GIT_DIR_KEY}`, linkedGitDirs[dir]);
      const next = new Set(keys);
      for (const dir of byClient.get(client) ?? []) if (!next.has(dir)) release(client, dir);
      for (const dir of next) {
        const entry = entries.get(dir) ?? start(dir);
        entry?.clients.add(client);
      }
      byClient.set(client, next);
    },
    dropClient(client: unknown) {
      for (const dir of byClient.get(client) ?? []) release(client, dir);
      byClient.delete(client);
    },
    watchedDirs: () => [...entries.keys()],
    stats: () => ({ ...totals, watched: entries.size }),
    closeAll() {
      for (const dir of [...entries.keys()]) stop(dir);
      byClient.clear();
    },
  };
}
