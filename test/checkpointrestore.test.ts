import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "agent-nav-restore-home-"));
const trash = mkdtempSync(join(tmpdir(), "agent-nav-restore-trash-"));
process.env.AGENT_NAV_HOME = home;
process.env.AGENT_NAV_TRASH_DIR = trash;
const touch = await import("../server/sessionTouch");
const guard = await import("../server/restoreGuard");
const { beginTurn: beginLastTurn } = await import("../server/lastTurn");

const repo = realpathSync(mkdtempSync(join(tmpdir(), "agent-nav-restore-repo-")));
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" }).toString().trim();
git("init", "-q", "-b", "main");
git("config", "user.email", "t@example.com");
git("config", "user.name", "t");
for (const [name, text] of [["keep.txt", "keep0\n"], ["mid.txt", "mid0\n"], ["mix.txt", "mix0\n"], ["c.txt", "c0\n"]]) writeFileSync(join(repo, name), text);
git("add", ".");
git("commit", "-q", "-m", "init");
const start = git("rev-parse", "HEAD");

const file = (name: string) => join(repo, name);
const read = (name: string) => readFileSync(file(name), "utf8");
let timeline: unknown[] = [];
const store = { changes: () => [], change: () => undefined, timeline: () => timeline } as never;
type Agent = Parameters<typeof touch.ensureLedger>[0];
const session = (id: string) => ({ id, cwd: repo, worktree: null, startCommit: start, feedbackId: null, workspaceId: "w1", forkBased: undefined }) as unknown as Agent;
const A = session("agent-a");
const B = session("agent-b");
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
};
const trashed = () => readdirSync(trash).sort();
const clearTrash = () => {
  for (const name of readdirSync(trash)) rmSync(join(trash, name), { force: true });
};

async function agentEdit(agent: Agent, name: string, text: string) {
  const input = { file_path: file(name) };
  await touch.recordBeforeEdit(agent, store, "Write", input);
  writeFileSync(file(name), text);
  await touch.recordAfterEdit(agent, store, "Write", input);
}

const fakeRewind = (checkpoint: Record<string, string | null>) => async () => {
  for (const [name, text] of Object.entries(checkpoint)) {
    if (text === null) {
      if (existsSync(file(name))) unlinkSync(file(name));
    } else writeFileSync(file(name), text);
  }
};

try {
  await agentEdit(A, "human-edit.txt", "agent line\n");
  await agentEdit(A, "agent-only.txt", "agent only\n");
  writeFileSync(file("human-edit.txt"), "agent line\nHUMAN LINE (uncommitted, written after the agent)\n");
  const plan1 = await touch.planRestore(A, store, [file("human-edit.txt"), file("agent-only.txt")], []);
  expect(plan1.skip.length === 1 && plan1.skip[0].rel === "human-edit.txt" && plan1.skip[0].reason === "modified", `사람이 고친 새 파일은 건너뜀: ${JSON.stringify(plan1)}`);
  expect(plan1.remove.length === 1 && plan1.remove[0].rel === "agent-only.txt" && plan1.revert.length === 0, `안 고친 새 파일은 휴지통: ${JSON.stringify(plan1)}`);
  const humanBytes = readFileSync(file("human-edit.txt"));
  const { trashed: moved } = await guard.applyRestore(plan1, fakeRewind({ "human-edit.txt": null, "agent-only.txt": null }));
  expect(readFileSync(file("human-edit.txt")).equals(humanBytes), "건너뛴 파일은 복원 전과 바이트가 같다(SDK 가 지웠어도 되살린다)");
  expect(!existsSync(file("agent-only.txt")) && moved.length === 1, "에이전트가 새로 만든 파일은 작업 폴더에서 사라진다");
  expect(trashed().join() === "agent-only.txt" && readFileSync(join(trash, "agent-only.txt"), "utf8") === "agent only\n", `휴지통에 내용이 있다: ${trashed()}`);
  clearTrash();

  await agentEdit(A, "keep.txt", "keep0\nagent adds\n");
  await agentEdit(A, "new.txt", "new file\n");
  await agentEdit(A, "mix.txt", "mix0\nagent adds\n");
  writeFileSync(file("mix.txt"), "mix0\nagent adds\nHUMAN\n");
  const changed = [file("keep.txt"), file("new.txt"), file("mix.txt")];
  const plan2 = await touch.planRestore(A, store, changed, []);
  expect(plan2.revert.map((f) => f.rel).join() === "keep.txt", `되돌릴 파일: ${JSON.stringify(plan2.revert)}`);
  expect(plan2.remove.map((f) => f.rel).join() === "new.txt", `지울 파일: ${JSON.stringify(plan2.remove)}`);
  expect(plan2.skip.map((f) => f.rel).join() === "mix.txt", `건너뛸 파일: ${JSON.stringify(plan2.skip)}`);
  await guard.applyRestore(plan2, fakeRewind({ "keep.txt": "keep0\n", "new.txt": null, "mix.txt": "mix0\n" }));
  expect(read("keep.txt") === "keep0\n", "안 고친 파일은 체크포인트 내용으로");
  expect(!existsSync(file("new.txt")) && trashed().join() === "new.txt", "새 파일은 휴지통");
  expect(read("mix.txt") === "mix0\nagent adds\nHUMAN\n", "사람이 고친 파일은 그대로");
  clearTrash();

  const before = await touch.checkUndo(A, store, [file("keep.txt")]);
  expect(before.skipped.length === 1, "맞추기 전에는 디스크가 장부와 달라 건너뛴다(대조군)");
  await touch.syncAfterRestore(A, store, [file("keep.txt"), file("new.txt")]);
  expect((await touch.checkUndo(A, store, [file("keep.txt")])).allowed.length === 1, "맞춘 뒤에는 에이전트의 쓰기로 본다");
  await agentEdit(A, "keep.txt", "keep0\nsecond try\n");
  expect((await touch.checkUndo(A, store, [file("keep.txt")])).allowed.length === 1, "복원 뒤 다시 편집해도 mixed 가 아니다");

  const keptTimeline = [
    { id: "u1", kind: "user", text: "turn 1", source: "user" },
    { id: "t1", kind: "tool", name: "Write", input: { file_path: file("early.txt") } },
  ];
  await agentEdit(B, "early.txt", "early v1\n");
  await agentEdit(B, "early.txt", "early v2\n");
  await agentEdit(B, "late.txt", "late\n");
  const plan3 = await touch.planRestore(B, store, [file("early.txt"), file("late.txt")], keptTimeline as never);
  expect(plan3.revert.map((f) => f.rel).join() === "early.txt", `앞 턴에서 만든 파일은 되돌림: ${JSON.stringify(plan3)}`);
  expect(plan3.remove.map((f) => f.rel).join() === "late.txt", `뒤 턴에서 처음 만든 파일은 지움: ${JSON.stringify(plan3)}`);
  const plan3b = await touch.planRestore(B, store, [file("early.txt"), file("late.txt")], []);
  expect(plan3b.remove.length === 2, "체크포인트 앞에 만진 호출이 없으면 둘 다 그 뒤에 만든 파일(Start Over)");
  await guard.applyRestore(plan3, fakeRewind({ "early.txt": "early v1\n", "late.txt": null }));
  await touch.syncAfterRestore(B, store, [file("early.txt"), file("late.txt")]);
  expect(read("early.txt") === "early v1\n" && !existsSync(file("late.txt")), "중간 복원 결과");
  expect((await touch.checkUndo(B, store, [file("early.txt")])).allowed.length === 1, "복원 뒤에도 Undo 와 다음 복원이 허용된다");
  clearTrash();

  writeFileSync(file("stranger.txt"), "nobody recorded this\n");
  const plan4 = await touch.planRestore(A, store, [file("stranger.txt")], []);
  expect(plan4.skip.length === 1 && plan4.skip[0].reason === "unknown", `장부에 없는 파일: ${JSON.stringify(plan4)}`);
  rmSync(file("stranger.txt"));

  await agentEdit(A, "c.txt", "c0\nagent\n");
  writeFileSync(file("c.txt"), "c0\nagent\nhuman wrote\n");
  const plan5 = await touch.planRestore(A, store, [file("c.txt")], []);
  let thrown = false;
  await guard
    .applyRestore(plan5, async () => {
      writeFileSync(file("c.txt"), "clobbered\n");
      throw new Error("rewind failed");
    })
    .catch(() => (thrown = true));
  expect(thrown && read("c.txt") === "c0\nagent\nhuman wrote\n", "실패해도 건너뛸 파일은 복원 전 내용");

  writeFileSync(file("r1.txt"), "after restore\n");
  writeFileSync(file("r2.txt"), "after restore 2\n");
  const restoredHash = await guard.hashesOf([file("r1.txt"), file("r2.txt"), file("r3.txt")]);
  writeFileSync(file("r2.txt"), "after restore 2\nhuman edited after the restore\n");
  writeFileSync(file("r3.txt"), "should have been absent\n");
  restoredHash[file("r3.txt")] = (await guard.hashesOf([file("r3.txt")]))[file("r3.txt")];
  const files = { [file("r1.txt")]: Buffer.from("agent v\n").toString("base64"), [file("r2.txt")]: Buffer.from("agent v2\n").toString("base64"), [file("r3.txt")]: null };
  const redone = await guard.redoFiles(A, files, restoredHash);
  expect(read("r1.txt") === "agent v\n", "안 고친 파일은 다시 쓴다");
  expect(read("r2.txt").includes("human edited") && redone.skipped.length === 1 && redone.skipped[0].rel === "r2.txt", `복원 뒤 고친 파일은 건너뛴다: ${JSON.stringify(redone.skipped)}`);
  expect(!existsSync(file("r3.txt")) && trashed().join() === "r3.txt", "복원 전에 없던 파일은 휴지통으로");
  clearTrash();
  const legacy = await guard.redoFiles(A, { [file("r2.txt")]: Buffer.from("legacy\n").toString("base64") }, undefined);
  expect(legacy.written.length === 1 && read("r2.txt") === "legacy\n", "복원 해시가 없는 옛 기록은 그대로 다시 쓴다");

  const S1 = session("agent-s1");
  const S2 = session("agent-s2");
  timeline = [{ id: "u9", kind: "user", text: "make the generated file\nand more", source: "user" }];
  await beginLastTurn(S1, store);
  touch.beginTurn(S1);
  touch.beginTurn(S2);
  touch.noteBash(S1.id);
  writeFileSync(file("generated.txt"), "gen\n");
  await touch.endTurn(S1, store);
  const noted = await touch.touchedChanges(S1, store);
  expect(noted.files.length === 0, "귀속 규칙은 그대로: 겹친 턴의 Bash 변경은 세션 목록에 넣지 않는다");
  expect(noted.shellNote?.turns.length === 1 && noted.shellNote.turns[0].title === "make the generated file", `세지 못한 턴 기록: ${JSON.stringify(noted.shellNote)}`);
  await touch.endTurn(S2, store);
  git("add", "-A");
  git("commit", "-q", "-m", "snapshot");
  const S3 = session("agent-s3");
  const S4 = session("agent-s4");
  await beginLastTurn(S3, store);
  touch.beginTurn(S3);
  touch.beginTurn(S4);
  touch.noteBash(S3.id);
  await touch.endTurn(S3, store);
  expect((await touch.touchedChanges(S3, store)).shellNote === undefined, "겹쳤어도 바뀐 파일이 없으면 안내하지 않는다");
  await touch.endTurn(S4, store);
  const S5 = session("agent-s5");
  await beginLastTurn(S5, store);
  touch.beginTurn(S5);
  touch.noteBash(S5.id);
  writeFileSync(file("solo.txt"), "solo\n");
  await touch.endTurn(S5, store);
  const solo = await touch.touchedChanges(S5, store);
  expect(solo.files.map((f) => f.rel).join() === "solo.txt" && solo.shellNote === undefined, `혼자 돌린 턴은 귀속: ${JSON.stringify(solo)}`);
  touch.flushTouchedSync();
  touch.resetTouchedMemory();
  expect((await touch.touchedChanges(S1, store)).shellNote?.turns.length === 1, "다시 읽은 장부에도 세지 못한 턴이 있다");

  console.log("checkpointrestore.test: ok");
} finally {
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(trash, { recursive: true, force: true });
}
