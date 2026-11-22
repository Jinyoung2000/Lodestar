import assert from "node:assert/strict";
import type { MediaInfo } from "../shared/protocol";
import { cachedMedia, clearMediaCache, HIT_TTL_MS, MISS_TTL_MS, resolveMediaPaths } from "../web/mediaResolve";

const info = (raw: string): MediaInfo => ({ raw, kind: "image", mime: "image/png", size: 1, name: raw, url: `/media?p=${raw}` });
const calls: string[][] = [];
const exists = new Set(["/a.png", "/b.png"]);
const call = async (_agent: string, paths: string[]) => {
  calls.push(paths);
  return paths.map((path) => (exists.has(path) ? info(path) : null));
};

await resolveMediaPaths("g", ["/a.png", "/b.png", "/a.png", "/none.png"], call);
assert.deepEqual(calls, [["/a.png", "/b.png", "/none.png"]]);
assert.equal(cachedMedia("g", "/a.png")?.url, "/media?p=/a.png");
assert.equal(cachedMedia("g", "/none.png"), null);
assert.equal(cachedMedia("g", "/never.png"), undefined);
assert.equal(cachedMedia("other", "/a.png"), undefined, "세션마다 따로 기억한다");

await resolveMediaPaths("g", ["/a.png", "/none.png"], call);
assert.equal(calls.length, 1);

const later = Date.now() + MISS_TTL_MS + 1;
assert.equal(cachedMedia("g", "/none.png", later), undefined);
assert.equal(cachedMedia("g", "/a.png", later)?.name, "/a.png");
assert.equal(cachedMedia("g", "/a.png", Date.now() + HIT_TTL_MS + 1), undefined);

exists.add("/none.png");
await resolveMediaPaths("g", ["/a.png", "/none.png"], call, { ignoreMiss: true });
assert.deepEqual(calls[1], ["/none.png"]);
assert.equal(cachedMedia("g", "/none.png")?.name, "/none.png");

clearMediaCache();
calls.length = 0;
let release: () => void = () => undefined;
const slow = (agent: string, paths: string[]) => new Promise<(MediaInfo | null)[]>((resolve) => (release = () => resolve(call(agent, paths))));
const first = resolveMediaPaths("g", ["/a.png"], slow);
const second = resolveMediaPaths("g", ["/a.png", "/b.png"], call);
await new Promise((r) => setTimeout(r, 5));
release();
await Promise.all([first, second]);
assert.deepEqual(calls.flat().sort(), ["/a.png", "/b.png"], "각 경로는 한 번씩만 물었다");

clearMediaCache();
await resolveMediaPaths("g", ["/a.png"], async () => {
  throw new Error("socket closed");
});
assert.equal(cachedMedia("g", "/a.png"), undefined);
await resolveMediaPaths("g", ["/a.png"], call);
assert.equal(cachedMedia("g", "/a.png")?.name, "/a.png");

clearMediaCache();
calls.length = 0;
await resolveMediaPaths("g", Array.from({ length: 70 }, (_, i) => `/n${i}.png`), call);
assert.deepEqual(calls.map((c) => c.length), [32, 32, 6]);

console.log("mediaresolve ok");
