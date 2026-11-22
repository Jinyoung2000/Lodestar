import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ServerEvent } from "../shared/protocol";
import { remoteRepoRefs } from "../shared/remoteRepo";
import { runGh } from "./ghExec";
import { git } from "./git";
import { parseRemoteUrl } from "./prRepos";

const CLONE_AFTER = 1;
const REFRESH_MS = 30 * 60_000;
const RETRY_FAILED_MS = 24 * 60 * 60_000;
const SEEN_MAX = 5000;

type Entry = { hits: number; lastSeen: string; dir?: string; clonedAt?: string; fetchedAt?: string; failedAt?: string; error?: string };

export class RepoMirrors {
  private entries: Record<string, Entry> = {};
  private seen = new Set<string>();
  private chain: Promise<unknown> = Promise.resolve();
  private pending = new Set<string>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly root: string,
    private readonly file: string,
    private readonly blocked: () => boolean,
    private readonly reserved: readonly string[] = [],
  ) {
    try {
      this.entries = (JSON.parse(readFileSync(file, "utf8")) as { repos?: Record<string, Entry> }).repos ?? {};
    } catch {
      this.entries = {};
    }
  }

  dirOf(repo: string): string | null {
    if (!validRepo(repo)) return null;
    const recorded = this.entries[repo]?.dir;
    if (recorded && originOf(recorded) === repo) return recorded;
    const found = candidates(this.root, repo).find((dir) => originOf(dir) === repo) ?? null;
    if (found) this.update(repo, { dir: found });
    return found;
  }

  createdDirs(): string[] {
    return Object.values(this.entries).flatMap((entry) => (entry.clonedAt && entry.dir ? [entry.dir] : []));
  }

  observe(event: ServerEvent) {
    if (event.type !== "timelineUpsert" || event.item.kind !== "tool" || event.item.status !== "done") return;
    if (this.seen.has(event.item.id)) return;
    if (this.seen.size >= SEEN_MAX) this.seen.clear();
    this.seen.add(event.item.id);
    const repos = new Set(remoteRepoRefs(JSON.stringify(event.item.input)).map((r) => r.repo).filter(validRepo));
    if (!repos.size) return;
    const now = new Date().toISOString();
    for (const repo of repos) {
      const entry = (this.entries[repo] ??= { hits: 0, lastSeen: now });
      entry.hits += 1;
      entry.lastSeen = now;
      if (entry.hits >= CLONE_AFTER) this.ensureClone(repo);
    }
    this.save();
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.refreshAll(), REFRESH_MS);
    this.timer.unref();
    setTimeout(() => this.refreshAll(), 60_000).unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  request(repo: string) {
    if (!validRepo(repo)) return;
    this.entries[repo] ??= { hits: 0, lastSeen: new Date().toISOString() };
    this.ensureClone(repo);
  }

  private ensureClone(repo: string) {
    if (this.blocked() || this.pending.has(repo) || this.dirOf(repo)) return;
    const entry = this.entries[repo];
    if (entry?.failedAt && Date.now() - Date.parse(entry.failedAt) < RETRY_FAILED_MS) return;
    const dir = candidates(this.root, repo).find((d) => !existsSync(d) && !this.reserved.includes(d));
    if (!dir) {
      this.update(repo, { failedAt: new Date().toISOString(), error: "no free folder name" });
      return;
    }
    this.pending.add(repo);
    this.enqueue(async () => {
      try {
        mkdirSync(dirname(dir), { recursive: true });
        await runGh(["repo", "clone", repo, dir, "--", "--quiet"]);
        this.update(repo, { dir, clonedAt: new Date().toISOString(), fetchedAt: new Date().toISOString(), failedAt: undefined, error: undefined });
        console.log(`[repos] cloned ${repo} to ${dir}`);
      } catch (error) {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
        this.update(repo, { failedAt: new Date().toISOString(), error: (error as Error).message });
        console.log(`[repos] clone ${repo} failed: ${(error as Error).message}`);
      } finally {
        this.pending.delete(repo);
      }
    });
  }

  private refreshAll() {
    if (this.blocked()) return;
    for (const repo of Object.keys(this.entries)) {
      const dir = this.dirOf(repo);
      if (!dir || this.pending.has(repo)) continue;
      this.pending.add(repo);
      this.enqueue(async () => {
        try {
          await git(dir, ["fetch", "--quiet", "--prune", "origin"], { unattended: true });
          await git(dir, ["remote", "set-head", "origin", "--auto"], { unattended: true }).catch(() => "");
          const base = (await git(dir, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])).trim().replace(/^origin\//, "");
          const branch = (await git(dir, ["branch", "--show-current"])).trim();
          const dirty = (await git(dir, ["status", "--porcelain"])).trim() !== "";
          if (base && branch === base && !dirty) await git(dir, ["merge", "--ff-only", "--quiet", `origin/${base}`], { unattended: true });
          this.update(repo, { fetchedAt: new Date().toISOString(), error: undefined });
        } catch (error) {
          this.update(repo, { error: (error as Error).message });
          console.log(`[repos] refresh ${repo} failed: ${(error as Error).message}`);
        } finally {
          this.pending.delete(repo);
        }
      });
    }
  }

  private enqueue(task: () => Promise<void>) {
    this.chain = this.chain.then(task, task);
  }

  private update(repo: string, patch: Partial<Entry>) {
    const entry = (this.entries[repo] ??= { hits: 0, lastSeen: new Date().toISOString() });
    Object.assign(entry, patch);
    for (const key of Object.keys(patch) as (keyof Entry)[]) if (patch[key] === undefined) delete entry[key];
    this.save();
  }

  private save() {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, `${JSON.stringify({ repos: this.entries }, null, 2)}\n`);
    } catch (error) {
      console.log(`[repos] save failed: ${(error as Error).message}`);
    }
  }
}

function candidates(root: string, repo: string) {
  const [owner, name] = repo.split("/");
  return [join(root, name), join(root, `${owner}-${name}`)];
}

function originOf(dir: string): string | null {
  try {
    const config = readFileSync(join(dir, ".git", "config"), "utf8");
    const section = /\[remote "origin"\]([^[]*)/.exec(config)?.[1] ?? "";
    const url = /^\s*url\s*=\s*(\S+)/m.exec(section)?.[1];
    return url ? parseRemoteUrl(url) : null;
  } catch {
    return null;
  }
}

function validRepo(repo: string) {
  const parts = repo.split("/");
  return parts.length === 2 && !repo.startsWith("-") && parts.every((p) => /^[\w-][\w.-]*$/.test(p));
}
