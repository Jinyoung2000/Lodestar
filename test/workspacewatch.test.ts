import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { createWorkspaceWatch, ignoredPath } = await import("../server/workspaceWatch");
const gitOps = await import("../server/git");

const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

for (const rel of [".git/objects/ab/cdef", ".git/index.lock", ".git/logs/HEAD", ".git/refs/heads/main.lock", "node_modules/x/index.js", "src/node_modules/y.js", "a.swp", "src/.DS_Store"]) expect(ignoredPath(rel), `${rel} 은 무시`);
for (const rel of [".git/rebase-merge/git-rebase-todo", ".git/rebase-apply/patch"]) expect(ignoredPath(rel), `${rel} 은 무시`);
for (const rel of [".git/MERGE_HEAD", ".git/rebase-merge", ".git/rebase-apply", ".git/REBASE_HEAD", ".git/CHERRY_PICK_HEAD"]) expect(!ignoredPath(rel), `${rel} 은 알린다`);
for (const rel of [".git/index", ".git/HEAD", ".git/refs/heads/main", "src/a.ts", "README.md", ".github/workflows/ci.yml"]) expect(!ignoredPath(rel), `${rel} 은 알린다`);

const repo = realpathSync(mkdtempSync(join(tmpdir(), "agent-nav-watch-")));
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" }).toString().trim();
git("init", "-q", "-b", "main");
git("config", "user.email", "t@example.com");
git("config", "user.name", "t");
writeFileSync(join(repo, "a.txt"), "a\n");
git("add", ".");
git("commit", "-q", "-m", "init");
mkdirSync(join(repo, "node_modules"));

const fired: string[] = [];
const watch = createWorkspaceWatch((dir) => fired.push(dir), { debounceMs: 150, minGapMs: 500 });
const clientA = {};
const clientB = {};

try {
  watch.setClient(clientA, [repo]);
  watch.setClient(clientB, [repo]);
  expect(watch.watchedDirs().length === 1, "두 연결이 같은 저장소를 봐도 감시는 하나");
  await sleep(300);

  writeFileSync(join(repo, "outside.txt"), "x\n");
  await sleep(600);
  expect(fired.length === 1 && fired[0] === repo, `파일 하나: 알림 ${fired.length}번`);

  const quiet = fired.length;
  writeFileSync(join(repo, "node_modules", "pkg.js"), "x\n");
  await sleep(700);
  expect(fired.length === quiet, `node_modules 쓰기는 알리지 않는다: ${fired.length - quiet}번`);

  const before = watch.stats();
  mkdirSync(join(repo, "burst"));
  const startedAt = Date.now();
  for (let i = 0; i < 200; i++) writeFileSync(join(repo, "burst", `f${i}.txt`), `${i}\n`);
  const wroteMs = Date.now() - startedAt;
  await sleep(1500);
  const after = watch.stats();
  const burstEvents = after.events - before.events;
  const burstEmits = after.emits - before.emits;
  expect(burstEmits >= 1 && burstEmits <= 3, `200개 파일: 알림 ${burstEmits}번(이벤트 ${burstEvents}개)`);
  const statusMs = await (async () => {
    const t = Date.now();
    await gitOps.git(repo, ["status", "--porcelain"]);
    return Date.now() - t;
  })();
  console.log(`workspacewatch cost: 200 files written in ${wroteMs}ms -> ${burstEvents} fs events, ${burstEmits} notifications; one git status with 200 untracked files ${statusMs}ms`);

  const staged = fired.length;
  git("add", "outside.txt");
  await sleep(800);
  expect(fired.length > staged, "git add 도 알린다");

  await sleep(600);
  const settled = fired.length;
  for (let i = 0; i < 3; i++) await gitOps.git(repo, ["status", "--porcelain"]);
  await sleep(900);
  expect(fired.length === settled, `git status 만 돌렸을 때 알림 ${fired.length - settled}번`);

  const linkedDir = realpathSync(mkdtempSync(join(tmpdir(), "agent-nav-watch-wt-")));
  rmSync(linkedDir, { recursive: true });
  git("worktree", "add", "-q", "-b", "wt-one", linkedDir);
  const linkedGit = await gitOps.linkedGitDir(linkedDir);
  expect((await gitOps.linkedGitDir(repo)) === null && linkedGit !== null, `연결된 worktree 만 git 폴더를 따로 돌려준다: ${linkedGit}`);
  const clientC = {};
  const watchedBefore = watch.watchedDirs().length;
  watch.setClient(clientC, [linkedDir], { [linkedDir]: linkedGit as string });
  expect(watch.watchedDirs().length === watchedBefore + 2, "worktree 는 폴더와 git 폴더 둘을 본다");
  await sleep(300);
  const linkedBefore = fired.filter((d) => d === linkedDir).length;
  execFileSync("git", ["switch", "-q", "-c", "wt-two"], { cwd: linkedDir, stdio: "pipe" });
  await sleep(800);
  expect(fired.filter((d) => d === linkedDir).length === linkedBefore + 1, `worktree 의 git switch -c 를 worktree 이름으로 한 번 알린다: ${fired.filter((d) => d === linkedDir).length - linkedBefore}번`);
  watch.setClient(clientC, []);
  expect(watch.watchedDirs().length === watchedBefore, "worktree 감시를 둘 다 닫는다");
  git("worktree", "remove", "--force", linkedDir);

  watch.dropClient(clientA);
  expect(watch.watchedDirs().length === 1, "다른 연결이 남아 있으면 감시 유지");
  watch.setClient(clientB, []);
  expect(watch.watchedDirs().length === 0, "보는 폴더가 없으면 감시를 닫는다");
  const closed = fired.length;
  writeFileSync(join(repo, "after-close.txt"), "x\n");
  await sleep(700);
  expect(fired.length === closed, "닫은 뒤에는 알리지 않는다");

  watch.setClient(clientA, [join(repo, "no-such-dir")]);
  expect(watch.watchedDirs().length === 0, "없는 폴더는 감시하지 않는다");
  console.log("workspacewatch.test: ok");
} finally {
  watch.closeAll();
  rmSync(repo, { recursive: true, force: true });
}
