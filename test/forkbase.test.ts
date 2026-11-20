// 갈래 세션의 Session 범위 기준(server/forkBase.ts)을 임시 git 저장소로 확인한다. 데몬도 모델도 필요 없다.
// 실행: npm test
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// forkBase.ts 가 읽는 HOME 은 import 시점에 정해진다.
const home = mkdtempSync(join(tmpdir(), "agent-nav-forkbase-home-"));
process.env.AGENT_NAV_HOME = home;
const { captureForkBase, forkBaseChanges, forkBaseOriginal, hasForkBase, forgetForkBase } = await import("../server/forkBase");
const gitOps = await import("../server/git");
const { defaultChangeScope } = await import("../shared/protocol");

const repo = realpathSync(mkdtempSync(join(tmpdir(), "agent-nav-forkbase-repo-")));
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" }).toString().trim();
git("init", "-q", "-b", "main");
git("config", "user.email", "t@example.com");
git("config", "user.name", "t");
mkdirSync(join(repo, "src"));
for (const [name, text] of [["a.ts", "a1\n"], ["b.ts", "b1\n"], ["c.ts", "c1\n"]]) writeFileSync(join(repo, "src", name), text);
git("add", ".");
git("commit", "-q", "-m", "init");

const file = (name: string) => join(repo, "src", name);
const agent = { id: "fork-1", cwd: repo, worktree: null, startCommit: null, feedbackId: null, workspaceId: "w1" } as never;
const store = { changes: () => [], change: () => undefined } as never;
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
};
const names = async () => (await forkBaseChanges(agent)).files.map((f) => `${f.status}:${f.rel}`).join(" ");

try {
  // 갈래 직전의 작업 폴더: a.ts 는 사람이나 원 세션이 고친 상태, d.ts 는 아직 커밋하지 않은 새 파일
  writeFileSync(file("a.ts"), "a1\na2\n");
  writeFileSync(file("d.ts"), "d1\n");
  expect((await captureForkBase(agent, store, "source-1")) === true, "HEAD 가 있으면 기준을 남긴다");
  expect(hasForkBase("fork-1"), "기준 파일이 있다");
  expect((await names()) === "", `갈래 직후는 변경이 없어야 함: ${await names()}`);
  expect((await gitOps.changes(repo, "HEAD")).files.length === 2, "Uncommitted(HEAD 대비)는 그대로 두 파일");

  // 갈래 안에서: a.ts 한 줄 추가, b.ts 수정, e.ts 새 파일, c.ts 삭제
  writeFileSync(file("a.ts"), "a1\na2\na3\n");
  writeFileSync(file("b.ts"), "b1\nb2\n");
  writeFileSync(file("e.ts"), "e1\n");
  unlinkSync(file("c.ts"));
  expect((await names()) === "M:src/a.ts M:src/b.ts D:src/c.ts A:src/e.ts", `갈래 안 변경만: ${await names()}`);
  const by = Object.fromEntries((await forkBaseChanges(agent)).files.map((f) => [f.rel, f]));
  expect(by["src/a.ts"].additions === 1 && by["src/a.ts"].deletions === 0, "a.ts 는 갈래 시점 대비 1줄 추가(HEAD 대비 2줄이 아님)");
  expect((await forkBaseOriginal(agent, file("a.ts"))) === "a1\na2\n", "a.ts 기준은 갈래 시점 내용");
  expect((await forkBaseOriginal(agent, file("b.ts"))) === "b1\n", "b.ts 기준은 갈래 시점 HEAD 내용");
  expect((await forkBaseOriginal(agent, file("e.ts"))) === null, "e.ts 는 그때 없던 파일");

  // 갈래 안에서 커밋해도 기준은 갈래 시점의 HEAD 라 목록이 사라지지 않는다
  git("add", ".");
  git("commit", "-q", "-m", "work in the fork");
  expect((await names()) === "M:src/a.ts M:src/b.ts D:src/c.ts A:src/e.ts", `커밋 뒤에도 같은 목록: ${await names()}`);

  // 갈래 시점에 바뀌어 있던 a.ts 를 갈래가 갈래 시점 내용으로 되돌리면 변경 없음, 옛 HEAD 내용으로 되돌리면 변경
  writeFileSync(file("a.ts"), "a1\na2\n");
  expect(!(await names()).includes("a.ts"), "갈래 시점 내용으로 돌아오면 목록에서 빠진다");
  writeFileSync(file("a.ts"), "a1\n");
  expect((await names()).includes("M:src/a.ts"), "갈래 시점에 있던 변경을 되돌리면 그것도 갈래의 변경");

  // 이름 바꾸기는 옛 이름 삭제와 새 이름 추가로 보인다
  renameSync(file("b.ts"), file("b2.ts"));
  expect((await names()).includes("D:src/b.ts") && (await names()).includes("A:src/b2.ts"), `이름 바꾸기: ${await names()}`);

  // 기준을 지우면 갈래가 아닌 세션처럼 빈 목록을 돌려주고 파일도 없다
  await forgetForkBase("fork-1");
  expect(!hasForkBase("fork-1"), "기준 삭제");

  // HEAD 가 없는 폴더에는 기준을 남기지 않는다(수정 직전 스냅샷이 그 폴더의 기준이다)
  const empty = realpathSync(mkdtempSync(join(tmpdir(), "agent-nav-forkbase-empty-")));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: empty });
  expect((await captureForkBase({ ...(agent as object), cwd: empty, id: "fork-2" } as never, store, "source-2")) === false, "커밋 0개 폴더는 기준 없음");
  rmSync(empty, { recursive: true, force: true });

  // 갈래의 기본 범위는 worktree 여부와 상관없이 Session
  expect(defaultChangeScope({ worktree: { root: "/x" }, forkBased: true }) === "session", "worktree 갈래의 기본 범위는 session");
  expect(defaultChangeScope({ worktree: { root: "/x" } }) === "branch", "worktree 세션의 기본 범위는 branch");
  expect(defaultChangeScope({ worktree: null }) === "branch", "worktree 가 아닌 세션도 VS Code 처럼 branch 가 처음 범위");
  expect(defaultChangeScope({ worktree: null, forkBased: true }) === "session", "갈래는 갈래 시점이 기준이라 session");
  console.log("ok   fork base: 갈래 직후 변경 없음, 갈래 안 변경만 보임, 커밋해도 유지, 기준 파일 삭제");
} finally {
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
}
