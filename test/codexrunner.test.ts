// CODEX: Codex 세션 실행기(server/codex/)를 가짜 앱 서버(test/fixtures/codex/app-server.mjs)로 시험한다.
// 스트리밍, 명령 실행과 파일 변경의 승인(허용과 거절), 중단, 오류, 큐, 데몬 재시작 뒤 thread/resume, 앱 서버 비정상 종료, 모델 목록과 로그인 상태, Codex 에 없는 기능의 거절을 본다.
// 실제 Codex 는 부르지 않는다. 실행: npm test
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = realpathSync(mkdtempSync(join(tmpdir(), "agent-nav-codex-")));
const home = join(root, "home");
const fakeState = join(root, "fake-state");
const logFile = join(root, "requests.jsonl");
mkdirSync(home);
process.env.AGENT_NAV_HOME = home;
process.env.AGENT_NAV_CODEX = resolve("test/fixtures/codex/app-server.mjs");
process.env.FAKE_CODEX_LOG = logFile;
process.env.FAKE_CODEX_STATE = fakeState;

const { Store } = await import("../server/store");
const { AgentRunner } = await import("../server/agents");
const { AppServer } = await import("../server/codex/appServer");
type Item = import("../shared/protocol").TimelineItem;
type ServerEvent = import("../shared/protocol").ServerEvent;

const repo = join(root, "repo");
mkdirSync(repo);
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" }).toString().trim();
git("init", "-q", "-b", "main");
git("config", "user.email", "t@example.com");
git("config", "user.name", "t");
writeFileSync(join(repo, "fixture-note.txt"), "existing line\n");
git("add", ".");
git("commit", "-q", "-m", "init");

const store = new Store();
const workspace = store.addWorkspace(repo);
const events: ServerEvent[] = [];
const emit = (event: ServerEvent) => events.push(event);
let runner = new AgentRunner(store, emit);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
};
async function until(check: () => boolean, detail: string, ms = 8000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`시간 초과: ${detail}`);
    await sleep(15);
  }
}
const requests = () => (existsSync(logFile) ? readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { method: string; params: Record<string, any> }) : []);
const timeline = (id: string) => store.timeline(id);
const find = <K extends Item["kind"]>(id: string, kind: K, pick: (item: Extract<Item, { kind: K }>) => boolean = () => true) => timeline(id).find((i): i is Extract<Item, { kind: K }> => i.kind === kind && pick(i as Extract<Item, { kind: K }>));
const idle = (id: string) => until(() => store.agent(id).status === "idle" || store.agent(id).status === "error", `${id.slice(0, 8)} 가 끝나기`);
const create = (prompt: string, permissionMode: "default" | "acceptEdits" | "auto" | "bypassPermissions" | "plan" = "acceptEdits", extra: Record<string, unknown> = {}) =>
  runner.create({ workspaceId: workspace.id, prompt, permissionMode, model: null, effort: null, worktree: null, harness: "codex", ...extra });
const pendingCard = (id: string) => find(id, "permission", (p) => p.status === "pending");

const cases: { name: string; run: () => Promise<void> }[] = [];
const test = (name: string, run: () => Promise<void>) => cases.push({ name, run });

test("새 Codex 세션: 스트리밍 글, 추론, 턴 요약(토큰과 시간), 스레드 id, 컨텍스트 사용량", async () => {
  const agent = await create("[stream] hello");
  expect(agent.harness === "codex" && agent.sessionId === null && agent.codexThreadId === null, "만든 직후 필드");
  await idle(agent.id);
  const now = store.agent(agent.id);
  expect(now.codexThreadId?.startsWith("thread-") === true, `스레드 id ${now.codexThreadId}`);
  expect(now.activeModel === "gpt-fixture-config", `activeModel ${now.activeModel}`);
  const assistant = find(agent.id, "assistant");
  expect(assistant?.text === "This is a streamed answer from the fixture app server." && assistant.streaming === false, `확정 글 ${assistant?.text}`);
  // 스트리밍 도중에 스트리밍 표시의 같은 항목이 갱신됐다
  const streams = events.filter((e) => e.type === "timelineUpsert" && e.agentId === agent.id && e.item.kind === "assistant" && e.item.streaming);
  expect(streams.length >= 2, `스트리밍 갱신 ${streams.length}회`);
  expect(find(agent.id, "thinking")?.text === "Checking the request", "추론");
  const result = find(agent.id, "result");
  expect(result?.isError === false && result.tokens === 1200 && result.costUsd === null && result.durationMs >= 0, JSON.stringify(result));
  expect(now.contextUsage?.used === 1200 && now.contextUsage.limit === 100000, JSON.stringify(now.contextUsage));
  const reqs = requests();
  const start = reqs.find((r) => r.method === "thread/start")!;
  expect(start.params.approvalPolicy === "on-request" && start.params.sandbox === "workspace-write" && start.params.cwd === repo && !("model" in start.params), `thread/start ${JSON.stringify(start.params)}`);
  const turn = reqs.find((r) => r.method === "turn/start")!;
  expect(turn.params.sandboxPolicy.type === "workspaceWrite" && turn.params.approvalsReviewer === "user" && turn.params.input[0].text === "[stream] hello" && !("model" in turn.params) && !("effort" in turn.params), `turn/start ${JSON.stringify(turn.params)}`);
  expect(store.agent(agent.id).unread === true, "안 읽음");
});

test("모델과 effort 를 고른 세션은 turn/start 에 실어 보낸다", async () => {
  const agent = await create("hi", "acceptEdits", { model: "gpt-fixture-mini", effort: "low" });
  await idle(agent.id);
  const turn = requests().filter((r) => r.method === "turn/start").at(-1)!;
  expect(turn.params.model === "gpt-fixture-mini" && turn.params.effort === "low", JSON.stringify(turn.params));
});

test("명령 실행 승인: untrusted 정책이라 명령마다 카드가 뜨고, 허용하면 실행되고 거절하면 건너뛴다", async () => {
  const agent = await create("[cmd] run", "default");
  await until(() => pendingCard(agent.id) !== undefined, "첫 승인 카드");
  const first = pendingCard(agent.id)!;
  expect(first.toolName === "Bash" && first.input.command === "ls -la" && first.toolUseId !== undefined, JSON.stringify(first));
  expect(store.agent(agent.id).status === "waiting" && runner.activeCount() >= 2 && runner.isLive(agent.id), "승인 대기 중 상태와 재시작 판정 수");
  const start = requests().find((r) => r.method === "thread/start" && r.params.cwd === repo && r.params.approvalPolicy === "untrusted");
  expect(!!start, "default 모드는 untrusted 로 시작");
  runner.respondPermission(agent.id, first.id, "allow");
  await until(() => find(agent.id, "tool", (t) => t.input.command === "ls -la" && t.status === "done") !== undefined, "첫 명령 완료");
  expect(find(agent.id, "tool", (t) => t.input.command === "ls -la")?.output?.includes("a.txt") === true, "명령 출력");
  await until(() => pendingCard(agent.id) !== undefined, "둘째 승인 카드");
  runner.respondPermission(agent.id, pendingCard(agent.id)!.id, "deny");
  await idle(agent.id);
  const second = find(agent.id, "tool", (t) => t.input.command === "false")!;
  expect(second.status === "error" && second.cancelled === true, `거절한 명령 ${JSON.stringify(second)}`);
  expect(timeline(agent.id).filter((i) => i.kind === "permission").map((i) => (i as { status: string }).status).join() === "allowed,denied", "카드 결과");
  expect(store.agent(agent.id).status === "idle" && runner.activeCount() === 0, "끝난 뒤");
});

test("비정상 종료한 명령은 error 로 보이고 종료 코드를 출력에 단다", async () => {
  const agent = await create("[cmd] run", "bypassPermissions");
  await idle(agent.id);
  const bad = find(agent.id, "tool", (t) => t.input.command === "false")!;
  expect(bad.status === "error" && bad.output === "Exit code 1", JSON.stringify(bad));
  const reqs = requests().filter((r) => r.method === "turn/start").at(-1)!;
  expect(reqs.params.approvalPolicy === "never" && reqs.params.sandboxPolicy.type === "dangerFullAccess", "bypass 는 never + danger-full-access");
});

test("파일 변경 승인: Edit 카드가 뜨고 허용하면 파일이 바뀌며 턴 요약에 변경 파일이 잡힌다", async () => {
  const agent = await create("[patch] append", "default");
  await until(() => pendingCard(agent.id) !== undefined, "파일 변경 카드");
  const card = pendingCard(agent.id)!;
  expect(card.toolName === "Edit" && String(card.input.file_path).endsWith("fixture-note.txt") && card.input.new_string === "existing line\nadded by codex\n", JSON.stringify(card));
  expect(readFileSync(join(repo, "fixture-note.txt"), "utf8") === "existing line\n", "허용 전에는 파일이 그대로");
  runner.respondPermission(agent.id, card.id, "allowAlways");
  await idle(agent.id);
  expect(readFileSync(join(repo, "fixture-note.txt"), "utf8").includes("added by codex"), "허용 뒤 파일이 바뀜");
  const tool = find(agent.id, "tool", (t) => t.name === "Edit")!;
  expect(tool.status === "done", "Edit 항목 완료");
  const result = find(agent.id, "result");
  expect(result?.changes?.files === 1 && result.changes.list?.[0].path === join(repo, "fixture-note.txt"), `턴 변경 요약 ${JSON.stringify(result?.changes)}`);
  expect(requests().some((r) => r.method === "thread/start") && store.changes(agent.id) !== undefined, "변경 기록");
  git("checkout", "--", "fixture-note.txt");
});

test("파일 변경을 거절하면 파일은 그대로고 도구 항목은 취소로 남는다", async () => {
  const agent = await create("[patch] append", "default");
  await until(() => pendingCard(agent.id) !== undefined, "카드");
  runner.respondPermission(agent.id, pendingCard(agent.id)!.id, "deny");
  await idle(agent.id);
  expect(readFileSync(join(repo, "fixture-note.txt"), "utf8") === "existing line\n", "파일 그대로");
  const tool = find(agent.id, "tool", (t) => t.name === "Edit")!;
  expect(tool.status === "error" && tool.cancelled === true, JSON.stringify(tool));
});

test("파일 둘을 만드는 변경은 Write 항목 둘이 되고 bypass 에서는 카드가 없다", async () => {
  const agent = await create("[patch2] create", "bypassPermissions");
  await idle(agent.id);
  const writes = timeline(agent.id).filter((i) => i.kind === "tool" && i.name === "Write");
  expect(writes.length === 2 && writes.every((w) => w.kind === "tool" && w.status === "done"), `Write ${writes.length}개`);
  expect(!timeline(agent.id).some((i) => i.kind === "permission"), "카드 없음");
  expect(existsSync(join(repo, "fixture-a.txt")) && existsSync(join(repo, "fixture-b.txt")), "파일 생성");
  rmSync(join(repo, "fixture-a.txt"));
  rmSync(join(repo, "fixture-b.txt"));
});

test("계획 갱신과 MCP 호출", async () => {
  const plan = await create("[plan] go");
  await idle(plan.id);
  const todo = find(plan.id, "tool", (t) => t.name === "TodoWrite")!;
  expect((todo.input.todos as unknown[]).length === 3, "할 일 3개");
  const mcp = await create("[mcp] go");
  await idle(mcp.id);
  const call = find(mcp.id, "tool", (t) => t.name === "mcp__docs__search")!;
  expect(call.status === "done" && call.output === "3 results for hooks", JSON.stringify(call));
});

test("중단: 도는 턴을 끊으면 Stopped 안내가 남고 도구는 취소되며 큐는 그대로다", async () => {
  const agent = await create("[slow] go");
  await until(() => find(agent.id, "tool", (t) => t.name === "Bash") !== undefined, "느린 명령 시작");
  expect(store.agent(agent.id).status === "running" && runner.activeCount() === 1, "도는 중");
  await runner.send(agent.id, "queued while running");
  expect(store.agent(agent.id).queue?.length === 1, "도는 중 보낸 메시지는 큐");
  await runner.interrupt(agent.id);
  await idle(agent.id);
  expect(find(agent.id, "notice", (n) => n.text === "Stopped") !== undefined, "Stopped 안내");
  const cmd = find(agent.id, "tool", (t) => t.name === "Bash")!;
  expect(cmd.status === "error" && cmd.cancelled === true, JSON.stringify(cmd));
  expect(store.agent(agent.id).queue?.length === 1 && runner.activeCount() === 0, "중단하면 큐는 그대로, 재시작 판정 0");
  expect(find(agent.id, "result") === undefined, "중단한 턴은 요약이 없다");
});

test("승인을 기다리는 중 중단하면 카드는 거절로 닫히고 턴이 끝난다", async () => {
  const agent = await create("[cmd] go", "default");
  await until(() => pendingCard(agent.id) !== undefined, "카드");
  await runner.interrupt(agent.id);
  await idle(agent.id);
  expect(find(agent.id, "permission")?.status === "denied", "카드 거절");
  expect(find(agent.id, "notice", (n) => n.text === "Stopped") !== undefined, "Stopped");
  expect(runner.activeCount() === 0, "남은 승인 없음");
});

test("턴 실패: 오류 항목이 한 번 남고 세션이 error 가 되며 큐를 보내지 않는다", async () => {
  const agent = await create("[fail] go");
  await idle(agent.id);
  const errors = timeline(agent.id).filter((i) => i.kind === "error");
  expect(errors.length === 1 && store.agent(agent.id).status === "error", `오류 ${errors.length}개, 상태 ${store.agent(agent.id).status}`);
  expect(find(agent.id, "result")?.isError === true, "요약은 isError");
});

test("큐: 도는 중 보낸 메시지는 턴이 정상으로 끝나면 이어서 보내진다", async () => {
  const agent = await create("[stream] first");
  await runner.send(agent.id, "second message");
  expect(store.agent(agent.id).queue?.length === 1, "큐에 한 건");
  await until(() => timeline(agent.id).filter((i) => i.kind === "result").length === 2, "두 턴 모두 끝나기");
  await idle(agent.id);
  expect(timeline(agent.id).filter((i) => i.kind === "user").map((i) => (i as { text: string }).text).join("|") === "[stream] first|second message", "사용자 메시지 순서");
  expect(!store.agent(agent.id).queue?.length, "큐가 비었다");
  const threadIds = new Set(requests().filter((r) => r.method === "turn/start").slice(-2).map((r) => r.params.threadId));
  expect(threadIds.size === 1, "같은 스레드로 이어서");
});

test("데몬 재시작: 새 실행기가 저장된 스레드를 thread/resume 해서 이어 보낸다", async () => {
  const agent = await create("[stream] before restart");
  await idle(agent.id);
  const threadId = store.agent(agent.id).codexThreadId!;
  runner.closeAll();
  await sleep(100);
  runner = new AgentRunner(store, emit);
  await runner.send(agent.id, "after restart");
  await idle(agent.id);
  const resume = requests().filter((r) => r.method === "thread/resume").at(-1);
  expect(resume?.params.threadId === threadId && resume.params.cwd === repo && resume.params.excludeTurns === true, `resume ${JSON.stringify(resume?.params)}`);
  expect(store.agent(agent.id).codexThreadId === threadId, "같은 스레드");
  expect(timeline(agent.id).filter((i) => i.kind === "assistant").length === 2, "대화가 이어졌다");
  expect(find(agent.id, "assistant", (a) => a.text.startsWith("Fixture reply to: after restart")) !== undefined, "새 답");
});

test("resume 이 실패하면(Codex 쪽 기록이 사라짐) 새 스레드로 이어 가고 안내를 남긴다", async () => {
  const agent = await create("[stream] first");
  await idle(agent.id);
  const old = store.agent(agent.id).codexThreadId!;
  runner.closeAll();
  await sleep(100);
  rmSync(join(fakeState, "threads.json"));
  runner = new AgentRunner(store, emit);
  await runner.send(agent.id, "again");
  await idle(agent.id);
  expect(store.agent(agent.id).codexThreadId !== old && store.agent(agent.id).status === "idle", "새 스레드");
  expect(find(agent.id, "notice", (n) => n.text.includes("could not resume")) !== undefined, "안내");
});

test("앱 서버가 턴 도중 죽으면 오류로 끝나고 다음 전송이 새 프로세스를 띄워 이어 간다", async () => {
  runner.closeAll();
  await sleep(100);
  process.env.FAKE_CODEX_CRASH = "1";
  const agent = await create("[stream] crash me");
  await idle(agent.id);
  delete process.env.FAKE_CODEX_CRASH;
  expect(store.agent(agent.id).status === "error" && find(agent.id, "error")?.text.includes("app server ended") === true, `죽음 처리 ${store.agent(agent.id).status}`);
  expect(runner.activeCount() === 0, "죽은 뒤 도는 턴 없음");
  await runner.send(agent.id, "[stream] try again");
  await idle(agent.id);
  expect(store.agent(agent.id).status === "idle" && find(agent.id, "assistant")?.text.length! > 0, "다시 보내면 돈다");
});

test("Codex 에 없는 기능: Plan 모드, 갈래, 체크포인트, 곁다리, 인계는 거절하고 Claude 세션은 막지 않는다", async () => {
  const agent = await create("hi");
  await idle(agent.id);
  const rejects = async (fn: () => Promise<unknown>, part: string) => {
    try {
      await fn();
    } catch (error) {
      return (error as Error).message.includes(part);
    }
    return false;
  };
  expect(await rejects(() => runner.setPermissionMode(agent.id, "plan"), "Plan"), "plan 모드 거절");
  await runner.setPermissionMode(agent.id, "auto");
  expect(store.agent(agent.id).permissionMode === "auto", "auto 는 고를 수 있다");
  expect(await rejects(() => runner.fork(agent.id), "not available for Codex"), "fork");
  expect(await rejects(() => runner.restoreCheckpoint(agent.id, "x"), "not available for Codex"), "checkpoint");
  expect(await rejects(async () => runner.assertClaude(agent.id, "Handoff"), "Handoff"), "assertClaude");
  const plan = await create("hi", "plan");
  expect(plan.permissionMode === "default", "plan 으로 시작하면 default 로 바뀐다");
  await idle(plan.id);
  // Claude 세션(harness 없음): 같은 진입점이 Codex 쪽으로 새지 않는다
  const claude = { ...agent, id: "claude-1", harness: undefined, codexThreadId: undefined, sessionId: "s1", status: "idle" as const };
  delete (claude as { harness?: unknown }).harness;
  store.addAgent(claude);
  expect(runner.willQueue("claude-1", false) === false, "Claude willQueue");
  expect(runner.isLive("claude-1") === false, "Claude isLive");
  runner.assertClaude("claude-1", "Fork");
});

test("권한 모드를 바꾸면 다음 턴의 승인 정책이 바뀐다", async () => {
  const agent = await create("hi", "default");
  await idle(agent.id);
  await runner.setPermissionMode(agent.id, "bypassPermissions");
  await runner.send(agent.id, "again");
  await idle(agent.id);
  const last = requests().filter((r) => r.method === "turn/start").at(-1)!;
  expect(last.params.approvalPolicy === "never" && last.params.sandboxPolicy.type === "dangerFullAccess", JSON.stringify(last.params));
});

test("Codex 세션을 지우면 스레드 구독을 풀고 타임라인이 지워진다", async () => {
  const agent = await create("hi");
  await idle(agent.id);
  const threadId = store.agent(agent.id).codexThreadId!;
  await runner.remove(agent.id, false);
  expect(!store.agents.some((a) => a.id === agent.id), "목록에서 빠짐");
  await until(() => requests().some((r) => r.method === "thread/unsubscribe" && r.params.threadId === threadId), "unsubscribe 요청");
});

test("codex.meta: 모델 목록은 Lodestar 가 고를 수 있는 effort 와의 교집합이고, config.toml 기본값과 로그인 상태가 온다", async () => {
  const meta = await runner.codexMeta(true);
  expect(meta.installed && meta.loggedIn && meta.account?.type === "chatgpt" && meta.account.plan === "plus", JSON.stringify(meta.account));
  expect(meta.version === "0.163.0-fixture", `버전 ${meta.version}`);
  const [full, mini] = meta.models;
  expect(full.value === "gpt-fixture" && full.isDefault && full.supportedEffortLevels.join() === "low,medium,high,xhigh,max", `ultra 는 뺀다 ${full.supportedEffortLevels}`);
  expect(mini.supportedEffortLevels.join() === "low,medium" && mini.defaultEffort === "low", "작은 모델");
  expect(meta.defaultModel === "gpt-fixture-config" && meta.defaultEffort === "high", "기본값은 config.toml 의 값이고 목록에 없어도 된다");
  expect(JSON.stringify(meta).includes("fixture@example.com") === false, "이메일은 화면에 보내지 않는다");
  const cached = await runner.codexMeta();
  expect(cached.fetchedAt === meta.fetchedAt, "캐시");
});

test("로그인 안 된 계정이면 loggedIn 이 false 다", async () => {
  runner.closeAll();
  await sleep(100);
  process.env.FAKE_CODEX_LOGGED_OUT = "1";
  runner = new AgentRunner(store, emit);
  const meta = await runner.codexMeta(true);
  delete process.env.FAKE_CODEX_LOGGED_OUT;
  expect(meta.loggedIn === false && meta.account === null && meta.models.length === 2, JSON.stringify(meta));
  runner.closeAll();
  await sleep(100);
});

test("Codex 실행 파일이 없으면 ENOENT 로 실패한다(installed 판단 근거)", async () => {
  let code = "";
  try {
    await AppServer.start({ onNotification: () => undefined, onRequest: async () => ({}), onExit: () => undefined }, join(root, "no-such-codex"));
  } catch (error) {
    code = (error as NodeJS.ErrnoException).code ?? "";
  }
  expect(code === "ENOENT", `코드 ${code}`);
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
runner.closeAll();
store.flush();
await sleep(200);
rmSync(root, { recursive: true, force: true });
console.log(failed ? `${failed} failed` : `${cases.length} passed`);
process.exit(failed ? 1 : 0);
