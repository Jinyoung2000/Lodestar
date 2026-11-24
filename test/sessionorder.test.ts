import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "agent-nav-sessionorder-unit-"));
process.env.AGENT_NAV_HOME = join(home, "nav");
mkdirSync(process.env.AGENT_NAV_HOME, { recursive: true });
const order = await import("../shared/sessionOrder");
const { buildGroups, DEFAULT_VIEW, orderFolders, sidebarLayout } = await import("../web/sessionList");
const { pickSlot } = await import("../web/sessionDropSlot");
const { MOBILE_METHODS } = await import("../shared/mobile");
const { Store } = await import("../server/store");
type Agent = import("../shared/protocol").Agent;
type GroupInput = import("../web/sessionList").GroupInput;

const cases: { name: string; run: () => string | Promise<string> }[] = [];
const test = (name: string, run: () => string | Promise<string>) => cases.push({ name, run });
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
  return detail;
};
const throws = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return (error as Error).message;
  }
  return null;
};

const NOW = new Date(2026, 9, 14, 15, 0, 0).getTime();
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

const agent = (id: string, minutesAgo: number, patch: Partial<Agent> = {}): Agent =>
  ({
    id,
    workspaceId: "w1",
    cwd: "/x",
    worktree: null,
    forkedFrom: null,
    resumeFrom: null,
    startCommit: null,
    feedbackId: null,
    title: id,
    sessionId: null,
    status: "idle",
    permissionMode: "default",
    model: null,
    effort: null,
    activeModel: null,
    activeEffort: null,
    backgroundTasks: 0,
    createdAt: at(minutesAgo),
    updatedAt: at(minutesAgo),
    ...patch,
  }) as Agent;

const workspaces = [
  { id: "w2", name: "zeta", dir: "/zeta", parentId: null },
  { id: "w1", name: "alpha", dir: "/alpha", parentId: null },
];
const input = (agents: Agent[], extra: Partial<GroupInput> = {}): GroupInput => ({
  agents,
  workspaces,
  topWorkspaceId: (id) => id || null,
  view: { ...DEFAULT_VIEW, show: "all" },
  defaultOrdering: "created",
  now: NOW,
  collapsedParents: new Set(),
  expandedGroups: new Set(),
  ...extra,
});
const rowIds = (groups: ReturnType<typeof buildGroups>, id: string) => groups.find((g) => g.id === id)!.rows.map((r) => r.agent.id).join(",");

const A = agent("a", 1);
const B = agent("b", 2);
const C = agent("c", 3);
const D = agent("d", 4);

test("applySessionOrder: 저장 순서, 새 세션은 맨 위, 지워진 id 는 조용히 빠짐", () => {
  const items = [A, B, C, D].map((a) => ({ id: a.id }));
  const ids = (list: { id: string }[]) => list.map((i) => i.id).join(",");
  expect(ids(order.applySessionOrder(items, undefined)) === "a,b,c,d", "no saved order keeps the default sort");
  expect(ids(order.applySessionOrder(items, [])) === "a,b,c,d", "an empty saved list is not a custom order");
  expect(ids(order.applySessionOrder(items, ["c", "a", "d", "b"])) === "c,a,d,b", "saved order wins over the default sort");
  expect(ids(order.applySessionOrder(items, ["d", "c", "a"])) === "b,d,c,a", "one new session goes on top");
  expect(ids(order.applySessionOrder(items, ["d", "c"])) === "a,b,d,c", "two new sessions go on top in default order");
  return expect(ids(order.applySessionOrder(items, ["zz", "d", "yy", "c", "b", "a"])) === "d,c,b,a", "deleted ids are skipped");
});

test("moveInOrder: 앞과 뒤로 옮기기, 제자리면 null", () => {
  const ids = ["a", "b", "c", "d"];
  expect(order.moveInOrder(ids, "d", "a", "before")?.join() === "d,a,b,c", "d before a");
  expect(order.moveInOrder(ids, "a", "c", "after")?.join() === "b,c,a,d", "a after c");
  expect(order.moveInOrder(ids, "a", "d", "after")?.join() === "b,c,d,a", "a to the very end");
  expect(order.moveInOrder(ids, "b", "a", "after") === null, "b after a is where b already is");
  expect(order.moveInOrder(ids, "b", "c", "before") === null, "b before c is where b already is");
  expect(order.moveInOrder(ids, "b", "b", "before") === null, "onto itself");
  return expect(order.moveInOrder(ids, "x", "a", "before") === null && order.moveInOrder(ids, "a", "x", "after") === null, "unknown id");
});

test("stepInOrder: 한 칸씩, 가장자리와 Show more 경계에서 멈춤", () => {
  const ids = ["a", "b", "c", "d", "e"];
  expect(order.stepInOrder(ids, "c", -1)?.join() === "a,c,b,d,e", "up");
  expect(order.stepInOrder(ids, "c", 1)?.join() === "a,b,d,c,e", "down");
  expect(order.stepInOrder(ids, "a", -1) === null, "top stays");
  expect(order.stepInOrder(ids, "e", 1) === null, "bottom stays");
  expect(order.stepInOrder(ids, "c", 1, 3) === null, "does not swap with a folded session");
  expect(order.stepInOrder(ids, "b", 1, 3)?.join() === "a,c,b,d,e", "within the visible part");
  return expect(order.stepInOrder(ids, "x", 1) === null, "unknown id");
});

test("buildGroups: 워크스페이스 묶음에 저장 순서를 입히고, 순서가 없는 워크스페이스는 기본 정렬 그대로", () => {
  const w2a = agent("w2a", 5, { workspaceId: "w2" });
  const w2b = agent("w2b", 6, { workspaceId: "w2" });
  const agents = [A, B, C, D, w2a, w2b];
  const plain = buildGroups(input(agents));
  expect(rowIds(plain, "ws:w1") === "a,b,c,d", "default");
  const custom = buildGroups(input(agents, { orders: { w1: ["d", "b", "a", "c"] } }));
  expect(rowIds(custom, "ws:w1") === "d,b,a,c", "w1 follows the saved order");
  expect(rowIds(custom, "ws:w2") === "w2a,w2b", "w2 has no saved order and keeps the default sort");
  const withNew = buildGroups(input([...agents, agent("e", 0)], { orders: { w1: ["d", "b", "a", "c"] } }));
  return expect(rowIds(withNew, "ws:w1") === "e,d,b,a,c", `new session on top: ${rowIds(withNew, "ws:w1")}`);
});

test("buildGroups: 고정 묶음과 완료 묶음은 자기 scope 로만 정렬되어 서로의 경계를 넘지 않음", () => {
  const P1 = agent("p1", 10, { pinned: true });
  const P2 = agent("p2", 11, { pinned: true });
  const X1 = agent("x1", 12, { done: true });
  const X2 = agent("x2", 13, { done: true });
  const agents = [A, B, P1, P2, X1, X2];
  const view = { ...DEFAULT_VIEW, show: "all" as const, showDone: true };
  const groups = buildGroups(input(agents, { view, orders: { w1: ["p2", "b", "x2", "a", "p1"], [order.PINNED_SCOPE]: ["p2", "p1"], [order.DONE_SCOPE]: ["x2", "x1"] } }));
  expect(rowIds(groups, "ws:w1") === "b,a", `workspace group: ${rowIds(groups, "ws:w1")}`);
  expect(rowIds(groups, "pinned") === "p2,p1", `pinned group follows @pinned: ${rowIds(groups, "pinned")}`);
  expect(rowIds(groups, "done") === "x2,x1", `done group follows @done: ${rowIds(groups, "done")}`);
  const plain = buildGroups(input(agents, { view }));
  return expect(rowIds(plain, "pinned") === "p1,p2" && rowIds(plain, "done") === "x1,x2", "default order without saved lists");
});

test("buildGroups: 핸드오프 세션은 같은 부모 안에서만 순서가 바뀜", () => {
  const parent = agent("parent", 1);
  const k1 = agent("k1", 20, { handoffFrom: "parent" });
  const k2 = agent("k2", 19, { handoffFrom: "parent" });
  const k3 = agent("k3", 18, { handoffFrom: "parent" });
  const other = agent("other", 2);
  const agents = [parent, k1, k2, k3, other];
  expect(rowIds(buildGroups(input(agents)), "ws:w1") === "parent,k1,k2,k3,other", "default: children by creation time");
  const custom = buildGroups(input(agents, { orders: { [order.kidsScope("parent")]: ["k3", "k1", "k2"] } }));
  expect(rowIds(custom, "ws:w1") === "parent,k3,k1,k2,other", `children reordered under the parent: ${rowIds(custom, "ws:w1")}`);
  const rows = custom.find((g) => g.id === "ws:w1")!.rows;
  expect(rows.find((r) => r.agent.id === "k3")!.scope === order.kidsScope("parent"), "child rows carry the kids scope");
  expect(rows.find((r) => r.agent.id === "parent")!.scope === "w1", "top rows carry the workspace scope");
  const collapsed = sidebarLayout({ ...input(agents, { collapsedParents: new Set(["parent"]) }), collapsedGroups: new Set() });
  expect(rowIds(collapsed.groups, "ws:w1") === "parent,other", "collapsed parent hides its children");
  expect(collapsed.scopes[order.kidsScope("parent")]?.ids.join() === "k1,k2,k3", "the full kids list is still published");
  return expect(collapsed.groups.find((g) => g.id === "ws:w1")!.resetScopes.join() === `w1,${order.kidsScope("parent")}`, "reset covers the workspace and its parents");
});

test("buildGroups: Show more 로 접힌 항목도 전체 순서에 남고, 시간별 묶음에서는 순서를 못 바꿈", () => {
  const many = Array.from({ length: 7 }, (_, i) => agent(`m${i}`, i + 1));
  const folded = sidebarLayout({ ...input(many, { view: { ...DEFAULT_VIEW, show: "recent" }, orders: { w1: ["m6", "m5", "m4", "m3", "m2", "m1", "m0"] } }), collapsedGroups: new Set() });
  expect(rowIds(folded.groups, "ws:w1") === "m6,m5,m4,m3,m2", "only the first five of the saved order are shown");
  expect(folded.scopes.w1.ids.join() === "m6,m5,m4,m3,m2,m1,m0" && folded.scopes.w1.shown === 5, `scope list keeps the folded ones: ${JSON.stringify(folded.scopes.w1)}`);
  const byTime = buildGroups(input(many, { view: { ...DEFAULT_VIEW, grouping: "time", show: "all" }, orders: { w1: ["m6", "m5"] } }));
  expect(byTime.every((g) => g.scope === null && g.rows.every((r) => r.scope === null)), "time buckets are not reorderable");
  return expect(byTime[0].rows[0].agent.id === "m0", "and ignore saved lists");
});

test("pickSlot: 블록 안 가운데 선, 틈, 묶음 머리, 목록 끝, 범위 밖", () => {
  const blocks = [
    { id: "a", top: 100, bottom: 140 },
    { id: "b", top: 142, bottom: 200 },
    { id: "c", top: 202, bottom: 242 },
  ];
  const bounds = { top: 80, bottom: 280 };
  const slot = (y: number) => JSON.stringify(pickSlot(blocks, y, bounds));
  expect(slot(105) === '{"id":"a","edge":"before"}', "upper half of a");
  expect(slot(135) === '{"id":"a","edge":"after"}', "lower half of a");
  expect(slot(141) === '{"id":"b","edge":"before"}', "gap above b reads as before b");
  expect(slot(190) === '{"id":"b","edge":"after"}', "lower half of the tall block b, below its children's middle");
  expect(slot(90) === '{"id":"a","edge":"before"}', "group head reads as before the first block");
  expect(slot(260) === '{"id":"c","edge":"after"}', "below the last block (Show more) reads as after the last");
  expect(slot(70) === "null" && slot(300) === "null", "outside the bounds");
  return expect(pickSlot([], 100, bounds) === null, "no siblings");
});

test("Store: 입력 검사, 없는 세션 id 제거, 비면 삭제, 저장과 재시작 뒤 유지", () => {
  const dir = mkdtempSync(join(home, "ws-"));
  const store = new Store();
  const workspace = store.addWorkspace(dir);
  for (const id of ["s1", "s2", "s3"]) store.addAgent(agent(id, 1, { workspaceId: workspace.id }));
  expect(Object.keys(store.sessionOrders).length === 0, "starts empty");

  const saved = store.setSessionOrder(workspace.id, ["s3", "s1", "gone", "s2", "s3"]);
  expect(saved[workspace.id].join() === "s3,s1,s2", `unknown ids dropped and duplicates collapsed: ${saved[workspace.id].join()}`);
  store.setSessionOrder(order.PINNED_SCOPE, ["s2", "s1"]);
  store.setSessionOrder(order.kidsScope("s1"), ["s3", "s2"]);

  expect(/Invalid session order scope/.test(throws(() => store.setSessionOrder("a/b", [])) ?? ""), "scope with a slash");
  expect(/Invalid session order scope/.test(throws(() => store.setSessionOrder(7, [])) ?? ""), "scope that is not a string");
  expect(/Unknown workspace/.test(throws(() => store.setSessionOrder("no-such-workspace", ["s1"])) ?? ""), "unknown workspace");
  expect(/Unknown session/.test(throws(() => store.setSessionOrder(order.kidsScope("nope"), ["s1"])) ?? ""), "unknown parent session");
  expect(/array/.test(throws(() => store.setSessionOrder(workspace.id, "s1")) ?? ""), "ids that is not an array");
  expect(/array/.test(throws(() => store.setSessionOrder(workspace.id, ["s1", 2])) ?? ""), "id that is not a string");
  expect(/array/.test(throws(() => store.setSessionOrder(workspace.id, ["../etc"])) ?? ""), "id with a bad shape");
  expect(/more than/.test(throws(() => store.setSessionOrder(workspace.id, Array.from({ length: order.MAX_ORDER_IDS + 1 }, (_, i) => `x${i}`))) ?? ""), "too many ids");
  expect(store.sessionOrders[workspace.id].join() === "s3,s1,s2", "rejected requests change nothing");

  store.flush();
  const reloaded = new Store();
  expect(reloaded.sessionOrders[workspace.id].join() === "s3,s1,s2" && reloaded.sessionOrders[order.PINNED_SCOPE].join() === "s2,s1", "persisted in state.json");

  expect(/array|Invalid/.test(throws(() => store.resetSessionOrders([workspace.id, "a/b"])) ?? ""), "reset with a bad scope throws");
  expect(store.sessionOrders[workspace.id] !== undefined, "and nothing was removed");
  const afterReset = store.resetSessionOrders([workspace.id, order.kidsScope("s1")]);
  expect(afterReset[workspace.id] === undefined && afterReset[order.kidsScope("s1")] === undefined && afterReset[order.PINNED_SCOPE] !== undefined, "reset removes only the named scopes");
  const cleared = store.setSessionOrder(order.PINNED_SCOPE, []);
  return expect(cleared[order.PINNED_SCOPE] === undefined, "an empty list removes the order");
});

test("pruneSessionOrders: 없는 워크스페이스와 부모 세션의 scope, 없는 세션 id 를 정리", () => {
  const pruned = order.pruneSessionOrders(
    { w1: ["a", "ghost"], gone: ["a"], [order.kidsScope("a")]: ["b"], [order.kidsScope("ghost")]: ["a"], [order.DONE_SCOPE]: ["ghost"], "bad/scope": ["a"] },
    { agents: new Set(["a", "b"]), workspaces: new Set(["w1"]) },
  );
  return expect(JSON.stringify(pruned) === JSON.stringify({ w1: ["a"], [order.kidsScope("a")]: ["b"] }), JSON.stringify(pruned));
});

test("@folders: scope 모양, prune 은 워크스페이스 id 로 맞춤, Store 는 워크스페이스 id 만 받음", () => {
  expect(order.parseOrderScope(order.FOLDERS_SCOPE)?.kind === "folders", "@folders is its own kind");
  const pruned = order.pruneSessionOrders({ [order.FOLDERS_SCOPE]: ["w1", "a", "gone"] }, { agents: new Set(["a"]), workspaces: new Set(["w1", "w2"]) });
  expect(pruned[order.FOLDERS_SCOPE]?.join() === "w1", `session ids and unknown ids drop out: ${JSON.stringify(pruned)}`);
  expect(order.pruneSessionOrders({ [order.FOLDERS_SCOPE]: ["a"] }, { agents: new Set(["a"]), workspaces: new Set(["w1"]) })[order.FOLDERS_SCOPE] === undefined, "an empty list is removed");

  const dir = mkdtempSync(join(home, "ws-folders-"));
  const store = new Store();
  const first = store.addWorkspace(dir);
  const second = store.addWorkspace(mkdtempSync(join(home, "ws-folders-")));
  store.addAgent(agent("fa", 1, { workspaceId: first.id }));
  const saved = store.setSessionOrder(order.FOLDERS_SCOPE, [second.id, "fa", "ghost", first.id]);
  expect(saved[order.FOLDERS_SCOPE].join() === `${second.id},${first.id}`, `keeps workspace ids only: ${saved[order.FOLDERS_SCOPE].join()}`);
  store.flush();
  expect(new Store().sessionOrders[order.FOLDERS_SCOPE].join() === `${second.id},${first.id}`, "persisted in state.json");
  const reset = store.resetSessionOrders([order.FOLDERS_SCOPE]);
  return expect(reset[order.FOLDERS_SCOPE] === undefined, "reset removes the folder order");
});

test("orderFolders manual: recent 위에 저장 순서, 새 폴더는 맨 위, 모르는 id 는 빠짐, 저장이 없으면 recent", () => {
  const folders = [...workspaces, { id: "w3", name: "mid", dir: "/mid", parentId: null }];
  const sessions = [agent("x", 1, { workspaceId: "w3" }), agent("y", 2, { workspaceId: "w2" })];
  const names = (list: { id: string }[]) => list.map((w) => w.id).join(",");
  const top = (id: string | null) => id;
  expect(names(orderFolders(folders, sessions, top, "recent")) === "w3,w2,w1", "recent: latest activity first");
  expect(names(orderFolders(folders, sessions, top, "manual", undefined)) === "w3,w2,w1", "manual without a saved order is recent");
  expect(names(orderFolders(folders, sessions, top, "manual", ["w1", "w2", "w3"])) === "w1,w2,w3", "manual follows the saved order");
  expect(names(orderFolders(folders, sessions, top, "manual", ["w1", "w2"])) === "w3,w1,w2", "a folder missing from the list goes on top");
  expect(names(orderFolders(folders, sessions, top, "manual", ["ghost", "w2", "w1", "w3"])) === "w2,w1,w3", "unknown ids drop");
  return expect(names(orderFolders(folders, sessions, top, "recent", ["w1", "w2", "w3"])) === "w3,w2,w1", "saved order is ignored unless folderOrder is manual");
});

test("sidebarLayout: @folders 목록은 보이는 최상위 폴더 순서 전부, 묶음 순서는 manual 일 때만 반영", () => {
  const view = { ...DEFAULT_VIEW, show: "all" as const, folderOrder: "manual" as const };
  const base = [agent("p", 1, { workspaceId: "w1" }), agent("q", 2, { workspaceId: "w2" })];
  const layout = sidebarLayout({ ...input(base, { view, orders: { [order.FOLDERS_SCOPE]: ["w2", "w1"] } }), collapsedGroups: new Set(["ws:w2"]) });
  const wsGroups = layout.groups.filter((g) => g.kind === "workspace").map((g) => g.workspaceId).join();
  expect(wsGroups === "w2,w1", `groups follow the saved folder order: ${wsGroups}`);
  expect(layout.scopes[order.FOLDERS_SCOPE]?.ids.join() === "w2,w1" && layout.scopes[order.FOLDERS_SCOPE].shown === 2, "collapsed folders stay in the list");
  const time = sidebarLayout({ ...input(base, { view: { ...DEFAULT_VIEW, grouping: "time" } }), collapsedGroups: new Set() });
  expect(time.scopes[order.FOLDERS_SCOPE] === undefined, "time grouping has no folder list");
  const recent = sidebarLayout({ ...input(base, { view: { ...DEFAULT_VIEW, show: "all" }, orders: { [order.FOLDERS_SCOPE]: ["w2", "w1"] } }), collapsedGroups: new Set() });
  return expect(recent.groups.filter((g) => g.kind === "workspace").map((g) => g.workspaceId).join() === "w1,w2", "recent ignores the saved folder order");
});

test("모바일 허용 RPC 에 세션 순서 메서드가 없음", () => {
  const methods = MOBILE_METHODS as readonly string[];
  return expect(!methods.includes("sessionOrder.set") && !methods.includes("sessionOrder.reset") && !methods.includes("sessionOrder.list"), "not exposed to the phone");
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
