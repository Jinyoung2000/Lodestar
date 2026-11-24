#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";

const LOG = process.env.FAKE_CLAUDE_LOG ?? "/tmp/fake-claude.log";
const SPAWN_LOG = process.env.FAKE_CLAUDE_SPAWN_LOG;
const spawnLog = (entry) => SPAWN_LOG && appendFileSync(SPAWN_LOG, `${JSON.stringify({ pid: process.pid, ...entry })}\n`);
spawnLog({ kind: "spawn", cwd: process.cwd(), argv: process.argv.slice(2), env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("LODESTAR_") || (key.startsWith("ANTHROPIC_") && !/KEY|TOKEN/.test(key)))), auth: { token: !!process.env.ANTHROPIC_AUTH_TOKEN, apiKey: !!process.env.ANTHROPIC_API_KEY } });
const session = randomUUID();
const out = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
let inited = false;
const MODELS = [
  { value: "default", resolvedModel: "claude-fake-1", displayName: "Default", description: "Fixture default model", supportedEffortLevels: ["low", "medium", "high", "xhigh", "max", "ultra"] },
  { value: "opus", resolvedModel: "claude-fake-opus", displayName: "Opus", description: "Fixture large model", supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },
];

const DELAY_MARK = "[delay]";
const STOP_HOOK_MARK = "[stop-hook";
const assistantText = (text) => out({ type: "assistant", message: { id: `msg_${randomUUID()}`, type: "message", role: "assistant", model: "fake", content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null, usage }, parent_tool_use_id: null, session_id: session, uuid: randomUUID() });
createInterface({ input: process.stdin }).on("line", async (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.type === "control_request") {
    const subtype = message.request?.subtype;
    if (subtype === "initialize") spawnLog({ kind: "initialize", request: message.request });
    const response = subtype === "initialize" ? { commands: [], output_style: "default", available_output_styles: ["default"], models: MODELS, account: {} } : subtype === "mcp_status" ? { mcpServers: [] } : {};
    out({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response } });
    return;
  }
  if (message.type !== "user") return;
  appendFileSync(LOG, `${line}\n`);
  if (!inited) {
    inited = true;
    out({ type: "system", subtype: "init", cwd: process.cwd(), session_id: session, tools: [], mcp_servers: [], model: "fake", permissionMode: "default", slash_commands: [], apiKeySource: "none", claude_code_version: "0.0.0", output_style: "default", skills: [], plugins: [], uuid: randomUUID() });
  }
  if (line.includes(DELAY_MARK)) await new Promise((resolve) => setTimeout(resolve, 1500));
  if (line.includes(STOP_HOOK_MARK)) {
    const answer = "Checked the install path.\n\n- Version: 0.172.0\n- Models: 12";
    const toolId = `toolu_${randomUUID()}`;
    assistantText(answer);
    out({ type: "user", message: { role: "user", content: [{ type: "text", text: "Stop hook feedback:\nRun the verification script before you finish." }] }, parent_tool_use_id: null, session_id: session, uuid: randomUUID() });
    out({ type: "assistant", message: { id: `msg_${randomUUID()}`, type: "message", role: "assistant", model: "fake", content: [{ type: "tool_use", id: toolId, name: "Bash", input: { command: "python3 verify.py" } }], stop_reason: "tool_use", stop_sequence: null, usage }, parent_tool_use_id: null, session_id: session, uuid: randomUUID() });
    out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolId, content: "ok" }] }, parent_tool_use_id: null, session_id: session, uuid: randomUUID() });
    assistantText(line.includes("[stop-hook-new]") ? "Verified. Everything matches." : answer);
    out({ type: "result", subtype: "success", is_error: false, duration_ms: 1, duration_api_ms: 1, num_turns: 2, result: answer, session_id: session, total_cost_usd: 0, usage, modelUsage: {}, permission_denials: [], uuid: randomUUID() });
    return;
  }
  out({ type: "assistant", message: { id: `msg_${randomUUID()}`, type: "message", role: "assistant", model: "fake", content: [{ type: "text", text: "ok (fake claude)" }], stop_reason: "end_turn", stop_sequence: null, usage }, parent_tool_use_id: null, session_id: session, uuid: randomUUID() });
  out({ type: "result", subtype: "success", is_error: false, duration_ms: 1, duration_api_ms: 1, num_turns: 1, result: "ok (fake claude)", session_id: session, total_cost_usd: 0, usage, modelUsage: {}, permission_denials: [], uuid: randomUUID() });
});
process.stdin.on("end", () => process.exit(0));
