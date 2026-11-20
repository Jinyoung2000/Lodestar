#!/usr/bin/env node
// CODEX: 시험용 가짜 Codex 앱 서버. `codex app-server` 의 stdio JSON-RPC(JSONL) 프로토콜 중 Lodestar 가 쓰는 부분만 흉내 낸다.
// 실제 프로토콜은 `codex app-server generate-ts` (0.163.0) 로 확인했고, 알림과 요청의 모양은 그 바인딩과 실제 서버 응답을 따른다.
// 시나리오는 프롬프트 안의 표지로 고른다: [stream] [cmd] [patch] [patch2] [slow] [fail] [plan] [mcp] [ask] (표지가 없으면 한 줄 답).
// 환경 변수: FAKE_CODEX_LOG(받은 요청을 JSONL 로 남길 파일), FAKE_CODEX_STATE(스레드 목록을 두는 폴더), FAKE_CODEX_LOGGED_OUT=1(로그인 안 된 계정), FAKE_CODEX_CRASH=1(첫 턴에서 비정상 종료)
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

const LOG = process.env.FAKE_CODEX_LOG;
const STATE = process.env.FAKE_CODEX_STATE || "/tmp/fake-codex-state";
mkdirSync(STATE, { recursive: true });
const THREADS = join(STATE, "threads.json");
const threads = existsSync(THREADS) ? JSON.parse(readFileSync(THREADS, "utf8")) : {};
const saveThreads = () => writeFileSync(THREADS, JSON.stringify(threads));

const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const notify = (method, params) => write({ method, params });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (entry) => LOG && appendFileSync(LOG, `${JSON.stringify(entry)}\n`);

let serverRequestId = 1000;
const waiting = new Map();
const askClient = (method, params) =>
  new Promise((resolve) => {
    const id = ++serverRequestId;
    waiting.set(id, resolve);
    write({ id, method, params });
  });

const MODELS = [
  { id: "gpt-fixture", model: "gpt-fixture", upgrade: null, upgradeInfo: null, availabilityNux: null, displayName: "GPT Fixture", description: "Fixture default model", modelSpecialty: null, hidden: false, supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"].map((reasoningEffort) => ({ reasoningEffort, description: reasoningEffort })), defaultReasoningEffort: "medium", inputModalities: ["text"], supportsPersonality: false, multiAgentVersion: null, additionalSpeedTiers: [], serviceTiers: [], defaultServiceTier: null, availableAccessPrograms: null, isDefault: true },
  { id: "gpt-fixture-mini", model: "gpt-fixture-mini", upgrade: null, upgradeInfo: null, availabilityNux: null, displayName: "GPT Fixture Mini", description: "Fixture small model", modelSpecialty: null, hidden: false, supportedReasoningEfforts: ["low", "medium"].map((reasoningEffort) => ({ reasoningEffort, description: reasoningEffort })), defaultReasoningEffort: "low", inputModalities: ["text"], supportsPersonality: false, multiAgentVersion: null, additionalSpeedTiers: [], serviceTiers: [], defaultServiceTier: null, availableAccessPrograms: null, isDefault: false },
];

let counter = 0;
const uid = (prefix) => `${prefix}-${Date.now().toString(36)}-${++counter}`;
const active = new Map(); // threadId -> { turnId, interrupted, wake }

const turnObject = (id, status, extra = {}) => ({ id, rootTurnId: id, items: [], itemsView: "notLoaded", status, error: null, startedAt: Math.floor(Date.now() / 1000), completedAt: null, durationMs: null, ...extra });

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.method === undefined) {
    // 서버 요청에 대한 클라이언트의 답
    const resolve = waiting.get(message.id);
    if (resolve) {
      waiting.delete(message.id);
      resolve(message);
    }
    return;
  }
  log({ method: message.method, params: message.params });
  if (message.id === undefined) return; // initialized 같은 알림
  void handle(message).catch((error) => write({ id: message.id, error: { code: -32603, message: String(error?.message ?? error) } }));
});

async function handle({ id, method, params }) {
  const ok = (result) => write({ id, result });
  switch (method) {
    case "initialize":
      return ok({ userAgent: "lodestar/0.163.0-fixture (Fixture OS) fixture (lodestar; 0.2.0)", codexHome: "/tmp/fake-codex-home", platformFamily: "unix", platformOs: "macos" });
    case "account/read":
      return ok(process.env.FAKE_CODEX_LOGGED_OUT === "1" ? { account: null, requiresOpenaiAuth: true } : { account: { type: "chatgpt", email: "fixture@example.com", planType: "plus" }, requiresOpenaiAuth: true });
    case "model/list":
      return ok({ data: MODELS, nextCursor: null });
    case "config/read":
      return ok({ config: { model: "gpt-fixture-config", model_reasoning_effort: "high" } });
    case "thread/start": {
      const threadId = uid("thread");
      threads[threadId] = { cwd: params.cwd };
      saveThreads();
      return ok({ thread: { id: threadId, cwd: params.cwd, turns: [] }, model: params.model ?? "gpt-fixture-config", modelProvider: "openai", serviceTier: null, disabledPluginIds: [], cwd: params.cwd, instructionSources: [], approvalPolicy: params.approvalPolicy, approvalsReviewer: params.approvalsReviewer ?? "user", sandbox: { type: "workspaceWrite" }, reasoningEffort: "high" });
    }
    case "thread/resume": {
      if (!threads[params.threadId]) return write({ id, error: { code: -32600, message: `no rollout found for thread id ${params.threadId}` } });
      return ok({ thread: { id: params.threadId, cwd: params.cwd, turns: [] }, model: params.model ?? "gpt-fixture-config", modelProvider: "openai", serviceTier: null, disabledPluginIds: [], cwd: params.cwd, instructionSources: [], approvalPolicy: params.approvalPolicy, approvalsReviewer: "user", sandbox: { type: "workspaceWrite" }, reasoningEffort: "high", collaborationMode: null, turnsBackwardsCursor: null, itemsBackwardsCursor: null });
    }
    case "thread/unsubscribe":
      return ok({ status: "unsubscribed" });
    case "turn/start": {
      const turnId = uid("turn");
      const state = { turnId, interrupted: false, wake: null };
      active.set(params.threadId, state);
      ok({ turn: turnObject(turnId, "inProgress") });
      void runTurn(params, state).catch((error) => console.error("fixture turn failed", error));
      return;
    }
    case "turn/interrupt": {
      const state = active.get(params.threadId);
      ok({});
      if (state) {
        state.interrupted = true;
        state.wake?.();
      }
      return;
    }
    default:
      return write({ id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}

// 사용자가 보낸 글에서 표지를 찾는다
const promptOf = (params) => params.input.map((i) => (i.type === "text" ? i.text : "")).join("\n");

async function pause(state, ms) {
  if (state.interrupted) return false;
  await Promise.race([sleep(ms), new Promise((resolve) => (state.wake = resolve))]);
  state.wake = null;
  return !state.interrupted;
}

async function runTurn(params, state) {
  const { threadId } = params;
  const turnId = state.turnId;
  const prompt = promptOf(params);
  const startedAt = Date.now();
  const cwd = params.cwd ?? threads[threadId]?.cwd ?? process.cwd();
  const policy = params.approvalPolicy ?? "on-request";
  const needsApproval = (kind) => policy === "untrusted" || (policy === "on-request" && kind === "escape");
  notify("turn/started", { threadId, turn: turnObject(turnId, "inProgress") });
  if (process.env.FAKE_CODEX_CRASH === "1") process.exit(3);
  await pause(state, 30);
  let failed = false;

  const reasoning = async () => {
    const id = uid("reasoning");
    notify("item/started", { threadId, turnId, startedAtMs: Date.now(), item: { type: "reasoning", id, summary: [], content: [] } });
    notify("item/reasoning/summaryTextDelta", { threadId, turnId, itemId: id, delta: "Checking the request", summaryIndex: 0 });
    await pause(state, 20);
    notify("item/completed", { threadId, turnId, completedAtMs: Date.now(), item: { type: "reasoning", id, summary: ["Checking the request"], content: [] } });
  };

  const say = async (text, chunks = 3) => {
    const id = uid("msg");
    notify("item/started", { threadId, turnId, startedAtMs: Date.now(), item: { type: "agentMessage", id, text: "", phase: null, memoryCitation: null, delivery: null, questions: null } });
    const size = Math.ceil(text.length / chunks);
    for (let i = 0; i < text.length; i += size) {
      notify("item/agentMessage/delta", { threadId, turnId, itemId: id, delta: text.slice(i, i + size) });
      if (!(await pause(state, 40))) break;
    }
    notify("item/completed", { threadId, turnId, completedAtMs: Date.now(), item: { type: "agentMessage", id, text, phase: null, memoryCitation: null, delivery: null, questions: null } });
  };

  const command = async (cmd, output, exitCode = 0) => {
    if (state.interrupted) return;
    const id = uid("cmd");
    const base = { type: "commandExecution", id, pluginId: null, scriptPath: null, command: `/bin/zsh -lc "${cmd}"`, cwd, processId: null, source: "agent", commandActions: [], aggregatedOutput: null, exitCode: null, durationMs: null };
    notify("item/started", { threadId, turnId, startedAtMs: Date.now(), item: { ...base, status: "inProgress" } });
    let status = "completed";
    if (needsApproval("command")) {
      const answer = await askClient("item/commandExecution/requestApproval", { kind: "command", threadId, turnId, itemId: id, startedAtMs: Date.now(), environmentId: null, command: `/bin/zsh -lc "${cmd}"`, cwd, reason: "Run a command outside the trusted list" });
      const decision = answer.result?.decision;
      if (decision === "cancel") state.interrupted = true;
      if (decision !== "accept" && decision !== "acceptForSession") status = "declined";
    }
    if (status === "completed") {
      notify("item/commandExecution/outputDelta", { threadId, turnId, itemId: id, delta: output });
      await pause(state, 30);
    }
    notify("item/completed", { threadId, turnId, completedAtMs: Date.now(), item: { ...base, status, aggregatedOutput: status === "completed" ? output : null, exitCode: status === "completed" ? exitCode : null, durationMs: 40 } });
  };

  const patch = async (files) => {
    if (state.interrupted) return;
    const id = uid("patch");
    const changes = files.map(([path, kind, diff]) => ({ path, kind: kind === "update" ? { type: "update", move_path: null } : { type: kind }, diff }));
    notify("item/started", { threadId, turnId, startedAtMs: Date.now(), item: { type: "fileChange", id, changes, status: "inProgress" } });
    let status = "completed";
    if (needsApproval("patch")) {
      const answer = await askClient("item/fileChange/requestApproval", { threadId, turnId, itemId: id, startedAtMs: Date.now(), reason: null });
      const decision = answer.result?.decision;
      if (decision === "cancel") state.interrupted = true;
      if (decision !== "accept" && decision !== "acceptForSession") status = "declined";
    }
    if (status === "completed") {
      for (const [path, kind, diff] of files) {
        const full = path.startsWith("/") ? path : join(cwd, path);
        mkdirSync(dirname(full), { recursive: true });
        if (kind === "add") writeFileSync(full, diff);
        else if (kind === "update") {
          const before = existsSync(full) ? readFileSync(full, "utf8") : "";
          const plus = diff.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1));
          writeFileSync(full, before + plus.join("\n") + "\n");
        }
      }
    }
    notify("item/completed", { threadId, turnId, completedAtMs: Date.now(), item: { type: "fileChange", id, changes, status } });
    if (status === "completed") notify("turn/diff/updated", { threadId, turnId, diff: files.map(([path, , diff]) => `--- a/${path}\n+++ b/${path}\n${diff}`).join("\n") });
  };

  if (prompt.includes("[crashed]")) {
    // 이어 가기 시험용: 프로세스를 죽인 뒤 같은 스레드가 resume 되는지 본다
  }

  await reasoning();
  if (state.interrupted) return finish(threadId, turnId, "interrupted", startedAt);

  if (prompt.includes("[slow]")) {
    await say("Working on it. ".repeat(4), 8);
    // 끝나지 않는 명령: 시작만 알리고 중단될 때까지 둔다(중단하면 turn/completed 의 interrupted 로 닫힌다)
    const id = uid("cmd");
    notify("item/started", { threadId, turnId, startedAtMs: Date.now(), item: { type: "commandExecution", id, pluginId: null, scriptPath: null, command: "/bin/zsh -lc \"sleep 30\"", cwd, processId: null, source: "agent", status: "inProgress", commandActions: [], aggregatedOutput: null, exitCode: null, durationMs: null } });
    while (!state.interrupted) await pause(state, 100);
  } else if (prompt.includes("[fail]")) {
    notify("error", { error: { message: "The model hit a fixture error", codexErrorInfo: "other", additionalDetails: null, misalignment: null }, willRetry: false, threadId, turnId });
    failed = true;
  } else if (prompt.includes("[plan]")) {
    notify("turn/plan/updated", { threadId, turnId, explanation: null, plan: [{ step: "Read the file", status: "completed" }, { step: "Edit the file", status: "inProgress" }, { step: "Run tests", status: "pending" }] });
    await say("Plan posted.");
  } else if (prompt.includes("[mcp]")) {
    const id = uid("mcp");
    const base = { type: "mcpToolCall", id, server: "docs", tool: "search", arguments: { query: "hooks" }, appContext: null, mcpAppUi: null, pluginId: null, readOnlyHint: true, result: null, error: null, durationMs: null };
    notify("item/started", { threadId, turnId, startedAtMs: Date.now(), item: { ...base, status: "inProgress" } });
    await pause(state, 30);
    notify("item/completed", { threadId, turnId, completedAtMs: Date.now(), item: { ...base, status: "completed", result: { content: [{ type: "text", text: "3 results for hooks" }], structuredContent: null, _meta: null }, durationMs: 30 } });
    await say("Searched the docs.");
  } else if (prompt.includes("[ask]")) {
    await askClient("item/permissions/requestApproval", { threadId, turnId, itemId: uid("perm"), environmentId: null, startedAtMs: Date.now(), cwd, reason: "network", permissions: {} });
    await say("Asked for permissions.");
  } else if (prompt.includes("[cmd]")) {
    await command("ls -la", "total 0\n-rw-r--r-- 1 me staff 0 a.txt");
    await command("false", "", 1);
    await say("Ran two commands.");
  } else if (prompt.includes("[patch2]")) {
    await patch([
      ["fixture-a.txt", "add", "hello from codex\n"],
      ["fixture-b.txt", "add", "second file\n"],
    ]);
    await say("Created two files.");
  } else if (prompt.includes("[patch]")) {
    await patch([["fixture-note.txt", "update", "@@ -1,1 +1,2 @@\n existing line\n+added by codex\n"]]);
    await say("Appended a line.");
  } else if (prompt.includes("[stream]")) {
    await say("This is a streamed answer from the fixture app server.", 6);
  } else {
    await say(`Fixture reply to: ${prompt.trim().slice(0, 60)}`);
  }
  if (state.interrupted) return finish(threadId, turnId, "interrupted", startedAt);
  notify("thread/tokenUsage/updated", { threadId, turnId, tokenUsage: { total: { totalTokens: 1200, inputTokens: 1000, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 200, reasoningOutputTokens: 50 }, last: { totalTokens: 1200, inputTokens: 1000, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 200, reasoningOutputTokens: 50 }, modelContextWindow: 100000 } });
  return finish(threadId, turnId, failed ? "failed" : "completed", startedAt);
}

function finish(threadId, turnId, status, startedAt) {
  active.delete(threadId);
  notify("turn/completed", { threadId, turn: turnObject(turnId, status, { completedAt: Math.floor(Date.now() / 1000), durationMs: Date.now() - startedAt, error: status === "failed" ? { message: "The model hit a fixture error", codexErrorInfo: "other", additionalDetails: null, misalignment: null } : null }) });
}

// 시작 직후 실제 서버처럼 상관없는 알림을 하나 보낸다(클라이언트가 모르는 알림을 무시해야 한다)
notify("remoteControl/status/changed", { status: "disabled", serverName: "fixture", installationId: "fixture", environmentId: null });
