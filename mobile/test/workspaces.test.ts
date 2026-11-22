import type { Agent, Workspace } from "../../shared/protocol";
import { aggregateState, baseChoices, branchLabel, buildProject, buildProjects, canStartWorktree, compareAgents, DEFAULT_SESSION_SORT, defaultBaseBranch, moveInOrder, orderOf, shortPath, topWorkspace, worktreeDisabledReason, worktreePreview } from "../src/logic/workspaces";
import { parseSortPrefs, SortPrefsStore } from "../src/state/sortPrefs";
import type { Cache } from "../src/state/store";
import { expect, run, sleep, test } from "./harness";

const ws = (id: string, name: string, extra: Partial<Workspace> = {}): Workspace => ({ id, name, dir: `/Users/me/Repos/${name}`, parentId: null, ...extra });
const agent = (id: string, workspaceId: string | null, updatedAt: string, extra: Partial<Agent> = {}): Agent => ({ id, workspaceId, title: `title ${id}`, status: "idle", updatedAt, createdAt: updatedAt, ...extra }) as Agent;

const W = [ws("a", "alpha"), ws("b", "beta"), ws("a1", "alpha (fix-login)", { parentId: "a", dir: "/Users/me/Repos/alpha.worktrees/fix-login" }), ws("a2", "alpha (zeta)", { parentId: "a" }), ws("f", "fb", { feedback: true }), ws("c", "empty")];

test("shortPath: 집 폴더는 ~ 로, macOS 의 /private/tmp 는 /tmp 로", () => {
  expect(shortPath("/Users/me/Repository/app") === "~/Repository/app", "home");
  expect(shortPath("/private/tmp/agent-nav-mobile-home/Repos/app") === "/tmp/agent-nav-mobile-home/Repos/app", "private tmp");
  expect(shortPath("/opt/app") === "/opt/app", "other");
  return "ok";
});

test("branchLabel: 세션의 worktree 정보가 먼저, 없으면 이름의 괄호, 그것도 없으면 폴더 이름", () => {
  const withInfo = agent("1", "a1", "1", { worktree: { root: "/x", branch: "feature/real", base: "main" } });
  expect(branchLabel(W[2], [withInfo]) === "feature/real", "agent worktree wins");
  expect(branchLabel(W[2], []) === "fix-login", "parenthesis in the name");
  expect(branchLabel(ws("z", "plain", { parentId: "a", dir: "/x/y/last" }), []) === "last", "folder name");
  return "ok";
});

test("buildProjects: 최상위만(worktree 와 피드백 폴더는 뺀다), 최근 움직인 순, 세션 없는 폴더는 이름 순으로 뒤", () => {
  const agents = [agent("1", "a", "2026-10-20T10:00:00Z"), agent("2", "b", "2026-10-20T12:00:00Z"), agent("3", "a1", "2026-10-20T11:00:00Z")];
  const projects = buildProjects(W, agents);
  expect(projects.map((p) => p.workspace.name).join() === "beta,alpha,empty", projects.map((p) => p.workspace.name).join());
  const alpha = projects[1];
  expect(alpha.active === 2 && alpha.lastActivity === "2026-10-20T11:00:00Z", "worktree session counts toward the project and its activity");
  expect(alpha.worktrees.map((l) => l.label).join() === "fix-login,zeta", "worktree locations sorted by branch");
  expect(alpha.main.label === "Main folder" && alpha.main.sessions.length === 1 && alpha.worktrees[0].sessions[0].id === "3", "sessions land in their own location");
  expect(buildProjects(W, agents, "BET").length === 1 && buildProjects(W, agents, "repos/alp").length === 1 && buildProjects(W, agents, "nope").length === 0, "query matches name and path");
  return projects.map((p) => `${p.workspace.name}:${p.active}`).join();
});

test("buildProject: 고정이 앞, 최근 순, done 은 따로, 상태는 done 을 뺀 가장 눈에 띄는 것", () => {
  const agents = [agent("1", "a", "2026-10-20T10:00:00Z"), agent("2", "a", "2026-10-20T09:00:00Z", { pinned: true }), agent("3", "a", "2026-10-20T11:00:00Z", { done: true, status: "waiting" }), agent("4", "a", "2026-10-20T08:00:00Z", { status: "running" })];
  const p = buildProject(W[0], W, agents);
  expect(p.main.sessions.map((a) => a.id).join() === "2,1,4", p.main.sessions.map((a) => a.id).join());
  expect(p.main.done.map((a) => a.id).join() === "3" && p.done === 1 && p.active === 3, "done kept apart");
  expect(p.state === "running", `a done session that waits does not light up the project: ${p.state}`);
  expect(aggregateState([agent("1", "a", "1", { status: "waiting" }), agent("2", "a", "1", { status: "error" })]) === "waiting", "waiting first");
  expect(aggregateState([]) === "idle" && aggregateState([agent("1", "a", "1", { unread: true })]) === "unread", "empty is idle, unread shows");
  return "ok";
});

test("topWorkspace: worktree 주소도 그 프로젝트로, 피드백 폴더와 모르는 id 는 null", () => {
  expect(topWorkspace(W, "a1")?.id === "a" && topWorkspace(W, "a")?.id === "a", "child resolves to parent");
  expect(topWorkspace(W, "f") === null && topWorkspace(W, "nope") === null, "feedback and unknown");
  return "ok";
});

test("새 세션 worktree 규칙은 데스크톱과 같다: 저장소이고 브랜치가 하나라도 있으면 가능, 기준은 defaultBase 다음 첫 브랜치", () => {
  const repo = { repoRoot: "/r/app", branches: ["main", "dev"], defaultBase: "main", locals: ["main", "dev"], remotes: ["origin/main"] };
  expect(canStartWorktree(repo) && worktreeDisabledReason(repo) === null, "repo with branches");
  expect(!canStartWorktree({ ...repo, repoRoot: null }) && worktreeDisabledReason({ ...repo, repoRoot: null }) === "Not a git repository", "not a repo");
  expect(!canStartWorktree({ ...repo, branches: [] }) && /no commits/.test(worktreeDisabledReason({ ...repo, branches: [] }) ?? ""), "no commits yet");
  expect(!canStartWorktree(null) && worktreeDisabledReason(null) === null, "unknown yet");
  expect(defaultBaseBranch(repo) === "main" && defaultBaseBranch({ ...repo, defaultBase: null }) === "main" && defaultBaseBranch({ branches: [], defaultBase: null }) === "", "default base");
  expect(baseChoices(repo).join() === "main,dev,origin/main", "locals then remotes");
  expect(baseChoices({ ...repo, locals: [], remotes: [] }).join() === "main,dev", "old servers: mixed list");
  expect(worktreePreview("/r/app", "feature/x") === "app.worktrees/feature/x" && worktreePreview("/r/app", " ") === "app.worktrees/<branch>", "preview");
  return "ok";
});

const names = (projects: { workspace: Workspace }[]) => projects.map((p) => p.workspace.name).join();
const memoryCache = (initial: Record<string, string> = {}): Cache & { data: Record<string, string> } => {
  const data = { ...initial };
  return { data, get: async (key) => data[key] ?? null, set: async (key, value) => void (data[key] = value), remove: async (keys) => void keys.forEach((key) => delete data[key]) };
};
const SORT_W = [ws("a", "alpha"), ws("b", "Beta"), ws("c", "empty"), ws("z", "zed"), ws("f", "fb", { feedback: true })];
const SORT_AGENTS = [agent("1", "a", "2026-10-20T09:00:00Z"), agent("2", "b", "2026-10-20T10:00:00Z"), agent("3", "z", "2026-10-20T12:00:00Z")];

test("프로젝트 정렬 activity: 기본값과 같다(최근 활동, 세션 없는 폴더는 이름 순으로 뒤)", () => {
  expect(names(buildProjects(SORT_W, SORT_AGENTS, "", "activity")) === "zed,Beta,alpha,empty", names(buildProjects(SORT_W, SORT_AGENTS, "", "activity")));
  expect(names(buildProjects(SORT_W, SORT_AGENTS)) === names(buildProjects(SORT_W, SORT_AGENTS, "", "activity")), "default is activity");
  return "ok";
});

test("프로젝트 정렬 name: 이름 순(대소문자 무시), 피드백 폴더는 빠진다, 검색과 같이 쓴다", () => {
  expect(names(buildProjects(SORT_W, SORT_AGENTS, "", "name")) === "alpha,Beta,empty,zed", names(buildProjects(SORT_W, SORT_AGENTS, "", "name")));
  expect(names(buildProjects(SORT_W, SORT_AGENTS, "t", "name")) === "Beta,empty", "query filters then name sorts");
  const twins = [ws("t2", "same", { dir: "/b/same" }), ws("t1", "same", { dir: "/a/same" })];
  expect(buildProjects(twins, [], "", "name").map((p) => p.workspace.id).join() === "t1,t2", "tie broken by dir");
  return "ok";
});

test("프로젝트 정렬 manual: 저장된 순서를 따르고, 새 프로젝트는 맨 아래(최근 활동 순), 사라진 id 는 조용히 빠진다", () => {
  const saved = ["z", "gone", "a", "also-gone"];
  const list = buildProjects(SORT_W, SORT_AGENTS, "", "manual", saved);
  expect(names(list) === "zed,alpha,Beta,empty", names(list));
  expect(list.length === 4 && !list.some((p) => p.workspace.id === "gone"), "vanished ids are skipped, not rendered");
  expect(names(buildProjects(SORT_W, SORT_AGENTS, "", "manual", [])) === names(buildProjects(SORT_W, SORT_AGENTS, "", "activity")), "no saved order: everything is new, so activity order");
  expect(names(buildProjects(SORT_W, SORT_AGENTS, "", "manual", ["a", "a", "z"])) === "alpha,zed,Beta,empty", "duplicate ids are ignored");
  const later = [...SORT_AGENTS, agent("4", "c", "2026-10-21T00:00:00Z")];
  expect(names(buildProjects(SORT_W, later, "", "manual", ["a", "b", "c", "z"])) === "alpha,Beta,empty,zed", "activity does not reorder manual");
  expect(names(buildProjects(SORT_W, SORT_AGENTS, "t", "manual", ["z", "c", "b", "a"])) === "empty,Beta", "query keeps manual order");
  return names(list);
});

test("수동 순서 옮기기: 한 칸, 맨 위와 맨 아래, 끝에서는 그대로, 모르는 id 는 무시", () => {
  const order = ["a", "b", "c", "d"];
  expect(moveInOrder(order, "c", "up").join() === "a,c,b,d" && moveInOrder(order, "b", "down").join() === "a,c,b,d", "one step");
  expect(moveInOrder(order, "d", "top").join() === "d,a,b,c" && moveInOrder(order, "a", "bottom").join() === "b,c,d,a", "top and bottom");
  expect(moveInOrder(order, "a", "up").join() === "a,b,c,d" && moveInOrder(order, "d", "down").join() === "a,b,c,d" && moveInOrder(order, "a", "top").join() === "a,b,c,d", "ends stay");
  expect(moveInOrder(order, "x", "up").join() === "a,b,c,d" && moveInOrder(order, "a", "down") !== order, "unknown id, and a copy is returned");
  const shown = orderOf(buildProjects(SORT_W, SORT_AGENTS, "", "manual", ["z", "gone", "a"]));
  expect(shown.join() === "z,a,b,c", shown.join());
  expect(moveInOrder(shown, "c", "up").join() === "z,a,c,b", "saved order has no vanished ids and includes the new ones");
  return "ok";
});

test("세션 정렬: 고정이 먼저, 그 안에서 updated 는 마지막 수정, created 는 만든 시각(늦은 것부터), Done 도 같은 기준", () => {
  const mk = (id: string, created: string, updated: string, extra: Partial<Agent> = {}) => agent(id, "a", updated, { createdAt: created, ...extra });
  const agents = [
    mk("old-busy", "2026-10-01T00:00:00Z", "2026-10-20T12:00:00Z"),
    mk("new-quiet", "2026-10-19T00:00:00Z", "2026-10-19T01:00:00Z"),
    mk("mid", "2026-10-10T00:00:00Z", "2026-10-20T06:00:00Z"),
    mk("pinned-oldest", "2026-09-01T00:00:00Z", "2026-09-02T00:00:00Z", { pinned: true }),
    mk("done-old", "2026-10-02T00:00:00Z", "2026-10-20T20:00:00Z", { done: true }),
    mk("done-new", "2026-10-18T00:00:00Z", "2026-10-18T01:00:00Z", { done: true }),
  ];
  const ids = (list: Agent[]) => list.map((a) => a.id).join();
  const updated = buildProject(W[0], W, agents, "updated").main;
  const created = buildProject(W[0], W, agents, "created").main;
  expect(ids(updated.sessions) === "pinned-oldest,old-busy,mid,new-quiet", "updated: " + ids(updated.sessions));
  expect(ids(created.sessions) === "pinned-oldest,new-quiet,mid,old-busy", "created: " + ids(created.sessions));
  expect(ids(updated.done) === "done-old,done-new" && ids(created.done) === "done-new,done-old", "done follows the sort");
  expect(ids(buildProject(W[0], W, agents).main.sessions) === ids(updated.sessions) && DEFAULT_SESSION_SORT === "updated", "default is updated");
  const twoPinned = [mk("p-old-created-new-updated", "2026-09-01T00:00:00Z", "2026-10-20T00:00:00Z", { pinned: true }), mk("p-new-created-old-updated", "2026-10-01T00:00:00Z", "2026-10-01T00:00:00Z", { pinned: true })];
  expect(ids([...twoPinned].sort(compareAgents("updated"))) === "p-old-created-new-updated,p-new-created-old-updated" && ids([...twoPinned].sort(compareAgents("created"))) === "p-new-created-old-updated,p-old-created-new-updated", "pinned ordered by the sort too");
  expect(buildProject(W[0], W, agents, "created").lastActivity === buildProject(W[0], W, agents, "updated").lastActivity, "lastActivity unaffected");
  const wt = [agent("w1", "a1", "2026-10-20T00:00:00Z", { createdAt: "2026-10-01T00:00:00Z" }), agent("w2", "a1", "2026-10-10T00:00:00Z", { createdAt: "2026-10-15T00:00:00Z" })];
  expect(ids(buildProject(W[0], W, wt, "created").worktrees[0].sessions) === "w2,w1" && ids(buildProject(W[0], W, wt, "updated").worktrees[0].sessions) === "w1,w2", "worktree locations too");
  return "ok";
});

test("저장 모양: 읽고 쓰기가 왕복하고, 깨진 값은 기본으로, 시작 때 읽은 값이 바로 쓰인다", async () => {
  const cache = memoryCache();
  const first = new SortPrefsStore(cache);
  await first.load();
  expect(first.getState().projects.sort === "activity" && first.getState().projects.order.length === 0, "fresh install defaults");
  first.setProjectSort("manual", ["a", "b", "c"]);
  expect(first.getState().projects.order.join() === "a,b,c", "first switch to manual seeds from what is on screen");
  first.setProjectOrder(["c", "a", "b"]);
  first.setProjectSort("name", ["x"]);
  first.setProjectSort("manual", ["x"]);
  expect(first.getState().projects.order.join() === "c,a,b", "switching back keeps the saved manual order, not the visible one");
  first.setSessionSort("a", "created");
  first.setSessionSort("b", "updated");
  await sleep(20);
  expect(JSON.parse(cache.data["pref:sort"]).v === 1, "stored under one key: " + cache.data["pref:sort"]);
  const second = new SortPrefsStore(cache);
  let notified = 0;
  second.subscribe(() => notified++);
  await second.load();
  expect(second.getState().projects.sort === "manual" && second.getState().projects.order.join() === "c,a,b", "project sort and order survive a restart");
  expect(second.getState().sessions.a === "created" && second.getState().sessions.b === "updated" && second.getState().sessions.zzz === undefined, "per-project session sort survives, others have none");
  expect(notified === 1, "load notifies subscribers once");
  for (const id of ["1", "2", "3", "4", "5"]) second.setProjectOrder([id]);
  await sleep(30);
  expect(parseSortPrefs(cache.data["pref:sort"]).projects.order.join() === "5", "last write wins");
  const mixed = JSON.stringify({ projects: { sort: "weird", order: [1, "ok", "ok", null] }, sessions: { a: "created", b: "oldest", c: 3 } });
  for (const bad of ["not json", "[]", "null", mixed]) {
    const parsed = parseSortPrefs(bad);
    expect(parsed.projects.sort === "activity" && parsed.projects.order.every((id) => typeof id === "string"), "bad input " + bad);
    expect(Object.values(parsed.sessions).every((v) => v === "created" || v === "updated"), "only valid session sorts survive");
  }
  expect(parseSortPrefs(mixed).projects.order.join() === "ok" && parseSortPrefs(mixed).sessions.a === "created" && parseSortPrefs(mixed).sessions.b === undefined, "non-string and duplicate ids dropped, valid session sort kept");
  const broken = new SortPrefsStore({ ...memoryCache(), get: async () => { throw new Error("disk"); } });
  await broken.load();
  expect(broken.getState().projects.sort === "activity", "read failure falls back");
  return "ok";
});

void run();
