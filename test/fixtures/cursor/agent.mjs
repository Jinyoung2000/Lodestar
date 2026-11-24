#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const LOG = process.env.FAKE_CURSOR_LOG;
const STATE = process.env.FAKE_CURSOR_STATE || "/tmp/fake-cursor-state";
const LOGGED_OUT = process.env.FAKE_CURSOR_LOGGED_OUT === "1";
const AUTH_ERROR = { code: -32000, message: "Authentication required", data: { message: "Authentication required. Please run 'agent login' first, then call authenticate() with methodId 'cursor_login'." } };

const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("2026.11.22-fixture\n");
  process.exit(0);
}
if (args.at(-1) !== "acp") {
  process.stderr.write(`unsupported: ${args.join(" ")}\n`);
  process.exit(2);
}
const addDirs = args.flatMap((arg, index) => (args[index - 1] === "--add-dir" ? [arg] : []));

mkdirSync(STATE, { recursive: true });
const SESSIONS = join(STATE, "sessions.json");
const sessions = existsSync(SESSIONS) ? JSON.parse(readFileSync(SESSIONS, "utf8")) : {};
const save = () => writeFileSync(SESSIONS, JSON.stringify(sessions));
const live = new Map();

const write = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const update = (sessionId, body) => write({ method: "session/update", params: { sessionId, update: body } });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (entry) => LOG && appendFileSync(LOG, `${JSON.stringify({ pid: process.pid, addDirs, ...entry })}\n`);

let serverRequestId = 0;
const waiting = new Map();
const askClient = (method, params) =>
  new Promise((resolve) => {
    const id = String(++serverRequestId);
    waiting.set(id, resolve);
    write({ id, method, params });
  });

const MODELS = [
  { value: "default", name: "Auto", levels: [] },
  { value: "fake-sonnet", name: "Fake Sonnet 5", levels: ["low", "medium", "high"], effortDefault: "medium" },
  { value: "fake-gpt", name: "Fake GPT 6", levels: ["low", "medium", "high", "extra-high"], effortDefault: "high" },
  { value: "fake-thinker", name: "Fake Thinker", thinking: true },
];

function parameterOptions(model, current) {
  if (model.levels?.length) return [{ id: "effort", name: "Effort", category: "thought_level", type: "select", currentValue: current ?? model.effortDefault, options: model.levels.map((v) => ({ value: v, name: v })) }];
  if (model.thinking) return [{ id: "thinking", name: "Thinking", category: "thought_level", type: "select", currentValue: current ?? "true", options: [{ value: "false", name: "Off" }, { value: "true", name: "On" }] }];
  return [];
}

let selected = { model: "default", effort: null };

function configOptions(state) {
  const model = MODELS.find((m) => m.value === selected.model) ?? MODELS[0];
  return [
    { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: state.mode, options: ["agent", "plan", "ask"].map((v) => ({ value: v, name: v })) },
    { id: "model", name: "Model", category: "model", type: "select", currentValue: model.value, options: MODELS.map((m) => ({ value: m.value, name: m.name })) },
    ...parameterOptions(model, selected.effort),
  ];
}

const freshState = (cwd) => ({ cwd, mode: "agent", prompts: [] });

async function streamText(sessionId, text) {
  for (const part of text.match(/.{1,12}/g) ?? []) {
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: part } });
    await sleep(5);
  }
}

async function runPrompt(id, params) {
  const { sessionId } = params;
  const state = live.get(sessionId);
  const text = (params.prompt ?? []).filter((p) => p.type === "text").map((p) => p.text).join("\n");
  state.prompts.push(text);
  sessions[sessionId] = { cwd: state.cwd, prompts: state.prompts };
  save();
  const run = { cancelled: false };
  state.run = run;
  const finish = (stopReason) => {
    state.run = null;
    write({ id, result: { stopReason } });
  };
  update(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Thinking about it" } });
  if (text.includes("[slow]")) {
    update(sessionId, { sessionUpdate: "tool_call", toolCallId: "call-slow", title: "`sleep 30`", kind: "execute", status: "pending", rawInput: { command: "sleep 30" } });
    while (!run.cancelled) await sleep(10);
    return finish("cancelled");
  }
  if (text.includes("[edit]")) {
    const path = join(state.cwd, "fixture-note.txt");
    const before = existsSync(path) ? readFileSync(path, "utf8") : null;
    const after = `${before ?? ""}made by cursor\n`;
    const diff = { type: "diff", path, oldText: before, newText: after };
    const answer = await askClient("session/request_permission", {
      sessionId,
      toolCall: { toolCallId: "call-edit", title: `Edit \`${path}\``, kind: "edit", content: [diff] },
      options: [
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
        { optionId: "allow-always", name: "Allow always", kind: "allow_always" },
        { optionId: "reject-once", name: "Reject", kind: "reject_once" },
      ],
    });
    log({ method: "permission-answer", params: answer });
    if (run.cancelled || answer?.outcome?.outcome === "cancelled") return finish("cancelled");
    const allowed = answer?.outcome?.optionId === "allow-once" || answer?.outcome?.optionId === "allow-always";
    const call = { toolCallId: "call-edit", title: `Edit \`${path}\``, kind: "edit", rawInput: { path }, locations: [{ path }] };
    update(sessionId, { sessionUpdate: "tool_call", ...call, status: "pending" });
    if (allowed) {
      writeFileSync(path, after);
      update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "call-edit", status: "completed", content: [diff] });
      await streamText(sessionId, "Updated fixture-note.txt.");
    } else {
      update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "call-edit", status: "failed" });
      await streamText(sessionId, "Skipped the file.");
    }
    return finish("end_turn");
  }
  if (text.includes("[cmd]")) {
    update(sessionId, { sessionUpdate: "tool_call", toolCallId: "call-ls", title: "`ls`", kind: "execute", status: "pending", rawInput: { command: "ls" } });
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "call-ls", status: "completed", rawOutput: { exitCode: 0, stdout: "fixture-note.txt\n", stderr: "" } });
    update(sessionId, { sessionUpdate: "tool_call", toolCallId: "call-false", title: "`false`", kind: "execute", status: "pending", rawInput: { command: "false" } });
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "call-false", status: "completed", rawOutput: { exitCode: 1, stdout: "", stderr: "" } });
    update(sessionId, { sessionUpdate: "tool_call", toolCallId: "call-grep", title: 'grep "TODO"', kind: "search", status: "pending", rawInput: { pattern: "TODO", path: "src" } });
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "call-grep", status: "completed", rawOutput: { totalMatches: 2, truncated: false } });
    update(sessionId, { sessionUpdate: "tool_call", toolCallId: "call-read", title: "Read fixture-note.txt", kind: "read", status: "pending", rawInput: { path: join(state.cwd, "fixture-note.txt") } });
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "call-read", status: "completed", rawOutput: { content: "existing line\n" } });
    await streamText(sessionId, "Ran the commands.");
    return finish("end_turn");
  }
  if (text.includes("[todos]")) {
    update(sessionId, { sessionUpdate: "tool_call", toolCallId: "call-todos", title: "Update TODOs", kind: "other", status: "pending", rawInput: { _toolName: "updateTodos", todos: [] } });
    await askClient("cursor/update_todos", { toolCallId: "call-todos", todos: [{ id: "1", content: "Read code", status: "completed" }, { id: "2", content: "Write fix", status: "in_progress" }], merge: false });
    await askClient("cursor/update_todos", { toolCallId: "call-todos", todos: [{ id: "3", content: "Run checks", status: "pending" }], merge: true });
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "call-todos", status: "completed" });
    await streamText(sessionId, "Planned.");
    return finish("end_turn");
  }
  if (text.includes("[recall]")) {
    await streamText(sessionId, `I have seen ${state.prompts.length} prompts in this conversation.`);
    return finish("end_turn");
  }
  const model = MODELS.find((m) => m.value === selected.model);
  await streamText(sessionId, `Hello from the fake Cursor agent on ${model?.name ?? selected.model}. You said: ${text.slice(-40)}`);
  return finish("end_turn");
}

let nextSession = 1;

function handle(message) {
  const { id, method, params } = message;
  if (method === undefined && id !== undefined) {
    const resolve = waiting.get(String(id));
    waiting.delete(String(id));
    resolve?.(message.result);
    return;
  }
  log({ method, params });
  switch (method) {
    case "initialize":
      return write({ id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, mcpCapabilities: { http: true, sse: true }, promptCapabilities: { audio: false, embeddedContext: false, image: true }, sessionCapabilities: { list: {} } }, authMethods: [{ id: "cursor_login", name: "Cursor Login", description: "Authenticate using existing Cursor login credentials." }] } });
    case "authenticate":
      return write({ id, error: { code: -32603, message: "The fake refuses authenticate so Lodestar never starts a browser login" } });
    case "cursor/list_available_models":
      if (LOGGED_OUT) return write({ id, error: AUTH_ERROR });
      return write({ id, result: { models: MODELS.map((m) => ({ value: m.value, name: m.name, configOptions: parameterOptions(m) })) } });
    case "session/new": {
      if (LOGGED_OUT) return write({ id, error: AUTH_ERROR });
      const sessionId = `cursor-session-${process.pid}-${nextSession++}`;
      const state = freshState(params.cwd);
      live.set(sessionId, state);
      sessions[sessionId] = { cwd: params.cwd, prompts: [] };
      save();
      return write({ id, result: { sessionId, modes: { currentModeId: "agent", availableModes: [] }, configOptions: configOptions(state) } });
    }
    case "session/load": {
      if (LOGGED_OUT) return write({ id, error: AUTH_ERROR });
      const saved = sessions[params.sessionId];
      if (!saved) return write({ id, error: { code: -32002, message: "Resource not found", data: `session ${params.sessionId}` } });
      const state = { ...freshState(params.cwd), prompts: saved.prompts };
      live.set(params.sessionId, state);
      for (const prompt of saved.prompts) update(params.sessionId, { sessionUpdate: "user_message_chunk", content: { type: "text", text: prompt } });
      return write({ id, result: { configOptions: configOptions(state) } });
    }
    case "session/set_config_option": {
      const state = live.get(params.sessionId);
      const option = configOptions(state).find((o) => o.id === params.configId);
      if (!option || !option.options.some((o) => o.value === params.value)) return write({ id, error: { code: -32602, message: `Invalid value for ${params.configId}: ${params.value}` } });
      if (params.configId === "model") selected = { model: params.value, effort: null };
      else if (params.configId === "mode") state.mode = params.value;
      else selected = { ...selected, effort: params.value };
      return write({ id, result: { configOptions: configOptions(state) } });
    }
    case "session/prompt":
      return void runPrompt(id, params);
    case "session/cancel": {
      const run = live.get(params.sessionId)?.run;
      if (run) run.cancelled = true;
      for (const [key, resolve] of waiting) {
        waiting.delete(key);
        resolve({ outcome: { outcome: "cancelled" } });
      }
      return;
    }
    default:
      if (id !== undefined) write({ id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  try {
    handle(JSON.parse(line));
  } catch (error) {
    process.stderr.write(`bad line: ${error}\n`);
  }
});
