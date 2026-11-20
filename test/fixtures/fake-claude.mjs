#!/usr/bin/env node
// 시험용 가짜 claude CLI. AGENT_NAV_CLAUDE 로 이 파일을 가리키면 데몬이 모델을 부르지 않고 이 프로세스와 stream-json 을 주고받는다.
// SDK 가 CLI 의 stdin 으로 넘기는 사용자 메시지 줄을 그대로 FAKE_CLAUDE_LOG 파일에 한 줄씩 남기므로, "SDK 가 모델에 넘기기 직전 프롬프트"를 확인할 수 있다.
// 초기화 요청(control_request)에는 성공으로 답하고, 사용자 메시지마다 init, assistant, result 를 돌려준다. 모델도 네트워크도 쓰지 않는다.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";

const LOG = process.env.FAKE_CLAUDE_LOG ?? "/tmp/fake-claude.log";
const session = randomUUID();
const out = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
let inited = false;

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.type === "control_request") {
    const subtype = message.request?.subtype;
    const response = subtype === "initialize" ? { commands: [], output_style: "default", available_output_styles: ["default"], models: [], account: {} } : subtype === "mcp_status" ? { mcpServers: [] } : {};
    out({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response } });
    return;
  }
  if (message.type !== "user") return;
  appendFileSync(LOG, `${line}\n`);
  if (!inited) {
    inited = true;
    out({ type: "system", subtype: "init", cwd: process.cwd(), session_id: session, tools: [], mcp_servers: [], model: "fake", permissionMode: "default", slash_commands: [], apiKeySource: "none", claude_code_version: "0.0.0", output_style: "default", skills: [], plugins: [], uuid: randomUUID() });
  }
  out({ type: "assistant", message: { id: `msg_${randomUUID()}`, type: "message", role: "assistant", model: "fake", content: [{ type: "text", text: "ok (fake claude)" }], stop_reason: "end_turn", stop_sequence: null, usage }, parent_tool_use_id: null, session_id: session, uuid: randomUUID() });
  out({ type: "result", subtype: "success", is_error: false, duration_ms: 1, duration_api_ms: 1, num_turns: 1, result: "ok (fake claude)", session_id: session, total_cost_usd: 0, usage, modelUsage: {}, permission_denials: [], uuid: randomUUID() });
});
process.stdin.on("end", () => process.exit(0));
