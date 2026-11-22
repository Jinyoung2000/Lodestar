import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { createServer, request, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = realpathSync(mkdtempSync(join(tmpdir(), "agent-nav-media-unit-")));
process.env.AGENT_NAV_HOME = join(root, "nav");
mkdirSync(process.env.AGENT_NAV_HOME, { recursive: true });

const { resolveReadable } = await import("../server/files");
const { mediaKey, mediaUrl, resolveMedia, resolveMediaBatch, signMedia, sniffMedia, verifyMedia, isAgentScratch } = await import("../server/media");
const { handleMedia, mediaOriginAllowed, parseRange } = await import("../server/mediaHttp");

const cases: { name: string; run: () => Promise<void> | void }[] = [];
const test = (name: string, run: () => Promise<void> | void) => cases.push({ name, run });
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
};
const same = (actual: unknown, wanted: unknown, what = "") => expect(JSON.stringify(actual) === JSON.stringify(wanted), `${what} got ${JSON.stringify(actual)}, wanted ${JSON.stringify(wanted)}`);

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(992, 7)]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom"), Buffer.alloc(2000, 9)]);
const MOV = Buffer.concat([Buffer.from([0, 0, 0, 0x14]), Buffer.from("ftypqt  "), Buffer.alloc(100, 1)]);
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(100, 2)]);
const SVG = Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>');
const put = (path: string, bytes: Buffer | string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, bytes);
  return path;
};

const ws = join(root, "ws");
const outside = join(root, "outside");
const home = join(root, "userhome");
const daemonHome = process.env.AGENT_NAV_HOME as string;
const scratchBase = join(root, "tmpbase");
const scratch = join(scratchBase, "claude-502", "-proj", "sess", "scratchpad");
mkdirSync(ws, { recursive: true });

const inWs = put(join(ws, "shots", "in.png"), PNG);
const inWsMp4 = put(join(ws, "rec.mp4"), MP4);
const outPng = put(join(outside, "secret.png"), PNG);
const outText = put(join(outside, "notes.txt"), "plain");
const fakePng = put(join(ws, "fake.png"), "this is not an image, just text");
const emptyPng = put(join(ws, "empty.png"), Buffer.alloc(0));
const homePng = put(join(home, "Desktop", "mock.png"), PNG);
const scratchPng = put(join(scratch, "after.png"), PNG);
const scratchMov = put(join(scratch, "rec.mov"), MOV);
const scratchWebm = put(join(scratch, "rec.webm"), WEBM);
const scratchSvg = put(join(scratch, "d.svg"), SVG);
const daemonPng = put(join(daemonHome, "images", "pasted.png"), PNG);
const lookalike = put(join(scratchBase, "claude-abc", "x", "a.png"), PNG);
const lookalike2 = put(join(scratchBase, "claudex-502", "x", "a.png"), PNG);
const hugePng = put(join(ws, "huge.png"), PNG);
truncateSync(hugePng, 33 * 1024 * 1024);
symlinkSync(outPng, join(ws, "link-out.png"));
symlinkSync(outText, join(ws, "link-text.png"));
symlinkSync(outside, join(ws, "linkdir"));
symlinkSync(inWs, join(ws, "link-in.png"));

let mentioned = new Set<string>();
const ctx = (cwd = ws) => ({
  cwd,
  inWorkspace: (real: string) => resolveReadable(cwd, real).then(() => true, () => false),
  daemonHome,
  userHome: home,
  mentioned: () => mentioned,
  scratchBases: [scratchBase],
});
const ok = async (raw: string, c = ctx()) => (await resolveMedia(raw, c))?.real ?? null;

test("작업 폴더 안: 절대 경로, 상대 경로, 영상", async () => {
  same(await ok(inWs), inWs, "abs");
  same(await ok("shots/in.png"), inWs, "relative");
  same(await ok("./shots/in.png"), inWs, "dot relative");
  same(await ok(inWsMp4), inWsMp4, "mp4");
});

test("없는 파일, 폴더, 빈 파일, 이름만 이미지인 글 파일, 크기 초과는 null", async () => {
  same(await ok(join(ws, "nope.png")), null, "missing");
  same(await ok(join(ws, "shots")), null, "dir");
  same(await ok(fakePng), null, "fake");
  same(await ok(emptyPng), null, "empty");
  same(await ok(hugePng), null, "huge");
});

test("확장자가 미디어가 아니거나 경로 모양이 나쁘면 null", async () => {
  same(await ok(join(ws, "package.json")), null);
  same(await ok(`${ws}/../outside/secret.png`), null, "dotdot");
  same(await ok("../outside/secret.png"), null, "relative dotdot");
  same(await ok("//host/a.png"), null);
  same(await ok(`${inWs}\0.png`), null, "nul");
});

test("작업 폴더 밖: 타임라인에 적히지 않으면 null, 적혀 있으면 열린다", async () => {
  mentioned = new Set();
  same(await ok(outPng), null, "outside unmentioned");
  same(await ok(homePng), null, "home unmentioned");
  mentioned = new Set([outPng, "~/Desktop/mock.png"]);
  same(await ok(outPng), outPng, "outside mentioned");
  same(await ok("~/Desktop/mock.png"), homePng, "tilde mentioned");
  same(await ok(homePng), null, "같은 파일이라도 적힌 글자(~/...)와 다른 글자는 근거가 아니다");
  mentioned = new Set();
});

test("상대 경로는 타임라인 근거로 열리지 않는다(작업 폴더 안만)", async () => {
  mentioned = new Set(["../outside/secret.png", "linkdir/secret.png"]);
  same(await ok("linkdir/secret.png"), null, "relative via symlink dir");
  mentioned = new Set();
});

test("링크 탈출: 작업 폴더 안의 링크가 밖을 가리키면 실제 경로로 판정해 거절", async () => {
  same(await ok(join(ws, "link-out.png")), null, "link to outside png");
  same(await ok(join(ws, "linkdir", "secret.png")), null, "through symlink dir");
  same(await ok("linkdir/secret.png"), null, "relative through symlink dir");
  same(await ok(join(ws, "link-text.png")), null, "png named link to text file");
  same(await ok(join(ws, "link-in.png")), inWs, "작업 폴더 안을 가리키는 링크는 괜찮다");
  mentioned = new Set([join(ws, "link-out.png")]);
  same(await ok(join(ws, "link-out.png")), null, "링크 이름이 적혀 있어도 링크가 가리키는 밖의 파일은 열지 않는다");
  mentioned = new Set([outPng]);
  same(await ok(outPng), outPng, "밖의 실제 경로를 적었으면 열린다");
  mentioned = new Set();
});

test("scratchpad: /tmp/claude-<uid>/ 아래만", async () => {
  same(await ok(scratchPng), scratchPng);
  same(await ok(scratchMov), scratchMov);
  same(await ok(scratchWebm), scratchWebm);
  same(await ok(scratchSvg), scratchSvg);
  same(await ok(lookalike), null, "claude-abc");
  same(await ok(lookalike2), null, "claudex-502");
  expect(isAgentScratch(`${scratchBase}/claude-502/a/b.png`, [scratchBase]), "match");
  expect(!isAgentScratch(`${scratchBase}/claude-502`, [scratchBase]), "폴더 자체는 아님");
});

test("데몬 홈(~/.agent-nav) 안의 이미지", async () => {
  same(await ok(daemonPng), daemonPng);
  same(await ok(join(daemonHome, "token")), null, "token file");
});

test("형식 확인: 앞 바이트", () => {
  same(sniffMedia(PNG, "png")?.mime, "image/png");
  same(sniffMedia(PNG, "mp4"), null, "png bytes named mp4");
  same(sniffMedia(MP4, "mp4")?.mime, "video/mp4");
  same(sniffMedia(MOV, "mov")?.mime, "video/quicktime");
  same(sniffMedia(WEBM, "webm")?.mime, "video/webm");
  same(sniffMedia(WEBM, "mp4"), null);
  same(sniffMedia(SVG, "svg")?.mime, "image/svg+xml");
  same(sniffMedia(Buffer.from("<html><svg></svg></html>"), "svg"), null, "html 속 svg 는 svg 파일이 아니다");
  same(sniffMedia(Buffer.from("<script>alert(1)</script>"), "svg"), null);
  same(sniffMedia(PNG, "txt"), null);
});

test("서명: 같은 경로와 수정 시각만 통과", () => {
  const key = mediaKey("token-a");
  const signature = signMedia(key, inWs, 1234.9);
  expect(verifyMedia(key, inWs, "1234", signature), "ok");
  expect(!verifyMedia(key, inWs, "1235", signature), "mtime");
  expect(!verifyMedia(key, outPng, "1234", signature), "path");
  expect(!verifyMedia(mediaKey("token-b"), inWs, "1234", signature), "other token");
  expect(!verifyMedia(key, inWs, "1234", ""), "empty");
  expect(!verifyMedia(key, inWs, "abc", signature), "bad mtime");
  expect(!verifyMedia(key, inWs, "1234", `${signature}x`), "length");
});

test("한꺼번에 확인: 순서와 길이 유지, 읽을 수 없는 것은 null", async () => {
  const key = mediaKey("t");
  const out = await resolveMediaBatch([inWs, outPng, "shots/in.png", 5, null, inWsMp4], ctx(), key);
  same(out.map((info) => info?.kind ?? null), ["image", null, "image", null, null, "video"]);
  same(out[0]?.name, "in.png");
  same(out[0]?.raw, inWs);
  expect(out[0]?.url.startsWith("/media?p=") === true, "url");
  expect(out[0]?.url.includes("token-a") !== true, "토큰이 주소에 없다");
  const many = await resolveMediaBatch(Array.from({ length: 40 }, () => inWs), ctx(), key);
  same(many.length, 40);
  same(many.filter(Boolean).length, 32, "한 번에 32개까지");
  let threw = false;
  await resolveMediaBatch("x", ctx(), key).catch(() => (threw = true));
  expect(threw, "배열이 아니면 오류");
});

type Reply = { status: number; headers: IncomingHttpHeaders; body: Buffer };
function startServer() {
  const key = mediaKey("unit-token");
  let origins = new Set<string>();
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    void handleMedia(req, res, url, { key, origins }).catch(() => res.writeHead(500).end());
  });
  return new Promise<{ key: Buffer; port: number; setOrigins: (o: string[]) => void; close: () => void }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      origins = new Set([`http://127.0.0.1:${port}`]);
      resolve({ key, port, setOrigins: (o) => (origins = new Set(o)), close: () => server.close() });
    });
  });
}
const get = (port: number, path: string, headers: Record<string, string> = {}, method = "GET") =>
  new Promise<Reply>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
const urlFor = (key: Buffer, real: string) => {
  const mtimeMs = Math.floor(Date.now());
  return `/media?p=${encodeURIComponent(real)}&m=${mtimeMs}&s=${signMedia(key, real, mtimeMs)}`;
};

test("HTTP: 200 전체, 헤더, HEAD", async () => {
  const s = await startServer();
  try {
    const r = await get(s.port, urlFor(s.key, scratchMov));
    same(r.status, 200);
    same(r.headers["content-type"], "video/quicktime");
    same(r.headers["accept-ranges"], "bytes");
    same(r.headers["content-length"], String(MOV.length));
    same(r.headers["x-content-type-options"], "nosniff");
    expect(String(r.headers["content-security-policy"]).includes("sandbox"), "csp sandbox");
    expect(r.body.equals(MOV), "body");
    const head = await get(s.port, urlFor(s.key, scratchMov), {}, "HEAD");
    same(head.status, 200);
    same(head.body.length, 0, "head body");
    same(head.headers["content-length"], String(MOV.length));
    same((await get(s.port, urlFor(s.key, scratchSvg))).headers["content-type"], "image/svg+xml");
  } finally {
    s.close();
  }
});

test("HTTP: resolve 가 준 주소를 그대로 요청하면 읽힌다", async () => {
  const s = await startServer();
  try {
    const [info] = await resolveMediaBatch([inWsMp4], ctx(), s.key);
    const r = await get(s.port, info?.url ?? "/none");
    same(r.status, 200);
    expect(r.body.equals(MP4), "body");
  } finally {
    s.close();
  }
});

test("HTTP: Range 구간, 접미 구간, 열린 구간", async () => {
  const s = await startServer();
  try {
    const url = urlFor(s.key, inWsMp4);
    const a = await get(s.port, url, { range: "bytes=0-9" });
    same(a.status, 206);
    same(a.headers["content-range"], `bytes 0-9/${MP4.length}`);
    same(a.headers["content-length"], "10");
    expect(a.body.equals(MP4.subarray(0, 10)), "body 0-9");
    const b = await get(s.port, url, { range: "bytes=-5" });
    same(b.status, 206);
    same(b.headers["content-range"], `bytes ${MP4.length - 5}-${MP4.length - 1}/${MP4.length}`);
    expect(b.body.equals(MP4.subarray(MP4.length - 5)), "suffix");
    const c = await get(s.port, url, { range: "bytes=1000-" });
    same(c.status, 206);
    expect(c.body.equals(MP4.subarray(1000)), "open end");
    const d = await get(s.port, url, { range: "bytes=10-99999999" });
    same(d.headers["content-range"], `bytes 10-${MP4.length - 1}/${MP4.length}`, "끝이 파일을 넘으면 잘린다");
    const e = await get(s.port, url, { range: `bytes=${MP4.length}-` });
    same(e.status, 416);
    same(e.headers["content-range"], `bytes */${MP4.length}`);
    same((await get(s.port, url, { range: "bytes=-0" })).status, 416);
    same((await get(s.port, url, { range: "bytes=0-1,5-9" })).status, 200, "여러 구간은 전체");
    same((await get(s.port, url, { range: "items=0-1" })).status, 200, "모르는 단위");
    same((await get(s.port, url, { range: "bytes=9-3" })).status, 200, "거꾸로 된 구간은 무시");
  } finally {
    s.close();
  }
});

test("parseRange 단위", () => {
  same(parseRange(undefined, 100), null);
  same(parseRange("bytes=0-0", 100), { start: 0, end: 0 });
  same(parseRange("bytes=90-", 100), { start: 90, end: 99 });
  same(parseRange("bytes=-200", 100), { start: 0, end: 99 });
  same(parseRange("bytes=100-", 100), "unsatisfiable");
  same(parseRange("bytes=-", 100), null);
});

test("HTTP: 서명이 없거나 틀리거나 다른 경로에 쓰면 403", async () => {
  const s = await startServer();
  try {
    const real = encodeURIComponent(inWs);
    same((await get(s.port, `/media?p=${real}`)).status, 403, "no sig");
    same((await get(s.port, `/media?p=${real}&m=1&s=AAAA`)).status, 403, "wrong sig");
    same((await get(s.port, "/media")).status, 403, "nothing");
    const good = urlFor(s.key, inWs);
    const swapped = good.replace(encodeURIComponent(inWs), encodeURIComponent(outPng));
    same((await get(s.port, swapped)).status, 403, "다른 경로에 옮겨 쓴 서명");
    const otherKey = mediaKey("another-daemon");
    same((await get(s.port, urlFor(otherKey, inWs))).status, 403, "다른 토큰 키");
    same((await get(s.port, good.replace(/&m=\d+/, "&m=1"))).status, 403, "수정 시각을 바꾼 주소");
    same((await get(s.port, urlFor(s.key, outPng))).status, 200, "서명이 맞으면 읽힌다(허용 판단은 resolve 에서 이미 끝난 것)");
  } finally {
    s.close();
  }
});

test("HTTP: Origin 과 Sec-Fetch-Site", async () => {
  const s = await startServer();
  try {
    const url = urlFor(s.key, inWs);
    same((await get(s.port, url, { origin: "http://evil.example" })).status, 403, "다른 origin");
    same((await get(s.port, url, { origin: "null" })).status, 403, "null origin");
    same((await get(s.port, url, { origin: `http://127.0.0.1:${s.port}` })).status, 200, "허용된 origin");
    same((await get(s.port, url, { "sec-fetch-site": "cross-site" })).status, 403, "교차 사이트 이미지 요청");
    same((await get(s.port, url, { "sec-fetch-site": "same-site" })).status, 403, "같은 사이트의 다른 포트");
    same((await get(s.port, url, { "sec-fetch-site": "same-origin" })).status, 200, "같은 출처 이미지 요청");
    same((await get(s.port, url, {})).status, 200, "헤더 없는 클라이언트는 서명이 증명");
    s.setOrigins([]);
    same((await get(s.port, url, { origin: `http://127.0.0.1:${s.port}` })).status, 403, "허용 목록이 비면 거절");
    const reply = await new Promise<number>((resolve) => {
      const req = request({ host: "127.0.0.1", port: s.port, path: url, method: "POST" }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.end();
    });
    same(reply, 405, "POST");
  } finally {
    s.close();
  }
});

test("mediaOriginAllowed 단위", () => {
  const origins = new Set(["http://127.0.0.1:1"]);
  expect(mediaOriginAllowed({}, origins), "none");
  expect(mediaOriginAllowed({ origin: "http://127.0.0.1:1" }, origins), "listed");
  expect(!mediaOriginAllowed({ origin: "http://127.0.0.1:2" }, origins), "other");
  expect(!mediaOriginAllowed({ "sec-fetch-site": "cross-site" }, origins), "cross");
  expect(mediaOriginAllowed({ "sec-fetch-site": "none" }, origins), "navigation");
});

test("HTTP: 서명 뒤에 바뀐 파일(링크로 교체, 내용 교체, 삭제, 크기 초과)은 404", async () => {
  const s = await startServer();
  try {
    const target = put(join(scratch, "swap.png"), PNG);
    const url = urlFor(s.key, target);
    same((await get(s.port, url)).status, 200, "before");
    rmSync(target);
    symlinkSync(outPng, target);
    same((await get(s.port, url)).status, 404, "링크로 교체");
    rmSync(target);
    put(target, "no longer an image");
    same((await get(s.port, url)).status, 404, "내용 교체");
    rmSync(target);
    same((await get(s.port, url)).status, 404, "삭제");
    put(target, PNG);
    truncateSync(target, 33 * 1024 * 1024);
    same((await get(s.port, url)).status, 404, "크기 초과");
    const dirTarget = join(scratch, "swapdir");
    put(join(dirTarget, "a.png"), PNG);
    const dirUrl = urlFor(s.key, join(dirTarget, "a.png"));
    same((await get(s.port, dirUrl)).status, 200, "dir before");
    rmSync(dirTarget, { recursive: true });
    mkdirSync(join(outside, "swapped"), { recursive: true });
    put(join(outside, "swapped", "a.png"), PNG);
    symlinkSync(join(outside, "swapped"), dirTarget);
    same((await get(s.port, dirUrl)).status, 404, "폴더를 링크로 교체");
  } finally {
    s.close();
  }
});

test("mediaUrl 은 토큰을 싣지 않고 경로와 수정 시각과 서명만", () => {
  const url = mediaUrl(mediaKey("secret-token-value"), { real: inWs, mtimeMs: 42.7 });
  expect(!url.includes("secret-token-value"), "token");
  expect(url.includes("&m=42&s="), "mtime floor");
});

let failed = 0;
for (const { name, run } of cases) {
  try {
    await run();
    console.log(`ok   ${name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${name}\n     ${error instanceof Error ? error.message : error}`);
  }
}
rmSync(root, { recursive: true, force: true });
if (failed) {
  console.log(`${failed} of ${cases.length} failed`);
  process.exit(1);
}
console.log(`media ok (${cases.length})`);
