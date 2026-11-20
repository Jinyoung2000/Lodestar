import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "agent-nav-permission-unit-"));
process.env.AGENT_NAV_HOME = join(home, "nav");
mkdirSync(process.env.AGENT_NAV_HOME, { recursive: true });
const memory = new Map<string, string>();
const fake = { getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => void memory.set(k, v), removeItem: (k: string) => void memory.delete(k) };
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage = fake;
g.sessionStorage = fake;
g.window = g;
g.addEventListener = () => {}; // 브라우저의 window 는 이벤트 대상이다. web/idleReload.ts 가 불러올 때 입력 이벤트를 단다
g.removeEventListener = () => {};
g.document = { querySelector: () => null, documentElement: { dataset: {}, style: {} }, addEventListener() {}, hasFocus: () => true, visibilityState: "visible" };
g.location = { reload() {}, origin: "http://localhost" };

const { AgentRunner } = await import("../server/agents");
const { Store } = await import("../server/store");
const { draftDefaults } = await import("../web/defaults");
const { getState, rememberPick } = await import("../web/store");
type ServerEvent = import("../shared/protocol").ServerEvent;
type PermissionMode = import("../shared/protocol").PermissionMode;
type ResolvedDefaults = import("../shared/protocol").ResolvedDefaults;

const cases: { name: string; run: () => Promise<string> | string }[] = [];
const test = (name: string, run: () => Promise<string> | string) => cases.push({ name, run });
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
  return detail;
};

const store = new Store();
const events: ServerEvent[] = [];
const runner = new AgentRunner(store, (e) => events.push(e));
(runner as unknown as { send: () => Promise<void> }).send = async () => {};
type FakeRun = { query: { setPermissionMode: (mode: PermissionMode) => Promise<void>; close: () => void }; input: { close: () => void }; active: boolean; closed: boolean; permissionMode: PermissionMode; permissionSetAt: number; stopWatch: null; idleTimer: null; steers: Set<string> };
const runs = () => (runner as unknown as { runs: Map<string, FakeRun> }).runs;
const calls: PermissionMode[] = [];
let refuse: string | null = null;
let closed = 0;
function addRun(agentId: string, active: boolean, mode: PermissionMode) {
  const run: FakeRun = {
    query: {
      setPermissionMode: async (m) => {
        calls.push(m);
        if (refuse) throw new Error(refuse);
      },
      close: () => void closed++,
    },
    input: { close() {} },
    active,
    closed: false,
    permissionMode: mode,
    permissionSetAt: 0,
    stopWatch: null,
    idleTimer: null,
    steers: new Set(),
  };
  runs().set(agentId, run);
  return run;
}
const agentMode = (id: string) => store.agents.find((a) => a.id === id)?.permissionMode;
const lastAgentEvent = (id: string) => [...events].reverse().find((e) => e.type === "agent" && e.agent.id === id);

const created = await runner.create({ workspaceId: null, prompt: "hello", permissionMode: "default", model: null, effort: null, worktree: null });
const id = created.id;

test("살아 있는 프로세스에 먼저 적용하고 저장하고 알린다", async () => {
  const run = addRun(id, false, "default");
  await runner.setPermissionMode(id, "acceptEdits");
  expect(calls.at(-1) === "acceptEdits", "프로세스에 setPermissionMode 호출");
  expect(agentMode(id) === "acceptEdits" && run.permissionMode === "acceptEdits", "저장값과 프로세스 값");
  const event = lastAgentEvent(id);
  return expect(event?.type === "agent" && event.agent.permissionMode === "acceptEdits", "agent 이벤트가 새 값을 싣는다");
});

test("프로세스가 없는 세션은 저장만 한다(다음 턴이 그 값으로 뜬다)", async () => {
  runs().delete(id);
  const before = calls.length;
  await runner.setPermissionMode(id, "plan");
  expect(calls.length === before, "호출 없음");
  return expect(agentMode(id) === "plan", "저장됨");
});

test("응답 중인 프로세스가 거절하면 저장하지 않고 이유를 올린다", async () => {
  addRun(id, true, "plan");
  refuse = "Cannot set permission mode";
  let message = "";
  await runner.setPermissionMode(id, "bypassPermissions").catch((e: Error) => (message = e.message));
  refuse = null;
  expect(message === "Cannot set permission mode", `에러 전달 ${message}`);
  return expect(agentMode(id) === "plan", "저장값 그대로");
});

test("유휴 프로세스가 거절하면 프로세스를 닫고 저장한다(다음 턴이 새로 뜬다)", async () => {
  addRun(id, false, "plan");
  refuse = "Cannot set permission mode";
  closed = 0;
  await runner.setPermissionMode(id, "bypassPermissions");
  refuse = null;
  expect(closed === 1 && !runs().has(id), "프로세스 닫힘");
  return expect(agentMode(id) === "bypassPermissions", "저장됨");
});

test("프로세스가 응답하지 않으면 시간 제한 뒤 실패로 본다(응답 중이면 에러, 유휴면 닫고 저장)", async () => {
  (runner as unknown as { modeApplyTimeoutMs: number }).modeApplyTimeoutMs = 50;
  const before = agentMode(id);
  const run = addRun(id, true, "default");
  run.query.setPermissionMode = () => new Promise(() => {});
  let message = "";
  await runner.setPermissionMode(id, "plan").catch((e: Error) => (message = e.message));
  expect(/did not confirm/.test(message), `응답 중 시간 초과 ${message}`);
  expect(agentMode(id) === before, "저장값 그대로");
  const idleRun = addRun(id, false, "default");
  idleRun.query.setPermissionMode = () => new Promise(() => {});
  closed = 0;
  await runner.setPermissionMode(id, "plan");
  expect(closed === 1 && !runs().has(id), "유휴면 프로세스를 닫는다");
  return expect(agentMode(id) === "plan", "저장됨");
});

const resolved = (value: PermissionMode, source: "vscode" | "agent-nav" | "claude" | "builtin") =>
  ({
    model: { value: null, source: "builtin" },
    effort: { value: null, source: "builtin" },
    permissionMode: { value, source },
    diffInlineWhenNarrow: { value: true, source: "builtin" },
    sessionSort: { value: "updated", source: "builtin" },
    requestQueuing: { value: "queue", source: "builtin" },
    previewEditors: { value: true, source: "builtin" },
  }) as unknown as ResolvedDefaults;

test("새 세션 권한: 고른 적이 없으면 VS Code 값, 마지막으로 고른 값이 있으면 그것", () => {
  const none = draftDefaults(null, resolved("bypassPermissions", "vscode"), {});
  expect(none.permissionMode === "bypassPermissions" && none.permissionSource === "vscode", "VS Code");
  const last = draftDefaults(null, resolved("bypassPermissions", "vscode"), { permissionMode: "plan" });
  return expect(last.permissionMode === "plan" && last.permissionSource === "last", "last used");
});

test("새 세션 권한: Settings 에서 직접 고른 값이 마지막으로 고른 값보다 앞선다", () => {
  const d = draftDefaults(null, resolved("acceptEdits", "agent-nav"), { permissionMode: "plan" });
  return expect(d.permissionMode === "acceptEdits" && d.permissionSource === "agent-nav", `${d.permissionMode} ${d.permissionSource}`);
});

test("새 세션 모델과 effort 도 같은 순서: 직접 고른 값 > 마지막으로 고른 값 > VS Code", () => {
  const r = { ...resolved("default", "builtin"), model: { value: "opus", source: "agent-nav" }, effort: { value: "high", source: "vscode" } } as unknown as ResolvedDefaults;
  const d = draftDefaults(null, r, { model: "haiku", effort: "low" });
  expect(d.model === "opus" && d.modelSource === "agent-nav", "model: 직접 고른 값이 앞섬");
  return expect(d.effort === "low" && d.effortSource === "last", "effort: VS Code 값보다 마지막 값");
});

test("rememberPick 은 권한 모드를 저장하고, 저장된 값을 되읽는다", () => {
  rememberPick({ permissionMode: "auto" });
  expect(getState().lastPicked.permissionMode === "auto", "state");
  return expect(JSON.parse(memory.get("agent-nav:lastPicked") ?? "{}").permissionMode === "auto", "localStorage");
});

test("이 세션에서 허용(allowAlways): 파일 편집 도구는 넷이 한 묶음이고 Bash 같은 도구는 자기 하나만 (dogfood 2회차 8번)", async () => {
  const ask = (toolName: string) => (runner as unknown as { askPermission: (a: string, t: string, i: Record<string, unknown>, s: AbortSignal, u?: string) => Promise<{ behavior: string; updatedPermissions?: { type: string; behavior: string; destination: string; rules: { toolName: string }[] }[] }> }).askPermission(id, toolName, {}, new AbortController().signal, "tu-1");
  const answer = async (toolName: string, decision: "allow" | "allowAlways") => {
    const pending = ask(toolName);
    const item = [...store.timeline(id)].reverse().find((i) => i.kind === "permission" && i.status === "pending");
    runner.respondPermission(id, item!.id, decision);
    return pending;
  };
  const write = await answer("Write", "allowAlways");
  const names = write.updatedPermissions?.[0]?.rules.map((r) => r.toolName).sort().join(",");
  expect(names === "Edit,MultiEdit,NotebookEdit,Write", `Write 허용이 편집 도구 전부: ${names}`);
  expect(write.updatedPermissions?.[0]?.destination === "session" && write.updatedPermissions[0].behavior === "allow", "세션 안에서만 허용");
  const edit = await answer("Edit", "allowAlways");
  expect(edit.updatedPermissions?.[0]?.rules.length === 4, "Edit 를 허용해도 같은 묶음");
  const bash = await answer("Bash", "allowAlways");
  expect(bash.updatedPermissions?.[0]?.rules.map((r) => r.toolName).join(",") === "Bash", "Bash 는 Bash 만");
  const once = await answer("Write", "allow");
  return expect(once.updatedPermissions === undefined, "Allow Once 는 규칙을 남기지 않는다");
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
console.log(failed ? `${failed} failed` : `${cases.length} passed`);
process.exit(failed ? 1 : 0);
