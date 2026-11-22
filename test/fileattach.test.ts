import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import WebSocket from "ws";
import { classifyDrop, FILE_BLOCK_HEADER, fileBlock, formatBytes, isUsablePath, MAX_FILE_BYTES, MAX_FILES, sanitizeFileName, withFileBlock } from "../shared/files";
import { MAX_IMAGE_BYTES } from "../shared/images";
import { handleUpload } from "../server/fileAttach";
import { chipIdentity } from "../web/attachDedupe";
import { useTestDaemon } from "./testDaemon";

type Case = { name: string; run: () => Promise<string> };
const cases: Case[] = [];
const test = (name: string, run: () => Promise<string> | string) => cases.push({ name, run: async () => run() });
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
  return detail;
};

test("classifyDrop: 이미지는 이미지 칩 그대로, 영상과 임의 파일은 파일 칩, 5MB 넘는 이미지도 파일 칩", () => {
  expect(classifyDrop("image/png", 1000, 0).kind === "image", "png");
  expect(classifyDrop("image/webp", MAX_IMAGE_BYTES, 0).kind === "image", "exactly 5MB is still an image");
  const big = classifyDrop("image/jpeg", MAX_IMAGE_BYTES + 1, 0);
  expect(big.kind === "file" && big.oversizeImage, `oversize image ${JSON.stringify(big)}`);
  const mp4 = classifyDrop("video/mp4", 40_000_000, 0);
  expect(mp4.kind === "file" && !mp4.oversizeImage, "mp4 is a file");
  expect(classifyDrop("", 10, 0).kind === "file", "unknown type is a file");
  expect(classifyDrop("image/svg+xml", 10, 0).kind === "file", "svg is not an accepted image type, so a file");
  expect(classifyDrop("image/png", 0, 0).kind === "reject", "empty image rejected");
  const empty = classifyDrop("video/mp4", 0, 0);
  expect(empty.kind === "reject" && empty.problem === "empty", "empty file (or folder) rejected");
  const huge = classifyDrop("video/mp4", MAX_FILE_BYTES + 1, 0);
  expect(huge.kind === "reject" && huge.problem === "size", "over 1GB rejected");
  expect(classifyDrop("video/mp4", MAX_FILE_BYTES, 0).kind === "file", "exactly 1GB allowed");
  const count = classifyDrop("video/mp4", 5, MAX_FILES);
  expect(count.kind === "reject" && count.problem === "count", "file count limit");
  expect(classifyDrop("image/png", 5, MAX_FILES).kind === "image", "image count is the image checker's job, not this one");
  return "ok";
});

test("sanitizeFileName: 경로 조각, 제어 문자, 빈 이름, 긴 이름", () => {
  const cases: [string, string][] = [
    ["Screen Recording.mp4", "Screen Recording.mp4"],
    ["../../etc/passwd", "passwd"],
    ["..\\..\\win.ini", "win.ini"],
    ["a/b/c.txt", "c.txt"],
    ["/", "file"],
    ["..", "file"],
    [".", "file"],
    ["", "file"],
    ["  ", "file"],
    ["x\u0000y\n.mp4", "xy.mp4"],
    [".env", ".env"],
    ["영상 녹화.mp4", "영상 녹화.mp4"],
  ];
  for (const [input, want] of cases) expect(sanitizeFileName(input) === want, `${JSON.stringify(input)} -> ${JSON.stringify(sanitizeFileName(input))} (want ${want})`);
  const long = `${"가".repeat(200)}.mp4`;
  const cut = sanitizeFileName(long);
  expect(new TextEncoder().encode(cut).length <= 200 && cut.endsWith(".mp4"), `long name keeps the extension and fits 200 bytes: ${cut.length} chars`);
  return "ok";
});

test("isUsablePath: 절대 경로만, 줄바꿈과 .. 조각은 거절", () => {
  expect(isUsablePath("/Users/g/a b.mp4"), "plain absolute path with space");
  for (const bad of ["relative/a.mp4", "", "/a/../b", "/a\nb", "/a\u0000b", "~/a.mp4", 5, null, `/${"x".repeat(5000)}`]) expect(!isUsablePath(bad), `rejects ${JSON.stringify(bad)?.slice(0, 30)}`);
  return "ok";
});

test("formatBytes", () => {
  const want: [number, string][] = [
    [0, "0 B"],
    [1023, "1023 B"],
    [1024, "1 KB"],
    [1536, "1.5 KB"],
    [12_345_678, "11.8 MB"],
    [1024 ** 3, "1 GB"],
    [150 * 1024 * 1024, "150 MB"],
  ];
  for (const [n, text] of want) expect(formatBytes(n) === text, `${n} -> ${formatBytes(n)} (want ${text})`);
  return "ok";
});

test("fileBlock, withFileBlock: 경로는 따옴표와 @ 없이 그대로, 글이 없으면 블록만", () => {
  const files = [
    { path: "/Users/me/Downloads/Screen_Recording_20261027_150207_Example.mp4", name: "Screen_Recording_20261027_150207_Example.mp4", bytes: 12_345_678, mediaType: "video/mp4" },
    { path: "/Users/me/Desktop/메모 파일.bin", name: "메모 파일.bin", bytes: 10, mediaType: "" },
  ];
  const block = fileBlock(files);
  expect(block === `${FILE_BLOCK_HEADER}\n- /Users/me/Downloads/Screen_Recording_20261027_150207_Example.mp4 (video/mp4, 11.8 MB)\n- /Users/me/Desktop/메모 파일.bin (10 B)`, block);
  expect(withFileBlock("이 영상 봐줘", files) === `이 영상 봐줘\n\n${block}`, "text then block");
  expect(withFileBlock("", files) === block, "no text: block only");
  expect(withFileBlock("hi", []) === "hi" && fileBlock([]) === "", "no files: unchanged");
  expect(!block.includes("@") && !block.includes('"'), "no @ mention and no quotes");
  return "ok";
});

test("chipIdentity: 경로를 아는 파일은 같은 경로가 같은 칩, 업로드 중(경로 없음)은 중복을 거르지 않는다", () => {
  const chip = (path: string | null) => ({ workspaceId: null, path: "a.mp4", startLine: null, endLine: null, file: { name: "a.mp4", bytes: 1, mediaType: "", path, status: "ready" as const, progress: 1, uploadId: null } });
  expect(chipIdentity(chip("/x/a.mp4"), () => undefined) === chipIdentity(chip("/x/a.mp4"), () => undefined), "same path, same chip");
  expect(chipIdentity(chip("/x/a.mp4"), () => undefined) !== chipIdentity(chip("/y/a.mp4"), () => undefined), "different path");
  expect(chipIdentity(chip(null), () => undefined) === null, "no path yet");
  return "ok";
});

const TOKEN = "t".repeat(64);
const ORIGIN = "http://127.0.0.1:9999";

type Reply = { status: number; json: Record<string, unknown> };
function post(port: number, path: string, options: { headers?: Record<string, string>; chunks?: Buffer[]; announce?: number | null; cutAfter?: number }): Promise<Reply> {
  const chunks = options.chunks ?? [Buffer.from("hello")];
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (options.announce !== null) headers["content-length"] = String(options.announce ?? total);
  return new Promise((resolveReply, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: "POST", headers }, (res) => {
      let text = "";
      res.on("data", (d) => (text += d));
      res.on("end", () => resolveReply({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : {} }));
    });
    req.on("error", (error) => (options.cutAfter !== undefined ? resolveReply({ status: 0, json: { error: String(error) } }) : reject(error)));
    let sent = 0;
    for (const chunk of chunks) {
      req.write(chunk);
      sent += chunk.length;
      if (options.cutAfter !== undefined && sent >= options.cutAfter) {
        setTimeout(() => req.destroy(), 30);
        return;
      }
    }
    req.end();
  });
}

async function uploadServer(maxBytes = 1000) {
  const dir = mkdtempSync(join(tmpdir(), "agent-nav-upload-"));
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    void handleUpload(req, res, url, { token: TOKEN, origins: new Set([ORIGIN]), dir, maxBytes });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return { port, dir, close: () => { server.close(); rmSync(dir, { recursive: true, force: true }); } };
}

const good = { origin: ORIGIN, "x-agent-nav-token": TOKEN };

test("handleUpload: 정상 업로드는 <dir>/<id>/<이름> 에 원본 바이트로 저장되고 경로를 돌려준다", async () => {
  const s = await uploadServer();
  try {
    const body = Buffer.from("0123456789".repeat(20));
    const r = await post(s.port, "/attachments?name=" + encodeURIComponent("Screen Recording 1.mp4"), { headers: good, chunks: [body.subarray(0, 50), body.subarray(50)] });
    expect(r.status === 200, `status ${r.status} ${JSON.stringify(r.json)}`);
    const path = String(r.json.path);
    expect(path === join(s.dir, String(r.json.id), "Screen Recording 1.mp4"), `path ${path}`);
    expect(readFileSync(path).equals(body) && r.json.bytes === body.length, "bytes identical");
    return "ok";
  } finally {
    s.close();
  }
});

test("handleUpload: 토큰 없음, 틀린 토큰, Origin 없음, 다른 Origin 은 403 이고 아무것도 저장하지 않는다", async () => {
  const s = await uploadServer();
  try {
    const attempts: [string, Record<string, string>][] = [
      ["no token", { origin: ORIGIN }],
      ["wrong token", { origin: ORIGIN, "x-agent-nav-token": "x".repeat(64) }],
      ["short token", { origin: ORIGIN, "x-agent-nav-token": "t" }],
      ["no origin", { "x-agent-nav-token": TOKEN }],
      ["other origin", { origin: "http://evil.example", "x-agent-nav-token": TOKEN }],
      ["origin same host other port", { origin: "http://127.0.0.1:1", "x-agent-nav-token": TOKEN }],
    ];
    for (const [label, headers] of attempts) {
      const r = await post(s.port, "/attachments?name=a.txt", { headers });
      expect(r.status === 403, `${label}: status ${r.status}`);
    }
    expect(readdirSync(s.dir).length === 0, "nothing was written");
    return `${attempts.length} refused`;
  } finally {
    s.close();
  }
});

test("handleUpload: Content-Length 없음(chunked)은 411, 상한 초과 선언은 413, 빈 파일은 400", async () => {
  const s = await uploadServer(1000);
  try {
    const chunked = await post(s.port, "/attachments?name=a.bin", { headers: { ...good, "transfer-encoding": "chunked" }, announce: null });
    expect(chunked.status === 411, `chunked ${chunked.status}`);
    const big = await post(s.port, "/attachments?name=a.bin", { headers: good, announce: 1001, chunks: [Buffer.alloc(10)] });
    expect(big.status === 413, `declared too large ${big.status}`);
    const empty = await post(s.port, "/attachments?name=a.bin", { headers: good, chunks: [] });
    expect(empty.status === 400, `empty ${empty.status}`);
    const get = await new Promise<number>((r) => request({ host: "127.0.0.1", port: s.port, path: "/attachments", method: "GET", headers: good }, (res) => { res.resume(); r(res.statusCode ?? 0); }).end());
    expect(get === 405, `GET ${get}`);
    expect(readdirSync(s.dir).length === 0, "nothing was written");
    return "ok";
  } finally {
    s.close();
  }
});

test("handleUpload: 선언한 길이보다 많이 보내면 끊고 지운다", async () => {
  const s = await uploadServer(1000);
  try {
    const r = await post(s.port, "/attachments?name=a.bin", { headers: good, announce: 10, chunks: [Buffer.alloc(500)] });
    expect(r.status === 400 || r.status === 0, `status ${r.status}`);
    await new Promise((res) => setTimeout(res, 100));
    expect(readdirSync(s.dir).length === 0, `leftover ${readdirSync(s.dir)}`);
    return `status ${r.status}`;
  } finally {
    s.close();
  }
});

test("handleUpload: 중간에 끊긴 업로드는 부분 파일을 남기지 않는다", async () => {
  const s = await uploadServer(10_000);
  try {
    await post(s.port, "/attachments?name=big.mp4", { headers: good, announce: 5000, chunks: [Buffer.alloc(100), Buffer.alloc(100)], cutAfter: 100 });
    await new Promise((res) => setTimeout(res, 300));
    expect(readdirSync(s.dir).length === 0, `leftover ${readdirSync(s.dir)}`);
    return "ok";
  } finally {
    s.close();
  }
});

test("handleUpload: ../ 가 든 이름은 마지막 조각만 남아 업로드 폴더 밖에 쓰지 못한다", async () => {
  const s = await uploadServer();
  try {
    const outside = resolve(s.dir, "..", "evil-upload-test.txt");
    for (const name of ["../evil-upload-test.txt", "..%2F..%2Fevil-upload-test.txt", "/etc/evil-upload-test.txt", "a/../../evil-upload-test.txt", "..", "", "%00"]) {
      const r = await post(s.port, `/attachments?name=${name.includes("%") ? name : encodeURIComponent(name)}`, { headers: good });
      expect(r.status === 200, `${JSON.stringify(name)}: status ${r.status} ${JSON.stringify(r.json)}`);
      const saved = String(r.json.path);
      const folder = join(s.dir, String(r.json.id));
      expect(saved.startsWith(folder + "/") && !saved.slice(folder.length + 1).includes("/"), `${JSON.stringify(name)} saved at ${saved}`);
      expect(String(r.json.name) === saved.slice(folder.length + 1), "returned name is the saved name");
    }
    expect(!existsSync(outside) && !existsSync("/etc/evil-upload-test.txt"), "nothing written outside");
    return "ok";
  } finally {
    s.close();
  }
});

const FAKE_CLAUDE = resolve(import.meta.dirname, "fixtures/fake-claude.mjs");
const SEEDED_AGENT = "00000000-0000-4000-8000-000000000001";

function daemonHttp(port: number, path: string, headers: Record<string, string>, body: Buffer) {
  return new Promise<Reply>((resolveReply, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: "POST", headers: { "content-length": String(body.length), ...headers } }, (res) => {
      let text = "";
      res.on("data", (d) => (text += d));
      res.on("end", () => resolveReply({ status: res.statusCode ?? 0, json: text.startsWith("{") ? JSON.parse(text) : { raw: text } }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

async function rpcClient(daemon: { port: number; token: string }) {
  const ws = new WebSocket(`ws://127.0.0.1:${daemon.port}/ws/rpc?token=${daemon.token}`, { headers: { origin: `http://127.0.0.1:${daemon.port}` } });
  await new Promise((r) => ws.on("open", r));
  let next = 1;
  const pending = new Map<number, (m: { result?: unknown; error?: string }) => void>();
  ws.on("message", (data) => {
    const message = JSON.parse(String(data)) as { id?: number; result?: unknown; error?: string };
    if (message.id !== undefined) pending.get(message.id)?.(message);
  });
  const call = (method: string, params: unknown) =>
    new Promise<{ result?: unknown; error?: string }>((r) => {
      const id = next++;
      pending.set(id, r);
      ws.send(JSON.stringify({ id, method, params }));
    });
  return { call, close: () => ws.close() };
}

async function until<T>(read: () => T | null | undefined | false, label: string, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = read();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${label}`);
}

test("데몬: POST /attachments 의 Host, Origin, 토큰 검사와 저장, discard RPC", async () => {
  const daemon = await useTestDaemon();
  const rpc = await rpcClient(daemon);
  try {
    const origin = `http://127.0.0.1:${daemon.port}`;
    const ok = { origin, "x-agent-nav-token": daemon.token };
    const body = Buffer.from("fake mp4 bytes");
    expect((await daemonHttp(daemon.port, "/attachments?name=a.mp4", { "x-agent-nav-token": daemon.token }, body)).status === 403, "no origin");
    expect((await daemonHttp(daemon.port, "/attachments?name=a.mp4", { origin }, body)).status === 403, "no token");
    expect((await daemonHttp(daemon.port, "/attachments?name=a.mp4", { origin: "http://evil.example", "x-agent-nav-token": daemon.token }, body)).status === 403, "other origin");
    expect((await daemonHttp(daemon.port, "/attachments?name=a.mp4", { ...ok, host: "evil.example" }, body)).status === 403, "other Host (DNS rebinding)");
    expect(!existsSync(join(daemon.home, "attachments")) || readdirSync(join(daemon.home, "attachments")).length === 0, "refused requests wrote nothing");

    const saved = await daemonHttp(daemon.port, "/attachments?name=" + encodeURIComponent("../../Screen Recording.mp4"), ok, body);
    expect(saved.status === 200, `upload ${saved.status} ${JSON.stringify(saved.json)}`);
    const path = String(saved.json.path);
    expect(path === join(daemon.home, "attachments", String(saved.json.id), "Screen Recording.mp4"), `saved under the daemon home: ${path}`);
    expect(readFileSync(path).equals(body), "bytes identical");

    const bad = await rpc.call("attachments.discard", { id: "../../x" });
    expect(/invalid attachment id/.test(String(bad.error)), `discard refuses a non-uuid id: ${bad.error}`);
    expect((await rpc.call("attachments.discard", { id: saved.json.id })).error === undefined, "discard ok");
    expect(!existsSync(path) && !existsSync(join(daemon.home, "attachments", String(saved.json.id))), "folder removed");
    return "ok";
  } finally {
    rpc.close();
    daemon.stop();
  }
});

test("데몬: 파일을 붙여 보내면 SDK 에 글 뒤에 경로 블록이 가고 말풍선은 글과 파일 칩이다 (agents.send, agents.create), 없어진 파일, 상대 경로, 폴더는 거절", async () => {
  const log = join(mkdtempSync(join(tmpdir(), "agent-nav-fakeclaude-")), "claude.log");
  const daemon = await useTestDaemon({ env: { AGENT_NAV_CLAUDE: FAKE_CLAUDE, FAKE_CLAUDE_LOG: log } });
  const rpc = await rpcClient(daemon);
  const media = mkdtempSync(join(tmpdir(), "agent-nav-media-"));
  try {
    const mp4 = join(media, "Screen_Recording 1.mp4");
    writeFileSync(mp4, Buffer.alloc(2048, 1));
    const prompts = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { message: { content: unknown } }) : []);
    const textOf = (m: { message: { content: unknown } }) => (typeof m.message.content === "string" ? m.message.content : (m.message.content as { type: string; text?: string }[]).filter((p) => p.type === "text").map((p) => p.text).join("\n"));

    const gone = await rpc.call("agents.send", { agentId: SEEDED_AGENT, prompt: "x", files: [{ path: join(media, "nope.mp4"), name: "nope.mp4", bytes: 1, mediaType: "video/mp4" }] });
    expect(/gone or is not a regular file/.test(String(gone.error)), `missing file rejected: ${gone.error}`);
    const relative = await rpc.call("agents.send", { agentId: SEEDED_AGENT, prompt: "x", files: [{ path: "relative/a.mp4", name: "a.mp4", bytes: 1, mediaType: "" }] });
    expect(/not a usable file path/.test(String(relative.error)), `relative path rejected: ${relative.error}`);
    const folder = await rpc.call("agents.send", { agentId: SEEDED_AGENT, prompt: "x", files: [{ path: media, name: "media", bytes: 1, mediaType: "" }] });
    expect(/not a regular file/.test(String(folder.error)), `folder rejected: ${folder.error}`);
    expect(prompts().length === 0, "nothing reached the model for rejected sends");

    const sent = await rpc.call("agents.send", { agentId: SEEDED_AGENT, prompt: "이 영상 봐줘", files: [{ path: mp4, name: "Screen_Recording 1.mp4", bytes: 1, mediaType: "video/mp4" }] });
    expect(sent.error === undefined, `send ${sent.error}`);
    const first = await until(() => prompts()[0], "the first prompt at the fake claude");
    expect(textOf(first) === `이 영상 봐줘\n\n${FILE_BLOCK_HEADER}\n- ${mp4} (video/mp4, 2 KB)`, `prompt: ${JSON.stringify(textOf(first))}`);

    const timeline = async () => ((await rpc.call("agents.timeline", { agentId: SEEDED_AGENT })).result ?? []) as { kind: string; text?: string; shown?: string; attachments?: { kind: string; label: string; path: string; bytes: number }[] }[];
    const items = await timeline();
    const bubble = items.find((i) => i.kind === "user");
    expect(bubble?.shown === "이 영상 봐줘", `bubble shows the typed text: ${JSON.stringify(bubble?.shown)}`);
    expect(JSON.stringify(bubble?.attachments) === JSON.stringify([{ kind: "file", label: "Screen_Recording 1.mp4", path: mp4, bytes: 2048 }]), `file chip: ${JSON.stringify(bubble?.attachments)}`);
    expect(bubble?.text?.includes(FILE_BLOCK_HEADER) === true, "the stored text is the model prompt");

    await new Promise((r) => setTimeout(r, 800));
    const only = await rpc.call("agents.send", { agentId: SEEDED_AGENT, prompt: "", files: [{ path: mp4, name: "Screen_Recording 1.mp4", bytes: 2048, mediaType: "" }] });
    expect(only.error === undefined, `send only file ${only.error}`);
    const second = await until(() => prompts()[1], "the second prompt");
    expect(textOf(second) === `${FILE_BLOCK_HEADER}\n- ${mp4} (2 KB)`, `files only: ${JSON.stringify(textOf(second))}`);

    const ws = ((await rpc.call("workspaces.list", {})).result as { id: string }[])[0];
    const created = (await rpc.call("agents.create", { workspaceId: ws.id, prompt: "", permissionMode: "default", model: null, effort: null, worktree: null, files: [{ path: mp4, name: "Screen_Recording 1.mp4", bytes: 2048, mediaType: "video/mp4" }] })).result as { id: string; title: string };
    expect(created?.title === "Screen_Recording 1.mp4", `title from the file name: ${created?.title}`);
    const third = await until(() => prompts()[2], "the first prompt of the new session");
    expect(textOf(third) === `${FILE_BLOCK_HEADER}\n- ${mp4} (video/mp4, 2 KB)`, `create: ${JSON.stringify(textOf(third))}`);
    return "ok";
  } finally {
    rpc.close();
    daemon.stop();
    rmSync(media, { recursive: true, force: true });
  }
});

let failed = 0;
for (const c of cases) {
  try {
    console.log(`ok   ${c.name} (${await c.run()})`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${c.name}: ${(error as Error).message}`);
  }
}
console.log(failed ? `${failed} failed` : `${cases.length} passed`);
process.exit(failed ? 1 : 0);
