import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "agent-nav-b4-home-"));
process.env.AGENT_NAV_HOME = home;
const { beginTurn, lastTurnChanges, lastTurnOriginal } = await import("../server/lastTurn");
const gitOps = await import("../server/git");

const repo = realpathSync(mkdtempSync(join(tmpdir(), "agent-nav-b4-repo-")));
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" }).toString();
git("init", "-q", "-b", "main");
git("config", "user.email", "t@example.com");
git("config", "user.name", "t");
mkdirSync(join(repo, "src"));
writeFileSync(join(repo, "src/a.ts"), "one\ntwo\n");
writeFileSync(join(repo, "src/b.ts"), "b1\n");
git("add", ".");
git("commit", "-q", "-m", "init");

const agent = { id: "agent-1", cwd: repo, worktree: null, startCommit: null, feedbackId: null } as never;
const store = { changes: () => [], change: () => undefined } as never;
const fail = (detail: string) => {
  throw new Error(detail);
};
const expect = (condition: boolean, detail: string) => {
  if (!condition) fail(detail);
};

try {
  writeFileSync(join(repo, "src/a.ts"), "one\ntwo\nthree\n");
  await beginTurn(agent, store);
  writeFileSync(join(repo, "src/a.ts"), "one\ntwo\nthree\nfour\n");
  writeFileSync(join(repo, "src/b.ts"), "b1\nb2\n");
  writeFileSync(join(repo, "src/c.ts"), "c\n");

  const turn = await lastTurnChanges(agent, store);
  const by = Object.fromEntries(turn.files.map((f) => [f.rel, f]));
  expect(turn.files.length === 3, `턴 변경 파일 3개여야 함: ${JSON.stringify(turn.files)}`);
  expect(by["src/a.ts"].additions === 1 && by["src/a.ts"].deletions === 0, "a.ts 는 턴 시작 이후 1줄만 추가로 보여야 함(HEAD 대비 2줄이 아님)");
  expect(by["src/b.ts"].status === "M" && by["src/b.ts"].additions === 1, "b.ts 는 HEAD 가 기준");
  expect(by["src/c.ts"].status === "A", "c.ts 는 새 파일");
  expect((await lastTurnOriginal(agent, store, join(repo, "src/a.ts"))) === "one\ntwo\nthree\n", "a.ts 기준은 턴 시작 때 내용");
  expect((await lastTurnOriginal(agent, store, join(repo, "src/b.ts"))) === "b1\n", "b.ts 기준은 HEAD 내용");
  expect((await lastTurnOriginal(agent, store, join(repo, "src/c.ts"))) === null, "c.ts 는 기준이 없다");

  const uncommitted = await gitOps.changes(repo, "HEAD");
  const a = uncommitted.files.find((f) => f.rel === "src/a.ts");
  expect(a?.additions === 2, "Uncommitted 의 a.ts 는 HEAD 대비 2줄 추가");

  await beginTurn(agent, store);
  expect((await lastTurnChanges(agent, store)).files.length === 0, "새 턴이 시작되면 Last Turn 은 비어야 함");
  writeFileSync(join(repo, "src/b.ts"), "b1\nb2\nb3\n");
  const turn2 = await lastTurnChanges(agent, store);
  expect(turn2.files.length === 1 && turn2.files[0].rel === "src/b.ts" && turn2.files[0].additions === 1, "턴 2 는 b.ts 1줄만");

  writeFileSync(join(repo, "src/b.ts"), "b1\nb2\n");
  expect((await lastTurnChanges(agent, store)).files.length === 0, "턴 시작 내용으로 되돌리면 빠져야 함");

  const none = await lastTurnChanges({ ...(agent as object), id: "agent-none" } as never, store);
  expect(none.base === null && none.files.length === 0, "턴 기록이 없으면 base null, 빈 목록");

  console.log("changes scope: 모든 확인 통과");
} finally {
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
}
