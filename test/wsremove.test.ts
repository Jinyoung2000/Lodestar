// WSMENU: 폴더를 목록에서 뺄 때 세션을 지우지 않고 숨기는지, 도는 세션이 있으면 거절하는지, 다시 추가하면 돌아오는지. 데몬도 모델도 필요 없다. 실행: npm test
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "agent-nav-wsremove-"));
const nav = join(root, "nav");
process.env.AGENT_NAV_HOME = nav;
mkdirSync(nav, { recursive: true });
const { Store } = await import("../server/store");
const { revealCommand } = await import("../server/reveal");
const { AgentRunner } = await import("../server/agents");
type Agent = import("../shared/protocol").Agent;

const cases: { name: string; run: () => string }[] = [];
const test = (name: string, run: () => string) => cases.push({ name, run });
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
  return detail;
};
const NOW = "2026-10-15T12:00:00.000Z";
const folder = (name: string) => {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  return dir;
};
const record = (id: string, workspaceId: string | null, patch: Partial<Agent> = {}): Agent => ({ id, workspaceId, cwd: root, worktree: null, forkedFrom: null, resumeFrom: null, startCommit: null, feedbackId: null, title: `title ${id}`, sessionId: `sess-${id}`, status: "idle", permissionMode: "default", model: null, effort: null, activeModel: null, activeEffort: null, backgroundTasks: 0, createdAt: NOW, updatedAt: NOW, ...patch });

test("세션이 없으면 폴더 기록만 지운다", () => {
  const store = new Store();
  const ws = store.addWorkspace(folder("empty"));
  const result = store.removeFolderFromList(ws.id);
  expect(result.hidden === 0, `hidden ${result.hidden}`);
  expect(!store.workspaces.some((w) => w.id === ws.id), "목록에서 빠짐");
  expect(!store.allWorkspaceIds.has(ws.id), "맡겨 두지도 않음");
  return "no sessions";
});

test("프로세스가 떠 있는(warm) 세션의 폴더를 빼도 오류 없이 프로세스를 닫는다", () => {
  const store = new Store();
  const ws = store.addWorkspace(folder("warm"));
  store.addAgent(record("warm-1", ws.id));
  const emitted: unknown[] = [];
  const runner = new AgentRunner(store, (event) => emitted.push(event));
  let closed = 0;
  // 한 번 턴을 돌린 세션은 프로세스를 들고 있다. 실제 SDK 대신 닫힘만 세는 가짜를 넣는다.
  (runner as unknown as { runs: Map<string, unknown> }).runs.set("warm-1", { closed: false, stopWatch: null, idleTimer: null, input: { close: () => closed++ }, query: { close: () => closed++ }, steers: new Set() });
  const { agents } = store.removeFolderFromList(ws.id);
  for (const agent of agents) runner.closeIdle(agent.id);
  expect(closed === 2, `process closed ${closed}`);
  expect(!store.agents.some((a) => a.id === "warm-1") && store.allAgentIds.has("warm-1"), "세션은 숨겨 둠");
  return "closed";
});

test("세션이 있으면 지우지 않고 숨긴다(타임라인 파일 그대로)", () => {
  const store = new Store();
  const ws = store.addWorkspace(folder("withsessions"));
  const wt = store.addWorkspace(folder("withsessions-wt"), ws.id, "withsessions (feature)");
  store.addAgent(record("a1", ws.id));
  store.addAgent(record("a2", wt.id));
  store.addAgent(record("chat", null));
  store.upsertItem("a1", { id: "m1", kind: "user", text: "hello" } as never);
  writeFileSync(join(nav, "timelines", "a1.json"), JSON.stringify([{ id: "m1", kind: "user", text: "hello" }]));
  const result = store.removeFolderFromList(ws.id);
  expect(result.hidden === 2, `hidden ${result.hidden}`);
  expect(!store.agents.some((a) => a.id === "a1" || a.id === "a2"), "목록의 세션에서 빠짐");
  expect(store.agents.some((a) => a.id === "chat"), "폴더 없는 세션은 그대로");
  expect(!store.workspaces.some((w) => w.id === ws.id || w.id === wt.id), "worktree 워크스페이스도 같이 빠짐");
  expect(store.allAgentIds.has("a1") && store.allWorkspaceIds.has(wt.id), "맡겨 둔 id 는 남아 보드 카드가 연결을 안 잃음");
  expect(existsSync(join(nav, "timelines", "a1.json")), "타임라인 파일은 지우지 않음");
  return "2 hidden, files kept";
});

test("도는 세션이 있으면 거절하고 아무것도 안 바꾼다", () => {
  const store = new Store();
  const ws = store.addWorkspace(folder("busy"));
  store.addAgent(record("b1", ws.id));
  store.addAgent(record("b2", ws.id, { status: "running" }));
  let message = "";
  try {
    store.removeFolderFromList(ws.id);
  } catch (error) {
    message = (error as Error).message;
  }
  expect(/still running/.test(message), `message: ${message}`);
  expect(store.workspaces.some((w) => w.id === ws.id) && store.agents.length >= 2, "그대로");
  store.patchAgent("b2", { status: "idle", backgroundTasks: 1 });
  let again = "";
  try {
    store.removeFolderFromList(ws.id);
  } catch (error) {
    again = (error as Error).message;
  }
  expect(/still running/.test(again), "백그라운드 작업이 남아도 거절");
  store.patchAgent("b2", { backgroundTasks: 0 });
  expect(store.removeFolderFromList(ws.id).hidden === 2, "멈추면 숨김");
  return message;
});

test("같은 폴더를 다시 추가하면 세션이 같은 id 로 돌아오고 알린다", () => {
  const store = new Store();
  const dir = folder("comeback");
  const ws = store.addWorkspace(dir);
  const wt = store.addWorkspace(folder("comeback-wt"), ws.id, "comeback (x)");
  store.addAgent(record("c1", ws.id, { title: "keep me", pinned: true }));
  store.addAgent(record("c2", wt.id));
  store.removeFolderFromList(ws.id);
  let announced: string[] = [];
  store.onRestored = (agents) => (announced = agents.map((a) => a.id));
  const back = store.addWorkspace(dir);
  expect(back.id === ws.id, "워크스페이스 id 유지");
  expect(store.workspaces.some((w) => w.id === wt.id && w.parentId === ws.id), "worktree 워크스페이스도 돌아옴");
  const c1 = store.agents.find((a) => a.id === "c1");
  expect(c1?.title === "keep me" && c1.pinned === true, "세션 내용 그대로");
  expect(announced.sort().join() === "c1,c2", `알림 ${announced}`);
  expect(!store.allAgentIds.has("zzz") && store.removeFolderFromList(ws.id).hidden === 2, "다시 숨길 수 있음");
  return "restored c1, c2";
});

test("숨긴 폴더와 세션은 다시 시작해도 남는다", () => {
  const first = new Store();
  const dir = folder("persist");
  const ws = first.addWorkspace(dir);
  first.addAgent(record("p1", ws.id));
  first.removeFolderFromList(ws.id);
  first.flush();
  const second = new Store();
  expect(!second.agents.some((a) => a.id === "p1"), "목록엔 없음");
  const back = second.addWorkspace(dir);
  expect(back.id === ws.id && second.agents.some((a) => a.id === "p1"), "저장된 뒤에도 돌아옴");
  return "persisted";
});

test("최상위가 아닌 워크스페이스는 뺄 수 없다", () => {
  const store = new Store();
  const ws = store.addWorkspace(folder("parent"));
  const wt = store.addWorkspace(folder("parent-wt"), ws.id, "parent (y)");
  let failed = false;
  try {
    store.removeFolderFromList(wt.id);
  } catch {
    failed = true;
  }
  expect(failed, "worktree 워크스페이스는 거절");
  return "rejected";
});

test("Finder 에서 보기 명령", () => {
  expect(JSON.stringify(revealCommand("/a/b", "darwin")) === JSON.stringify({ file: "open", args: ["-R", "/a/b"] }), "darwin");
  expect(revealCommand("/a/b", "linux").args[0] === "/a", "linux 는 부모 폴더");
  return "open -R";
});

let failed = 0;
for (const c of cases) {
  try {
    console.log(`ok   wsremove: ${c.name} (${c.run()})`);
  } catch (error) {
    failed++;
    console.log(`FAIL wsremove: ${c.name}: ${(error as Error).message}`);
  }
}
if (failed) process.exit(1);
