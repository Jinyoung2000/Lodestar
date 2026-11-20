// 에디터 저장과 새 파일 만들기(server/files.ts). 포맷은 test/format.test.ts.
// 데몬도 모델도 필요 없다.
// 실행: npm test
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceEntry, listEmptyDirs, readWorkspaceFileWithStat, saveWorkspaceFile } from "../server/files";

const cases: { name: string; run: () => Promise<string> | string }[] = [];
const test = (name: string, run: () => Promise<string> | string) => cases.push({ name, run });
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
  return detail;
};
const fails = async (run: () => Promise<unknown>, pattern: RegExp) => {
  try {
    await run();
  } catch (error) {
    return pattern.test((error as Error).message);
  }
  return false;
};

const base = realpathSync(mkdtempSync(join(tmpdir(), "agent-nav-filesave-")));
const repo = join(base, "repo");
mkdirSync(join(repo, "src"), { recursive: true });
writeFileSync(join(repo, "src/a.ts"), "export const a = 1;\n");
execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });

test("새 파일은 만들어지고, 이미 있으면 덮어쓰지 않고 오류", async () => {
  const made = await createWorkspaceEntry(repo, "src/new.ts", "file", "x\n");
  expect(typeof made.mtimeMs === "number" && readFileSync(join(repo, "src/new.ts"), "utf8") === "x\n", "created");
  expect(await fails(() => createWorkspaceEntry(repo, "src/new.ts", "file", "OVERWRITE"), /already exists/), "second create fails");
  expect(readFileSync(join(repo, "src/new.ts"), "utf8") === "x\n", "content untouched");
  expect(await fails(() => createWorkspaceEntry(repo, "src", "folder"), /already exists/), "folder over existing folder");
  return "ok";
});

test("아래 폴더가 없으면 함께 만들고, 폴더도 만든다", async () => {
  await createWorkspaceEntry(repo, "deep/er/file.ts", "file");
  expect(existsSync(join(repo, "deep/er/file.ts")), "nested file");
  await createWorkspaceEntry(repo, "emptyfolder", "folder");
  expect(existsSync(join(repo, "emptyfolder")), "folder");
  return "ok";
});

test("작업 폴더 밖 경로는 만들기와 저장 모두 거절", async () => {
  for (const path of ["../escape.ts", "/tmp/agent-nav-escape.ts", "src/../../escape.ts", ".."]) {
    expect(await fails(() => createWorkspaceEntry(repo, path, "file"), /outside the workspace|Enter a name/), `create ${path}`);
    expect(await fails(() => saveWorkspaceFile(repo, path, "x", null), /outside the workspace/), `save ${path}`);
  }
  expect(!existsSync(join(base, "escape.ts")), "nothing written");
  return "ok";
});

test("작업 폴더 안 심볼릭 링크로 밖을 가리키는 경로는 거절", async () => {
  const outside = join(base, "outside");
  mkdirSync(outside);
  symlinkSync(outside, join(repo, "linkout"));
  expect(await fails(() => createWorkspaceEntry(repo, "linkout/x.ts", "file"), /outside the workspace/), "create via link");
  expect(await fails(() => saveWorkspaceFile(repo, "linkout/x.ts", "x", null), /outside the workspace/), "save via link");
  expect(!existsSync(join(outside, "x.ts")), "nothing written outside");
  return "ok";
});

test("가리키는 곳이 아직 없는(끊긴) 심볼릭 링크로는 작업 폴더 밖에 파일을 만들지 않는다", async () => {
  symlinkSync(join(base, "made-through-link.txt"), join(repo, "dangling"));
  expect(await fails(() => saveWorkspaceFile(repo, "dangling", "x", null), /outside the workspace/), "save via dangling link");
  expect(!existsSync(join(base, "made-through-link.txt")), "nothing created outside");
  rmSync(join(repo, "dangling"));
  return "ok";
});

test("저장: 읽은 때와 수정 시각이 같으면 저장, 디스크가 바뀌었으면 충돌, force 면 덮어쓴다", async () => {
  const read = await readWorkspaceFileWithStat(repo, "src/a.ts");
  expect(read.text === "export const a = 1;\n" && typeof read.mtimeMs === "number", "read has stat");
  const first = await saveWorkspaceFile(repo, "src/a.ts", "export const a = 2;\n", read.mtimeMs);
  expect(first.saved && readFileSync(join(repo, "src/a.ts"), "utf8") === "export const a = 2;\n", "saved");
  // 다른 프로세스(에이전트)가 같은 파일을 고친 상황
  writeFileSync(join(repo, "src/a.ts"), "export const a = 99; // agent\n");
  const stale = await saveWorkspaceFile(repo, "src/a.ts", "export const a = 3;\n", first.saved ? first.mtimeMs - 1000 : null);
  expect(!stale.saved && stale.conflict === "changed", "conflict reported");
  expect(readFileSync(join(repo, "src/a.ts"), "utf8").includes("agent"), "disk kept on conflict");
  const forced = await saveWorkspaceFile(repo, "src/a.ts", "export const a = 3;\n", first.saved ? first.mtimeMs - 1000 : null, true);
  expect(forced.saved && readFileSync(join(repo, "src/a.ts"), "utf8") === "export const a = 3;\n", "force overwrites");
  return "ok";
});

test("저장: 수정 시각이 달라도 내용이 같으면 충돌이 아니다. 새 파일 저장은 이미 있으면 충돌", async () => {
  writeFileSync(join(repo, "same.ts"), "same\n");
  const same = await saveWorkspaceFile(repo, "same.ts", "same\n", 1);
  expect(same.saved, "same content is not a conflict");
  const exists = await saveWorkspaceFile(repo, "same.ts", "other\n", null);
  expect(!exists.saved && exists.conflict === "exists", "null base on existing file");
  const fresh = await saveWorkspaceFile(repo, "fresh/new.ts", "n\n", null);
  expect(fresh.saved && readFileSync(join(repo, "fresh/new.ts"), "utf8") === "n\n", "new file with parents");
  return "ok";
});

test("빈 폴더 목록: 파일이 없는 폴더만, 파일이 든 새 폴더는 빼고", async () => {
  mkdirSync(join(repo, "src/emptyone"));
  mkdirSync(join(repo, "withfile"));
  writeFileSync(join(repo, "withfile/x.ts"), "x");
  const dirs = await listEmptyDirs(repo);
  expect(dirs.includes("emptyfolder") && dirs.includes("src/emptyone"), `empty dirs listed: ${dirs.join(",")}`);
  expect(!dirs.includes("withfile") && !dirs.includes("src"), "dirs with files are not listed");
  return dirs.join(",");
});

let failed = 0;
for (const c of cases) {
  try {
    console.log(`ok  ${c.name} - ${await c.run()}`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${c.name}\n  ${(error as Error).message}`);
  }
}
rmSync(base, { recursive: true, force: true });
if (failed) process.exit(1);
