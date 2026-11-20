// Discard Changes 와 Files 트리 Delete 가 파일을 영구 삭제하지 않고 휴지통으로 옮기는지, 이름 바꾸기, 터미널 시작 폴더, 새 세션 화면의 변경 목록(server/files.ts, server/git.ts)을 /tmp 임시 저장소에서 본다.
// 휴지통은 AGENT_NAV_TRASH_DIR 로 임시 폴더를 가리킨다(사용자의 ~/.Trash 는 건드리지 않는다). 데몬도 모델도 필요 없다. 실행: npm test
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renameWorkspaceEntry, terminalDir, trashWorkspaceEntry, writeWorkspaceFile } from "../server/files";
import { changes, headCommit, limitToFolder } from "../server/git";
import { discard } from "../server/scm";

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

const base = realpathSync(mkdtempSync(join(tmpdir(), "agent-nav-filestrash-")));
const trash = join(base, "trash");
process.env.AGENT_NAV_TRASH_DIR = trash;
const repo = join(base, "repo");
mkdirSync(join(repo, "src/lib"), { recursive: true });
writeFileSync(join(repo, "src/lib/a.ts"), "export const a = 1;\n");
writeFileSync(join(repo, "src/keep.ts"), "keep\n");
const git = (...args: string[]) => execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd: repo, stdio: "pipe" }).toString();
git("init", "-q", "-b", "main");
git("add", ".");
git("commit", "-q", "-m", "init");

const inTrash = () => (existsSync(trash) ? readdirSync(trash).sort() : []);

test("files.write 의 text null(새 파일 되돌리기)은 영구 삭제가 아니라 휴지통 이동이고, 내용이 그대로 남는다", async () => {
  writeFileSync(join(repo, "src/new.ts"), "agent wrote this\n");
  await writeWorkspaceFile(repo, "src/new.ts", null);
  expect(!existsSync(join(repo, "src/new.ts")), "gone from the folder");
  expect(readFileSync(join(trash, "new.ts"), "utf8") === "agent wrote this\n", "content kept in the Trash");
  return inTrash().join();
});

test("같은 이름이 휴지통에 있으면 덮어쓰지 않고 이름 2 로 비킨다", async () => {
  writeFileSync(join(repo, "src/new.ts"), "second\n");
  await writeWorkspaceFile(repo, "src/new.ts", null);
  expect(readFileSync(join(trash, "new.ts"), "utf8") === "agent wrote this\n" && readFileSync(join(trash, "new 2.ts"), "utf8") === "second\n", "both copies kept");
  return inTrash().join();
});

test("새 파일을 치운 뒤 비게 된 폴더는 거두고, 다른 파일이 있는 폴더는 남긴다", async () => {
  mkdirSync(join(repo, "only/deep"), { recursive: true });
  writeFileSync(join(repo, "only/deep/x.ts"), "x\n");
  await writeWorkspaceFile(repo, "only/deep/x.ts", null);
  expect(!existsSync(join(repo, "only")), "emptied folders pruned up to the workspace root");
  writeFileSync(join(repo, "src/lib/b.ts"), "b\n");
  await writeWorkspaceFile(repo, "src/lib/b.ts", null);
  expect(existsSync(join(repo, "src/lib/a.ts")) && existsSync(join(repo, "src")), "folder with other files stays");
  expect(existsSync(repo), "workspace root stays");
  return "ok";
});

test("없는 파일을 되돌려도 오류 없이 지나간다", async () => {
  await writeWorkspaceFile(repo, "src/never-existed.ts", null);
  return "ok";
});

test("text 가 있으면 그 내용으로 쓴다(추적 파일을 기준 내용으로 되돌리는 길)", async () => {
  await writeWorkspaceFile(repo, "src/keep.ts", "restored\n");
  return expect(readFileSync(join(repo, "src/keep.ts"), "utf8") === "restored\n", "written");
});

test("Source Control 의 discard: 추적 파일은 되돌리고, 새 파일은 휴지통으로(영구 삭제 없음)", async () => {
  writeFileSync(join(repo, "src/keep.ts"), "edited\n");
  writeFileSync(join(repo, "src/fresh.ts"), "fresh content\n");
  const before = inTrash();
  const result = await discard(repo, ["src/keep.ts", "src/fresh.ts"]);
  expect(result.restored === 1 && result.trashed === 1, JSON.stringify(result));
  expect(readFileSync(join(repo, "src/keep.ts"), "utf8") === "keep\n", "tracked file restored from git");
  expect(!existsSync(join(repo, "src/fresh.ts")) && readFileSync(join(trash, "fresh.ts"), "utf8") === "fresh content\n", "new file in the Trash");
  expect(inTrash().length === before.length + 1, "exactly one more item in the Trash");
  return inTrash().join();
});

test("Files 트리 Delete: 파일과 폴더(안의 파일 포함)가 통째로 휴지통으로 가고, 없는 항목과 작업 폴더 자체는 거절", async () => {
  mkdirSync(join(repo, "dir/inner"), { recursive: true });
  writeFileSync(join(repo, "dir/inner/f.txt"), "inner\n");
  writeFileSync(join(repo, "single.txt"), "single\n");
  await trashWorkspaceEntry(repo, "single.txt");
  expect(!existsSync(join(repo, "single.txt")) && readFileSync(join(trash, "single.txt"), "utf8") === "single\n", "file");
  await trashWorkspaceEntry(repo, "dir");
  expect(!existsSync(join(repo, "dir")) && readFileSync(join(trash, "dir/inner/f.txt"), "utf8") === "inner\n", "folder with contents");
  expect(await fails(() => trashWorkspaceEntry(repo, "nope.txt"), /No file or folder/), "missing");
  expect(await fails(() => trashWorkspaceEntry(repo, "."), /outside the workspace|Cannot write/), "root refused");
  expect(await fails(() => trashWorkspaceEntry(repo, "../escape.txt"), /outside the workspace|Cannot write/), "outside refused");
  expect(existsSync(repo), "workspace root still there");
  return inTrash().join();
});

test("작업 폴더 밖을 가리키는 심볼릭 링크 경로는 Delete 도 거절", async () => {
  const outside = join(base, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "secret.txt"), "s\n");
  symlinkSync(outside, join(repo, "linkout"));
  expect(await fails(() => trashWorkspaceEntry(repo, "linkout/secret.txt"), /outside the workspace|Cannot write/), "through link refused");
  expect(readFileSync(join(outside, "secret.txt"), "utf8") === "s\n", "outside file untouched");
  rmSync(join(repo, "linkout"));
  return "ok";
});

test("files.write 는 작업 폴더 밖을 가리키는 심볼릭 링크를 따라 쓰거나 치우지 않고, 링크 자체는 휴지통으로 옮긴다", async () => {
  const outside = join(base, "outside2");
  mkdirSync(outside);
  writeFileSync(join(outside, "victim.txt"), "original\n");
  symlinkSync(join(outside, "victim.txt"), join(repo, "filelink"));
  symlinkSync(outside, join(repo, "dirlink"));
  expect(await fails(() => writeWorkspaceFile(repo, "filelink", "overwritten\n"), /Cannot write outside/), "write through a file link refused");
  expect(await fails(() => writeWorkspaceFile(repo, "dirlink/victim.txt", "overwritten\n"), /Cannot write outside/), "write through a folder link refused");
  expect(await fails(() => writeWorkspaceFile(repo, "dirlink/victim.txt", null), /Cannot write outside/), "trash through a folder link refused");
  expect(readFileSync(join(outside, "victim.txt"), "utf8") === "original\n", "outside file untouched");
  await writeWorkspaceFile(repo, "filelink", null);
  expect(!existsSync(join(repo, "filelink")) && readFileSync(join(outside, "victim.txt"), "utf8") === "original\n", "the link itself moved to the Trash, its target stays");
  rmSync(join(repo, "dirlink"));
  return "ok";
});

test("Rename: 같은 폴더 이름 바꾸기, 폴더 통째로, 새 폴더로 옮기기는 되고 이미 있는 이름은 덮어쓰지 않는다", async () => {
  await renameWorkspaceEntry(repo, "src/keep.ts", "src/kept.ts");
  expect(!existsSync(join(repo, "src/keep.ts")) && readFileSync(join(repo, "src/kept.ts"), "utf8") === "keep\n", "file renamed");
  await renameWorkspaceEntry(repo, "src/lib", "src/core");
  expect(readFileSync(join(repo, "src/core/a.ts"), "utf8") === "export const a = 1;\n", "folder renamed with contents");
  await renameWorkspaceEntry(repo, "src/kept.ts", "moved/deeper/kept.ts");
  expect(existsSync(join(repo, "moved/deeper/kept.ts")), "moved into a new folder");
  writeFileSync(join(repo, "one.txt"), "1\n");
  writeFileSync(join(repo, "two.txt"), "2\n");
  expect(await fails(() => renameWorkspaceEntry(repo, "one.txt", "two.txt"), /already exists/), "collision refused");
  expect(readFileSync(join(repo, "one.txt"), "utf8") === "1\n" && readFileSync(join(repo, "two.txt"), "utf8") === "2\n", "both untouched");
  expect(await fails(() => renameWorkspaceEntry(repo, "ghost.txt", "x.txt"), /No file or folder/), "missing source");
  expect(await fails(() => renameWorkspaceEntry(repo, "one.txt", "../escape.txt"), /Cannot write outside/), "outside destination refused");
  expect(await fails(() => renameWorkspaceEntry(repo, "../outside.txt", "x.txt"), /Cannot write outside/), "outside source refused");
  expect(await fails(() => renameWorkspaceEntry(repo, "one.txt", "  "), /Enter a name/), "blank name");
  await renameWorkspaceEntry(repo, "one.txt", "one.txt");
  return expect(existsSync(join(repo, "one.txt")), "same name is a no-op");
});

test("터미널 시작 폴더: 작업 폴더 안의 실제 폴더만", () => {
  expect(terminalDir(repo, "src/core") === join(repo, "src/core"), "subfolder");
  for (const bad of ["../x", "/etc", "src/missing", "one.txt"]) {
    let refused = false;
    try {
      terminalDir(repo, bad);
    } catch {
      refused = true;
    }
    expect(refused, `refused ${bad}`);
  }
  return "ok";
});

test("새 세션 화면의 Changes: 커밋 안 된 변경(수정, 새 파일, 삭제)을 HEAD 기준 +N -N 과 함께, 폴더 밖 변경은 뺀다", async () => {
  const clean = join(base, "clean");
  mkdirSync(join(clean, "pkg/app"), { recursive: true });
  mkdirSync(join(clean, "pkg/other"), { recursive: true });
  writeFileSync(join(clean, "pkg/app/m.ts"), "one\ntwo\n");
  writeFileSync(join(clean, "pkg/app/gone.ts"), "x\ny\nz\n");
  writeFileSync(join(clean, "pkg/other/o.ts"), "o\n");
  const g = (...args: string[]) => execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd: clean, stdio: "pipe" });
  g("init", "-q", "-b", "main");
  g("add", ".");
  g("commit", "-q", "-m", "init");
  writeFileSync(join(clean, "pkg/app/m.ts"), "one\nTWO\nthree\n");
  writeFileSync(join(clean, "pkg/app/new.ts"), "n1\nn2\n");
  rmSync(join(clean, "pkg/app/gone.ts"));
  writeFileSync(join(clean, "pkg/other/o.ts"), "changed outside the folder\n");
  const folder = join(clean, "pkg/app");
  const head = await headCommit(folder);
  expect(head !== null, "has HEAD");
  const result = limitToFolder(folder, await changes(folder, head ? "HEAD" : null), false);
  const rows = result.files.map((f) => `${f.rel}:${f.status}:+${f.additions}-${f.deletions}`).sort();
  expect(rows.join() === "pkg/app/gone.ts:D:+0-3,pkg/app/m.ts:M:+2-1,pkg/app/new.ts:A:+2-0", rows.join());
  expect(result.outsideCount === 1, `outside count ${result.outsideCount}`);
  return rows.join(" ");
});

test("커밋이 없는 저장소는 HEAD 가 없어 목록이 비어 있다(배지도 없다)", async () => {
  const fresh = join(base, "unborn");
  mkdirSync(fresh);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: fresh });
  writeFileSync(join(fresh, "a.txt"), "a\n");
  const head = await headCommit(fresh);
  expect(head === null, "no HEAD");
  return expect((await changes(fresh, head ? "HEAD" : null)).files.length === 0, "empty");
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
rmSync(base, { recursive: true, force: true });
console.log(failed ? `${failed} failed` : `${cases.length} passed`);
process.exit(failed ? 1 : 0);
