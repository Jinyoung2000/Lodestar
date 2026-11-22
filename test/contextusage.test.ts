import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "agent-nav-context-unit-"));
process.env.AGENT_NAV_HOME = join(home, "nav");
mkdirSync(process.env.AGENT_NAV_HOME, { recursive: true });
const c = await import("../shared/contextUsage");
const { AgentRunner } = await import("../server/agents");
const { Store } = await import("../server/store");
type Agent = import("../shared/protocol").Agent;
type ServerEvent = import("../shared/protocol").ServerEvent;

const cases: { name: string; run: () => string | Promise<string> }[] = [];
const test = (name: string, run: () => string | Promise<string>) => cases.push({ name, run });
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
  return detail;
};
const NOW = "2026-10-15T12:00:00.000Z";
const usage = (used: number, limit: number) => ({ used, limit, source: "api" as const, at: NOW });

test("비율, 퍼센트, 단계: 80% 부터 경고, 95% 부터 오류", () => {
  const levels = [[0, "ok"], [79_999, "ok"], [80_000, "warning"], [94_999, "warning"], [95_000, "error"], [120_000, "error"]] as const;
  for (const [used, level] of levels) expect(c.contextLevel(usage(used, 100_000)) === level, `${used} -> ${c.contextLevel(usage(used, 100_000))}`);
  expect(c.contextPercent(usage(34_968, 1_000_000)) === 3 && c.contextPercent(usage(0, 0)) === 0, "percent");
  return "6 thresholds";
});

test("formatTokens: k, M 표기", () => {
  const got = [0, 999, 1000, 12_345, 100_000, 999_999, 1_000_000, 1_500_000].map(c.formatTokens).join(" ");
  return expect(got === "0 999 1k 12.3k 100k 1000k 1M 1.5M", got);
});

test("usedFromUsage: 입력 + 캐시 읽기 + 캐시 쓰기(출력은 세지 않는다), 전부 0 이면 null", () => {
  expect(c.usedFromUsage({ input_tokens: 2, cache_read_input_tokens: 26486, cache_creation_input_tokens: 7637, output_tokens: 4 }) === 34125, "sum");
  expect(c.usedFromUsage({ input_tokens: 0, output_tokens: 5 }) === null && c.usedFromUsage(undefined) === null, "zero");
  return "34125";
});

test("fallbackLimit: [1m] 변형만 1M", () => {
  return expect(c.fallbackLimit("claude-sonnet-5[1m]") === 1_000_000 && c.fallbackLimit("claude-haiku-5-5") === 200_000 && c.fallbackLimit(null) === 200_000, "limits");
});

test("estimateContext: SDK 가 준 창 크기가 있으면 그것을 쓴다", () => {
  const first = c.estimateContext(undefined, { input_tokens: 10 }, "claude-haiku-5-5", NOW)!;
  const next = c.estimateContext(usage(30_000, 1_000_000), { input_tokens: 10, cache_read_input_tokens: 40_000 }, "claude-haiku-5-5", NOW)!;
  return expect(first.limit === 200_000 && first.source === "estimate" && next.limit === 1_000_000 && next.used === 40_010, JSON.stringify([first, next]));
});

test("contextFromApi: totalTokens 와 rawMaxTokens, 비정상 값은 버린다", () => {
  const ok = c.contextFromApi({ totalTokens: 34968, rawMaxTokens: 1_000_000, maxTokens: 1_000_000 }, NOW)!;
  expect(ok.used === 34968 && ok.limit === 1_000_000 && ok.source === "api", JSON.stringify(ok));
  expect(c.contextFromApi({ totalTokens: 10, rawMaxTokens: 0 }, NOW) === null && c.contextFromApi({ totalTokens: -1, rawMaxTokens: 100 }, NOW) === null, "invalid");
  return "ok";
});

test("압축: post_tokens 로 바로 내려간다", () => {
  const before = usage(180_000, 200_000);
  const after = c.contextAfterCompact(before, 12_000, null, NOW)!;
  expect(c.contextPercent(before) === 90 && c.contextLevel(before) === "warning", "before");
  expect(c.contextPercent(after) === 6 && c.contextLevel(after) === "ok" && after.limit === 200_000, JSON.stringify(after));
  return expect(c.contextAfterCompact(before, undefined, null, NOW) === null, "no post_tokens -> null");
});

let seq = 0;
const agentRecord = (id: string): Agent => ({ id, workspaceId: null, cwd: home, worktree: null, forkedFrom: null, resumeFrom: null, startCommit: null, feedbackId: null, title: "t", sessionId: "s", status: "idle", permissionMode: "default", model: null, effort: null, activeModel: "claude-haiku-5-5", activeEffort: null, backgroundTasks: 0, createdAt: NOW, updatedAt: NOW });
function harness(api: () => Promise<{ totalTokens: number; maxTokens: number; rawMaxTokens: number }>) {
  const store = new Store();
  const events: ServerEvent[] = [];
  const runner = new AgentRunner(store, (e) => events.push(JSON.parse(JSON.stringify(e)) as ServerEvent));
  const id = `ag${++seq}`;
  store.addAgent(agentRecord(id));
  const run = { query: { close() {}, getContextUsage: api }, input: { close() {} }, draftId: null, active: true, interrupted: false, turnMessageId: null, steers: new Set(), model: null, effort: null, permissionMode: "default", permissionSetAt: 0, idleTimer: null, closed: false, apiError: false, approvalWaitMs: 0, stopWatch: null, ctxSeq: 0 };
  (runner as unknown as { runs: Map<string, unknown> }).runs.set(id, run);
  const feed = (message: unknown) => (runner as unknown as { handleMessage: (id: string, run: unknown, m: unknown) => Promise<void> }).handleMessage(id, run, message);
  return { store, run, feed, events, context: () => store.agent(id).contextUsage };
}
const assistant = (used: number, parent: string | null = null) => ({ type: "assistant", parent_tool_use_id: parent, uuid: `m${used}`, message: { model: "claude-haiku-5-5", usage: { input_tokens: 1, cache_read_input_tokens: used - 1, cache_creation_input_tokens: 0, output_tokens: 3 }, content: [{ type: "text", text: "hi" }] } });
const result = { type: "result", subtype: "success", is_error: false, num_turns: 1, duration_ms: 1, total_cost_usd: 0, uuid: "r", user_message_uuids: [], queued_turn_count: 0 };
const settle = () => new Promise((r) => setTimeout(r, 20));

test("응답 프레임으로 어림하고, 턴이 끝나면 SDK 값으로 바뀐다", async () => {
  const h = harness(async () => ({ totalTokens: 34968, maxTokens: 1_000_000, rawMaxTokens: 1_000_000 }));
  await h.feed(assistant(32_737));
  expect(h.context()?.used === 32_737 && h.context()?.source === "estimate" && h.context()?.limit === 200_000, JSON.stringify(h.context()));
  await h.feed(result);
  await settle();
  const got = h.context()!;
  expect(got.used === 34968 && got.limit === 1_000_000 && got.source === "api", JSON.stringify(got));
  const emitted = h.events.filter((e) => e.type === "agent").length;
  return expect(emitted >= 2, `${emitted} agent events (estimate, then api)`);
});

test("서브에이전트의 프레임은 세션 컨텍스트로 세지 않는다", async () => {
  const h = harness(async () => ({ totalTokens: 1, maxTokens: 1, rawMaxTokens: 1 }));
  await h.feed(assistant(50_000, "T1"));
  return expect(h.context() === undefined, JSON.stringify(h.context()));
});

test("압축이 일어나면 사용률이 내려간다", async () => {
  let total = 190_000;
  const h = harness(async () => ({ totalTokens: total, maxTokens: 200_000, rawMaxTokens: 200_000 }));
  await h.feed(assistant(189_000));
  await h.feed(result);
  await settle();
  expect(c.contextLevel(h.context()!) === "warning" && c.contextPercent(h.context()!) === 95 || c.contextLevel(h.context()!) === "error", `before ${JSON.stringify(h.context())}`);
  total = 14_000;
  await h.feed({ type: "system", subtype: "compact_boundary", uuid: "cb", compact_metadata: { trigger: "auto", pre_tokens: 190_000, post_tokens: 13_000 } });
  const seen = h.events.flatMap((e) => (e.type === "agent" && e.agent.contextUsage ? [e.agent.contextUsage] : []));
  const dropped = seen.find((u) => u.used === 13_000);
  expect(!!dropped && c.contextPercent(dropped) === 7 && c.contextLevel(dropped) === "ok", `right after boundary ${JSON.stringify(seen.map((u) => u.used))}`);
  await settle();
  return expect(h.context()!.used === 14_000 && h.context()!.source === "api", `after SDK ${JSON.stringify(h.context())}`);
});

test("SDK 의 늦은 답은 더 새 값을 덮지 않는다", async () => {
  let release: (v: { totalTokens: number; maxTokens: number; rawMaxTokens: number }) => void = () => {};
  const h = harness(() => new Promise((r) => (release = r)));
  await h.feed(result);
  await h.feed(assistant(70_000));
  release({ totalTokens: 5, maxTokens: 100, rawMaxTokens: 100 });
  await settle();
  return expect(h.context()?.used === 70_000, JSON.stringify(h.context()));
});

test("SDK 호출이 실패해도 어림한 값을 지킨다(프로세스가 닫히는 중)", async () => {
  const h = harness(async () => {
    throw new Error("Query closed before response received");
  });
  await h.feed(assistant(40_000));
  await h.feed(result);
  await settle();
  return expect(h.context()?.used === 40_000, JSON.stringify(h.context()));
});

test("estimateContext: 같은 모델의 SDK 창 크기를 쓰고, 읽은 양이 어림 창보다 크면 1M 으로 올린다", () => {
  const known = c.estimateContext(undefined, { input_tokens: 10, cache_read_input_tokens: 50_000 }, "claude-sonnet-5-5", NOW, 1_000_000)!;
  const over = c.estimateContext(undefined, { input_tokens: 10, cache_read_input_tokens: 248_000 }, "claude-sonnet-5-5", NOW)!;
  const under = c.estimateContext(undefined, { input_tokens: 10, cache_read_input_tokens: 50_000 }, "claude-sonnet-5-5", NOW)!;
  return expect(known.limit === 1_000_000 && over.limit === 1_000_000 && under.limit === 200_000, `${known.limit} ${over.limit} ${under.limit}`);
});

let failed = 0;
for (const t of cases) {
  try {
    console.log(`ok   ${t.name} (${await t.run()})`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${t.name}: ${(error as Error).message}`);
  }
}
rmSync(home, { recursive: true, force: true });
console.log(failed ? `${failed} failed` : `${cases.length} passed`);
process.exit(failed ? 1 : 0);
