import type { MediaInfo } from "../shared/protocol";

type Entry = { at: number; info: MediaInfo | null };
type Call = (agentId: string, paths: string[]) => Promise<(MediaInfo | null)[]>;

export const MISS_TTL_MS = 5_000;
export const HIT_TTL_MS = 60_000;
const MAX_ENTRIES = 600;
const BATCH = 32;

const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<void>>();
const keyOf = (agentId: string, raw: string) => `${agentId}\0${raw}`;

const fresh = (entry: Entry | undefined, now: number, ignoreMiss: boolean): entry is Entry =>
  !!entry && now - entry.at < (entry.info ? HIT_TTL_MS : ignoreMiss ? 0 : MISS_TTL_MS);

export const knownMedia = (agentId: string, raw: string): MediaInfo | null | undefined => cache.get(keyOf(agentId, raw))?.info;

export function cachedMedia(agentId: string, raw: string, now = Date.now()): MediaInfo | null | undefined {
  const entry = cache.get(keyOf(agentId, raw));
  return fresh(entry, now, false) ? entry.info : undefined;
}

export async function resolveMediaPaths(agentId: string, raws: string[], call: Call, options: { now?: number; ignoreMiss?: boolean } = {}): Promise<void> {
  const now = options.now ?? Date.now();
  const wanted = [...new Set(raws)].filter((raw) => !fresh(cache.get(keyOf(agentId, raw)), now, options.ignoreMiss === true));
  const waiting = wanted.flatMap((raw) => inflight.get(keyOf(agentId, raw)) ?? []);
  const fetching = wanted.filter((raw) => !inflight.has(keyOf(agentId, raw)));
  const jobs: Promise<void>[] = [];
  for (let from = 0; from < fetching.length; from += BATCH) {
    const group = fetching.slice(from, from + BATCH);
    const job = call(agentId, group).then(
      (infos) => {
        group.forEach((raw, index) => cache.set(keyOf(agentId, raw), { at: Date.now(), info: infos[index] ?? null }));
        if (cache.size > MAX_ENTRIES) for (const key of [...cache.keys()].slice(0, cache.size - MAX_ENTRIES)) cache.delete(key);
      },
      () => undefined,
    );
    const tracked = job.finally(() => group.forEach((raw) => inflight.delete(keyOf(agentId, raw))));
    group.forEach((raw) => inflight.set(keyOf(agentId, raw), tracked));
    jobs.push(tracked);
  }
  await Promise.all([...jobs, ...new Set(waiting)]);
}

export function clearMediaCache() {
  cache.clear();
  inflight.clear();
}
