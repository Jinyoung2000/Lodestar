import type { Agent, Workspace } from "../../shared/protocol";
import { aggregateState, baseChoices, branchLabel, buildProject, canStartWorktree, compareAgents, DEFAULT_SESSION_SORT, defaultBaseBranch, shortPath, topWorkspace, worktreeDisabledReason, worktreePreview } from "../src/logic/workspaces";
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

test("buildProject: worktree 세션도 그 프로젝트의 활동으로 센다", () => {
  const agents = [agent("1", "a", "2026-10-20T10:00:00Z"), agent("2", "b", "2026-10-20T12:00:00Z"), agent("3", "a1", "2026-10-20T11:00:00Z")];
  const alpha = buildProject(W[0], W, agents);
  expect(alpha.active === 2 && alpha.lastActivity === "2026-10-20T11:00:00Z", "worktree session counts toward the project and its activity");
  expect(alpha.worktrees.map((l) => l.label).join() === "fix-login,zeta", "worktree locations sorted by branch");
  expect(alpha.main.label === "Main folder" && alpha.main.sessions.length === 1 && alpha.worktrees[0].sessions[0].id === "3", "sessions land in their own location");
  return "ok";
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

const memoryCache = (initial: Record<string, string> = {}): Cache & { data: Record<string, string> } => {
  const data = { ...initial };
  return { data, get: async (key) => data[key] ?? null, set: async (key, value) => void (data[key] = value), remove: async (keys) => void keys.forEach((key) => delete data[key]) };
};
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
  expect(Object.keys(first.getState().sessions).length === 0 && first.getState().collapsed.length === 0, "fresh install defaults");
  first.setSessionSort("a", "created");
  first.setSessionSort("b", "updated");
  await sleep(20);
  expect(JSON.parse(cache.data["pref:sort"]).v === 1, "stored under one key: " + cache.data["pref:sort"]);
  const second = new SortPrefsStore(cache);
  let notified = 0;
  second.subscribe(() => notified++);
  await second.load();
  expect(second.getState().sessions.a === "created" && second.getState().sessions.b === "updated" && second.getState().sessions.zzz === undefined, "per-project session sort survives, others have none");
  expect(notified === 1, "load notifies subscribers once");
  for (const sort of ["updated", "created", "updated", "created"] as const) second.setSessionSort("a", sort);
  await sleep(30);
  expect(parseSortPrefs(cache.data["pref:sort"]).sessions.a === "created", "last write wins");
  const mixed = JSON.stringify({ projects: { sort: "manual", order: ["a"] }, sessions: { a: "created", b: "oldest", c: 3 } });
  for (const bad of ["not json", "[]", "null", mixed]) {
    const parsed = parseSortPrefs(bad);
    expect(Object.values(parsed.sessions).every((v) => v === "created" || v === "updated"), "only valid session sorts survive");
  }
  expect(parseSortPrefs(mixed).sessions.a === "created" && parseSortPrefs(mixed).sessions.b === undefined && !("projects" in parseSortPrefs(mixed)), "old project sort is dropped, valid session sort kept");
  const broken = new SortPrefsStore({ ...memoryCache(), get: async () => { throw new Error("disk"); } });
  await broken.load();
  expect(Object.keys(broken.getState().sessions).length === 0, "read failure falls back");
  return "ok";
});

void run();
