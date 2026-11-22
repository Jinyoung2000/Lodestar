#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";

const LOG = process.env.FAKE_CLAUDE_LOG ?? "/tmp/fake-claude.log";
const SPAWN_LOG = process.env.FAKE_CLAUDE_SPAWN_LOG;
const spawnLog = (entry) => SPAWN_LOG && appendFileSync(SPAWN_LOG, `${JSON.stringify({ pid: process.pid, ...entry })}\n`);
spawnLog({ kind: "spawn", cwd: process.cwd(), argv: process.argv.slice(2), env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("LODESTAR_"))) });
const session = randomUUID();
const out = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
let inited = false;
const MODELS = [
  { value: "default", resolvedModel: "claude-fake-1", displayName: "Default", description: "Fixture default model", supportedEffortLevels: ["low", "medium", "high", "xhigh", "max", "ultra"] },
  { value: "opus", resolvedModel: "claude-fake-opus", displayName: "Opus", description: "Fixture large model", supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },
];

const DELAY_MARK = "[delay]";
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
  out({ type: "assistant", message: { id: `msg_${randomUUID()}`, type: "message", role: "assistant", model: "fake", content: [{ type: "text", text: "ok (fake claude)" }], stop_reason: "end_turn", stop_sequence: null, usage }, parent_tool_use_id: null, session_id: session, uuid: randomUUID() });
  out({ type: "result", subtype: "success", is_error: false, duration_ms: 1, duration_api_ms: 1, num_turns: 1, result: "ok (fake claude)", session_id: session, total_cost_usd: 0, usage, modelUsage: {}, permission_denials: [], uuid: randomUUID() });
});
process.stdin.on("end", () => process.exit(0));
