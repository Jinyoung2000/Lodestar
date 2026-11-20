import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Workspace } from "../shared/protocol";


export type TrustRoots = {
  workspaces: readonly Pick<Workspace, "id" | "dir" | "parentId">[];
  // PR 리뷰 체크아웃 폴더. 같은 폴더의 워크스페이스보다 앞선다(체크아웃이 워크스페이스를 같이 만든다).
  reviews: readonly string[];
  // 앱이 받아 둔 클론. 같은 폴더를 사용자가 워크스페이스로 추가했으면 워크스페이스가 앞선다.
  downloads: readonly string[];
};

// 아직 없는 파일(새로 저장할 파일)은 있는 가장 가까운 상위 폴더의 실제 경로에 나머지를 붙인다(/var 와 /private/var 처럼 링크가 낀 경로도 같은 뿌리로 본다).
const real = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(real(parent), basename(path));
  }
};

const inside = (path: string, root: string) => path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`);

// path 를 품은 가장 깊은 뿌리가 정한다. 사용자가 추가한 워크스페이스면 실행해도 되고(worktree 워크스페이스는 부모를 따른다), 리뷰 체크아웃이나 받아 둔 클론이거나 어느 워크스페이스에도 없으면 안 된다.
export function runsFolderCode(path: string, roots: TrustRoots, depth = 0): boolean {
  const target = real(path);
  type Root = { dir: string; rank: number; workspace?: TrustRoots["workspaces"][number] };
  const all: Root[] = [
    ...roots.reviews.map((dir) => ({ dir: real(dir), rank: 0 })),
    ...roots.workspaces.map((workspace) => ({ dir: real(workspace.dir), rank: 1, workspace })),
    ...roots.downloads.map((dir) => ({ dir: real(dir), rank: 2 })),
  ];
  const best = all.filter((root) => inside(target, root.dir)).sort((a, b) => b.dir.length - a.dir.length || a.rank - b.rank)[0];
  if (!best?.workspace) return false;
  const parentId = best.workspace.parentId;
  if (!parentId) return true;
  const parent = roots.workspaces.find((w) => w.id === parentId);
  return !!parent && depth < 8 && runsFolderCode(parent.dir, roots, depth + 1);
}

// PR 리뷰 체크아웃 폴더 목록(~/.agent-nav/review-checkouts.json). 임시 파일에 쓴 뒤 rename 으로 바꾼다.
export class ReviewCheckouts {
  private dirs: string[];

  constructor(private readonly file: string) {
    this.dirs = this.load();
  }

  private load(): string[] {
    if (!existsSync(this.file)) return [];
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as unknown;
      return Array.isArray(raw) ? raw.filter((d): d is string => typeof d === "string" && d.startsWith("/")) : [];
    } catch {
      // 쓰기가 rename 이라 반쪽 파일은 생기지 않는다. 그래도 읽을 수 없으면 덮어쓰지 않게 옆으로 치우고 로그에 남긴다.
      const aside = `${this.file}.corrupt-${Date.now()}`;
      renameSync(this.file, aside);
      console.error(`[trust] ${this.file} is unreadable, moved to ${aside}`);
      return [];
    }
  }

  list(): readonly string[] {
    return this.dirs;
  }

  add(dir: string) {
    const path = real(dir);
    if (this.dirs.includes(path)) return;
    this.save([...this.dirs, path]);
  }

  // 사용자가 그 폴더를 직접 워크스페이스로 추가하거나 열었다
  forget(dir: string) {
    const path = real(dir);
    if (!this.dirs.includes(path)) return;
    this.save(this.dirs.filter((d) => d !== path));
  }

  private save(next: string[]) {
    this.dirs = next;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2));
    renameSync(tmp, this.file);
  }
}
