// INLINEMEDIA: 대화 속 이미지와 영상 경로를 데몬(media.resolve)에 물어 결과를 기억해 둔다. DOM 과 React 없이 도는 부분이라 test/mediaresolve.test.ts 가 바로 부른다.
import type { MediaInfo } from "../shared/protocol";

type Entry = { at: number; info: MediaInfo | null };
type Call = (agentId: string, paths: string[]) => Promise<(MediaInfo | null)[]>;

// 읽을 수 없다는 답(파일이 아직 없을 수 있다)은 짧게, 읽을 수 있다는 답은 길게 기억한다. 파일이 바뀌면 주소(수정 시각)가 달라지므로 긴 기억도 오래된 그림을 붙들지는 않는다.
export const MISS_TTL_MS = 5_000;
export const HIT_TTL_MS = 60_000;
const MAX_ENTRIES = 600;
// 한 번의 호출에 싣는 경로 수(데몬 상한과 같다)
const BATCH = 32;

const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<void>>();
const keyOf = (agentId: string, raw: string) => `${agentId}\0${raw}`;

const fresh = (entry: Entry | undefined, now: number, ignoreMiss: boolean): entry is Entry =>
  !!entry && now - entry.at < (entry.info ? HIT_TTL_MS : ignoreMiss ? 0 : MISS_TTL_MS);

// 기억해 둔 답을 나이와 상관없이 돌려준다(이미 그려진 미리보기가 기억 시간이 지났다고 사라지지 않게). 없으면 undefined.
export const knownMedia = (agentId: string, raw: string): MediaInfo | null | undefined => cache.get(keyOf(agentId, raw))?.info;

// 기억해 둔 답. 없거나 오래됐으면 undefined, 읽을 수 없다는 답은 null.
export function cachedMedia(agentId: string, raw: string, now = Date.now()): MediaInfo | null | undefined {
  const entry = cache.get(keyOf(agentId, raw));
  return fresh(entry, now, false) ? entry.info : undefined;
}

// 기억에 없는 경로만 모아 묶음 호출로 묻는다. 같은 경로를 이미 묻는 중이면 그 답을 기다린다. 실패는 기억하지 않는다(다음에 다시 묻는다).
// ignoreMiss: 스트리밍이 끝난 직후처럼 "읽을 수 없음" 기억을 무시하고 다시 묻고 싶을 때.
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
