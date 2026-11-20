import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent, DiffFeedback, QueuedMessage, ServerEvent } from "../shared/protocol";

const home = mkdtempSync(join(tmpdir(), "agent-nav-queuecancel-unit-"));
process.env.AGENT_NAV_HOME = join(home, "nav");
mkdirSync(process.env.AGENT_NAV_HOME, { recursive: true });

const { AgentRunner } = await import("../server/agents");
const { Store } = await import("../server/store");
const { PushQueue, userMessage } = await import("../server/turnInput");
const { lastPending } = await import("../web/pendingMessages");

const cases: { name: string; run: () => Promise<void> | void }[] = [];
const test = (name: string, run: () => Promise<void> | void) => cases.push({ name, run });
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
};

const store = new Store();
const events: ServerEvent[] = [];
const runner = new AgentRunner(store, (e) => events.push(e));
type Result = { cancelled: true; text: string } | { cancelled: false } | null;
type Inside = {
  runs: Map<string, unknown>;
  foldSteers: (agentId: string, uuids: string[]) => void;
  finishTurn: (agentId: string, run: unknown, outcome: "ok" | "error" | "interrupted") => void;
  send: (agentId: string, prompt: string, options?: object) => Promise<{ queued: boolean }>;
};
const inside = runner as unknown as Inside;

let counter = 0;
function newAgent(extra: Partial<Agent> = {}): Agent {
  const now = new Date().toISOString();
  const a = { id: `a-${++counter}`, workspaceId: null, cwd: home, worktree: null, forkedFrom: null, resumeFrom: null, startCommit: null, feedbackId: null, title: "t", sessionId: null, status: "running", permissionMode: "default", model: null, effort: null, activeModel: null, activeEffort: null, backgroundTasks: 0, createdAt: now, updatedAt: now, ...extra } as unknown as Agent;
  store.addAgent(a);
  return a;
}

// cancel 은 CLI 에 물어볼 답을 줄 수 있는 가짜 프로세스. calls 로 CLI 에 간 물음을 센다.
function fakeRun(answer: (uuid: string) => Promise<boolean | undefined> | boolean | undefined) {
  const calls: string[] = [];
  const run = {
    query: { cancelAsyncMessage: async (uuid: string) => (calls.push(uuid), answer(uuid)) },
    input: new PushQueue(),
    steers: new Set<string>(),
    active: true,
    closed: false,
    interrupted: false,
    turnMessageId: null,
    draftId: null,
    approvalWaitMs: 0,
    apiError: false,
    idleTimer: null,
    idleSince: 0,
    stopWatch: null,
  };
  return { run, calls };
}

// 끼어들기를 하나 보낸 상태를 만든다. pulled 가 true 면 PushQueue 의 메시지를 SDK 가 이미 꺼내 간 것으로 본다(CLI 명령 큐에 있는 상태).
async function steerState(run: ReturnType<typeof fakeRun>["run"], agent: Agent, id: string, extras: Partial<QueuedMessage> = {}, pulled = true) {
  const iterator = run.input[Symbol.asyncIterator]();
  run.input.push(userMessage("steer me", id, "next"));
  if (pulled) await iterator.next();
  run.steers.add(id);
  store.patchAgent(agent.id, { steering: [...(store.agent(agent.id).steering ?? []), { id, text: "steer me", ...extras }] });
  inside.runs.set(agent.id, run);
}

test("PushQueue.remove: 아직 꺼내 가지 않은 메시지만 빼고 나머지 순서는 그대로다", async () => {
  const queue = new PushQueue();
  queue.push(userMessage("a", "u1"));
  queue.push(userMessage("b", "u2"));
  queue.push(userMessage("c", "u3"));
  expect(queue.remove("u2"), "대기 중인 것은 뺀다");
  expect(!queue.remove("u2") && !queue.remove("nope"), "없는 것은 false");
  const iterator = queue[Symbol.asyncIterator]();
  const first = await iterator.next();
  expect(!queue.remove("u1"), "이미 꺼내 간 것은 뺄 수 없다");
  const second = await iterator.next();
  expect(String(first.value.message.content) === "a" && String(second.value.message.content) === "c", "남은 순서 a, c");
});

test("cancelSteering: 우리 입력 큐에 남아 있으면 CLI 에 묻지 않고 빼서 글을 돌려준다", async () => {
  const agent = newAgent();
  const { run, calls } = fakeRun(() => true);
  await steerState(run, agent, "s1", {}, false);
  const result = (await runner.cancelSteering(agent.id, "s1")) as Result;
  expect(result?.cancelled === true && result.text === "steer me", JSON.stringify(result));
  expect(calls.length === 0, "CLI 호출 없음");
  expect(!store.agent(agent.id).steering && run.steers.size === 0, "Steering 표시와 run.steers 에서 모두 빠진다");
  const rest = run.input[Symbol.asyncIterator]();
  run.input.close();
  expect((await rest.next()).done === true, "입력 큐에서도 빠져 CLI 로 안 간다");
});

test("cancelSteering: CLI 명령 큐에 있으면(true) 지우고, run.steers 에서도 빼서 턴 끝 판단이 막히지 않는다", async () => {
  const agent = newAgent();
  const { run, calls } = fakeRun(() => true);
  await steerState(run, agent, "s1");
  const result = (await runner.cancelSteering(agent.id, "s1")) as Result;
  expect(result?.cancelled === true && calls.join() === "s1", `취소 ${JSON.stringify(result)} ${calls}`);
  expect(!store.agent(agent.id).steering?.length, "Steering 에서 빠진다");
  expect(run.steers.size === 0, "남은 uuid 가 있으면 다음 result 가 steered 로 읽혀 세션이 안 끝난다");
});

test("cancelSteering: 묶인 diff 피드백은 다시 쌓인 상태로 돌아간다", async () => {
  const agent = newAgent();
  const feedback = { id: "f1", state: "submitted", text: "fix", createdAt: "x" } as unknown as DiffFeedback;
  store.setDiffFeedback(agent.id, [feedback]);
  const { run } = fakeRun(() => true);
  await steerState(run, agent, "s1", { feedback: [feedback], shown: "typed" });
  const result = (await runner.cancelSteering(agent.id, "s1")) as Result;
  expect(result?.cancelled === true && result.text === "typed", "입력창에 쓴 글을 돌려준다");
  expect(store.diffFeedback(agent.id)[0].state !== "submitted", "다시 쌓인 상태");
});

test("cancelSteering: CLI 가 이미 넘겨받았으면(false) 지우지 않고 sent 표지만 단다", async () => {
  const agent = newAgent();
  const { run } = fakeRun(() => false);
  await steerState(run, agent, "s1");
  const result = (await runner.cancelSteering(agent.id, "s1")) as Result;
  expect(result?.cancelled === false, JSON.stringify(result));
  expect(store.agent(agent.id).steering?.[0].sent === true && store.agent(agent.id).steering?.length === 1, "항목은 남고 sent");
  expect(run.steers.has("s1"), "아직 모델이 받아 처리 중인 메시지라 run.steers 는 그대로");
  inside.foldSteers(agent.id, ["s1"]);
  expect(!store.agent(agent.id).steering?.length, "곧 오는 started 가 말풍선으로 옮긴다");
  expect(store.timeline(agent.id).some((i) => i.kind === "user" && i.messageId === "s1"), "대화에 사용자 말풍선");
});

test("cancelSteering: 묻는 사이에 모델이 받아 말풍선이 됐으면 null 이고 sent 를 달지 않는다", async () => {
  const agent = newAgent();
  const { run } = fakeRun(async () => {
    inside.foldSteers(agent.id, ["s1"]);
    return false;
  });
  await steerState(run, agent, "s1");
  const result = await runner.cancelSteering(agent.id, "s1");
  expect(result === null, JSON.stringify(result));
  expect(store.timeline(agent.id).filter((i) => i.kind === "user" && i.messageId === "s1").length === 1, "말풍선은 하나");
});

test("cancelSteering: 같은 메시지에 대한 두 번째 요청은 CLI 에 다시 묻지 않는다", async () => {
  const agent = newAgent();
  let release: (v: boolean) => void = () => {};
  const { run, calls } = fakeRun(() => new Promise<boolean>((r) => (release = r)));
  await steerState(run, agent, "s1");
  const first = runner.cancelSteering(agent.id, "s1");
  const second = await runner.cancelSteering(agent.id, "s1");
  release(true);
  const firstResult = (await first) as Result;
  expect(second === null && calls.length === 1, `두 번째 ${second} 호출 ${calls.length}`);
  expect(firstResult?.cancelled === true, "첫 요청은 취소됨");
  expect((await runner.cancelSteering(agent.id, "s1")) === null, "취소된 뒤의 요청은 null");
});

test("cancelSteering: 이 CLI 가 취소를 지원하지 않으면 지우지 않고 오류를 낸다", async () => {
  const agent = newAgent();
  const { run } = fakeRun(() => true);
  (run.query as { cancelAsyncMessage?: unknown }).cancelAsyncMessage = undefined;
  await steerState(run, agent, "s1");
  let message = "";
  await runner.cancelSteering(agent.id, "s1").catch((e: Error) => (message = e.message));
  expect(message.includes("cannot cancel") && store.agent(agent.id).steering?.length === 1 && run.steers.has("s1"), `오류 ${message}`);
});

test("dequeue 와 턴 끝의 큐 발송이 겹쳐도 한 쪽만 이긴다(먼저 dequeue 면 보내지 않고, 먼저 발송이면 null)", async () => {
  const sent: string[] = [];
  const realSend = inside.send.bind(runner);
  inside.send = async (_id, prompt) => (sent.push(prompt), { queued: false });
  try {
    for (const dequeueFirst of [true, false]) {
      sent.length = 0;
      const agent = newAgent();
      store.patchAgent(agent.id, { queue: [{ id: "q1", text: "first" }, { id: "q2", text: "second" }] });
      const { run } = fakeRun(() => true);
      inside.runs.set(agent.id, run);
      let taken: { text: string } | null = null;
      if (dequeueFirst) taken = runner.dequeue(agent.id, "q1");
      inside.finishTurn(agent.id, run, "ok");
      if (!dequeueFirst) taken = runner.dequeue(agent.id, "q1");
      if (dequeueFirst) {
        expect(taken?.text === "first" && sent.join() === "second", `먼저 dequeue: 가져감 ${taken?.text}, 발송 ${sent}`);
        expect(!store.agent(agent.id).queue?.length, "큐가 빈다");
      } else {
        expect(taken === null && sent.join() === "first", `먼저 발송: dequeue ${taken}, 발송 ${sent}`);
        expect(store.agent(agent.id).queue?.length === 1 && store.agent(agent.id).queue?.[0].id === "q2", "남은 건 둘째 하나");
      }
      inside.runs.delete(agent.id);
    }
  } finally {
    inside.send = realSend;
  }
});

test("중단으로 끝난 턴에 남은 Steering 은 sent 표지를 떼고 큐로 돌아간다", () => {
  const agent = newAgent();
  store.patchAgent(agent.id, { steering: [{ id: "s1", text: "keep me", sent: true }] });
  const { run } = fakeRun(() => true);
  run.steers.add("s1");
  inside.runs.set(agent.id, run);
  inside.finishTurn(agent.id, run, "interrupted");
  const queue = store.agent(agent.id).queue ?? [];
  expect(queue.length === 1 && queue[0].text === "keep me" && queue[0].sent === undefined, JSON.stringify(queue));
  expect(!store.agent(agent.id).steering?.length, "Steering 은 비워진다");
});

test("lastPending: 큐의 마지막이 먼저, 큐가 비면 아직 안 넘어간 Steering 의 마지막, 둘 다 없으면 null(입력 기록으로 간다)", () => {
  const queue = [{ id: "q1", text: "a" }, { id: "q2", text: "b" }];
  const steering = [{ id: "s1", text: "c" }, { id: "s2", text: "d", sent: true }];
  expect(JSON.stringify(lastPending({ queue, steering })) === JSON.stringify({ kind: "queue", id: "q2" }), "큐 우선");
  expect(JSON.stringify(lastPending({ steering })) === JSON.stringify({ kind: "steering", id: "s1" }), "sent 는 건너뛴다");
  expect(lastPending({ steering: [{ id: "s2", text: "d", sent: true }] }) === null, "넘어간 것만 있으면 null");
  expect(lastPending({}) === null && lastPending(undefined) === null, "없음");
});

let failed = 0;
for (const c of cases) {
  try {
    await c.run();
    console.log(`ok   ${c.name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${c.name}: ${(error as Error).message}`);
  }
}
console.log(failed ? `${failed} failed` : `${cases.length} passed`);
process.exit(failed ? 1 : 0);
