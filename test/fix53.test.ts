import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "agent-nav-fix53-"));
process.env.AGENT_NAV_HOME = join(home, "nav");
mkdirSync(process.env.AGENT_NAV_HOME, { recursive: true });
const { orderFolders, isDefaultView, DEFAULT_VIEW } = await import("../web/sessionList");
const { pickAnchor, restoredScrollTop } = await import("../web/chatAnchor");
const { worktreeMenuState } = await import("../web/worktreeMenu");
const { sanitizeExtras } = await import("../web/windowState");
const { Store } = await import("../server/store");
type Agent = import("../shared/protocol").Agent;
type Workspace = import("../shared/protocol").Workspace;

const cases: { name: string; run: () => string | Promise<string> }[] = [];
const test = (name: string, run: () => string | Promise<string>) => cases.push({ name, run });
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
  return detail;
};

const ws = (id: string, name: string): Workspace => ({ id, name, dir: `/${name}`, parentId: null });
const session = (workspaceId: string, updatedAt: string): Agent => ({ id: `${workspaceId}-${updatedAt}`, workspaceId, cwd: "/x", worktree: null, forkedFrom: null, resumeFrom: null, startCommit: null, feedbackId: null, title: "t", sessionId: null, status: "idle", permissionMode: "default", model: null, effort: null, activeModel: null, activeEffort: null, backgroundTasks: 0, createdAt: updatedAt, updatedAt });
const names = (list: Workspace[]) => list.map((w) => w.name).join(",");
const top = (id: string | null) => id;

test("12: recent 는 가장 최근 세션 활동이 있는 폴더가 위, 세션 없는 폴더는 맨 아래(이름순)", () => {
  const folders = [ws("a", "api"), ws("g", "gone"), ws("n", "notes"), ws("p", "practice"), ws("e", "empty")];
  const sessions = [session("p", "2026-10-16T01:00:00Z"), session("p", "2026-10-16T05:00:00Z"), session("n", "2026-10-16T09:00:00Z"), session("a", "2026-10-16T03:00:00Z")];
  expect(names(orderFolders(folders, sessions, top, "recent")) === "notes,practice,api,empty,gone", names(orderFolders(folders, sessions, top, "recent")));
  return expect(names(orderFolders(folders, sessions, top, "name")) === "api,empty,gone,notes,practice", "name 은 이름순");
});

test("12: 활동 시각이 같으면 이름순, 하위 워크스페이스 세션은 최상위 폴더 몫", () => {
  const folders = [ws("b", "beta"), ws("a", "alpha")];
  const sameTime = [session("a", "2026-10-16T01:00:00Z"), session("b", "2026-10-16T01:00:00Z")];
  expect(names(orderFolders(folders, sameTime, top, "recent")) === "alpha,beta", "같은 시각은 이름순");
  const viaChild = [session("child-of-b", "2026-10-16T09:00:00Z"), session("a", "2026-10-16T01:00:00Z")];
  return expect(names(orderFolders(folders, viaChild, (id) => (id === "child-of-b" ? "b" : id), "recent")) === "beta,alpha", "worktree 워크스페이스는 부모 폴더로 센다");
});

test("12: 기본 보기는 recent 이고, name 으로 바꾸면 기본이 아니다", () => {
  expect(DEFAULT_VIEW.folderOrder === "recent", "기본값");
  expect(isDefaultView({ ...DEFAULT_VIEW }, "created") && !isDefaultView({ ...DEFAULT_VIEW, folderOrder: "name" }, "created"), "Reset Filters 대상");
  return "ok";
});

test("13: pickAnchor 는 화면 맨 위를 지나는 가장 안쪽 요소와 그 안 오프셋", () => {
  const c = [
    { turn: "t1", child: -1, top: 0 },
    { turn: "t1", child: 0, top: 0 },
    { turn: "t1", child: 1, top: 300 },
    { turn: "t2", child: -1, top: 900 },
    { turn: "t2", child: 0, top: 900 },
    { turn: "t2", child: 1, top: 1100 },
  ];
  expect(JSON.stringify(pickAnchor(c, 1000)) === JSON.stringify({ turn: "t2", child: 0, offset: 100 }), JSON.stringify(pickAnchor(c, 1000)));
  expect(JSON.stringify(pickAnchor(c, 350)) === JSON.stringify({ turn: "t1", child: 1, offset: 50 }), "턴 안의 둘째 행");
  expect(pickAnchor([], 10) === null, "후보 없음");
  return expect(pickAnchor(c, -20)?.offset === -20, "첫 후보보다 위면 음수 오프셋");
});

test("13: 높이가 나중에 늘어도 같은 메시지 위치가 나온다(픽셀 저장은 어긋나는 경우)", () => {
  const saved = pickAnchor([{ turn: "t2", child: 1, top: 1100 }], 1150)!;
  expect(restoredScrollTop(1220, saved.offset, 5000) === 1270, "밀린 만큼 따라감");
  expect(restoredScrollTop(1220, saved.offset, 1200) === 1200, "아직 짧은 내용은 끝으로 맞춤");
  return expect(restoredScrollTop(10, -40, 5000) === 0, "0 아래로는 안 내려감");
});

test("13: 저장본의 anchor 는 모양이 맞을 때만 남고 옛 저장본(top 만)도 읽힌다", () => {
  const e = sanitizeExtras({ chatScroll: { a: { top: 10, atBottom: false, anchor: { turn: "t", child: 2, offset: 5.5 } }, b: { top: 7, atBottom: false, anchor: { turn: "", child: 1, offset: 0 } }, c: { top: 3, atBottom: true }, d: { top: 4, atBottom: false, anchor: { turn: "t", child: 1.5, offset: 0 } } } });
  expect(JSON.stringify(e.chatScroll.a.anchor) === JSON.stringify({ turn: "t", child: 2, offset: 5.5 }), "정상 anchor");
  expect(e.chatScroll.b.anchor === undefined && e.chatScroll.d.anchor === undefined, "깨진 anchor 는 버림");
  return expect(e.chatScroll.c.top === 3 && e.chatScroll.c.anchor === undefined, "옛 저장본");
});

test("14: 합칠 커밋이 0 이면 Merge 와 Create 가 꺼지고 이유가 붙는다", () => {
  const state = worktreeMenuState({ branch: "feat/x", target: "main", unmerged: 0, prs: [] });
  expect(state.merge.disabled && /Nothing to merge/.test(state.merge.reason ?? ""), `merge ${state.merge.reason}`);
  return expect(state.pr.kind === "create" && state.pr.disabled && /No pull request needed/.test(state.pr.reason ?? ""), JSON.stringify(state.pr));
});

test("14: 커밋이 있으면 켜지고, 열린 PR 이 있으면 Create 대신 Open, 닫힌 PR 은 무시", () => {
  const pr = (state: string) => ({ number: 42, title: "Add", url: "https://github.com/x/y/pull/42", state, checks: { passing: 0, failing: 0, pending: 0 } });
  const plain = worktreeMenuState({ branch: "b", target: "main", unmerged: 2, prs: [] });
  expect(!plain.merge.disabled && plain.pr.kind === "create" && !plain.pr.disabled, "켜짐");
  const open = worktreeMenuState({ branch: "b", target: "main", unmerged: 2, prs: [pr("OPEN")] });
  expect(open.pr.kind === "open" && open.pr.url.endsWith("/42"), "열린 PR");
  const closed = worktreeMenuState({ branch: "b", target: "main", unmerged: 2, prs: [pr("MERGED"), pr("CLOSED")] });
  expect(closed.pr.kind === "create", "닫힌 PR 은 Create");
  const unknown = worktreeMenuState({ branch: "b", target: "main", unmerged: null, prs: undefined });
  return expect(!unknown.merge.disabled && unknown.pr.kind === "create" && !unknown.pr.disabled, "모르면 켜 둔다(서버가 다시 확인)");
});

test("21: relocateWorkspace 는 폴더와 안의 세션 cwd 접두만 바꾸고 worktree 세션은 둔다", () => {
  const store = new Store();
  const dirA = join(home, "old"), dirB = join(home, "new");
  mkdirSync(dirA, { recursive: true });
  mkdirSync(dirB, { recursive: true });
  const w = store.addWorkspace(dirA);
  const mk = (id: string, patch: Partial<Agent>) => store.addAgent({ ...session(w.id, "2026-10-16T01:00:00Z"), id, ...patch });
  mk("plain", { cwd: w.dir });
  mk("sub", { cwd: `${w.dir}/packages/app` });
  mk("wt", { cwd: "/elsewhere/wt", worktree: { root: "/elsewhere/wt", branch: "b", base: "main" } });
  const { workspace, moved } = store.relocateWorkspace(w.id, dirB);
  const cwd = (id: string) => store.agent(id).cwd;
  expect(workspace.dir.endsWith("/new") && cwd("plain") === workspace.dir && cwd("sub") === `${workspace.dir}/packages/app`, `${cwd("plain")} ${cwd("sub")}`);
  expect(cwd("wt") === "/elsewhere/wt" && moved.map((a) => a.id).sort().join() === "plain,sub", "worktree 는 그대로");
  const other = store.addWorkspace(join(home, "other"), null, "other");
  let threw = false;
  try {
    store.relocateWorkspace(other.id, dirB);
  } catch {
    threw = true;
  }
  return expect(threw, "이미 쓰는 폴더로는 못 옮김");
});

let failed = 0;
for (const c of cases) {
  try {
    console.log(`ok   ${c.name} (${await c.run()})`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${c.name}: ${(error as Error).message}`);
  }
}
rmSync(home, { recursive: true, force: true });
console.log(failed ? `${failed} failed` : `${cases.length} passed`);
process.exit(failed ? 1 : 0);
