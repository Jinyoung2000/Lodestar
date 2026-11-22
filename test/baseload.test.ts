import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "agent-nav-base-home-"));
process.env.AGENT_NAV_HOME = home;
const gitOps = await import("../server/git");
const { resolveInside, resolveReadable, resolveWritable } = await import("../server/files");

const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
};
const rejects = async (run: () => unknown, detail: string) => {
  try {
    await run();
  } catch {
    return;
  }
  throw new Error(detail);
};

const dirs: string[] = [home];
function makeRepo(prefix: string) {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(repo);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" }).toString();
  git("init", "-q", "-b", "develop");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  return { repo, git };
}

try {
  const { repo, git } = makeRepo("agent-nav-base-mono-");
  mkdirSync(join(repo, "webview"));
  mkdirSync(join(repo, "cli"));
  writeFileSync(join(repo, "webview/a.ts"), "a1\na2\n");
  writeFileSync(join(repo, "cli/old.ts"), "keep\n");
  writeFileSync(join(repo, "cli/gone.ts"), "g1\ng2\n");
  writeFileSync(join(repo, "cli/renamed-from.ts"), "r1\nr2\nr3\nr4\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  git("checkout", "-q", "-b", "feat");
  const cwd = join(repo, "webview");
  writeFileSync(join(repo, "cli/new.ts"), "n1\nn2\n");
  git("rm", "-q", "cli/gone.ts");
  git("mv", "cli/renamed-from.ts", "cli/renamed-to.ts");
  writeFileSync(join(repo, "cli/renamed-to.ts"), "r1\nr2\nr3\nr4\nr5\n");
  writeFileSync(join(cwd, "a.ts"), "a1\na2\na3\n");
  git("add", ".");
  git("commit", "-q", "-m", "work");
  writeFileSync(join(cwd, "untracked.ts"), "u\n");

  const base = await gitOps.mergeBase(cwd, "develop");
  expect(!!base, "merge-base 가 있어야 함");
  const changes = await gitOps.changes(cwd, base);
  const by = Object.fromEntries(gitOps.limitToFolder(cwd, changes, true).files.map((f) => [f.rel, f]));
  expect(Object.keys(by).sort().join() === "cli/gone.ts,cli/new.ts,cli/renamed-to.ts,webview/a.ts,webview/untracked.ts", `변경 파일 목록: ${Object.keys(by).join()}`);
  expect(by["cli/new.ts"].outside === true && by["cli/new.ts"].status === "A", "다른 폴더의 추가 파일은 outside 이고 A");
  expect(by["cli/gone.ts"].status === "D" && by["cli/gone.ts"].outside === true, "다른 폴더의 삭제 파일은 D");
  expect(by["webview/a.ts"].outside === undefined, "작업 폴더 안 파일은 outside 가 없다");
  expect(by["webview/untracked.ts"].status === "A" && by["webview/untracked.ts"].outside === undefined, "추적 안 되는 새 파일은 A");
  const renamed = by["cli/renamed-to.ts"];
  expect(renamed.status === "R" && renamed.from === join(repo, "cli/renamed-from.ts"), `이름 바뀜은 옛 경로를 들고 있다: ${JSON.stringify(renamed)}`);

  const folderOnly = gitOps.limitToFolder(cwd, changes, false);
  expect(folderOnly.files.map((f) => f.rel).join() === "webview/a.ts,webview/untracked.ts", `폴더 안 파일만: ${folderOnly.files.map((f) => f.rel).join()}`);
  expect(folderOnly.outsideCount === 3, `폴더 밖 3개(new, gone, renamed-to): ${folderOnly.outsideCount}`);
  const everything = gitOps.limitToFolder(cwd, changes, true);
  expect(everything.files.length === 5 && everything.outsideCount === 3, "includeOutside 면 5개 전부, 밖은 3개");
  expect(gitOps.limitToFolder(repo, changes, false).files.length === 5, "루트가 작업 폴더면 전부 안쪽");

  expect((await gitOps.original(cwd, base, by["cli/new.ts"].path, { strict: true })) === null, "A 파일의 기준은 null(빈 기준)");
  expect((await gitOps.original(cwd, base, by["cli/gone.ts"].path, { strict: true })) === "g1\ng2\n", "D 파일의 기준은 옛 내용");
  expect((await gitOps.original(cwd, base, renamed.from!, { strict: true }))?.startsWith("r1\n") === true, "R 파일의 기준은 옛 이름으로 읽는다");
  expect((await gitOps.original(cwd, base, renamed.path, { strict: true })) === null, "R 의 새 이름으로는 기준이 없다(옛 이름으로 읽어야 한다)");
  await rejects(() => gitOps.original(cwd, "not-a-ref", join(repo, "cli/old.ts"), { strict: true }), "없는 기준 커밋은 오류여야 함");
  expect((await gitOps.original(cwd, "not-a-ref", join(repo, "cli/old.ts"))) === null, "strict 가 아니면 기존처럼 null");
  await rejects(() => gitOps.original(cwd, base, "/etc/hosts", { strict: true }), "저장소 밖 경로는 오류여야 함");

  expect(resolveInside(cwd, join(cwd, "a.ts")) === join(cwd, "a.ts"), "폴더 안은 resolveInside 통과");
  await rejects(() => resolveInside(cwd, join(repo, "cli/new.ts")), "resolveInside 는 여전히 폴더 밖을 거절");
  expect((await resolveReadable(cwd, join(repo, "cli/new.ts"))) === join(repo, "cli/new.ts"), "resolveReadable 은 저장소 안 폴더 밖 파일을 허용");
  expect((await resolveReadable(cwd, "../cli/new.ts")) === join(repo, "cli/new.ts"), "상대 경로 ../cli/new.ts 도 허용");
  await rejects(() => resolveReadable(cwd, "/etc/hosts"), "저장소 밖은 거절");
  await rejects(() => resolveReadable(cwd, "../../etc/hosts"), "저장소를 벗어나는 상대 경로는 거절");
  await rejects(() => resolveWritable(cwd, join(repo, "cli/new.ts")), "쓰기는 폴더 밖을 거절");

  symlinkSync("/etc", join(repo, "cli/etc-link"));
  await rejects(() => resolveReadable(cwd, join(repo, "cli/etc-link/hosts")), "저장소 밖으로 나가는 링크는 거절");

  const plain = realpathSync(mkdtempSync(join(tmpdir(), "agent-nav-base-plain-")));
  dirs.push(plain);
  await rejects(() => resolveReadable(plain, "/etc/hosts"), "git 이 아닌 폴더는 기존 범위");

  const unborn = makeRepo("agent-nav-base-unborn-");
  writeFileSync(join(unborn.repo, "big.ts"), "x\n".repeat(1000));
  expect((await gitOps.defaultBase(unborn.repo)) === null, "커밋 없는 저장소는 기준 브랜치가 없다");
  expect((await gitOps.changes(unborn.repo, null)).files.length === 0, "기준이 없으면 변경 목록은 비어 있다(추적 안 되는 파일을 전부 추가로 세지 않는다)");

  const { pickChanges } = await import("../web/changesState");
  const agent = { id: "a1", worktree: null } as never;
  const gitChanges = { base: "b", files: [], outsideCount: 2 };
  const scopedOn = { scope: "branch" as const, includeOutside: true, base: "b", files: [] };
  expect(pickChanges(agent, "branch", false, undefined, gitChanges) === gitChanges, "기본 범위, 폴더 밖 끔: 기본 목록");
  expect(pickChanges(agent, "branch", true, undefined, gitChanges) === undefined, "폴더 밖 켬: 아직 못 받았으면 undefined(옛 목록을 보이지 않는다)");
  expect(pickChanges(agent, "branch", true, scopedOn, gitChanges) === scopedOn, "폴더 밖 켬: 받은 목록");
  expect(pickChanges(agent, "branch", false, { ...scopedOn, includeOutside: true }, gitChanges) === gitChanges, "끄면 다시 기본 목록");
  expect(pickChanges(agent, "uncommitted", false, scopedOn, gitChanges) === undefined, "다른 범위에 폴더 밖 켠 목록을 쓰지 않는다");

  console.log("baseload.test.ts 통과");
} finally {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
}
