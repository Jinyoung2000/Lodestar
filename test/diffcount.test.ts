import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "agent-nav-diffcount-home-"));
process.env.AGENT_NAV_HOME = home;
const { captureForkBase, forkBaseChanges } = await import("../server/forkBase");
const gitOps = await import("../server/git");
const { countLineChanges } = await import("../shared/lineDiff");

const root = realpathSync(mkdtempSync(join(tmpdir(), "agent-nav-diffcount-")));
const run = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
};
const numstat = (cwd: string, base: string) => {
  const out: Record<string, string> = {};
  for (const line of run(cwd, "diff", "--numstat", "--no-renames", base).split("\n").filter(Boolean)) {
    const [a, d, path] = line.split("\t");
    out[path] = `+${a} -${d}`;
  }
  return out;
};
const shown = (files: { rel: string; additions: number; deletions: number }[]) => Object.fromEntries(files.map((f) => [f.rel, `+${f.additions} -${f.deletions}`]));
const same = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);
const lines = (count: number, tag = "") => Array.from({ length: count }, (_, i) => `line ${i}${tag}`).join("\n") + "\n";

const identity = (cwd: string) => {
  run(cwd, "config", "user.email", "t@example.com");
  run(cwd, "config", "user.name", "t");
};

try {
  const big = lines(3000);
  const scattered = big.split("\n").map((l, i) => (i % 5 === 0 && l ? `${l} edited` : l)).join("\n");
  const c = countLineChanges(big, scattered);
  expect(c.additions === 600 && c.deletions === 600, `흩어진 변경 600/600: ${JSON.stringify(c)}`);
  const eol = countLineChanges("a\nb\n", "a\nb");
  expect(eol.additions === 1 && eol.deletions === 1, `끝 개행만 달라도 git 은 1/1: ${JSON.stringify(eol)}`);
  expect(same(countLineChanges("", "x\ny\n"), { additions: 2, deletions: 0 }), "새 파일");
  expect(same(countLineChanges("x\ny\n", ""), { additions: 0, deletions: 2 }), "삭제");

  const origin = join(root, "origin.git");
  run(root, "init", "-q", "--bare", "-b", "develop", origin);
  const mine = join(root, "mine");
  const theirs = join(root, "theirs");
  run(root, "clone", "-q", origin, mine);
  identity(mine);
  mkdirSync(join(mine, "src"));
  writeFileSync(join(mine, "src", "a.ts"), "a1\na2\n");
  writeFileSync(join(mine, "src", "b.ts"), "b1\n");
  writeFileSync(join(mine, "src", "gen.ts"), big);
  run(mine, "add", ".");
  run(mine, "commit", "-q", "-m", "init");
  run(mine, "push", "-q", "-u", "origin", "develop");
  run(root, "clone", "-q", origin, theirs);
  identity(theirs);

  const start = run(mine, "rev-parse", "HEAD");
  const agent = { id: "diffcount-1", cwd: mine, worktree: null, startCommit: start, feedbackId: null, workspaceId: "w1" } as never;
  const store = { changes: () => [], change: () => undefined } as never;
  expect(await captureForkBase(agent, store, "source-1"), "갈래 기준을 남긴다");

  writeFileSync(join(mine, "src", "a.ts"), "a1\na2\na3\n");
  writeFileSync(join(mine, "src", "b.ts"), "b0\nb1\nb2\n");

  for (let i = 0; i < 20; i++) {
    writeFileSync(join(theirs, `other${i}.ts`), lines(30, `-${i}`));
    if (i === 10) writeFileSync(join(theirs, "src", "gen.ts"), scattered);
    run(theirs, "add", ".");
    run(theirs, "commit", "-q", "-m", `other ${i}`);
  }
  run(theirs, "push", "-q", "origin", "develop");
  run(mine, "pull", "-q", "--ff-only");
  expect(run(mine, "rev-list", "--count", `${start}..HEAD`) === "20", "남의 커밋 20개가 들어왔다");
  expect(Object.keys(numstat(mine, start)).length === 23, `옛 기준이면 23개 파일이 보인다: ${Object.keys(numstat(mine, start)).length}`);

  const base = await gitOps.sessionBase(mine, start);
  expect(base === run(mine, "rev-parse", "HEAD"), "기준이 pull 로 들어온 커밋 끝으로 옮겨간다");
  const expected = numstat(mine, "HEAD");
  const viaGit = shown((await gitOps.changes(mine, base, { renames: false })).files);
  expect(same(viaGit, expected) && Object.keys(viaGit).length === 2, `시작 커밋 기준: 세션 편집 2개와 git 줄 수: ${JSON.stringify(viaGit)}`);
  const viaFork = shown((await forkBaseChanges(agent)).files);
  expect(same(viaFork, expected), `갈래 Session 범위도 같은 값: ${JSON.stringify(viaFork)}`);
  expect(viaFork["src/a.ts"] === "+1 -0" && viaFork["src/b.ts"] === "+2 -0", `줄 수 값: ${JSON.stringify(viaFork)}`);

  run(mine, "add", ".");
  run(mine, "commit", "-q", "-m", "session work");
  writeFileSync(join(mine, "src", "c.ts"), "c1\n");
  const afterCommit = shown((await forkBaseChanges(agent)).files);
  expect(same(afterCommit, { "src/a.ts": "+1 -0", "src/b.ts": "+2 -0", "src/c.ts": "+1 -0" }), `push 전 커밋은 포함: ${JSON.stringify(afterCommit)}`);
  expect(same(shown((await gitOps.changes(mine, await gitOps.sessionBase(mine, start), { renames: false })).files), afterCommit), "시작 커밋 기준 계산도 같다");
  run(mine, "add", ".");
  run(mine, "commit", "-q", "-m", "more");
  run(mine, "push", "-q");
  const afterPush = (await forkBaseChanges(agent)).files;
  expect(afterPush.length === 0, `push 한 커밋은 원격에 있는 것이라 빠진다: ${afterPush.map((f) => f.rel)}`);

  run(mine, "switch", "-q", "-c", "feat/x");
  writeFileSync(join(mine, "feat.ts"), lines(100, "-feat"));
  run(mine, "add", ".");
  run(mine, "commit", "-q", "-m", "feature work");
  const featureStart = run(mine, "rev-parse", "HEAD");
  run(mine, "switch", "-q", "develop");
  for (let i = 0; i < 3; i++) {
    writeFileSync(join(theirs, `late${i}.ts`), lines(10, `-late${i}`));
    run(theirs, "add", ".");
    run(theirs, "commit", "-q", "-m", `late ${i}`);
  }
  run(theirs, "pull", "-q", "--no-rebase");
  run(theirs, "push", "-q", "origin", "develop");
  run(mine, "pull", "-q", "--ff-only");
  const switchedBase = await gitOps.sessionBase(mine, featureStart);
  expect(switchedBase === run(mine, "rev-parse", "HEAD"), "다른 브랜치에서 시작한 세션도 기본 브랜치에서는 HEAD 가 기준");
  expect((await gitOps.changes(mine, switchedBase, { renames: false })).files.length === 0, "기본 브랜치에서 ff pull 한 뒤 깨끗하면 0");
  writeFileSync(join(mine, "src", "a.ts"), "edited by session\n");
  expect(same(shown((await gitOps.changes(mine, switchedBase, { renames: false })).files), { "src/a.ts": "+1 -3" }), "그 뒤 세션이 고친 파일만 보인다");
  run(mine, "checkout", "-q", "--", "src/a.ts");

  run(mine, "switch", "-q", "-c", "feat/y");
  writeFileSync(join(mine, "before.ts"), "before\n");
  run(mine, "add", ".");
  run(mine, "commit", "-q", "-m", "before session");
  const preStart = run(mine, "rev-parse", "HEAD");
  writeFileSync(join(mine, "during.ts"), "during\n");
  run(mine, "add", ".");
  run(mine, "commit", "-q", "-m", "during session");
  expect((await gitOps.sessionBase(mine, preStart)) === preStart, "미push 커밋이 시작 커밋에 들어 있으면 시작 커밋이 기준");
  expect(same(shown((await gitOps.changes(mine, preStart, { renames: false })).files), { "during.ts": "+1 -0" }), "세션이 만든 커밋만");

  const lone = join(root, "lone");
  mkdirSync(lone);
  run(lone, "init", "-q", "-b", "main");
  identity(lone);
  writeFileSync(join(lone, "x.ts"), "x\n");
  run(lone, "add", ".");
  run(lone, "commit", "-q", "-m", "init");
  const loneStart = run(lone, "rev-parse", "HEAD");
  writeFileSync(join(lone, "y.ts"), "y\n");
  run(lone, "add", ".");
  run(lone, "commit", "-q", "-m", "y");
  expect((await gitOps.sessionBase(lone, loneStart)) === loneStart, "원격이 없으면 시작 커밋 그대로");

  console.log("diffcount ok");
} finally {
  execFileSync("rm", ["-rf", root, home]);
}
