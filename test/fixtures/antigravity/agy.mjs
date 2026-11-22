#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const LOG = process.env.FAKE_AGY_LOG;
const STATE = process.env.FAKE_AGY_STATE || "/tmp/fake-agy-state";
const MODELS = [
  ["fake-pro-high", "Fake Pro (High)"],
  ["fake-pro-medium", "Fake Pro (Medium)"],
  ["fake-pro-low", "Fake Pro (Low)"],
  ["fake-flash-xhigh", "Fake Flash (XHigh)"],
  ["fake-flash-low", "Fake Flash (Low)"],
  ["fake-oss-medium", "Fake OSS (Medium)"],
];

if (process.argv[2] === "models") {
  process.stderr.write("Fetching available models...\n");
  if (process.env.FAKE_AGY_LOGGED_OUT === "1") {
    process.stderr.write("Error: not signed in. Run agy to sign in.\n");
    process.exit(1);
  }
  for (const [id, name] of MODELS) process.stdout.write(`${id}\t${name}\n`);
  process.exit(0);
}
if (process.argv[2] !== "acp") {
  process.stderr.write(`unsupported: ${process.argv.slice(2).join(" ")}\n`);
  process.exit(2);
}

mkdirSync(STATE, { recursive: true });
const SESSIONS = join(STATE, "sessions.json");
const sessions = existsSync(SESSIONS) ? JSON.parse(readFileSync(SESSIONS, "utf8")) : {};
const save = () => writeFileSync(SESSIONS, JSON.stringify(sessions));
const live = new Map();

const write = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const update = (sessionId, body) => write({ method: "session/update", params: { sessionId, update: body } });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (entry) => LOG && appendFileSync(LOG, `${JSON.stringify(entry)}\n`);

let serverRequestId = 0;
const waiting = new Map();
const askClient = (method, params) =>
  new Promise((resolve) => {
    const id = String(++serverRequestId);
    waiting.set(id, resolve);
    write({ id, method, params });
  });

const baseModels = [
  { value: "fake-pro", name: "Fake Pro", levels: ["low", "medium", "high"] },
  { value: "fake-flash", name: "Fake Flash", levels: ["low", "xhigh"] },
  { value: "fake-oss-medium", name: "Fake OSS (Medium)", levels: [] },
];

function configOptions(state) {
  const model = baseModels.find((m) => m.value === state.model) ?? baseModels[0];
  return [
    { id: "model", name: "Model", category: "model", type: "select", currentValue: model.value, options: baseModels.map((m) => ({ value: m.value, name: m.name })) },
    { id: "thought_level", name: "Thinking Level", category: "thought_level", type: "select", currentValue: state.effort, options: model.levels.map((l) => ({ value: l, name: l })) },
    { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: state.mode, options: ["default", "accept-edits", "auto", "plan"].map((v) => ({ value: v, name: v })) },
  ];
}

const freshState = (cwd) => ({ cwd, model: "fake-pro", effort: "high", mode: "default", prompts: [] });

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
  const finish = (stopReason, totalTokens = 321) => {
    state.run = null;
    write({ id, result: { stopReason, usage: { inputTokens: 300, outputTokens: 21, totalTokens } } });
  };
  if (process.env.FAKE_AGY_CRASH === "1") {
    update(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "about to crash" } });
    await sleep(20);
    process.exit(3);
  }
  update(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Thinking about it" } });
  update(sessionId, { sessionUpdate: "usage_update", used: 4096, size: 1048576 });
  if (text.includes("[fail]")) {
    state.run = null;
    write({ id, error: { code: -32603, message: "Internal error", data: "model overloaded" } });
    return;
  }
  if (text.includes("[slow]")) {
    update(sessionId, { sessionUpdate: "tool_call", toolCallId: "call-slow", name: "run_command", args: { CommandLine: "sleep 30" }, status: "in_progress", kind: "execute", title: "sleep 30" });
    while (!run.cancelled) await sleep(10);
    return finish("cancelled");
  }
  if (text.includes("[edit]")) {
    const path = join(state.cwd, "fixture-note.txt");
    const before = existsSync(path) ? readFileSync(path, "utf8") : null;
    const after = `${before ?? ""}made by agy\n`;
    const diff = { type: "diff", path, ...(before === null ? {} : { oldText: before }), newText: after };
    const call = { toolCallId: "call-edit", name: "replace_file_content", args: { TargetFile: path }, kind: "edit", title: "File fixture-note.txt", locations: [{ path }] };
    update(sessionId, { sessionUpdate: "tool_call", ...call, status: "in_progress" });
    update(sessionId, { sessionUpdate: "tool_call_update", ...call, status: "pending" });
    let allowed = state.mode !== "default";
    if (!allowed) {
      const answer = await askClient("session/request_permission", {
        sessionId,
        toolCall: { sessionUpdate: "tool_call", ...call, status: "pending", content: [diff] },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
        ],
      });
      log({ method: "permission-answer", params: answer });
      if (run.cancelled || answer?.outcome?.outcome === "cancelled") return finish("cancelled");
      allowed = answer?.outcome?.optionId === "allow";
    }
    if (allowed) {
      writeFileSync(path, after);
      update(sessionId, { sessionUpdate: "tool_call_update", ...call, status: "completed", rawOutput: {}, content: [diff] });
      await streamText(sessionId, "Updated fixture-note.txt.");
    } else {
      update(sessionId, { sessionUpdate: "tool_call_update", ...call, status: "failed" });
      await streamText(sessionId, "Skipped the file.");
    }
    return finish("end_turn");
  }
  if (text.includes("[cmd]")) {
    const ok = { toolCallId: "call-ls", name: "run_command", args: { CommandLine: "ls", toolSummary: "List files" }, kind: "execute", title: "ls" };
    update(sessionId, { sessionUpdate: "tool_call", ...ok, status: "in_progress" });
    update(sessionId, { sessionUpdate: "tool_call_update", ...ok, status: "completed", rawOutput: { output: "Created At: x\nCompleted At: y\nCommand exited with code 0.\n\nCommand output:\nfixture-note.txt\r\n", exit_code: 0 } });
    const bad = { toolCallId: "call-false", name: "run_command", args: { CommandLine: "false" }, kind: "execute", title: "false" };
    update(sessionId, { sessionUpdate: "tool_call", ...bad, status: "in_progress" });
    update(sessionId, { sessionUpdate: "tool_call_update", ...bad, status: "completed", rawOutput: { output: "Created At: x\nCompleted At: y\nCommand exited with code 1.\n\nNo output from the command.", exit_code: 1 } });
    await streamText(sessionId, "Ran the commands.");
    return finish("end_turn");
  }
  if (text.includes("[plan]")) {
    update(sessionId, { sessionUpdate: "plan", entries: [{ content: "Read code", priority: "high", status: "completed" }, { content: "Write fix", priority: "high", status: "in_progress" }] });
    await streamText(sessionId, "Planned.");
    return finish("end_turn");
  }
  if (text.includes("[recall]")) {
    await streamText(sessionId, `I have seen ${state.prompts.length} prompts in this conversation.`);
    return finish("end_turn");
  }
  await streamText(sessionId, `Hello from the fixture agent. You said: ${text.slice(-40)}`);
  return finish("end_turn");
}

let nextSession = Object.keys(sessions).length + 1;

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
      return write({ id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: true }, sessionCapabilities: { resume: {}, close: {}, load: {}, additionalDirectories: {} }, _meta: { antigravity: { systemPrompt: { append: true } } } }, agentInfo: { name: "Fake Antigravity", version: "1.5.13-fixture" } } });
    case "session/new": {
      const sessionId = `agy-session-${process.pid}-${nextSession++}`;
      const state = freshState(params.cwd);
      live.set(sessionId, state);
      sessions[sessionId] = { cwd: params.cwd, prompts: [] };
      save();
      return write({ id, result: { sessionId, configOptions: configOptions(state) } });
    }
    case "session/resume": {
      const saved = sessions[params.sessionId];
      if (!saved) return write({ id, error: { code: -32002, message: "Resource not found", data: `session ${params.sessionId}` } });
      const state = { ...freshState(params.cwd), prompts: saved.prompts };
      live.set(params.sessionId, state);
      return write({ id, result: { configOptions: configOptions(state) } });
    }
    case "session/set_config_option": {
      const state = live.get(params.sessionId);
      const option = configOptions(state).find((o) => o.id === params.configId);
      if (!option || !option.options.some((o) => o.value === params.value)) return write({ id, error: { code: -32602, message: `Invalid value ${params.value} for ${params.configId}` } });
      if (params.configId === "model") {
        state.model = params.value;
        const levels = baseModels.find((m) => m.value === params.value).levels;
        if (!levels.includes(state.effort)) state.effort = levels.at(-1) ?? null;
      }
      if (params.configId === "thought_level") state.effort = params.value;
      if (params.configId === "mode") state.mode = params.value;
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
    case "session/close":
      live.delete(params.sessionId);
      return write({ id, result: {} });
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
