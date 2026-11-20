// 대화 속 이미지와 영상 경로 확인 결과를 기억하는 곳(web/mediaResolve.ts) 시험. 실행: npm test
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

// 묶음 호출 하나, 중복 제거, 없는 파일은 null
await resolveMediaPaths("g", ["/a.png", "/b.png", "/a.png", "/none.png"], call);
assert.deepEqual(calls, [["/a.png", "/b.png", "/none.png"]]);
assert.equal(cachedMedia("g", "/a.png")?.url, "/media?p=/a.png");
assert.equal(cachedMedia("g", "/none.png"), null);
assert.equal(cachedMedia("g", "/never.png"), undefined);
assert.equal(cachedMedia("other", "/a.png"), undefined, "세션마다 따로 기억한다");

// 기억에 있으면 다시 묻지 않는다
await resolveMediaPaths("g", ["/a.png", "/none.png"], call);
assert.equal(calls.length, 1);

// 없다는 답은 짧게만 기억한다
const later = Date.now() + MISS_TTL_MS + 1;
assert.equal(cachedMedia("g", "/none.png", later), undefined);
assert.equal(cachedMedia("g", "/a.png", later)?.name, "/a.png");
assert.equal(cachedMedia("g", "/a.png", Date.now() + HIT_TTL_MS + 1), undefined);

// ignoreMiss: 방금 없다고 답한 경로도 다시 묻는다. 있다는 답은 그대로 둔다
exists.add("/none.png");
await resolveMediaPaths("g", ["/a.png", "/none.png"], call, { ignoreMiss: true });
assert.deepEqual(calls[1], ["/none.png"]);
assert.equal(cachedMedia("g", "/none.png")?.name, "/none.png");

// 같은 경로를 이미 묻는 중이면 두 번 묻지 않고 그 답을 기다린다
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

// 실패는 기억하지 않는다
clearMediaCache();
await resolveMediaPaths("g", ["/a.png"], async () => {
  throw new Error("socket closed");
});
assert.equal(cachedMedia("g", "/a.png"), undefined);
await resolveMediaPaths("g", ["/a.png"], call);
assert.equal(cachedMedia("g", "/a.png")?.name, "/a.png");

// 32개 단위로 나눠 묻는다
clearMediaCache();
calls.length = 0;
await resolveMediaPaths("g", Array.from({ length: 70 }, (_, i) => `/n${i}.png`), call);
assert.deepEqual(calls.map((c) => c.length), [32, 32, 6]);

console.log("mediaresolve ok");
