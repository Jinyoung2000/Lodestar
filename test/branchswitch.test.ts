// BRANCH-SWITCH: server/git.ts 의 브랜치 목록과 switchBranch 를 /tmp 임시 저장소로 시험한다. 데몬도 모델도 필요 없다.
// 실행: npm test
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { branches, switchBranch } from "../server/git";

const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
};
const run = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const failure = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
  } catch (error) {
    return (error as Error).message;
  }
  return null;
};

const root = realpathSync(mkdtempSync(join(tmpdir(), "agent-nav-switch-")));
try {
  const origin = join(root, "origin.git");
  const seed = join(root, "seed");
  const work = join(root, "work");
  mkdirSync(origin);
  run(origin, "init", "--bare");
  mkdirSync(seed);
  run(seed, "init");
  writeFileSync(join(seed, "a.txt"), "main\n");
  run(seed, "add", "-A");
  run(seed, "commit", "-m", "main");
  run(seed, "remote", "add", "origin", origin);
  run(seed, "switch", "-c", "feat/remote-only");
  writeFileSync(join(seed, "r.txt"), "remote\n");
  run(seed, "add", "-A");
  run(seed, "commit", "-m", "remote");
  run(seed, "push", "origin", "main", "feat/remote-only");
  run(root, "clone", origin, work);
  run(work, "switch", "-c", "other");
  writeFileSync(join(work, "a.txt"), "other\n");
  run(work, "commit", "-am", "other changes a.txt");
  run(work, "switch", "main");

  // 목록: 로컬과 원격 추적을 나눠 주고 origin/HEAD 는 뺀다
  const list = await branches(work);
  expect(list.current === "main", `current ${list.current}`);
  expect(list.locals.includes("main") && list.locals.includes("other") && !list.locals.includes("feat/remote-only"), `locals ${list.locals}`);
  expect(list.remotes.includes("origin/main") && list.remotes.includes("origin/feat/remote-only") && !list.remotes.some((r) => r.endsWith("/HEAD")), `remotes ${list.remotes}`);

  // 로컬 전환
  await switchBranch(work, "other");
  expect(run(work, "rev-parse", "--abbrev-ref", "HEAD") === "other" && readFileSync(join(work, "a.txt"), "utf8") === "other\n", "local switch");
  await switchBranch(work, "main");

  // 원격 추적 전환: 같은 이름의 로컬 브랜치가 생기고 upstream 이 걸린다
  await switchBranch(work, "origin/feat/remote-only");
  expect(run(work, "rev-parse", "--abbrev-ref", "HEAD") === "feat/remote-only", "remote switch head");
  expect(run(work, "rev-parse", "--abbrev-ref", "@{upstream}") === "origin/feat/remote-only", "upstream");
  const after = await branches(work);
  expect(after.current === "feat/remote-only" && after.locals.includes("feat/remote-only"), "list after remote switch");
  await switchBranch(work, "main");

  // 겹치는 변경: git 이 거절하고 HEAD 와 파일이 그대로다. 오류에는 git 의 문장만 있다
  writeFileSync(join(work, "a.txt"), "dirty\n");
  const refused = await failure(() => switchBranch(work, "other"));
  expect(refused !== null && /would be overwritten/.test(refused) && !refused.startsWith("Command failed"), `dirty refused: ${refused}`);
  expect(run(work, "rev-parse", "--abbrev-ref", "HEAD") === "main" && readFileSync(join(work, "a.txt"), "utf8") === "dirty\n", "nothing changed after refusal");
  expect((await branches(work)).uncommitted === 1, "uncommitted count");
  run(work, "checkout", "--", "a.txt");

  // 겹치지 않는 변경은 git 이 들고 간다
  writeFileSync(join(work, "new.txt"), "untracked\n");
  await switchBranch(work, "other");
  expect(readFileSync(join(work, "new.txt"), "utf8") === "untracked\n", "untracked file carried");
  rmSync(join(work, "new.txt"));
  await switchBranch(work, "main");

  // 다른 worktree 가 쓰는 브랜치도 git 의 문장이 그대로 올라온다
  run(work, "worktree", "add", join(root, "wt"), "other");
  const inUse = await failure(() => switchBranch(work, "other"));
  expect(inUse !== null && /already (checked out|used by worktree)/.test(inUse), `worktree refused: ${inUse}`);
  expect(run(work, "rev-parse", "--abbrev-ref", "HEAD") === "main", "head unchanged after worktree refusal");

  // 이름 검사: '-' 로 시작, 없는 이름, 빈 이름, 옵션처럼 보이는 원격 이름
  for (const bad of ["--detach", "-c", "--orphan=x", "", "no-such-branch", "origin/no-such", "main\n--detach"]) {
    const message = await failure(() => switchBranch(work, bad));
    expect(message !== null, `rejected: ${JSON.stringify(bad)}`);
  }
  expect(run(work, "rev-parse", "--abbrev-ref", "HEAD") === "main", "head unchanged after bad names");
  expect((await failure(() => switchBranch(work, "--detach"))) === "Invalid branch name", "dash message");

  // 저장소가 아닌 폴더
  const plain = join(root, "plain");
  mkdirSync(plain);
  expect((await failure(() => switchBranch(plain, "main"))) !== null, "not a repo");
  expect((await branches(plain)).locals.length === 0, "not a repo list");
  console.log("branchswitch: ok");
} finally {
  rmSync(root, { recursive: true, force: true });
}
