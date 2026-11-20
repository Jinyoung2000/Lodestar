// FIX4A: 세션 범위 변경과 Undo 의 장부(server/sessionTouch.ts)를 임시 git 저장소로 확인한다. 데몬도 모델도 필요 없다.
// dogfood 4회차 1번: 대화만 한 세션의 Session 범위가 같은 폴더의 바깥 수정과 커밋을 담고, Undo All 이 그것을 되돌렸다.
// 실행: npm test
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// sessionTouch.ts 와 lastTurn.ts 가 읽는 HOME 은 import 시점에 정해진다.
const home = mkdtempSync(join(tmpdir(), "agent-nav-touch-home-"));
process.env.AGENT_NAV_HOME = home;
const touch = await import("../server/sessionTouch");
const { beginTurn: beginLastTurn } = await import("../server/lastTurn");
const gitOps = await import("../server/git");

const repo = realpathSync(mkdtempSync(join(tmpdir(), "agent-nav-touch-repo-")));
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" }).toString().trim();
git("init", "-q", "-b", "main");
git("config", "user.email", "t@example.com");
git("config", "user.name", "t");
mkdirSync(join(repo, "src"));
for (const [name, text] of [["a.ts", "a1\n"], ["b.ts", "b1\n"], ["clean.ts", "clean1\n"], ["d.ts", "d1\n"]]) writeFileSync(join(repo, "src", name), text);
git("add", ".");
git("commit", "-q", "-m", "init");
const start = git("rev-parse", "HEAD");

const file = (name: string) => join(repo, "src", name);
const write = (name: string, text: string) => writeFileSync(file(name), text);
const read = (name: string) => readFileSync(file(name), "utf8");
let timeline: unknown[] = [];
const store = { changes: () => [], change: () => undefined, timeline: () => timeline } as never;
type Agent = Parameters<typeof touch.ensureLedger>[0];
const session = (id: string, patch: Record<string, unknown> = {}) => ({ id, cwd: repo, worktree: null, startCommit: start, feedbackId: null, workspaceId: "w1", forkBased: undefined, ...patch }) as unknown as Agent;
const A = session("agent-a");
const B = session("agent-b");
const C = session("agent-c");
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
};

// 편집 도구 한 번을 흉내 낸다: PreToolUse 훅, 디스크 쓰기, PostToolUse 훅
async function agentEdit(agent: Agent, name: string, text: string, tool = "Write") {
  const input = { file_path: file(name) };
  await touch.recordBeforeEdit(agent, store, tool, input);
  write(name, text);
  await touch.recordAfterEdit(agent, store, tool, input);
}
const names = async (agent: Agent) => (await touch.touchedChanges(agent, store)).files.map((f) => `${f.status}:${f.rel}`).join(" ");
const undoable = async (agent: Agent, ...paths: string[]) => touch.checkUndo(agent, store, paths.map(file));

try {
  // 같은 폴더에 세션 셋: A 와 B 는 서로 다른 파일을 고치고, C 는 대화만 한다.
  // 사용자가 세션 밖에서 clean.ts 를 고치고 커밋한다(dogfood 의 재현 단계).
  await agentEdit(A, "a.ts", "a1\na2\n");
  await agentEdit(B, "b.ts", "b1\nb2\n");
  write("clean.ts", "clean99 // edited outside\n");
  git("commit", "-q", "-m", "wip: outside commit", "--", "src/clean.ts");
  expect((await names(A)) === "M:src/a.ts", `A 는 자기 파일만: ${await names(A)}`);
  expect((await names(B)) === "M:src/b.ts", `B 는 자기 파일만: ${await names(B)}`);
  expect((await names(C)) === "", `대화만 한 C 는 변경 없음(바깥 수정과 커밋이 섞이지 않는다): ${await names(C)}`);

  // 기준은 그 세션이 처음 만지기 직전 내용이고 폴더 전체 스냅샷이 아니다
  expect((await touch.touchedOriginal(A, store, file("a.ts"))) === "a1\n", "a.ts 기준은 A 가 만지기 직전 내용");
  expect((await touch.touchedOriginal(A, store, file("clean.ts"))) === undefined, "A 가 안 만진 파일은 기준이 없다");
  const a = (await touch.touchedChanges(A, store)).files[0];
  expect(a.additions === 1 && a.deletions === 0 && !a.modifiedSince, `a.ts +1 -0 이고 표시 없음: ${JSON.stringify(a)}`);

  // 세션이 고친 뒤 커밋해도 목록에서 사라지지 않고, 디스크가 에이전트의 마지막 쓰기와 같으니 Undo 는 허용
  git("commit", "-q", "-am", "commit a and b");
  expect((await names(A)) === "M:src/a.ts", "커밋 뒤에도 A 의 목록");
  expect((await undoable(A, "a.ts")).allowed.length === 1, "커밋만 하고 안 고쳤으면 Undo 허용");

  // 에이전트가 고친 뒤 사용자가 다시 고친 파일: 목록에는 남고 표시가 붙고 Undo 는 거부(서버가 막는다)
  write("a.ts", "a1\na2\nuser line\n");
  const touched = (await touch.touchedChanges(A, store)).files[0];
  expect(touched.modifiedSince === true, "사용자가 다시 고친 파일에 modifiedSince");
  const refused = await undoable(A, "a.ts");
  expect(refused.allowed.length === 0 && refused.skipped.length === 1 && refused.skipped[0].reason === "modified", `Undo 거부: ${JSON.stringify(refused)}`);

  // 한 파일을 두 세션이 차례로 고치면 앞 세션의 Undo 는 거부, 뒤 세션은 허용(각자 만진 파일이라 둘 다 목록에 든다)
  await agentEdit(A, "d.ts", "d1\nfrom A\n");
  await agentEdit(B, "d.ts", "d1\nfrom A\nfrom B\n");
  expect((await names(A)).includes("src/d.ts") && (await names(B)).includes("src/d.ts"), "같은 파일은 둘 다 센다");
  expect((await undoable(A, "d.ts")).skipped.length === 1, "A 의 마지막 쓰기 뒤에 B 가 고쳤으니 A 의 Undo 는 거부");
  expect((await undoable(B, "d.ts")).allowed.length === 1, "B 는 자기 마지막 쓰기와 디스크가 같다");
  expect((await touch.touchedOriginal(B, store, file("d.ts"))) === "d1\nfrom A\n", "B 의 기준은 B 가 만지기 직전(A 가 쓴 뒤) 내용");

  // 에이전트가 쓰는 사이 다른 손이 고친 파일 위에 또 쓰면(mixed) Undo 가 그 변경까지 지우게 되니 거부
  await agentEdit(C, "clean.ts", "clean99 // edited outside\nfrom C\n");
  write("clean.ts", "clean99 // edited outside\nfrom C\nuser again\n");
  await agentEdit(C, "clean.ts", "clean99 // edited outside\nfrom C\nuser again\nfrom C 2\n");
  const mixed = await undoable(C, "clean.ts");
  expect(mixed.allowed.length === 0 && mixed.skipped[0].reason === "mixed", `mixed: ${JSON.stringify(mixed)}`);

  // 되돌린 파일은 장부에서 빠지고, 다음에 만지면 그때 내용이 새 기준
  await touch.forgetTouched(B, store, [file("b.ts")]);
  expect(!(await names(B)).includes("src/b.ts"), "되돌린 파일은 B 의 목록에서 빠진다");
  await agentEdit(B, "b.ts", "b1\nb2\nb3\n");
  expect((await touch.touchedOriginal(B, store, file("b.ts"))) === "b1\nb2\n", "다시 만지면 그때 내용이 기준");

  // 시작 때 이미 바뀌어 있던 파일(기존 변경 제외): 세션이 더 고친 줄만 센다
  write("b.ts", "b1\nb2\nb3\nhuman edit\n");
  const E = session("agent-e");
  await agentEdit(E, "b.ts", "b1\nb2\nb3\nhuman edit\nE adds\n");
  const e = (await touch.touchedChanges(E, store)).files[0];
  expect(e.additions === 1 && e.deletions === 0, `기존 변경은 세지 않는다: ${JSON.stringify(e)}`);
  git("commit", "-q", "-am", "snapshot");

  // Bash 귀속: Bash 를 부른 턴이 끝나면 턴 동안 바뀐 파일을 장부에 넣는다
  const F = session("agent-f");
  await beginLastTurn(F, store);
  touch.beginTurn(F);
  touch.noteBash(F.id);
  write("generated.ts", "gen\n");
  write("a.ts", `${read("a.ts")}bash line\n`);
  await touch.endTurn(F, store);
  const f = (await touch.touchedChanges(F, store)).files.map((x) => `${x.status}:${x.rel}`).join(" ");
  expect(f === "M:src/a.ts A:src/generated.ts", `Bash 로 바뀐 파일: ${f}`);
  expect((await touch.touchedOriginal(F, store, file("a.ts"))) === "a1\na2\nuser line\n", "Bash 귀속의 기준은 턴 시작 때 내용");
  expect((await undoable(F, "generated.ts")).allowed.length === 1, "Bash 가 만든 파일은 Undo 허용");

  // Bash 를 안 부른 턴: 폴더의 바깥 변경은 장부에 안 들어온다
  const G = session("agent-g");
  await beginLastTurn(G, store);
  touch.beginTurn(G);
  write("outside.ts", "outside\n");
  await touch.endTurn(G, store);
  expect((await names(G)) === "", "Bash 없는 턴은 귀속이 없다");

  // 다른 세션의 턴이 겹쳤으면 Bash 귀속을 하지 않는다. 편집 도구 기록은 그대로 남는다
  const H = session("agent-h");
  const I = session("agent-i");
  await beginLastTurn(H, store);
  touch.beginTurn(H);
  touch.beginTurn(I);
  touch.noteBash(H.id);
  write("shared-turn.ts", "someone wrote this\n");
  await agentEdit(H, "d.ts", "d1\nfrom A\nfrom B\nH edit\n");
  await touch.endTurn(I, store);
  await touch.endTurn(H, store);
  expect((await names(H)) === "M:src/d.ts", `겹친 턴은 편집 도구 기록만: ${await names(H)}`);

  // Last Turn 은 이 세션이 만진 파일만 남긴다(같은 턴에 다른 손이 바꾼 파일은 빠진다)
  const J = session("agent-j");
  await beginLastTurn(J, store);
  touch.beginTurn(J);
  await agentEdit(J, "a.ts", `${read("a.ts")}J line\n`);
  write("other-hand.ts", "someone else\n");
  const turn = await touch.touchedLastTurn(J, store);
  expect(turn.files.map((x) => x.rel).join(" ") === "src/a.ts", `Last Turn: ${turn.files.map((x) => x.rel)}`);
  await touch.endTurn(J, store);

  // 끝났다는 신호(PostToolUse)를 못 받은 편집은 턴 끝에 마무리된다
  const K = session("agent-k");
  touch.beginTurn(K);
  await touch.recordBeforeEdit(K, store, "Edit", { file_path: file("b.ts") });
  write("b.ts", `${read("b.ts")}K\n`);
  await touch.endTurn(K, store);
  expect((await undoable(K, "b.ts")).allowed.length === 1, "Post 훅이 없어도 턴 끝에 after 가 채워진다");

  // 옛 세션(장부 없음): 타임라인의 편집 도구 호출로 목록을 만들고, 마지막 쓰기를 모르니 Undo 는 거부
  const L = session("agent-l");
  timeline = [{ id: "t1", kind: "tool", name: "Edit", input: { file_path: file("clean.ts") }, status: "done", output: null }];
  const legacy = (await touch.touchedChanges(L, store)).files;
  expect(legacy.length === 1 && legacy[0].rel === "src/clean.ts", `옛 세션의 목록은 타임라인의 편집 경로만: ${JSON.stringify(legacy.map((x) => x.rel))}`);
  expect((await undoable(L, "clean.ts")).skipped[0]?.reason === "unknown", "옛 세션은 마지막 쓰기를 몰라 Undo 를 거부");
  timeline = [];

  // 저장소 밖 파일과 이진 파일은 장부에 넣지 않는다
  const outside = join(tmpdir(), `agent-nav-touch-outside-${process.pid}.txt`);
  writeFileSync(outside, "x");
  expect(!(await touch.recordBeforeEdit(A, store, "Write", { file_path: outside })), "저장소 밖 파일은 기록하지 않는다");
  rmSync(outside, { force: true });
  writeFileSync(file("bin.dat"), Buffer.from([0, 1, 2, 3]));
  expect(!(await touch.recordBeforeEdit(A, store, "Write", { file_path: file("bin.dat") })), "이진 파일은 기록하지 않는다");

  // 장부는 디스크에 저장돼 데몬을 다시 띄워도 남는다
  touch.flushTouchedSync();
  touch.resetTouchedMemory();
  expect((await names(A)).includes("src/a.ts"), "다시 읽은 장부에도 A 의 파일이 있다");
  expect(touch.hasLedger("agent-a"), "장부 파일이 있다");

  // 폴더가 없는 세션, 피드백 세션은 장부를 쓰지 않는다
  expect((await touch.ensureLedger(session("agent-n", { workspaceId: null }), store)) === null, "폴더 없는 세션");
  expect((await touch.ensureLedger(session("agent-o", { feedbackId: "f1" }), store)) === null, "피드백 세션");

  // 삭제된 파일은 D 로 보이고 Undo 로 되돌릴 수 있다
  unlinkSync(file("d.ts"));
  expect((await touch.touchedChanges(B, store)).files.find((x) => x.rel === "src/d.ts")?.status === "D", "지워진 파일은 D");

  expect((await gitOps.changes(repo, "HEAD")).files.length > 0, "Uncommitted 는 폴더 전체 그대로(이 시험은 그 계산을 바꾸지 않았다)");
  console.log("sessiontouch.test: ok");
} finally {
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
}
