import type { PrRepo } from "../shared/prTypes";
import { ghGraphql } from "./ghExec";
import { git } from "./git";

export function parseRemoteUrl(url: string): string | null {
  const match = /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return match ? `${match[1]}/${match[2]}` : null;
}

export type RemoteRef = { name: string; repo: string };

export function parseRemotes(output: string): RemoteRef[] {
  const found: RemoteRef[] = [];
  for (const line of output.split("\n")) {
    const match = /^remote\.(.+)\.url (\S+)$/.exec(line.trim());
    if (!match) continue;
    const repo = parseRemoteUrl(match[2]);
    if (repo) found.push({ name: match[1], repo });
  }
  return found;
}

export function mergeRepos(entries: { dir: string; remotes: RemoteRef[] }[], parents: Record<string, string | null>): PrRepo[] {
  const repos = new Map<string, PrRepo>();
  const add = (fullName: string, dir: string, remote: string, upstreamOf: string | null) => {
    const existing = repos.get(fullName);
    if (existing) {
      if (!existing.dirs.includes(dir)) existing.dirs.push(dir);
      return;
    }
    repos.set(fullName, { fullName, dirs: [dir], remote, upstreamOf });
  };
  for (const { dir, remotes } of entries) {
    const ordered = [...remotes].sort((a, b) => Number(b.name === "origin") - Number(a.name === "origin"));
    for (const remote of ordered) {
      add(remote.repo, dir, remote.name, null);
      const parent = parents[remote.repo];
      if (parent) add(parent, dir, remotes.find((r) => r.repo === parent)?.name ?? remote.name, remote.repo);
    }
  }
  return [...repos.values()];
}

const cache = new Map<string, { at: number; repos: PrRepo[] }>();
const CACHE_MS = 60_000;

export async function discoverRepos(dirs: string[]): Promise<PrRepo[]> {
  const key = dirs.join("\n");
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.repos;
  const entries = await Promise.all(
    dirs.map(async (dir) => {
      try {
        return { dir, remotes: parseRemotes(await git(dir, ["config", "--get-regexp", "^remote\\..+\\.url$"])) };
      } catch {
        return { dir, remotes: [] };
      }
    }),
  );
  const names = [...new Set(entries.flatMap((e) => e.remotes.map((r) => r.repo)))];
  const parents: Record<string, string | null> = {};
  await Promise.all(
    names.map(async (name) => {
      const [owner, repo] = name.split("/");
      try {
        const data = (await ghGraphql("query PrRepoParent($owner:String!,$name:String!){repository(owner:$owner,name:$name){parent{nameWithOwner}}}", { owner, name: repo })) as { repository?: { parent?: { nameWithOwner: string } | null } | null };
        parents[name] = data.repository?.parent?.nameWithOwner ?? null;
      } catch {
        parents[name] = null;
      }
    }),
  );
  const repos = mergeRepos(entries, parents);
  cache.set(key, { at: Date.now(), repos });
  return repos;
}
