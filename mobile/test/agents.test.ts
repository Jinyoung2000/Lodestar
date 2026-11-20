import type { Agent, Workspace } from "../../shared/protocol";
import { groupAgents, pickableWorkspaces, stateOf, waitingCount, workspaceName } from "../src/logic/agents";
import { expect, run, test } from "./harness";

const ws = (id: string, name: string, extra: Partial<Workspace> = {}): Workspace => ({ id, name, dir: `/${name}`, parentId: null, ...extra });
const agent = (id: string, workspaceId: string | null, updatedAt: string, extra: Partial<Agent> = {}): Agent => ({ id, workspaceId, title: `title ${id}`, status: "idle", updatedAt, createdAt: updatedAt, ...extra }) as Agent;

const W = [ws("a", "alpha"), ws("b", "beta"), ws("a2", "alpha (fix)", { parentId: "a" }), ws("f", "fb", { feedback: true })];

test("stateOf: 답 대기가 가장 눈에 띄고, 그다음 오류, 실행 중, 안 읽음 순", () => {
  expect(stateOf(agent("1", "a", "1", { status: "waiting", unread: true })) === "waiting", "waiting wins");
  expect(stateOf(agent("1", "a", "1", { status: "error" })) === "error", "error");
  expect(stateOf(agent("1", "a", "1", { status: "running", unread: true })) === "running", "running");
  expect(stateOf(agent("1", "a", "1", { unread: true })) === "unread" && stateOf(agent("1", "a", "1")) === "idle", "unread and idle");
  return "ok";
});

test("groupAgents: 프로젝트별로 묶고, worktree 는 부모 아래, 최근 순, 고정과 done 은 따로", () => {
  const agents = [agent("1", "a", "2026-10-20T10:00:00Z"), agent("2", "b", "2026-10-20T12:00:00Z"), agent("3", "a2", "2026-10-20T11:00:00Z"), agent("4", null, "2026-10-20T09:00:00Z"), agent("5", "b", "2026-10-20T08:00:00Z", { done: true }), agent("6", "b", "2026-10-20T07:00:00Z", { pinned: true })];
  const sections = groupAgents(agents, W);
  expect(sections.map((s) => s.title).join() === "Pinned,beta,alpha,Chats,Done", sections.map((s) => s.title).join());
  expect(sections[2].agents.map((a) => a.id).join() === "3,1", "worktree session sits under its parent, newest first");
  return sections.map((s) => `${s.title}:${s.agents.length}`).join();
});

test("groupAgents: 검색은 제목과 프로젝트 이름에서 대소문자 없이", () => {
  const agents = [agent("1", "a", "2", { title: "Fix Login" }), agent("2", "b", "1", { title: "Other" })];
  expect(groupAgents(agents, W, "login")[0].agents[0].id === "1", "title");
  expect(groupAgents(agents, W, "BETA")[0].agents[0].id === "2", "workspace name");
  expect(groupAgents(agents, W, "zzz").length === 0, "no match");
  return "ok";
});

test("workspaceName, pickableWorkspaces, waitingCount", () => {
  expect(workspaceName(agent("1", null, "1"), W) === "Chat" && workspaceName(agent("1", "a", "1"), W) === "alpha", "names");
  expect(workspaceName(agent("1", "a2", "1", { worktree: { root: "/r", branch: "fix", base: "main" } }), W) === "alpha (fix)", "worktree label");
  const picks = pickableWorkspaces(W, [agent("1", "b", "2026-10-20T12:00:00Z"), agent("2", "a", "2026-10-20T10:00:00Z")]);
  expect(picks.map((w) => w.name).join() === "beta,alpha", picks.map((w) => w.name).join());
  expect(waitingCount([agent("1", "a", "1", { status: "waiting" }), agent("2", "a", "1")]) === 1, "waiting count");
  return "ok";
});

void run();
