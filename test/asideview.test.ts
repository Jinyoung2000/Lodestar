// Aside 호출 행의 순수 로직(shared/asideTool.ts, web/asideStep.ts)과 이미지 읽기 허용 범위(server/asideImages.ts) 시험. 실행: npm test
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "agent-nav-asideview-unit-"));
process.env.AGENT_NAV_HOME = join(home, "nav");
mkdirSync(process.env.AGENT_NAV_HOME, { recursive: true });

const { asideImageRefs, withoutImageNotes, isAsideTool } = await import("../shared/asideTool");
const { asideSummary, asideTitle, asideUrl, shortUrl } = await import("../web/asideStep");
const { asideImageAllowed, readAsideImage, saveAsideShots } = await import("../server/asideImages");

const cases: { name: string; run: () => Promise<void> | void }[] = [];
const test = (name: string, run: () => Promise<void> | void) => cases.push({ name, run });
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
};
const same = (actual: unknown, wanted: unknown) => expect(JSON.stringify(actual) === JSON.stringify(wanted), `got ${JSON.stringify(actual)}, wanted ${JSON.stringify(wanted)}`);

const SAVED = "Displayed image saved to: /Users/me/.aside/u/0/sessions/2026-10-16_X/tmp/repl-display-abc.png [image/png]";
const SIZE = "[Image: original 2880x1800, displayed at 2000x1250. Multiply coordinates by 1.44 to map to original image.]";
const SOURCE = "[Image: source: /Users/me/.claude/projects/-Users-me-Repository-app/7ff2629e/tool-results/mcp-aside-blob-1792142798567-bk5rpp.png]";

test("도구 이름", () => {
  expect(isAsideTool("mcp__aside__repl") && !isAsideTool("mcp__browser__read_page") && !isAsideTool("Bash"), "name");
});

test("제목: title, 없으면 코드 첫 줄(주석 제외), 둘 다 없으면 빈 글", () => {
  expect(asideTitle({ title: "  Probe   bridge state ", code: "x" }) === "Probe bridge state", "title trimmed");
  expect(asideTitle({ code: "// note\n  await pa.click('a');\nmore" }) === "await pa.click('a');", "first code line");
  expect(asideTitle({ title: "   ", code: "" }) === "" && asideTitle({}) === "", "empty");
  expect(asideTitle({ code: "x".repeat(300) }).length === 120, "code line capped");
});

test("주소: 결과의 첫 주소(괄호와 [url=] 안), 없으면 코드가 여는 주소", () => {
  expect(asideUrl("✔︎ Opened a new tab: tabs[0], page → X (http://127.0.0.1:5199/checkin/?a=1&b=2)\nX", null) === "http://127.0.0.1:5199/checkin/?a=1&b=2", "paren");
  expect(asideUrl('- title: "Models" [url=https://p.example.net/models]', null) === "https://p.example.net/models", "bracket");
  expect(asideUrl("no url here", "const pa = await openTab('https://a.example/x');") === "https://a.example/x", "from code");
  expect(asideUrl("nothing", "await pa.click('a')") === null, "none");
  expect(asideUrl(`${SAVED}\n${SOURCE}`, null) === null, "image note lines are not urls");
  expect(shortUrl("https://a.example/path/") === "a.example/path" && shortUrl("http://127.0.0.1:5199/a") === "127.0.0.1:5199/a", "short");
});

test("이미지 경로: saved 와 source 한 쌍은 한 장의 후보, 낱줄은 각각 한 장", () => {
  same(asideImageRefs(`|4443\n${SAVED}\n${SIZE}\n\n${SOURCE}`), [["/Users/me/.aside/u/0/sessions/2026-10-16_X/tmp/repl-display-abc.png", "/Users/me/.claude/projects/-Users-me-Repository-app/7ff2629e/tool-results/mcp-aside-blob-1792142798567-bk5rpp.png"]]);
  same(asideImageRefs(`${SAVED}\n${SAVED.replace("abc", "def")}`).length, 2);
  same(asideImageRefs(SOURCE).length, 1);
  same(asideImageRefs("log: Displayed image saved to: /x.png (inline text)"), []);
  same(asideImageRefs(null), []);
  same(asideImageRefs("Displayed image saved to: /a/b.jpeg [image/jpeg]"), [["/a/b.jpeg"]]);
});

test("이미지 안내 줄은 결과 글에서 빠진다", () => {
  same(withoutImageNotes(`|4443\n${SAVED}\n${SIZE}\n\n${SOURCE}`), "|4443");
  same(withoutImageNotes(`${SAVED}\n${SIZE}\n\n${SOURCE}`), "");
});

test("요약: 정상 결과의 첫 줄, [system] 경고 줄과 ✔︎ 는 건너뛴다", () => {
  const s = asideSummary({ input: { title: "Open", code: "await openTab('http://x.test/a')" }, output: "[system][warning] DO NOT USE tree.slice()\n\n✔︎ Opened a new tab and set it active", status: "done" });
  expect(s.state === "ok" && s.preview === "Opened a new tab and set it active" && s.url === "http://x.test/a" && s.title === "Open", JSON.stringify(s));
});

test("요약: 미리보기는 주소만 있는 줄을 건너뛰고 줄 안의 같은 주소 표기를 뗀다", () => {
  const a = asideSummary({ input: {}, output: '✔︎ Opened a new tab: tabs[0], page → X (http://h.test/a?b=1)\nX', status: "done" });
  expect(a.preview === "Opened a new tab: tabs[0], page → X", a.preview);
  const b = asideSummary({ input: {}, output: 'https://p.example/models\n- title: "Models" [url=https://p.example/models]\n- button "x" [ref=e1]', status: "done" });
  expect(b.preview === '- title: "Models"', b.preview);
  expect(asideSummary({ input: {}, output: "https://p.example/only", status: "done" }).preview === "", "url-only output leaves the preview empty (the url is shown next to the title)");
});

test("요약: 오류는 state error 와 오류 첫 줄(겹친 Error: 접두어 제거)", () => {
  const s = asideSummary({ input: { title: "T" }, output: "Error: Error: External modules are not available in the REPL.\n    at x", status: "error" });
  expect(s.state === "error" && s.preview === "External modules are not available in the REPL.", JSON.stringify(s));
  expect(asideSummary({ input: {}, output: "No browser window is open for account u0", status: "error" }).preview === "No browser window is open for account u0", "plain error");
});

test("요약: 출력 없음, 이미지만 있는 출력, 진행 중", () => {
  expect(asideSummary({ input: {}, output: "(mcp__aside__repl completed with no output)", status: "done" }).state === "empty", "no output");
  expect(asideSummary({ input: {}, output: null, status: "done" }).state === "empty", "null output");
  const img = asideSummary({ input: {}, output: `${SAVED}\n${SIZE}\n\n${SOURCE}`, status: "done" });
  expect(img.state === "ok" && img.images.length === 1 && img.text === "" && img.preview === "", JSON.stringify(img));
  const run = asideSummary({ input: { code: "await openTab('https://a.example')" }, output: null, status: "running" });
  expect(run.state === "running" && run.url === "https://a.example", JSON.stringify(run));
});

test("요약: 저장된 shots 가 있으면 결과 글의 경로 대신 쓴다", () => {
  const s = asideSummary({ input: {}, output: `${SAVED}\n${SOURCE}`, status: "done", shots: ["/d/tool-shots/a.png", "/d/tool-shots/b.jpg"] });
  same(s.images, [["/d/tool-shots/a.png"], ["/d/tool-shots/b.jpg"]]);
});

test("요약: 긴 결과는 long", () => {
  const lines = Array.from({ length: 60 }, (_, i) => `- button "Item ${i}" [ref=e${i}]`).join("\n");
  const s = asideSummary({ input: {}, output: `https://p.example/models\n${lines}`, status: "done" });
  expect(s.long && s.textLines === 61 && s.url === "https://p.example/models", JSON.stringify({ long: s.long, lines: s.textLines }));
  expect(!asideSummary({ input: {}, output: "a\nb\nc", status: "done" }).long, "short is not long");
});

const HOME = process.env.AGENT_NAV_HOME as string;
test("이미지 읽기 허용 범위: 정해진 폴더의 이미지 파일만", () => {
  const h = "/Users/x";
  const ok = (p: string) => asideImageAllowed(p, h, "/data") !== null;
  expect(ok("/Users/x/.aside/u/0/sessions/2026-10-16_ab/tmp/repl-display-Ab1.png"), "aside tmp png");
  expect(asideImageAllowed("/Users/x/.aside/u/0/sessions/s/tmp/repl-display-a.jpeg", h, "/data") === "image/jpeg", "jpeg mime");
  expect(ok("/Users/x/.claude/projects/-Users-x-Repo/7ff2/tool-results/mcp-aside-blob-1792-bk5.jpg"), "claude blob");
  expect(ok("/data/tool-shots/lq3-ab12.png"), "tool-shots");
  expect(!ok("/Users/x/.aside/u/0/sessions/s/tmp/repl-display-a.txt"), "ext");
  expect(!ok("/Users/x/.aside/u/0/sessions/s/tmp/other.png"), "name");
  expect(!ok("/Users/x/.ssh/id_rsa.png") && !ok("/etc/passwd") && !ok("/Users/x/Documents/a.png"), "elsewhere");
  expect(!ok("/Users/x/.aside/u/0/sessions/../../../.ssh/tmp/repl-display-a.png"), "dotdot");
  expect(!ok("/Users/x/.aside/u/0/sessions/s/tmp/repl-display-a.png\0.txt"), "nul");
  expect(!ok("/Users/x/.claude/projects/a/b/c/tool-results/mcp-aside-blob-1.png"), "extra depth");
});

test("이미지 읽기: 후보를 앞에서부터, 심볼릭 링크와 빈 파일과 없는 파일은 건너뛴다", async () => {
  const tmp = join(home, "asideroot");
  const dir = join(tmp, ".aside", "u", "0", "sessions", "s1", "tmp");
  mkdirSync(dir, { recursive: true });
  const real = join(dir, "repl-display-real.png");
  writeFileSync(real, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
  writeFileSync(join(dir, "repl-display-empty.png"), "");
  symlinkSync("/etc/hosts", join(dir, "repl-display-link.png"));
  const got = await readAsideImage([join(dir, "repl-display-missing.png"), join(dir, "repl-display-empty.png"), join(dir, "repl-display-link.png"), real], tmp, "/data");
  expect(got?.mime === "image/png" && got.data === Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]).toString("base64"), JSON.stringify(got));
  expect((await readAsideImage([join(dir, "repl-display-link.png"), "/etc/hosts"], tmp, "/data")) === null, "symlink and outside path only");
  expect((await readAsideImage("nope", tmp, "/data")) === null && (await readAsideImage([42, null], tmp, "/data")) === null, "bad params");
});

test("결과의 이미지 조각 저장: 형식은 앞 바이트로 확인하고 오래된 것은 지운다", async () => {
  const dir = join(home, "shots");
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)]);
  const part = (b: Buffer, media = "image/png") => ({ type: "image", source: { type: "base64", media_type: media, data: b.toString("base64") } });
  const paths = await saveAsideShots([{ type: "text", text: "hi" }, part(png), part(jpg, "image/jpeg"), part(Buffer.from("not an image at all!!"))], dir, 200);
  expect(paths.length === 2 && paths[0].endsWith(".png") && paths[1].endsWith(".jpg"), JSON.stringify(paths));
  const again = await saveAsideShots([part(png), part(png)], dir, 3);
  const { readdirSync } = await import("node:fs");
  expect(again.length === 2 && readdirSync(dir).length === 3, `kept ${readdirSync(dir).length}`);
  expect((await saveAsideShots("text", dir)).length === 0 && (await saveAsideShots(undefined, dir)).length === 0, "non-array");
});

let failed = 0;
for (const c of cases) {
  try {
    await c.run();
    console.log(`ok   ${c.name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${c.name}: ${(error as Error).message}`);
  }
}
console.log(failed ? `${failed} failed` : `${cases.length} passed`);
process.exit(failed ? 1 : 0);
