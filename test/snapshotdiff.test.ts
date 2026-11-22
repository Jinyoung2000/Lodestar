import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "agent-nav-sd-home-"));
process.env.AGENT_NAV_HOME = home;
const { beginTurn, lastTurnChanges } = await import("../server/lastTurn");
const gitOps = await import("../server/git");

const repo = realpathSync(mkdtempSync(join(tmpdir(), "agent-nav-sd-repo-")));
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" }).toString();
git("init", "-q", "-b", "main");
git("config", "user.email", "t@example.com");
git("config", "user.name", "t");
mkdirSync(join(repo, "src"));
const COUNT = 80;
for (let i = 0; i < COUNT; i++) writeFileSync(join(repo, "src", `f${i}.ts`), `line a ${i}\nline b ${i}\n`);
writeFileSync(join(repo, "src/한글 이름.txt"), "안녕\n");
writeFileSync(join(repo, "src/bin.dat"), Buffer.from([0, 1, 2, 255, 10, 13, 10]));
writeFileSync(join(repo, "src/empty.txt"), "");
git("add", ".");
git("commit", "-q", "-m", "init");

const agent = { id: "agent-sd", cwd: repo, worktree: null, startCommit: null, feedbackId: null } as never;
const store = { changes: () => [], change: () => undefined } as never;
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
};

try {
  for (let i = 0; i < 10; i++) writeFileSync(join(repo, "src", `f${i}.ts`), `line a ${i}\nline b ${i}\nhuman\n`);
  await beginTurn(agent, store);
  for (let i = 0; i < COUNT; i++) writeFileSync(join(repo, "src", `f${i}.ts`), `line a ${i}\nline b ${i}\nhuman\nagent\n`);
  writeFileSync(join(repo, "src/한글 이름.txt"), "안녕\n세상\n");
  writeFileSync(join(repo, "src/empty.txt"), "x\n");
  writeFileSync(join(repo, "src/new.ts"), "new\n");
  rmSync(join(repo, "src/bin.dat"));

  const abs = (name: string) => join(repo, "src", name);
  const names = [...Array.from({ length: COUNT }, (_, i) => `f${i}.ts`), "한글 이름.txt", "bin.dat", "empty.txt", "new.ts", "nope.ts"];
  const paths = names.map(abs);

  let started = performance.now();
  const one = new Map<string, string | null>();
  for (const path of paths) {
    await gitOps.headCommit(repo);
    one.set(path, await gitOps.original(repo, "HEAD", path));
  }
  const oneByOne = performance.now() - started;
  started = performance.now();
  const batch = await gitOps.originals(repo, "HEAD", paths);
  const batched = performance.now() - started;
  for (const path of paths) expect(batch.get(path) === one.get(path), `originals 가 original 과 다름: ${path}: ${JSON.stringify(batch.get(path))} vs ${JSON.stringify(one.get(path))}`);
  expect(batch.get(abs("한글 이름.txt")) === "안녕\n", "한글 파일 이름도 읽어야 함");
  expect(batch.get(abs("empty.txt")) === "", "빈 파일은 빈 문자열");
  expect(batch.get(abs("new.ts")) === null && batch.get(abs("nope.ts")) === null, "기준에 없는 파일은 null");
  expect((await gitOps.originals(repo, "HEAD", ["/elsewhere/x"])).get("/elsewhere/x") === null, "저장소 밖 경로는 null");
  expect((await gitOps.originals(repo, null, [abs("f1.ts")])).get(abs("f1.ts")) === null, "기준이 없으면 null");

  started = performance.now();
  const turn = await lastTurnChanges(agent, store);
  const lastTurn = performance.now() - started;
  const by = Object.fromEntries(turn.files.map((f) => [f.rel, f]));
  expect(turn.files.length === COUNT + 4, `변경 파일 ${COUNT + 4}개여야 함: ${turn.files.length}`);
  expect(by["src/f0.ts"].additions === 1 && by["src/f0.ts"].deletions === 0, "턴 전에 고친 파일은 턴 동안 바뀐 1줄만");
  expect(by["src/f50.ts"].additions === 2, "고치지 않았던 파일은 HEAD 기준 2줄");
  expect(by["src/new.ts"].status === "A" && by["src/bin.dat"].status === "D", "새 파일 A, 지운 파일 D");
  expect(turn.files.every((f, i, all) => i === 0 || all[i - 1].rel.localeCompare(f.rel) <= 0), "경로 순 정렬");
  console.log(`snapshotdiff ok: 파일마다 git show ${Math.round(oneByOne)}ms -> cat-file 한 번 ${Math.round(batched)}ms, lastTurnChanges ${Math.round(lastTurn)}ms`);
} finally {
  rmSync(home, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
}
