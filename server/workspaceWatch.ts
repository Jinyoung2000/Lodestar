import { watch, type FSWatcher } from "node:fs";

// 작업 폴더 밖의 파일 변화(사용자가 다른 편집기나 터미널에서 만든 파일, git 명령)를 Source Control 과 Changes 패널이 포커스 이벤트 없이 반영하려는 파일 감시(dogfood 4회차 14번).
// 저장소 루트마다 fs.watch 하나(macOS 는 recursive 가 FSEvents 라 폴더 수에 비례하는 비용이 없다). 웹 연결이 보고 있다고 알린 폴더만 감시하고, 연결이 모두 끊기면 닫는다.
// 변경은 디바운스로 묶어 한 번만 알린다. 알림이 연달아 가지 않게 최소 간격도 둔다(빌드 산출물이 쏟아지는 폴더에서 git status 를 연타하지 않는다).
const DEBOUNCE_MS = 400;
const MIN_GAP_MS = 1000;

// 알릴 필요가 없는 경로. .git 안은 index, HEAD, refs 만 의미가 있다(스테이지, 커밋, 브랜치 이동). 객체, 로그, 잠금 파일은 git 이 스스로 만들어 낸 잡음이다.
export function ignoredPath(rel: string): boolean {
  const parts = rel.split("/");
  if (parts[0] === ".git") {
    const second = parts[1];
    // FIX6B: 병합과 리베이스의 시작과 끝은 표식 파일과 폴더가 생기고 사라지는 것으로 알 수 있다(그 안의 파일들은 잡음이다)
    if (second === "index" || second === "HEAD" || second === "MERGE_HEAD" || second === "REBASE_HEAD" || second === "CHERRY_PICK_HEAD" || second === "rebase-merge" || second === "rebase-apply") return parts.length > 2;
    if (second === "refs") return rel.endsWith(".lock");
    return true;
  }
  return parts.includes("node_modules") || parts.includes(".DS_Store") || rel.endsWith(".swp") || rel.endsWith("~");
}

type Entry = { watcher: FSWatcher; clients: Set<unknown>; timer: ReturnType<typeof setTimeout> | null; lastEmit: number; events: number; emits: number };

// TB: 연결된 worktree 의 폴더에는 .git 이 파일이라 HEAD 가 거기 없다(메인 저장소의 .git/worktrees/<이름>/HEAD). 파일이 안 바뀌는 브랜치 전환(`git switch -c`)을 알려면 그 폴더의 HEAD 를 따로 본다.
// 키는 이 접미사를 붙여 저장소 루트 감시와 구분하고, 알림은 저장소 루트 이름으로 나간다(HEAD 말고는 안 본다).
const GIT_DIR_KEY = "\0gitdir";

export type WorkspaceWatch = ReturnType<typeof createWorkspaceWatch>;

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
      // 폴더가 지워지거나 감시가 끊기면 닫는다(다음 보고 때 다시 열린다)
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
    // 이 연결이 보고 있는 폴더 목록(저장소 루트)으로 바꾼다. 빠진 폴더는 놓고 새 폴더는 연다.
    // linkedGitDirs: 저장소 루트 -> 그 루트가 연결된 worktree 일 때 실제 git 폴더(rev-parse --absolute-git-dir). 보통 저장소는 넣지 않는다.
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
