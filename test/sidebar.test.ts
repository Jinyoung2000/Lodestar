// B1 사이드바 세션 목록: 묶음, 정렬, 접기, 상대 시간(web/sessionList.ts)과 읽음, 고정, 완료, 이름 서버 동작(server/agents.ts) 단독 시험.
// 모델은 부르지 않는다. 실행: npm test
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "agent-nav-sidebar-unit-"));
process.env.AGENT_NAV_HOME = join(home, "nav");
mkdirSync(process.env.AGENT_NAV_HOME, { recursive: true });
const { buildGroups, DEFAULT_VIEW, isDefaultView, relativeTime, sidebarLayout, sumChanges, timeBucket } = await import("../web/sessionList");
const { AgentRunner } = await import("../server/agents");
const { Store } = await import("../server/store");
type Agent = import("../shared/protocol").Agent;
type ServerEvent = import("../shared/protocol").ServerEvent;
type GroupInput = import("../web/sessionList").GroupInput;

const cases: { name: string; run: () => string | Promise<string> }[] = [];
const test = (name: string, run: () => string | Promise<string>) => cases.push({ name, run });
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
  return detail;
};

const NOW = new Date(2026, 9, 14, 15, 0, 0).getTime();
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
const DAY = 24 * 60;

let seq = 0;
const agent = (patch: Partial<Agent>): Agent => ({
  id: `a${++seq}`,
  workspaceId: "w1",
  cwd: "/x",
  worktree: null,
  forkedFrom: null,
  resumeFrom: null,
  startCommit: null,
  feedbackId: null,
  title: "t",
  sessionId: null,
  status: "idle",
  permissionMode: "default",
  model: null,
  effort: null,
  activeModel: null,
  activeEffort: null,
  backgroundTasks: 0,
  createdAt: at(10),
  updatedAt: at(10),
  ...patch,
});

const workspaces = [
  { id: "w2", name: "zeta", dir: "/zeta", parentId: null },
  { id: "w1", name: "alpha", dir: "/alpha", parentId: null },
];
const input = (agents: Agent[], extra: Partial<GroupInput> = {}): GroupInput => ({
  agents,
  workspaces,
  topWorkspaceId: (id) => id || null,
  view: { ...DEFAULT_VIEW },
  defaultOrdering: "created",
  now: NOW,
  collapsedParents: new Set(),
  expandedGroups: new Set(),
  ...extra,
});
const ids = (rows: { agent: Agent }[]) => rows.map((r) => r.agent.id).join(",");
// w1 폴더 묶음(고정한 세션은 맨 위 Pinned 묶음으로 올라가고, Chats 는 비어 있어도 머리가 있다)
const w1 = (groups: ReturnType<typeof buildGroups>) => groups.find((g) => g.id === "ws:w1")!;

test("relativeTime: VS Code 와 같은 반올림과 단위", () => {
  const sec = (n: number) => at(n / 60);
  expect(relativeTime(sec(29), NOW) === "now", "under 30 secs is now");
  expect(relativeTime(sec(30), NOW) === "30 secs ago", "30 secs ago");
  expect(relativeTime(sec(59), NOW) === "59 secs ago", "59 secs ago");
  expect(relativeTime(at(1), NOW) === "1 min ago", "1 min ago");
  expect(relativeTime(at(26), NOW) === "26 mins ago", "26 mins ago");
  expect(relativeTime(at(90), NOW) === "2 hrs ago", "90 mins rounds up to 2 hrs");
  expect(relativeTime(at(60), NOW) === "1 hr ago", "1 hr ago");
  expect(relativeTime(at(5 * 60), NOW) === "5 hrs ago", "5 hrs ago");
  expect(relativeTime(at(DAY), NOW) === "1 day ago", "1 day ago");
  expect(relativeTime(at(6 * DAY), NOW) === "6 days ago", "6 days ago");
  expect(relativeTime(at(9 * DAY), NOW) === "1 wk ago", "9 days is 1 wk");
  expect(relativeTime(at(21 * DAY), NOW) === "3 wks ago", "3 wks ago");
  expect(relativeTime(at(60 * DAY), NOW) === "2 mos ago", "2 mos ago");
  expect(relativeTime(at(400 * DAY), NOW) === "1 yr ago", "1 yr ago");
  expect(relativeTime(sec(-20), NOW) === "now", "a clock a bit ahead of the daemon still says now");
  // 분 틱 사이에 갱신된 세션: 틱이 든 now 보다 updatedAt 이 35초 앞서도 in N secs 가 아니라 now
  expect(relativeTime(sec(-35), NOW) === "now", "35 secs after the stale tick still says now");
  expect(relativeTime(at(-5), NOW) === "now", "a time well in the future is clamped to now");
  return expect(relativeTime("nope", NOW) === "", "bad timestamp is empty");
});

test("timeBucket: local midnight boundaries", () => {
  expect(timeBucket(new Date(2026, 9, 14, 0, 0, 1).toISOString(), NOW) === "today", "today");
  expect(timeBucket(new Date(2026, 9, 13, 23, 59, 0).toISOString(), NOW) === "yesterday", "yesterday");
  expect(timeBucket(new Date(2026, 9, 7, 0, 0, 0).toISOString(), NOW) === "week", "7 days back at midnight is Last 7 days");
  return expect(timeBucket(new Date(2026, 9, 6, 23, 0, 0).toISOString(), NOW) === "older", "older");
});

test("Workspace grouping: Chats first, folders by name when asked, folders without sessions keep their head, Done hidden", () => {
  const groups = buildGroups(input([agent({ workspaceId: "w2", title: "z" }), agent({ workspaceId: "" }), agent({ done: true })], { view: { ...DEFAULT_VIEW, folderOrder: "name" } }));
  return expect(groups.map((g) => g.id).join(",") === "chats,ws:w1,ws:w2", `got ${groups.map((g) => g.id)} (alpha has only a done session but keeps its head)`);
});

test("Workspace grouping default: the folder with the most recent session activity comes first (fix5-3)", () => {
  const groups = buildGroups(input([agent({ workspaceId: "w2", title: "z", updatedAt: at(1) }), agent({ workspaceId: "w1", updatedAt: at(50) }), agent({ done: true })]));
  return expect(groups.map((g) => g.id).join(",") === "chats,ws:w2,ws:w1", `got ${groups.map((g) => g.id)}`);
});

test("Ordering: created vs updated; pinned sessions move to a Pinned group above everything", () => {
  const a = agent({ createdAt: at(30), updatedAt: at(1) });
  const b = agent({ createdAt: at(20), updatedAt: at(15) });
  const c = agent({ createdAt: at(40), updatedAt: at(40), pinned: true });
  const byCreated = buildGroups(input([a, b, c]));
  expect(byCreated.map((g) => g.id).join(",") === "pinned,chats,ws:w1,ws:w2", `groups: ${byCreated.map((g) => g.id)}`);
  expect(ids(byCreated[0].rows) === c.id && byCreated[0].kind === "pinned", "the pinned session is alone in Pinned");
  expect(ids(w1(byCreated).rows) === `${b.id},${a.id}`, `created: ${ids(w1(byCreated).rows)}`);
  const byUpdated = buildGroups(input([a, b, c], { view: { ...DEFAULT_VIEW, ordering: "updated" } }));
  expect(ids(w1(byUpdated).rows) === `${a.id},${b.id}`, `updated: ${ids(w1(byUpdated).rows)}`);
  // 고정한 세션의 갈래는 부모와 함께 Pinned 로 가고, 고정한 갈래만 따로 올라가면 부모는 제자리에 남는다
  const kid = agent({ forkedFrom: c.id, createdAt: at(5) });
  const pinnedKid = agent({ forkedFrom: a.id, createdAt: at(4), pinned: true });
  const groups = buildGroups(input([a, b, c, kid, pinnedKid]));
  expect(groups[0].rows.map((r) => `${r.agent.id}:${r.depth}`).join() === `${pinnedKid.id}:0,${c.id}:0,${kid.id}:1`, `pinned family: ${groups[0].rows.map((r) => r.agent.id)}`);
  expect(ids(w1(groups).rows) === `${b.id},${a.id}`, "the unpinned parent stays in its folder without the pinned fork");
  // Chats 는 세션이 없어도 머리가 있다
  return expect(groups.find((g) => g.id === "chats")!.rows.length === 0, "empty Chats keeps its head");
});

test("Forks nest under the parent at any depth; a fork whose parent is elsewhere becomes a top-level row", () => {
  const parent = agent({ createdAt: at(50) });
  const child = agent({ forkedFrom: parent.id, createdAt: at(40) });
  const grand = agent({ forkedFrom: child.id, createdAt: at(30) });
  const orphan = agent({ forkedFrom: "gone", createdAt: at(20) });
  const rows = w1(buildGroups(input([parent, child, grand, orphan]))).rows;
  expect(rows.map((r) => `${r.agent.id}:${r.depth}`).join(",") === `${orphan.id}:0,${parent.id}:0,${child.id}:1,${grand.id}:2`, `got ${rows.map((r) => `${r.agent.id}:${r.depth}`)}`);
  expect(rows[1].hasChildren && rows[2].hasChildren && !rows[3].hasChildren, "twistie flags");
  const collapsed = w1(buildGroups(input([parent, child, grand], { collapsedParents: new Set([parent.id]) }))).rows;
  expect(ids(collapsed) === parent.id, "collapsing the parent hides the whole subtree");
  const done = buildGroups(input([parent, { ...child, done: true }]));
  return expect(ids(w1(done).rows) === `${parent.id}` && w1(done).count === 1, "a done fork leaves its parent's group");
});

test("Show=Recent folds a group past 5 top-level sessions; Show more and Show=All unfold it", () => {
  const list = Array.from({ length: 7 }, (_, i) => agent({ createdAt: at(i + 1) }));
  const fork = agent({ forkedFrom: list[0].id, createdAt: at(0) });
  const folded = w1(buildGroups(input([...list, fork])));
  expect(folded.foldable && folded.folded && folded.rows.length === 6, `5 top-level plus the shown parent's fork, got ${folded.rows.length}`);
  expect(folded.count === 8, "count still covers every session");
  expect(folded.hidden === 2, `+2 more counts the hidden top-level sessions, got ${folded.hidden}`);
  const open = w1(buildGroups(input([...list, fork], { expandedGroups: new Set(["ws:w1"]) })));
  expect(open.foldable && !open.folded && open.rows.length === 8 && open.hidden === 0, "expanded shows all and still offers Show less");
  const all = w1(buildGroups(input([...list, fork], { view: { ...DEFAULT_VIEW, show: "all" } })));
  expect(!all.foldable && all.rows.length === 8, "Show=All never folds");
  const five = w1(buildGroups(input(list.slice(0, 5))));
  return expect(!five.foldable, "exactly 5 does not fold");
});

test("Show Done adds a Done group at the bottom; feedback sessions never appear in groups", () => {
  const live = agent({});
  const finished = agent({ done: true });
  const feedback = agent({ feedbackId: "f1" });
  const hidden = buildGroups(input([live, finished, feedback]));
  expect(!hidden.some((g) => g.id === "done") && !hidden.some((g) => g.rows.some((r) => r.agent.id === feedback.id)), "hidden by default");
  const shown = buildGroups(input([live, finished, feedback], { view: { ...DEFAULT_VIEW, showDone: true } }));
  expect(shown[shown.length - 1].id === "done" && ids(shown[shown.length - 1].rows) === finished.id, "Done is last");
  const none = buildGroups(input([live], { view: { ...DEFAULT_VIEW, showDone: true } }));
  return expect(!none.some((g) => g.id === "done"), "no done sessions, no Done head");
});

test("Time grouping buckets by the ordering timestamp", () => {
  const a = agent({ createdAt: at(10), updatedAt: at(10) });
  const b = agent({ createdAt: at(2 * DAY), updatedAt: at(5) });
  const c = agent({ createdAt: at(30 * DAY), updatedAt: at(30 * DAY) });
  const byCreated = buildGroups(input([a, b, c], { view: { ...DEFAULT_VIEW, grouping: "time" } }));
  expect(byCreated.map((g) => g.name).join(",") === "Today,Last 7 days,Older", `created: ${byCreated.map((g) => g.name)}`);
  const byUpdated = buildGroups(input([a, b, c], { view: { ...DEFAULT_VIEW, grouping: "time", ordering: "updated" } }));
  return expect(byUpdated[0].name === "Today" && byUpdated[0].rows.length === 2, "updated moves b into Today");
});

test("isDefaultView: only a non-default choice lights the filter button", () => {
  expect(isDefaultView(DEFAULT_VIEW, "created"), "default");
  expect(isDefaultView({ ...DEFAULT_VIEW, ordering: "created" }, "created"), "explicit created equals default created");
  expect(!isDefaultView({ ...DEFAULT_VIEW, ordering: "updated" }, "created"), "updated differs");
  expect(isDefaultView({ ...DEFAULT_VIEW, ordering: "updated" }, "updated"), "default follows the VS Code setting");
  return expect(!isDefaultView({ ...DEFAULT_VIEW, showDone: true }, "created"), "Show Done differs");
});

test("sumChanges adds files", () => {
  const files = [
    { path: "/a", rel: "a", status: "M" as const, additions: 3, deletions: 1 },
    { path: "/b", rel: "b", status: "A" as const, additions: 4, deletions: 0 },
  ];
  const sum = sumChanges(files);
  return expect(sum.add === 7 && sum.del === 1 && sumChanges(undefined).add === 0, `${sum.add} ${sum.del}`);
});

test("Server: read, pin, done, rename emit the agent and keep updatedAt", () => {
  const store = new Store();
  const events: ServerEvent[] = [];
  const runner = new AgentRunner(store, (e) => events.push(e));
  const created = agent({ id: "s1", title: "first", unread: true, updatedAt: at(120) });
  store.addAgent(created);
  runner.setRead("s1", true);
  runner.setPinned("s1", true);
  runner.setDone("s1", true);
  runner.rename("s1", "  new   name \n");
  const stored = store.agent("s1");
  expect(stored.unread === false && stored.pinned === true && stored.done === true && stored.title === "new name", `${stored.unread} ${stored.pinned} ${stored.done} ${stored.title}`);
  expect(stored.updatedAt === created.updatedAt, "updatedAt untouched (it drives ordering and 2 hrs ago)");
  expect(events.length === 4 && events.every((e) => e.type === "agent"), "one agent event per action");
  runner.setRead("s1", false);
  expect(store.agent("s1").unread === true, "mark as unread");
  let rejected = 0;
  for (const bad of ["", "   ", undefined as never]) {
    try {
      runner.rename("s1", bad);
    } catch {
      rejected++;
    }
  }
  expect(rejected === 3 && store.agent("s1").title === "new name", "an empty name is refused and the title stays");
  store.flush();
  const reloaded = new Store();
  return expect(reloaded.agent("s1").pinned === true && reloaded.agent("s1").title === "new name", "persisted to state.json");
});

// ⌥⌘←/→ 가 따라가는 순서(sidebarLayout.order)는 사이드바가 그리는 행과 같은 값이어야 한다.
test("sidebarLayout.order: Pinned, Chats, folders, forks under the parent, collapsed groups and Show more respected", () => {
  const feedback = agent({ feedbackId: "f1", updatedAt: at(1) });
  const chat = agent({ workspaceId: "" });
  const parent = agent({ workspaceId: "w1", createdAt: at(50) });
  const fork = agent({ workspaceId: "w1", forkedFrom: parent.id, createdAt: at(40) });
  const pinned = agent({ workspaceId: "w1", createdAt: at(70), pinned: true });
  const zeta = agent({ workspaceId: "w2" });
  const done = agent({ workspaceId: "w1", done: true });
  const all = [zeta, done, fork, parent, chat, feedback, pinned];
  const open = { ...input(all), collapsedGroups: new Set<string>() };
  const layout = sidebarLayout(open);
  expect(layout.order.join() === [pinned, chat, parent, fork, zeta].map((a) => a.id).join(), `order: ${layout.order.join()}`);
  expect(layout.groups.flatMap((g) => g.rows.map((r) => r.agent.id)).length === layout.order.length && !layout.order.includes(feedback.id), "the order holds exactly the drawn rows, never a feedback session");
  // 접은 묶음의 행은 화면에 없어서 순서에도 없다
  const collapsed = sidebarLayout({ ...open, collapsedGroups: new Set(["chats", "ws:w1"]) });
  expect(collapsed.order.join() === [pinned, zeta].map((a) => a.id).join(), `collapsed: ${collapsed.order.join()}`);
  // 부모의 자식 행을 접으면 자식은 순서에서 빠진다
  const parentsCollapsed = sidebarLayout({ ...open, collapsedParents: new Set([parent.id]) });
  expect(!parentsCollapsed.order.includes(fork.id), "collapsed parent hides its forks");
  // 완료 보기를 켜면 맨 아래 Done 묶음이 순서 끝에 붙고, 기본으로 접혀 있으면(Sidebar 의 처음 상태) 빠진다
  const withDone = sidebarLayout({ ...open, view: { ...DEFAULT_VIEW, showDone: true } });
  expect(withDone.order.at(-1) === done.id, "Done is last");
  expect(!sidebarLayout({ ...open, view: { ...DEFAULT_VIEW, showDone: true }, collapsedGroups: new Set(["done"]) }).order.includes(done.id), "Done collapsed by default is skipped");
  // Show more 로 접혀 있는 묶음은 처음 5개만 보이는 만큼만 순서에 든다
  const many = Array.from({ length: 7 }, (_, i) => agent({ workspaceId: "w1", createdAt: at(10 + i) }));
  expect(sidebarLayout({ ...input(many), collapsedGroups: new Set() }).order.length === 5, "Show more folded to 5");
  expect(sidebarLayout({ ...input(many, { expandedGroups: new Set(["ws:w1"]) }), collapsedGroups: new Set() }).order.length === 7, "expanded shows all 7");
  // 정렬 기준을 updated 로 바꾸면 순서도 바뀐다
  const x = agent({ workspaceId: "w1", createdAt: at(30), updatedAt: at(1) });
  const y = agent({ workspaceId: "w1", createdAt: at(20), updatedAt: at(15) });
  const created = sidebarLayout({ ...input([x, y]), collapsedGroups: new Set() }).order.join();
  const updated = sidebarLayout({ ...input([x, y], { view: { ...DEFAULT_VIEW, ordering: "updated" } }), collapsedGroups: new Set() }).order.join();
  return expect(created === `${y.id},${x.id}` && updated === `${x.id},${y.id}`, `created ${created} updated ${updated}`);
});

test("Server: a fork does not inherit pinned, done, or unread", async () => {
  const store = new Store();
  const runner = new AgentRunner(store, () => {});
  store.addAgent(agent({ id: "p1", sessionId: "sess", pinned: true, done: true, unread: true }));
  const fork = await runner.fork("p1");
  return expect(fork.pinned === false && fork.done === false && fork.unread === false && fork.forkedFrom === "p1", `${fork.pinned} ${fork.done} ${fork.unread}`);
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
