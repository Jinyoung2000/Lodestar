import type { TimelineItem } from "../../shared/protocol";
import { buildRows, stabilizeRows } from "../src/logic/timeline";
import { describeTool } from "../src/logic/tools";
import { expect, run, test } from "./harness";

const tool = (id: string, name = "Bash", status: "running" | "done" | "error" = "done", extra: Partial<TimelineItem> = {}): TimelineItem => ({ id, kind: "tool", name, input: { command: `echo ${id}` }, status, output: null, ...extra }) as TimelineItem;
const user = (id: string): TimelineItem => ({ id, kind: "user", text: id });
const assistant = (id: string, text = id, streaming = false): TimelineItem => ({ id, kind: "assistant", text, streaming });
const perm = (id: string, toolName: string, status: "pending" | "allowed" | "denied", extra: Partial<TimelineItem> = {}): TimelineItem => ({ id, kind: "permission", toolName, input: {}, status, ...extra }) as TimelineItem;
const shape = (items: TimelineItem[]) => buildRows(items).map((r) => r.type).join(",");

test("연속한 도구 호출과 생각은 한 행으로 묶인다", () => {
  const rows = buildRows([user("u"), tool("t1"), { id: "th", kind: "thinking", text: "hmm" }, tool("t2"), assistant("a")]);
  expect(rows.map((r) => r.type).join() === "user,steps,assistant", rows.map((r) => r.type).join());
  const steps = rows[1];
  expect(steps.type === "steps" && steps.steps.length === 3 && !steps.running, "three steps");
  return "ok";
});

test("실행 중인 도구가 있으면 steps.running, 마지막이 오류면 failed", () => {
  const running = buildRows([tool("t1", "Bash", "running")])[0];
  const failed = buildRows([tool("t1"), tool("t2", "Bash", "error")])[0];
  expect(running.type === "steps" && running.running, "running");
  expect(failed.type === "steps" && failed.failed && !failed.running, "failed");
  return "ok";
});

test("승인 대기 요청은 그 도구 줄을 대신해 카드가 되고, 응답한 요청은 기록에 남는다", () => {
  const items = [tool("t0"), perm("p0", "Bash", "allowed", { toolUseId: "t0" }), tool("t1", "Write"), perm("p1", "Write", "pending", { toolUseId: "t1" })];
  const rows = buildRows(items);
  expect(rows.map((r) => r.type).join() === "steps,answered,approval", rows.map((r) => r.type).join());
  const card = rows[2];
  expect(card.type === "approval" && card.tool?.id === "t1", "card knows its tool");
  expect(shape([perm("p", "Bash", "denied")]) === "answered", "denied request stays in history");
  return "ok";
});

test("질문과 계획: 대기 중이면 카드, 끝나면 기록 한 줄", () => {
  expect(shape([perm("q", "AskUserQuestion", "pending")]) === "question", "question card");
  expect(shape([perm("q", "AskUserQuestion", "allowed", { outcome: { answers: { a: "b" } } })]) === "answered", "answered");
  expect(shape([perm("p", "ExitPlanMode", "pending")]) === "plan", "plan card");
  const notion = buildRows([perm("n", "mcp__lodestar_notion__notion_update_page", "pending")])[0];
  expect(notion.type === "approval" && notion.reviewOnDesktop, "notion writes are reviewed on the desktop");
  return "ok";
});

test("질문과 계획 승인 호출 줄은 숨는다(카드와 기록 줄이 대신한다)", () => {
  expect(shape([tool("t1", "AskUserQuestion"), perm("q", "AskUserQuestion", "allowed", { toolUseId: "t1", outcome: { answers: { a: "b" } } }), tool("t2", "ExitPlanMode")]) === "answered", shape([tool("t1", "AskUserQuestion"), perm("q", "AskUserQuestion", "allowed")]));
  return "ok";
});

test("서브에이전트 안쪽 호출, 턴 결과, 복원 표시, 빈 어시스턴트 글은 숨긴다", () => {
  const items: TimelineItem[] = [tool("t1", "Agent"), tool("inner", "Read", "done", { parentToolUseId: "t1" }), { id: "r", kind: "result", isError: false, durationMs: 5, costUsd: 0 }, { id: "x", kind: "restored", redoable: false }, assistant("e", "  "), assistant("s", "", true)];
  expect(shape(items) === "steps,assistant", shape(items));
  const rows = buildRows(items);
  expect(rows[0].type === "steps" && rows[0].steps.length === 1, "inner tool hidden");
  return "ok";
});

test("system 사용자 메시지와 알림은 notice 가 되고 오류는 error 행", () => {
  const items: TimelineItem[] = [{ id: "s", kind: "user", text: "internal", source: "system" }, { id: "n", kind: "notice", text: "Compacted" }, { id: "e", kind: "error", text: "boom", auth: false }];
  expect(shape(items) === "notice,notice,error", shape(items));
  return "ok";
});

test("describeTool: 동사와 한 줄 설명, 승인 전에는 기본형 동사", () => {
  expect(JSON.stringify(describeTool("Bash", { command: "npm test\nsecond line" })) === '{"verb":"Ran","detail":"npm test"}', "bash");
  expect(describeTool("Edit", { file_path: "/Users/me/Repository/agent-nav/web/App.tsx" }).detail === "…/web/App.tsx", "edit path");
  expect(describeTool("Bash", { command: "ls" }, false).verb === "Run", "base verb");
  expect(describeTool("mcp__github__list_prs", {}).verb === "github: list_prs", "mcp name");
  expect(describeTool("Grep", { pattern: "foo", path: "/a/b/c/d" }).detail === "foo in …/c/d", "grep");
  return "ok";
});

test("stabilizeRows: 안 바뀐 행은 같은 객체, 스트리밍으로 바뀐 행만 새 객체", () => {
  const items: TimelineItem[] = [user("u"), tool("t1"), assistant("a", "hel", true)];
  const first = buildRows(items);
  const next = stabilizeRows(first, buildRows([items[0], items[1], assistant("a", "hello", true)]));
  expect(next[0] === first[0] && next[1] === first[1] && next[2] !== first[2], "only the streaming row changes identity");
  const added = stabilizeRows(first, buildRows([...items, tool("t2")]));
  expect(added.length === 4 && added[0] === first[0], "unchanged rows kept when one is appended");
  const grown = stabilizeRows(first, buildRows([items[0], items[1], tool("t9"), items[2]]));
  expect(grown[1] !== first[1], "a steps row that gained a step is a new row");
  return "ok";
});

void run();
