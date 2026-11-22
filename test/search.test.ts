import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveBrowserShot } from "../server/browserShot";
import { findRipgrep, globVariants, parseGitGrep, parseRipgrepJson, searchWorkspace, splitPatterns, withContext } from "../server/search";
import { highlightPattern, matchColumn, searchSummary } from "../web/searchText";

const cases: { name: string; run: () => string | Promise<string> }[] = [];
const test = (name: string, run: () => string | Promise<string>) => cases.push({ name, run });
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
  return detail;
};

test("rg --json 해석: match 사건만, ./ 접두를 떼고 줄 끝 개행을 뺀다", () => {
  const out = [
    JSON.stringify({ type: "begin", data: { path: { text: "./src/a.ts" } } }),
    JSON.stringify({ type: "match", data: { path: { text: "./src/a.ts" }, line_number: 3, lines: { text: "export const a = 1;\n" } } }),
    JSON.stringify({ type: "match", data: { path: { text: "./src/b.ts" }, line_number: 1, lines: { text: "export x\r\n" } } }),
    JSON.stringify({ type: "summary", data: {} }),
    "not json",
  ].join("\n");
  const { hits, truncated } = parseRipgrepJson(out);
  expect(!truncated && hits.length === 2, `hits ${hits.length}`);
  expect(hits[0].path === "src/a.ts" && hits[0].line === 3 && hits[0].text === "export const a = 1;", JSON.stringify(hits[0]));
  expect(hits[1].text === "export x", "CRLF");
  return "ok";
});

test("git grep -z 해석: 경로 NUL 줄번호 NUL 본문, 본문에 콜론이 있어도 그대로", () => {
  const out = "src/a.ts\0abc\0x\nsrc/a.ts\x002\0const a: number = 1;\nweird name.ts\x0010\0a:b:c\n";
  const { hits } = parseGitGrep(out);
  expect(hits.length === 2, `hits ${hits.length}`);
  expect(hits[0].path === "src/a.ts" && hits[0].line === 2 && hits[0].text === "const a: number = 1;", JSON.stringify(hits[0]));
  expect(hits[1].path === "weird name.ts" && hits[1].text === "a:b:c", JSON.stringify(hits[1]));
  return "ok";
});

test("앞뒤 줄: 겹치면 한 번만 나오고 일치한 줄에 표시, 파일은 경로순", async () => {
  const dir = mkdtempSync(join(tmpdir(), "an-search-"));
  try {
    writeFileSync(join(dir, "b.txt"), "one\ntwo\nthree\nfour\nfive\nsix\nseven\n");
    writeFileSync(join(dir, "a.txt"), "x\nneedle\ny\n");
    const files = await withContext(dir, [{ path: "b.txt", line: 2, text: "two" }, { path: "b.txt", line: 4, text: "four" }, { path: "b.txt", line: 7, text: "seven" }, { path: "a.txt", line: 2, text: "needle" }], 1);
    expect(files.map((f) => f.path).join() === "a.txt,b.txt", "경로순");
    const b = files[1].rows.map((r) => `${r.line}${r.match ? "*" : ""}`).join(" ");
    expect(b === "1 2* 3 4* 5 6 7*", b);
    const none = await withContext(dir, [{ path: "b.txt", line: 2, text: "two" }], 0);
    expect(none[0].rows.length === 1 && none[0].rows[0].match, "context 0");
    return "ok";
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("실제 저장소 검색: 옵션(대소문자, 낱말, 정규식), 새 파일, .gitignore, 오류", async () => {
  const dir = mkdtempSync(join(tmpdir(), "an-search-repo-"));
  try {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
    git("init", "-q");
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "a.ts"), "export const Alpha = 1;\nconst alphabet = 2;\nexport const alpha = 3;\n");
    writeFileSync(join(dir, ".gitignore"), "ignored.ts\n");
    writeFileSync(join(dir, "ignored.ts"), "alpha hidden\n");
    git("add", "-A");
    git("-c", "user.email=a@a", "-c", "user.name=a", "commit", "-qm", "init");
    writeFileSync(join(dir, "src", "new.ts"), "// alpha in an untracked file\n");
    const base = { query: "alpha", matchCase: false, wholeWord: false, regex: false, context: 0 };
    const lines = async (o: Partial<typeof base>) => {
      const r = await searchWorkspace(dir, { ...base, ...o });
      return `${r.files.map((f) => `${f.path}:${f.rows.filter((x) => x.match).map((x) => x.line).join(",")}`).join(" ")} (${r.engine})`;
    };
    const rg = await findRipgrep();
    const engine = rg ? "rg" : "git";
    expect((await lines({})) === `src/a.ts:1,2,3 src/new.ts:1 (${engine})`, await lines({}));
    expect((await lines({ matchCase: true })).startsWith("src/a.ts:2,3 src/new.ts:1"), await lines({ matchCase: true }));
    expect((await lines({ wholeWord: true })).startsWith("src/a.ts:1,3 src/new.ts:1"), await lines({ wholeWord: true }));
    expect((await lines({ query: "al(pha|phabet) =", regex: true })).startsWith("src/a.ts:1,2,3"), await lines({ query: "al(pha|phabet) =", regex: true }));
    expect((await lines({ query: "a.pha" })).startsWith(" ") || (await lines({ query: "a.pha" })).startsWith("("), "정규식 아님");
    expect((await searchWorkspace(dir, { ...base, query: "   " })).matches === 0, "빈 검색어");
    let message = "";
    await searchWorkspace(dir, { ...base, query: "(unclosed", regex: true }).catch((e: Error) => (message = e.message));
    expect(message.length > 0, "잘못된 정규식은 오류 문구");
    const ctx = await searchWorkspace(dir, { ...base, query: "alphabet", context: 1 });
    expect(ctx.files[0].rows.map((r) => r.line).join() === "1,2,3", `context ${JSON.stringify(ctx.files[0].rows)}`);
    return `엔진 ${engine}`;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rg 엔진: 같은 저장소에서 git grep 과 같은 일치 줄", async () => {
  const claude = join(process.env.HOME ?? "", ".local", "bin", "claude");
  const real = await findRipgrep();
  if (!real && !existsSync(claude)) return "건너뜀: rg 도 대체 실행 파일도 없음";
  const dir = mkdtempSync(join(tmpdir(), "an-search-rg-"));
  try {
    let bin = real;
    if (!bin) {
      bin = join(dir, "rg-shim");
      writeFileSync(bin, `#!/bin/sh\nARGV0=rg exec "${claude}" "$@"\n`, { mode: 0o755 });
    }
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "a.ts"), "export const Alpha = 1;\nconst alphabet = 2;\nexport const alpha = 3;\n");
    writeFileSync(join(dir, "src", "b.ts"), "nothing\n");
    const ask = (rgBin: string | null, extra: object = {}) => searchWorkspace(dir, { query: "alpha", matchCase: false, wholeWord: false, regex: false, context: 1, ...extra }, rgBin);
    const viaRg = await ask(bin);
    const viaGit = await ask(null);
    expect(viaRg.engine === "rg" && viaGit.engine === "git", "엔진 이름");
    expect(JSON.stringify(viaRg.files) === JSON.stringify(viaGit.files), `${JSON.stringify(viaRg.files)} 대 ${JSON.stringify(viaGit.files)}`);
    expect(JSON.stringify((await ask(bin, { matchCase: true, wholeWord: true })).files.map((f) => f.rows.filter((r) => r.match).map((r) => r.line))) === "[[3]]", "옵션");
    let message = "";
    await ask(bin, { query: "(x", regex: true }).catch((e: Error) => (message = e.message));
    expect(message.length > 0, "정규식 오류");
    return real ? "rg" : "Claude 실행 파일로 대체";
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("git 이 아닌 폴더도 검색된다(git grep --no-index)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "an-search-nogit-"));
  try {
    writeFileSync(join(dir, "note.txt"), "hello world\n");
    const r = await searchWorkspace(dir, { query: "hello", matchCase: false, wholeWord: false, regex: false, context: 0 });
    expect(r.matches === 1 && r.files[0].path === "note.txt", JSON.stringify(r.files));
    return "ok";
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("스크린샷 저장: PNG 만, 상한을 넘기면 오래된 것부터 지운다", async () => {
  const dir = mkdtempSync(join(tmpdir(), "an-shots-"));
  try {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("data")]);
    const saved = await saveBrowserShot(png.toString("base64"), dir);
    expect(existsSync(saved.path) && readFileSync(saved.path).equals(png), "저장");
    let refused = "";
    await saveBrowserShot(Buffer.from("not a png").toString("base64"), dir).catch((e: Error) => (refused = e.message));
    expect(refused.includes("PNG"), "PNG 아님은 거절");
    for (let i = 0; i < 45; i++) await saveBrowserShot(png.toString("base64"), dir);
    expect(readdirSync(dir).length === 40, `남은 ${readdirSync(dir).length}`);
    return "ok";
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("files to include, files to exclude: 패턴을 glob 로 풀고 두 엔진이 같은 결과를 낸다", async () => {
  expect(JSON.stringify(globVariants("*.ts")) === JSON.stringify(["**/*.ts", "**/*.ts/**"]), "이름만 있는 패턴은 어느 깊이에서든");
  expect(JSON.stringify(globVariants("./src/")) === JSON.stringify(["src", "src/**"]), "경로 패턴은 작업 폴더 기준");
  expect(JSON.stringify(globVariants("./src")) === JSON.stringify(["src", "src/**"]) && JSON.stringify(globVariants("src")) === JSON.stringify(["**/src", "**/src/**"]), "R4FIX: ./ 로 시작하면 슬래시가 없어도 작업 폴더 기준(Find in Folder)");
  expect(splitPatterns(" *.md , docs ,, ").length === 4 && splitPatterns("").length === 0 && splitPatterns(undefined).length === 0, "쉼표로 나눔과 빈 항목");
  const dir = mkdtempSync(join(tmpdir(), "an-globs-"));
  try {
    mkdirSync(join(dir, "src"));
    mkdirSync(join(dir, "docs"));
    writeFileSync(join(dir, "src", "a.ts"), "needle in ts\n");
    writeFileSync(join(dir, "src", "b.md"), "needle in md\n");
    writeFileSync(join(dir, "docs", "c.md"), "needle in docs\n");
    execFileSync("git", ["init", "-q"], { cwd: dir });
    const base = { query: "needle", matchCase: false, wholeWord: false, regex: false, context: 0 };
    const paths = async (extra: object, rg: string | null) => (await searchWorkspace(dir, { ...base, ...extra }, rg)).files.map((f) => f.path).join();
    let rg = await findRipgrep();
    const claude = join(process.env.HOME ?? "", ".local", "bin", "claude");
    if (!rg && existsSync(claude)) {
      rg = join(dir, "rg-shim");
      writeFileSync(rg, `#!/bin/sh\nARGV0=rg exec "${claude}" "$@"\n`, { mode: 0o755 });
    }
    const engines: (string | null)[] = rg ? [null, rg] : [null];
    for (const engine of engines) {
      const name = engine ? "rg" : "git grep";
      expect((await paths({}, engine)) === "docs/c.md,src/a.ts,src/b.md", `${name}: 제한 없음 ${await paths({}, engine)}`);
      expect((await paths({ include: "*.md" }, engine)) === "docs/c.md,src/b.md", `${name}: include *.md ${await paths({ include: "*.md" }, engine)}`);
      expect((await paths({ include: "src" }, engine)) === "src/a.ts,src/b.md", `${name}: include 폴더 ${await paths({ include: "src" }, engine)}`);
      expect((await paths({ exclude: "docs" }, engine)) === "src/a.ts,src/b.md", `${name}: exclude 폴더 ${await paths({ exclude: "docs" }, engine)}`);
      expect((await paths({ include: "*.md", exclude: "docs" }, engine)) === "src/b.md", `${name}: 둘 다 ${await paths({ include: "*.md", exclude: "docs" }, engine)}`);
      expect((await paths({ include: "src/a.ts" }, engine)) === "src/a.ts", `${name}: 경로 하나 ${await paths({ include: "src/a.ts" }, engine)}`);
    }
    return `ok (${engines.length} 엔진)`;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("표시: 일치 표시 정규식, 첫 일치 열, 요약 줄", () => {
  const plain = highlightPattern("a.b", { matchCase: false, wholeWord: false, regex: false });
  expect(!!plain && plain.test("xA.By") && !new RegExp(plain.source, "i").test("xaXby"), "정규식이 아니면 글자 그대로");
  expect(highlightPattern("(", { matchCase: false, wholeWord: false, regex: true }) === null, "잘못된 정규식");
  expect(highlightPattern("", { matchCase: false, wholeWord: false, regex: false }) === null, "빈 검색어");
  const word = highlightPattern("cat", { matchCase: true, wholeWord: true, regex: false });
  expect(matchColumn("concat cat", word) === 8 && matchColumn("none", word) === 1, "낱말 열");
  expect(searchSummary(1, 1, false) === "1 result - 1 file" && searchSummary(12, 3, false) === "12 results - 3 files" && searchSummary(2000, 5, true).includes("first matches"), "요약");
  return "ok";
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
