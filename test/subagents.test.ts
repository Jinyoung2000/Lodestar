import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "agent-nav-subagents-unit-"));
process.env.AGENT_NAV_HOME = join(home, "nav");
mkdirSync(process.env.AGENT_NAV_HOME, { recursive: true });
const sub = await import("../server/subagents");
const shared = await import("../shared/subagents");
const { AgentRunner } = await import("../server/agents");
const { Store } = await import("../server/store");
const { groupTurns } = await import("../web/timelineModel");
type Agent = import("../shared/protocol").Agent;
type ServerEvent = import("../shared/protocol").ServerEvent;
type TimelineItem = import("../shared/protocol").TimelineItem;
type ToolItem = Extract<TimelineItem, { kind: "tool" }>;

const cases: { name: string; run: () => string | Promise<string> }[] = [];
const test = (name: string, run: () => string | Promise<string>) => cases.push({ name, run });
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
  return detail;
};

const NOW = "2026-10-15T12:00:00.000Z";
const LATER = "2026-10-15T12:00:09.000Z";
const tool = (patch: Partial<ToolItem> = {}): ToolItem => ({ id: "T1", kind: "tool", name: "Agent", input: { description: "Read a.txt", subagent_type: "general-purpose", run_in_background: true }, status: "running", output: null, task: sub.newTask({ description: "Read a.txt", subagent_type: "general-purpose", run_in_background: true }, NOW), ...patch });
const started = { type: "system", subtype: "task_started", task_id: "a1", tool_use_id: "T1", description: "Read a.txt word", subagent_type: "general-purpose", is_backgrounded: true, task_type: "local_agent" } as never;
const progress = { type: "system", subtype: "task_progress", task_id: "a1", tool_use_id: "T1", description: "Reading /tmp/a.txt", subagent_type: "general-purpose", usage: { total_tokens: 24038, tool_uses: 1, duration_ms: 1476 }, last_tool_name: "Read" } as never;
const notification = (status: "completed" | "failed" | "stopped", summary = "ALPHA\n\nThe file has one line.") => ({ type: "system", subtype: "task_notification", task_id: "a1", tool_use_id: "T1", status, output_file: "/x", summary, usage: { total_tokens: 29647, tool_uses: 1, duration_ms: 5084 } }) as never;

test("newTask: Agent 호출 입력만으로 현황을 만든다", () => {
  const task = sub.newTask({ description: "Read a.txt", subagent_type: "Explore", run_in_background: true }, NOW);
  const bare = sub.newTask({ prompt: "Find the thing\nand report" }, NOW);
  expect(task.status === "running" && task.backgrounded && task.subagentType === "Explore" && task.description === "Read a.txt", JSON.stringify(task));
  return expect(bare.description === "Find the thing" && !bare.backgrounded && bare.subagentType === null, JSON.stringify(bare));
});

test("task_started, task_progress: 이름, 토큰, 도구 수, 마지막 도구", () => {
  const a = sub.progressTask(sub.startTask(tool(), started, NOW), progress);
  const t = a.task!;
  return expect(t.taskId === "a1" && t.description === "Read a.txt word" && t.tokens === 24038 && t.toolUses === 1 && t.lastTool === "Read" && t.activity === "Reading /tmp/a.txt" && t.status === "running", JSON.stringify(t));
});

test("백그라운드 안내 결과는 끝이 아니고, 앞에서 기다린 결과는 끝이다", () => {
  const launched = sub.resultTask(tool({ task: sub.newTask({}, NOW) }), "Async agent launched successfully. (This tool result is internal metadata)", false, LATER);
  expect(launched.task!.status === "running" && launched.task!.backgrounded, JSON.stringify(launched.task));
  const waited = sub.resultTask(tool({ task: sub.newTask({}, NOW) }), "Found it\nmore text", false, LATER);
  expect(waited.task!.status === "completed" && waited.task!.summary === "Found it" && waited.task!.durationMs === 9000, JSON.stringify(waited.task));
  const failed = sub.resultTask(tool(), "denied", true, LATER);
  return expect(failed.task!.status === "failed", failed.task!.status);
});

test("task_notification: 완료, 실패, 중단과 결과 요약 첫 줄", () => {
  const done = sub.finishTask(sub.startTask(tool(), started, NOW), notification("completed"), LATER).task!;
  expect(done.status === "completed" && done.summary === "ALPHA" && done.tokens === 29647 && done.durationMs === 5084 && done.endedAt === LATER, JSON.stringify(done));
  const failed = sub.finishTask(tool(), notification("failed", "Error: boom"), LATER).task!;
  const stopped = sub.finishTask(tool(), notification("stopped", ""), LATER).task!;
  return expect(failed.status === "failed" && failed.summary === "Error: boom" && stopped.status === "stopped", `${failed.status} ${stopped.status}`);
});

test("끝난 서브에이전트는 늦게 온 갱신과 결과로 되살아나지 않는다", () => {
  const done = sub.finishTask(tool(), notification("completed"), LATER);
  const updated = sub.updateTask(done, { type: "system", subtype: "task_updated", task_id: "a1", patch: { status: "running" } } as never, LATER);
  const progressed = sub.progressTask(done, progress);
  const resulted = sub.resultTask(done, "later text", false, LATER);
  return expect(updated.task!.status === "completed" && progressed.task!.tokens === 29647 && resulted.task!.summary === "ALPHA", `${updated.task!.status} ${progressed.task!.tokens} ${resulted.task!.summary}`);
});

test("task_updated: 상태와 백그라운드 전환", () => {
  const moved = sub.updateTask(tool({ task: { ...sub.newTask({}, NOW), backgrounded: false } }), { type: "system", subtype: "task_updated", task_id: "a1", patch: { is_backgrounded: true } } as never, LATER);
  const killed = sub.updateTask(tool(), { type: "system", subtype: "task_updated", task_id: "a1", patch: { status: "killed" } } as never, LATER);
  return expect(moved.task!.backgrounded && killed.task!.status === "stopped" && killed.task!.endedAt === LATER, JSON.stringify([moved.task!.backgrounded, killed.task!.status]));
});

test("서브에이전트가 아닌 작업(백그라운드 Bash)의 task_* 는 다루지 않는다", () => {
  expect(!sub.isAgentTask({ task_type: "local_bash" }) && sub.isAgentTask({ task_type: "local_agent" }) && sub.isAgentTask({ subagent_type: "x" }), "isAgentTask");
  return "local_bash ignored";
});

test("background_tasks_changed: 목록에서 빠진 백그라운드 서브에이전트만 멈춘 것으로", () => {
  const items: TimelineItem[] = [
    tool({ id: "A", task: { ...sub.newTask({ run_in_background: true }, NOW), taskId: "t-a" } }),
    tool({ id: "B", task: { ...sub.newTask({ run_in_background: true }, NOW), taskId: "t-b" } }),
    tool({ id: "C", task: { ...sub.newTask({}, NOW), taskId: "t-c" } }),
    tool({ id: "D", task: sub.newTask({ run_in_background: true }, NOW) }),
  ];
  const changed = sub.reconcileTasks(items, new Set(["t-b"]), LATER);
  return expect(changed.length === 1 && changed[0].id === "A" && changed[0].task!.status === "stopped", `${changed.map((c) => c.id)} (B 는 살아 있고, C 는 앞에서 기다리는 중, D 는 task_started 전)`);
});

test("settleStale: 디스크에서 읽은 도는 서브에이전트와 단계는 멈춘 것으로", () => {
  const child: ToolItem = { id: "C1", kind: "tool", name: "Read", input: {}, status: "running", output: null, parentToolUseId: "T1" };
  const [a, b] = sub.settleStale([tool(), child]) as ToolItem[];
  return expect(a.task!.status === "stopped" && b.status === "error" && b.cancelled === true, `${a.task!.status} ${b.status}`);
});

test("slimInput, slimOutput: 긴 값은 줄여 저장", () => {
  const long = "x".repeat(2000);
  const input = sub.slimInput({ file_path: "/a", content: long, n: 3 });
  return expect((input.content as string).length < 500 && input.file_path === "/a" && input.n === 3 && sub.slimOutput(long).length < 600, String((input.content as string).length));
});

test("mainFlow, groupTurns: 서브에이전트가 부른 도구는 대화의 단계 목록에서 빠진다", () => {
  const child: ToolItem = { id: "C1", kind: "tool", name: "Read", input: {}, status: "done", output: "x", parentToolUseId: "T1" };
  const items: TimelineItem[] = [
    { id: "u", kind: "user", text: "go", source: "user" },
    tool({ status: "done" }),
    child,
    { id: "p", kind: "permission", toolUseId: "C1", toolName: "Read", input: {}, status: "allowed" },
    { id: "a", kind: "assistant", text: "done", streaming: false },
  ];
  const blocks = groupTurns(items);
  const steps = blocks.flatMap((b) => (b.kind === "steps" ? b.items : []));
  expect(steps.length === 1 && steps[0].item.id === "T1", `steps ${steps.map((s) => s.item.id)}`);
  return expect(shared.mainFlow(items).length === 3 && shared.runningBackground(items).length === 1, "mainFlow keeps user, Agent row, assistant; the Agent row is still a running background task");
});

const dir = join(home, "work");
mkdirSync(dir, { recursive: true });
let seq = 0;
const agentRecord = (id: string): Agent => ({ id, workspaceId: null, cwd: dir, worktree: null, forkedFrom: null, resumeFrom: null, startCommit: null, feedbackId: null, title: "t", sessionId: "s", status: "idle", permissionMode: "default", model: null, effort: null, activeModel: "claude-haiku-5-5", activeEffort: null, backgroundTasks: 0, createdAt: NOW, updatedAt: NOW });

function harness() {
  const store = new Store();
  const events: ServerEvent[] = [];
  const runner = new AgentRunner(store, (e) => events.push(JSON.parse(JSON.stringify(e)) as ServerEvent));
  const id = `ag${++seq}`;
  store.addAgent(agentRecord(id));
  const usage = { totalTokens: 34968, maxTokens: 1_000_000, rawMaxTokens: 1_000_000 };
  const run = { query: { close() {}, getContextUsage: async () => usage }, input: { close() {} }, draftId: null, active: true, interrupted: false, turnMessageId: null, steers: new Set(), model: null, effort: null, permissionMode: "default", permissionSetAt: 0, idleTimer: null, closed: false, apiError: false, approvalWaitMs: 0, stopWatch: null, ctxSeq: 0 };
  (runner as unknown as { runs: Map<string, unknown> }).runs.set(id, run);
  const feed = (message: unknown) => (runner as unknown as { handleMessage: (id: string, run: unknown, m: unknown) => Promise<void> }).handleMessage(id, run, message);
  const items = () => store.timeline(id);
  const item = (id: string) => items().find((i) => i.id === id) as ToolItem | undefined;
  return { id, store, runner, run, feed, items, item, events };
}

test("흐름: 백그라운드 서브에이전트가 턴이 끝난 뒤에도 돌다가 알림으로 끝난다", async () => {
  const h = harness();
  await h.feed({ type: "assistant", parent_tool_use_id: null, uuid: "m1", message: { model: "claude-haiku-5-5", usage: { input_tokens: 2, cache_read_input_tokens: 22530, cache_creation_input_tokens: 4367, output_tokens: 17 }, content: [{ type: "tool_use", id: "T1", name: "Agent", input: { description: "Read a.txt", subagent_type: "general-purpose", run_in_background: true } }] } });
  expect(h.item("T1")?.task?.status === "running" && h.item("T1")?.task?.backgrounded === true, "task at tool_use");
  await h.feed(started);
  expect(h.item("T1")?.task?.taskId === "a1", "taskId from task_started");
  await h.feed({ type: "user", parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "T1", content: [{ type: "text", text: "Async agent launched successfully. (This tool result is internal metadata)" }] }] } });
  expect(h.item("T1")?.status === "done" && h.item("T1")?.task?.status === "running", "launch result keeps task running");
  expect(shared.runningBackground(h.items()).length === 1, "chip counts 1");

  await h.feed({ type: "assistant", parent_tool_use_id: null, uuid: "m2", message: { model: "claude-haiku-5-5", usage: { input_tokens: 2, cache_read_input_tokens: 26486, cache_creation_input_tokens: 7637, output_tokens: 4 }, content: [{ type: "text", text: "launched" }] } });
  await h.feed({ type: "result", subtype: "success", is_error: false, num_turns: 1, duration_ms: 500, total_cost_usd: 0, uuid: "r1", user_message_uuids: [], queued_turn_count: 0 });
  expect(h.run.active === false && h.store.agent(h.id).status === "idle", `turn ended (active=${h.run.active})`);
  await h.feed({ type: "assistant", parent_tool_use_id: "T1", uuid: "c1", message: { model: "claude-haiku-5-5", usage: { input_tokens: 2, cache_read_input_tokens: 18374, cache_creation_input_tokens: 5642, output_tokens: 16 }, content: [{ type: "tool_use", id: "C1", name: "Read", input: { file_path: "/tmp/a.txt" } }] } });
  await h.feed(progress);
  await h.feed({ type: "user", parent_tool_use_id: "T1", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "C1", content: "1\talpha file: contains the word ALPHA\n2\t" }] } });
  const child = h.item("C1");
  expect(child?.parentToolUseId === "T1" && child.status === "done" && child.name === "Read" && String(child.output).startsWith("1\talpha"), JSON.stringify(child));
  expect(h.run.active === false && h.store.agent(h.id).status === "idle", `child frames must not open a turn (active=${h.run.active}, status=${h.store.agent(h.id).status})`);
  expect(h.item("T1")?.task?.toolUses === 1 && h.item("T1")?.task?.tokens === 24038, "progress usage");
  expect(h.store.agent(h.id).contextUsage === undefined || h.store.agent(h.id).contextUsage?.used !== 18374 + 5642 + 2, "child usage is not the session context");

  await h.feed(notification("completed"));
  const t = h.item("T1")!.task!;
  expect(t.status === "completed" && t.summary === "ALPHA", JSON.stringify(t));
  expect(shared.runningBackground(h.items()).length === 0, "chip count back to 0");
  expect(h.items().some((i) => i.kind === "notice" && i.text.includes("ALPHA")), "notice kept");
  const upserts = h.events.filter((e) => e.type === "timelineUpsert" && e.item.kind === "tool" && e.item.id === "T1").length;
  return expect(upserts >= 5, `${upserts} upserts of the Agent row`);
});

test("흐름: 도는 중 프로세스가 닫히면 멈춘 것으로 바뀐다", () => {
  const h = harness();
  h.store.upsertItem(h.id, tool({ id: "T9" }));
  (h.runner as unknown as { closeRun: (id: string) => void }).closeRun(h.id);
  return expect(h.item("T9")?.task?.status === "stopped", h.item("T9")?.task?.status ?? "none");
});

test("흐름: 앞에서 기다린 서브에이전트(task_started 가 foreground)는 결과가 끝이다", async () => {
  const h = harness();
  await h.feed({ type: "assistant", parent_tool_use_id: null, uuid: "m1", message: { model: "m", usage: {}, content: [{ type: "tool_use", id: "T2", name: "Task", input: { description: "Explore", prompt: "p" } }] } });
  await h.feed({ type: "system", subtype: "task_started", task_id: "a2", tool_use_id: "T2", description: "Explore", is_backgrounded: false, task_type: "local_agent" });
  expect(h.item("T2")?.task?.backgrounded === false, "foreground");
  await h.feed({ type: "user", parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "T2", content: [{ type: "text", text: "Found 3 files\nfoo" }] }] } });
  const t = h.item("T2")!.task!;
  return expect(t.status === "completed" && t.summary === "Found 3 files", JSON.stringify(t));
});

test("흐름: 백그라운드 Bash 의 task_* 는 Agent 행에 영향이 없다", async () => {
  const h = harness();
  await h.feed({ type: "assistant", parent_tool_use_id: null, uuid: "m1", message: { model: "m", usage: {}, content: [{ type: "tool_use", id: "B1", name: "Bash", input: { command: "sleep 5" } }] } });
  await h.feed({ type: "system", subtype: "task_started", task_id: "b1", tool_use_id: "B1", description: "sleep", task_type: "local_bash" });
  await h.feed({ type: "system", subtype: "task_notification", task_id: "b1", tool_use_id: "B1", status: "completed", summary: "done", output_file: "/x" });
  return expect(h.item("B1")?.task === undefined, "bash has no task");
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
