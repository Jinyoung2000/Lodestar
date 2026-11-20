// PERFDAEMON: 데몬이 하는 일의 개수와 바이트를 센다. 시험 인스턴스에서 perf.stats 로 읽고(perf.reset 으로 0부터), 항목마다 호출 수, 바이트, 걸린 시간을 모은다.
// 항목은 종류와 이름으로 구분한다: event(브로드캐스트 type), rpc(method), git(하위 명령), save(state, timeline).
export type PerfBucket = { count: number; bytes: number; ms: number };
export type PerfSnapshot = {
  since: number;
  now: number;
  buckets: Record<string, PerfBucket>;
  process: { rssMb: number; heapMb: number; cpuUserMs: number; cpuSystemMs: number };
};

const buckets = new Map<string, PerfBucket>();
let since = Date.now();

export function perfNote(kind: string, name: string, bytes = 0, ms = 0) {
  const key = `${kind}:${name}`;
  const bucket = buckets.get(key) ?? { count: 0, bytes: 0, ms: 0 };
  bucket.count++;
  bucket.bytes += bytes;
  bucket.ms += ms;
  buckets.set(key, bucket);
}

// 동기 작업이 걸린 시간을 재서 센다.
export function perfTime<T>(kind: string, name: string, work: () => { value: T; bytes: number }): T {
  const start = performance.now();
  const { value, bytes } = work();
  perfNote(kind, name, bytes, performance.now() - start);
  return value;
}

export function perfReset() {
  buckets.clear();
  since = Date.now();
}

export function perfSnapshot(): PerfSnapshot {
  const usage = process.cpuUsage();
  const memory = process.memoryUsage();
  return {
    since,
    now: Date.now(),
    buckets: Object.fromEntries([...buckets.entries()].map(([key, bucket]) => [key, { ...bucket, ms: Math.round(bucket.ms * 10) / 10 }])),
    process: { rssMb: Math.round(memory.rss / 1048576), heapMb: Math.round(memory.heapUsed / 1048576), cpuUserMs: Math.round(usage.user / 1000), cpuSystemMs: Math.round(usage.system / 1000) },
  };
}
