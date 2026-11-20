// Improvements: 피드백 개선 세션이 Sessions 목록, 세션 검색, 순서 이동에서 빠지고 별도 화면의 목록 거르기가 맞는지 순수 함수로 확인한다. 실행: npm test
import type { Agent, Feedback } from "../shared/protocol";
import { improvementRows, improvementsBusy, matchesImprovement, needsInputCount, notAppliedCount, requestFirstLine, retryTargets, withoutImprovementSessions } from "../web/improvementRows";
import { buildGroups, DEFAULT_VIEW, sidebarLayout, type GroupInput } from "../web/sessionList";
import { sessionOptions } from "../web/sessionSearch";
import { recentRows, searchGroups, visibleTabs, SEARCH_ACTIONS, type SearchData } from "../web/searchModel";

const cases: { name: string; run: () => string }[] = [];
const test = (name: string, run: () => string) => cases.push({ name, run });
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
  return detail;
};

const NOW = new Date(2026, 9, 15, 12, 0, 0).getTime();
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

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
  model: "haiku",
  effort: null,
  activeModel: null,
  activeEffort: null,
  backgroundTasks: 0,
  resumeAt: null,
  createdAt: at(60),
  updatedAt: at(60),
  ...patch,
});

const feedback = (id: string, agentId: string, patch: Partial<Feedback> = {}): Feedback => ({
  id,
  agentId,
  text: `request ${id}`,
  element: null,
  screenshot: false,
  screenshotNote: null,
  status: "applied",
  summary: null,
  changedFiles: [],
  needsRestart: false,
  restartRequested: false,
  restartPending: false,
  checks: [],
  failure: null,
  worktree: `/tmp/${id}`,
  seen: false,
  createdAt: at(60),
  updatedAt: at(60),
  ...patch,
});

// 세션 하나와 그 피드백 기록을 짝으로 만든다
const pair = (id: string, patch: Partial<Feedback> = {}, agentPatch: Partial<Agent> = {}) => {
  const a = agent({ id: `s-${id}`, feedbackId: id, title: `Feedback ${id}`, ...agentPatch });
  return { agent: a, feedback: feedback(id, a.id, patch) };
};
const record = (list: Feedback[]) => Object.fromEntries(list.map((f) => [f.id, f]));
const ids = (list: { id: string }[]) => list.map((f) => f.id).join();

const applied = pair("applied", { status: "applied", updatedAt: at(5) });
const failed = pair("failed", { status: "failed", failure: "Not applied: tsc failed", checks: [{ name: "tsc", ok: false, output: "x" }], updatedAt: at(10), createdAt: at(30) });
const failedNoChecks = pair("failedNoChecks", { status: "failed", failure: "Agent session failed", updatedAt: at(20), createdAt: at(40) });
const restart = pair("restart", { status: "awaitingRestart", updatedAt: at(30) });
const reverted = pair("reverted", { status: "reverted", restartPending: true, updatedAt: at(40) });
const retrying = pair("retrying", { status: "checking", retrying: true, failure: null, checks: [{ name: "tsc", ok: false, output: "x" }], updatedAt: at(1) });
const noChanges = pair("noChanges", { status: "noChanges", updatedAt: at(50) });
const all = [applied, failed, failedNoChecks, restart, reverted, retrying, noChanges];
const feedbacks = record(all.map((p) => p.feedback));
const agents = all.map((p) => p.agent);

test("All lists every feedback whose session still exists, newest first", () => {
  const rows = improvementRows(feedbacks, agents, "all", null);
  return expect(ids(rows) === "retrying,applied,failed,failedNoChecks,restart,reverted,noChanges", ids(rows));
});

test("Not applied is the badge's Not applied: a retry in progress and Restart needed do not count", () => {
  const rows = improvementRows(feedbacks, agents, "notApplied", null);
  return expect(ids(rows) === "failed,failedNoChecks", ids(rows));
});

test("Applied keeps applied and the ones waiting only for a restart, not reverted", () => {
  const rows = improvementRows(feedbacks, agents, "applied", null);
  return expect(ids(rows) === "applied,restart", ids(rows));
});

test("a feedback whose session was deleted leaves the list (the record stays only as a revert backup)", () => {
  const rest = agents.filter((a) => a.id !== applied.agent.id);
  const rows = improvementRows(feedbacks, rest, "all", null);
  return expect(!rows.some((f) => f.id === "applied") && rows.length === all.length - 1, ids(rows));
});

test("the open row stays in the list while it no longer matches the filter", () => {
  const rows = improvementRows(feedbacks, agents, "notApplied", "applied");
  const other = improvementRows(feedbacks, agents, "notApplied", null);
  return expect(ids(rows) === "applied,failed,failedNoChecks" && ids(other) === "failed,failedNoChecks", ids(rows));
});

test("matchesImprovement follows the same statuses for a single record", () => {
  const f = (status: Feedback["status"], extra: Partial<Feedback> = {}) => feedback("x", "y", { status, ...extra });
  return expect(
    matchesImprovement(f("failed"), "notApplied") &&
      !matchesImprovement(f("failed", { retrying: true }), "notApplied") &&
      matchesImprovement(f("applied"), "applied") &&
      !matchesImprovement(f("reverted"), "applied") &&
      matchesImprovement(f("running"), "all") &&
      !matchesImprovement(f("running"), "applied"),
    "statuses",
  );
});

test("the sidebar count is the Not applied rows with a live session", () => {
  const rest = agents.filter((a) => a.id !== failed.agent.id);
  return expect(notAppliedCount(feedbacks, agents) === 2 && notAppliedCount(feedbacks, rest) === 1 && notAppliedCount({}, []) === 0, `${notAppliedCount(feedbacks, agents)} ${notAppliedCount(feedbacks, rest)}`);
});

test("busy is on while an improvement session works or its checks run, off when everything is settled", () => {
  const idle = [applied, failed, restart];
  const settled = improvementsBusy(record(idle.map((p) => p.feedback)), idle.map((p) => p.agent));
  const working = pair("working", { status: "running" }, { status: "running" });
  const withWorking = improvementsBusy(record([...idle, working].map((p) => p.feedback)), [...idle, working].map((p) => p.agent));
  const turn = pair("turn", { status: "applied" }, { status: "running" });
  const withTurn = improvementsBusy(record([turn.feedback]), [turn.agent]);
  const checking = improvementsBusy(feedbacks, agents);
  const noSession = improvementsBusy(record([working.feedback]), []);
  return expect(!settled && withWorking && withTurn && checking && !noSession, `${settled} ${withWorking} ${withTurn} ${checking} ${noSession}`);
});

test("Retry all runs the retryable Not applied ones, oldest first (no checks means nothing to retry)", () => {
  const targets = retryTargets(feedbacks, agents);
  return expect(targets.join() === "failed", targets.join());
});

test("the first line of a request is the row text", () => {
  return expect(requestFirstLine("\n  make it wider \nand taller") === "make it wider" && requestFirstLine("") === "", "first line");
});

// --- Sessions 목록에서 빠짐 ---

const normal = [agent({ id: "n1", createdAt: at(50) }), agent({ id: "n2", createdAt: at(40), workspaceId: null })];
const withImprovements = [...normal, ...agents];
const input = (list: Agent[]): GroupInput => ({
  agents: list,
  workspaces: [{ id: "w1", name: "agent-nav", dir: "/x", parentId: null }],
  topWorkspaceId: (id) => id,
  view: DEFAULT_VIEW,
  defaultOrdering: "created",
  now: NOW,
  collapsedParents: new Set(),
  expandedGroups: new Set(),
});

test("withoutImprovementSessions drops only the feedback sessions", () => {
  return expect(ids(withoutImprovementSessions(withImprovements)) === "n1,n2", ids(withoutImprovementSessions(withImprovements)));
});

test("the sidebar layout has no Improvements group and its order never lands on an improvement session", () => {
  const layout = sidebarLayout({ ...input(withImprovements), collapsedGroups: new Set() });
  const drawn = layout.groups.flatMap((g) => g.rows.map((r) => r.agent.id));
  return expect(!("feedback" in layout) && drawn.join() === layout.order.join() && !layout.order.some((id) => id.startsWith("s-")) && layout.order.includes("n1"), layout.order.join());
});

test("the sidebar session count ignores improvement sessions in every group", () => {
  const groups = buildGroups(input(withImprovements));
  const total = groups.reduce((sum, g) => sum + g.count, 0);
  return expect(total === normal.length, `${total}`);
});

// --- 검색(⌘K, ⌃⌥R) ---

const searchData = (list: Agent[], recentAgentIds: string[]): SearchData => ({
  agents: list,
  workspaces: [{ id: "w1", name: "agent-nav", dir: "/x", parentId: null }],
  recentAgentIds,
  fileWorkspaceId: null,
  files: undefined,
  recentFiles: [],
  prs: [],
  cards: [],
  columns: [],
  mentions: [],
  stamps: {},
  now: NOW,
});

test("session search lists no improvement session, with or without a query", () => {
  const options = sessionOptions({ agents: withImprovements, workspaces: [], recentIds: [applied.agent.id, "n1"], query: "" });
  const queried = sessionOptions({ agents: withImprovements, workspaces: [], recentIds: [], query: "Feedback" });
  return expect(options.map((o) => o.agent.id).join() === "n1,n2" && queried.length === 0, options.map((o) => o.agent.id).join());
});

test("the search window's Sessions tab and Recent hide improvement sessions", () => {
  const data = searchData(withImprovements, [applied.agent.id, "n1"]);
  const sessions = searchGroups(data, "sessions", "").flatMap((g) => g.rows).map((r) => r.key);
  const recent = recentRows(data).map((r) => r.key);
  const typed = searchGroups(data, "all", "Feedback").flatMap((g) => g.rows).filter((r) => r.kind === "session");
  return expect(sessions.join() === "session:n1,session:n2" && recent.join() === "session:n1" && typed.length === 0, `${sessions.join()} | ${recent.join()} | ${typed.length}`);
});

test("the Sessions tab disappears when only improvement sessions exist", () => {
  const onlyImprovements = visibleTabs(searchData(agents, []));
  const mixed = visibleTabs(searchData(withImprovements, []));
  return expect(!onlyImprovements.includes("sessions") && mixed.includes("sessions"), onlyImprovements.join());
});

test("the search window finds the Improvements screen as an action when typing, not in the default list", () => {
  const typed = searchGroups(searchData([], []), "all", "improvements").flatMap((g) => g.rows);
  const idle = searchGroups(searchData([], []), "all", "").flatMap((g) => g.rows).filter((r) => r.kind === "action");
  const action = SEARCH_ACTIONS.find((a) => a.id === "improvements");
  return expect(typed.some((r) => r.kind === "action" && r.command === "openImprovements") && !idle.some((r) => r.kind === "action" && r.command === "openImprovements") && !!action, `${typed.length} ${idle.length}`);
});

const waitingA = pair("waitingA", { status: "needsInput", question: "고정 패널로 만들까요?", updatedAt: at(2) });
const waitingB = pair("waitingB", { status: "needsInput", question: "어느 화면인가요?", updatedAt: at(3) });
const withWaiting = [...all, waitingA, waitingB];

test("a waiting-for-answer feedback is its own count, not a Not applied one", () => {
  const f = record(withWaiting.map((p) => p.feedback));
  const a = withWaiting.map((p) => p.agent);
  return expect(needsInputCount(f, a) === 2 && notAppliedCount(f, a) === 2 && needsInputCount(feedbacks, agents) === 0, `${needsInputCount(f, a)} ${notAppliedCount(f, a)}`);
});

test("the waiting count drops a feedback whose session was deleted", () => {
  const f = record(withWaiting.map((p) => p.feedback));
  const rest = withWaiting.map((p) => p.agent).filter((a) => a.id !== waitingA.agent.id);
  return expect(needsInputCount(f, rest) === 1, String(needsInputCount(f, rest)));
});

test("waiting rows show under All but not under Not applied or Applied", () => {
  const f = record(withWaiting.map((p) => p.feedback));
  const a = withWaiting.map((p) => p.agent);
  const inAll = improvementRows(f, a, "all", null).map((r) => r.id);
  return expect(inAll.includes("waitingA") && !improvementRows(f, a, "notApplied", null).some((r) => r.id.startsWith("waiting")) && !improvementRows(f, a, "applied", null).some((r) => r.id.startsWith("waiting")), inAll.join());
});

test("a waiting feedback is not busy (the session is idle, it is the user's turn)", () => {
  return expect(!improvementsBusy(record([waitingA.feedback]), [waitingA.agent]), "idle");
});

let failures = 0;
for (const c of cases) {
  try {
    console.log(`ok   ${c.name} (${c.run()})`);
  } catch (error) {
    failures++;
    console.log(`FAIL ${c.name}: ${(error as Error).message}`);
  }
}
console.log(failures ? `${failures} failed` : `${cases.length} passed`);
process.exit(failures ? 1 : 0);
