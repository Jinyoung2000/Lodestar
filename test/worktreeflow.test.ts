import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const gitOps = await import("../server/git");
const flow = await import("../server/worktreeFlow");
const { GhError } = await import("../server/ghExec");

const base = realpathSync(mkdtempSync(join(tmpdir(), "agent-nav-wtflow-")));
const repo = join(base, "repo");
const bare = join(base, "origin.git");
const run = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
};
const rejects = async (work: Promise<unknown>, pattern: RegExp, detail: string) => {
  try {
    await work;
  } catch (error) {
    expect(pattern.test((error as Error).message), `${detail}: ${(error as Error).message}`);
    return;
  }
  throw new Error(`${detail}: 거절돼야 함`);
};

mkdirSync(repo);
run(repo, "init", "-q", "-b", "main");
run(repo, "config", "user.email", "t@example.com");
run(repo, "config", "user.name", "t");
writeFileSync(join(repo, "a.txt"), "a1\n");
writeFileSync(join(repo, "shared.txt"), "line\n");
run(repo, "add", ".");
run(repo, "commit", "-q", "-m", "init");
run(base, "init", "-q", "--bare", "-b", "main", bare);
run(repo, "remote", "add", "origin", bare);
run(repo, "push", "-q", "-u", "origin", "main");

const commitIn = (dir: string, file: string, text: string, message: string) => {
  writeFileSync(join(dir, file), text);
  run(dir, "add", ".");
  run(dir, "commit", "-q", "-m", message);
};

try {
  const problem = (name: string) => gitOps.branchNameProblem(repo, name);
  expect((await problem("feature/한글-작업")) === null, "한글 브랜치 이름은 통과");
  expect((await problem("é/ü")) === null, "비ASCII 문자 통과");
  expect((await problem("feature/ok")) === null, "평범한 이름 통과");
  for (const [name, pattern] of [
    ["my branch", /spaces/],
    ["a..b", /\.\./],
    ["x/", /slash/],
    [".hidden", /dot/],
    ["a.lock", /\.lock/],
    ["-x", /dash/],
    ["a~1", /~/],
    ["@{-1}", /@\{/],
    ["main", /already exists/],
  ] as const) expect(pattern.test((await problem(name)) ?? ""), `${name} 의 문제 문구: ${await problem(name)}`);

  const korean = await gitOps.addWorktree(repo, "feature/한글-작업", "main");
  expect(existsSync(korean), "한글 브랜치의 워크트리 폴더");
  expect((await problem("feature/한글-작업"))?.includes("already exists") === true, "만든 뒤에는 이미 있는 이름");
  await rejects(gitOps.addWorktree(repo, "bad name", "main"), /spaces/, "공백 이름은 서버가 거절");

  const ref = (path: string, branch: string, from = "main") => ({ root: path, branch, base: from });
  const kr = ref(korean, "feature/한글-작업");
  expect((await flow.mergeInfo(kr)).blocker?.includes("no commits") === true, "앞선 커밋이 없으면 합칠 것이 없다");
  expect((await flow.unmergedCount(kr)) === 0, "미병합 0");

  commitIn(korean, "k.txt", "k1\n", "korean work");
  expect((await flow.unmergedCount(kr)) === 1, "미병합 1");
  writeFileSync(join(korean, "dirty.txt"), "x");
  expect((await flow.mergeInfo(kr)).blocker?.includes("uncommitted") === true, "워크트리에 커밋 안 된 변경이 있으면 막는다(커밋만 합쳐지므로)");
  rmSync(join(korean, "dirty.txt"));
  const ff = await flow.mergeIntoBase(kr);
  expect(ff.fastForward && ff.target === "main" && ff.commits === 1 && ff.dir === repo, `fast-forward: ${JSON.stringify(ff)}`);
  expect(existsSync(join(repo, "k.txt")) && run(repo, "rev-parse", "main") === run(korean, "rev-parse", "HEAD"), "main 이 워크트리 브랜치로 이동하고 파일이 보인다");
  await rejects(flow.mergeIntoBase(kr), /no commits/, "합친 뒤 다시 합치려 하면 할 것이 없다");

  const wtB = await gitOps.addWorktree(repo, "feature/b", "origin/main");
  commitIn(wtB, "b.txt", "b\n", "feature b");
  commitIn(repo, "main-only.txt", "m\n", "main moves on");
  const merged = await flow.mergeIntoBase(ref(wtB, "feature/b", "origin/main"));
  expect(!merged.fastForward && merged.target === "main", `갈라졌으면 merge 커밋: ${JSON.stringify(merged)}`);
  expect(run(repo, "rev-list", "--parents", "-n", "1", "main").split(" ").length === 3, "merge 커밋은 부모가 둘");
  expect(existsSync(join(repo, "b.txt")) && existsSync(join(repo, "main-only.txt")), "양쪽 파일이 다 있다");

  const wtC = await gitOps.addWorktree(repo, "feature/c", "main");
  commitIn(wtC, "shared.txt", "from c\n", "c edits shared");
  commitIn(repo, "shared.txt", "from main\n", "main edits shared");
  const before = run(repo, "rev-parse", "main");
  await rejects(flow.mergeIntoBase(ref(wtC, "feature/c")), /conflicts in 1 file \(shared\.txt\)/, "충돌은 파일 이름과 함께 중단");
  expect(run(repo, "rev-parse", "main") === before, "충돌 뒤 main 은 그대로");
  expect(run(repo, "status", "--porcelain") === "" && !existsSync(join(repo, ".git", "MERGE_HEAD")), "충돌 뒤 작업 트리는 깨끗하고 merge 중이 아니다");

  const wtD = await gitOps.addWorktree(repo, "feature/d", "main");
  commitIn(wtD, "d.txt", "d\n", "d");
  writeFileSync(join(repo, "a.txt"), "a1\nlocal edit\n");
  await rejects(flow.mergeIntoBase(ref(wtD, "feature/d")), /uncommitted changes on main/, "기준 브랜치 작업 트리가 더러우면 거절");
  run(repo, "checkout", "-q", "--", "a.txt");

  run(repo, "branch", "release", "main");
  const wtE = await gitOps.addWorktree(repo, "feature/e", "release");
  commitIn(wtE, "e.txt", "e\n", "e");
  const noCheckout = await flow.mergeIntoBase(ref(wtE, "feature/e", "release"));
  expect(noCheckout.fastForward && noCheckout.dir === null && run(repo, "rev-parse", "release") === run(wtE, "rev-parse", "HEAD"), "체크아웃 안 된 브랜치는 포인터만 옮긴다");
  commitIn(repo, "after-release.txt", "r\n", "main moves again");
  run(repo, "branch", "-f", "release", "main");
  commitIn(wtE, "e2.txt", "e2\n", "e2");
  run(repo, "update-ref", "refs/heads/release", run(repo, "rev-parse", "main"));
  await rejects(flow.mergeIntoBase(ref(wtE, "feature/e", "release")), /not a fast-forward/, "체크아웃 안 됐고 fast-forward 도 아니면 거절");
  await rejects(flow.mergeIntoBase(ref(wtE, "feature/e", "nope")), /no local branch named nope/, "없는 기준 브랜치");

  const wtF = await gitOps.addWorktree(repo, "feature/pr", "main");
  commitIn(wtF, "pr.txt", "p\n", "pr work");
  const noGh = { gh: async () => Promise.reject(new GhError("gh not installed", "missing")) };
  const plain = await flow.createPullRequest(ref(wtF, "feature/pr"), noGh);
  expect(plain.kind === "pushed" && plain.url === null, `GitHub 가 아니면 push 만: ${JSON.stringify(plain)}`);
  expect(run(bare, "branch", "--list", "feature/pr") !== "", "브랜치가 원격에 올라갔다");
  expect(run(wtF, "rev-parse", "--abbrev-ref", "feature/pr@{upstream}") === "origin/feature/pr", "upstream 이 설정됐다");
  run(repo, "config", "remote.origin.url", "https://github.com/acme/app.git");
  run(repo, "config", `url.${bare}.insteadOf`, "https://github.com/acme/app.git");
  commitIn(wtF, "pr2.txt", "p2\n", "more");
  const withoutGh = await flow.createPullRequest(ref(wtF, "feature/pr"), noGh);
  expect(withoutGh.kind === "pushed" && withoutGh.url === "https://github.com/acme/app/compare/main...feature/pr?expand=1", `gh 가 없으면 비교 URL: ${JSON.stringify(withoutGh)}`);
  let seen: string[] = [];
  const created = await flow.createPullRequest(ref(wtF, "feature/pr"), { gh: async (args) => ((seen = args), "https://github.com/acme/app/pull/7\n") });
  expect(created.kind === "created" && created.url === "https://github.com/acme/app/pull/7", `gh 가 있으면 PR 생성: ${JSON.stringify(created)}`);
  expect(seen.includes("--fill") && !seen.includes("--web") && seen[seen.indexOf("--base") + 1] === "main" && seen[seen.indexOf("--head") + 1] === "feature/pr", `gh 인자(브라우저 없음): ${seen.join(" ")}`);
  const existing = await flow.createPullRequest(ref(wtF, "feature/pr"), { gh: async () => Promise.reject(new GhError("a pull request for branch \"feature/pr\" into branch \"main\" already exists:\nhttps://github.com/acme/app/pull/3", "failed")) });
  expect(existing.kind === "existing" && existing.url === "https://github.com/acme/app/pull/3", "이미 있는 PR 은 그 URL");
  await rejects(flow.createPullRequest(ref(wtF, "feature/pr"), { gh: async () => Promise.reject(new GhError("boom", "failed")) }), /Pushed feature\/pr, but the pull request was not created: boom/, "gh 실패는 push 된 사실과 함께");
  expect(flow.compareUrl("a/b", "main", "feature/한글") === "https://github.com/a/b/compare/main...feature/%ED%95%9C%EA%B8%80?expand=1", "비교 URL 은 브랜치 이름을 인코딩");
  const wtG = await gitOps.addWorktree(repo, "feature/empty", "main");
  await rejects(flow.createPullRequest(ref(wtG, "feature/empty"), noGh), /no commits/, "앞선 커밋이 없으면 PR 을 만들지 않는다");
  run(repo, "remote", "remove", "origin");
  await rejects(flow.createPullRequest(ref(wtF, "feature/pr"), noGh), /no origin remote/, "origin 이 없으면 거절");

  console.log("worktreeflow.test: ok");
} finally {
  rmSync(base, { recursive: true, force: true });
}
