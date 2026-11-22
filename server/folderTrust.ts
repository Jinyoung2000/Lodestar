import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Workspace } from "../shared/protocol";


export type TrustRoots = {
  workspaces: readonly Pick<Workspace, "id" | "dir" | "parentId">[];
  reviews: readonly string[];
  downloads: readonly string[];
};

const real = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(real(parent), basename(path));
  }
};

const inside = (path: string, root: string) => path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`);

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
