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
