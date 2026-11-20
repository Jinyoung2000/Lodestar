#!/usr/bin/env node
// Lodestar CLI: 실행 중인 데몬에 UI 와 같은 WebSocket RPC 로 붙어 세션을 보고, 다른 세션에 메시지를 보낸다.
// 심볼릭 링크(~/.local/bin/lodestar)로 실행되니 ws 는 이 파일의 실제 위치 기준으로 찾는다.
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(realpathSync(fileURLToPath(import.meta.url)));
const WebSocket = require("ws");

const HOME = process.env.AGENT_NAV_HOME || join(homedir(), ".agent-nav");
const PORT = process.env.AGENT_NAV_PORT || "7788";
const SELF_REF = process.env.LODESTAR_SESSION_REF || "";
const SELF_ID = process.env.LODESTAR_SESSION_ID || "";

const USAGE = `Usage: lodestar session <command>

  list [--all] [--json]                  Recent sessions, newest first (default 20)
  show <ref> [--last N] [--json]         Header and the last N user/assistant messages (default 10)
  send <ref> <message...>                Message another session (reads stdin when no message is given)
  wait <ref> [--timeout SECONDS]         Wait until the session is idle, then print its last reply (default 600)
  id                                     Print this session's own reference

<ref> is lodestar://session/<id>, a full uuid, or a unique id prefix of 6+ hex chars.`;

async function main() {
  const [group, command, ...rest] = process.argv.slice(2);
  if (!group || group === "help" || group === "--help" || group === "-h") return console.log(USAGE);
  if (group !== "session" || !command) return usage();
  const args = parseArgs(rest);
  if (command === "id") return printId();
  if (command === "list") return list(args);
  if (command === "show") return show(args);
  if (command === "send") return send(args);
  if (command === "wait") return wait(args);
  usage();
}

function usage() {
  console.error(USAGE);
  process.exit(1);
}

function fail(message, code = 1) {
  console.error(`lodestar: ${message}`);
  process.exit(code);
}

// --name value 와 --flag 를 가르고 나머지는 위치 인자로 둔다. 숫자 옵션만 값을 받는다.
function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--last" || arg === "--timeout") {
      const value = Number(argv[++i]);
      if (!Number.isFinite(value) || value <= 0) fail(`${arg} needs a positive number`);
      flags[arg.slice(2)] = value;
    } else if (arg === "--all" || arg === "--json") flags[arg.slice(2)] = true;
    else positional.push(arg);
  }
  return { flags, positional };
}

// --- 세션 참조: shared/sessionRef.ts 의 파서를 복제했다(.mjs 에서 TypeScript 를 불러오지 않으려고). 정규식을 바꾸면 거기도 맞춘다. ---
const REF_PATTERN = /(?:lodestar|agent-nav):\/\/session\/([0-9a-f][0-9a-f-]{5,35})/i;

function parseRef(input) {
  const trimmed = input.trim();
  const linked = REF_PATTERN.exec(trimmed)?.[1] ?? (/^[0-9a-f][0-9a-f-]{5,35}$/i.test(trimmed) ? trimmed : null);
  const id = linked?.toLowerCase().replace(/-+$/, "");
  return id && id.length >= 6 ? id : null;
}

const shortId = (id) => id.slice(0, 8);
const refOf = (id) => `lodestar://session/${shortId(id)}`;

function resolve(input, agents) {
  const id = parseRef(input);
  if (!id) fail(`"${input}" is not a session reference (use lodestar://session/<id>, a uuid, or a prefix of 6+ hex chars)`);
  const visible = agents.filter((a) => !a.feedbackId);
  const exact = visible.find((a) => a.id === id);
  if (exact) return exact;
  const matches = visible.filter((a) => a.id.startsWith(id));
  if (matches.length === 1) return matches[0];
  if (!matches.length) fail(`no session matches "${input}". Run \`lodestar session list\` to see sessions.`);
  fail(`"${input}" matches ${matches.length} sessions, use a longer prefix:\n${matches.map((a) => `  ${shortId(a.id)}  ${a.title}`).join("\n")}`);
}

// --- RPC ---
let socket = null;
let nextId = 1;
const pending = new Map();

function connect() {
  if (socket) return socket;
  let token;
  try {
    token = readFileSync(join(HOME, "token"), "utf8").trim();
  } catch {
    fail(`cannot read ${join(HOME, "token")}. Is Lodestar running?`);
  }
  socket = new Promise((resolveSocket, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/rpc?token=${token}`, { headers: { origin: `http://127.0.0.1:${PORT}` } });
    ws.on("open", () => resolveSocket(ws));
    ws.on("error", (error) => reject(new Error(`cannot reach the Lodestar daemon on port ${PORT} (${error.message})`)));
    // 답을 받기 전에 연결이 끊기면(데몬 재시작) 기다리던 호출을 실패로 끝낸다. 그대로 두면 이벤트 루프가 비어 아무것도 찍지 않고 0 으로 끝나서, wait 와 send 가 성공한 것처럼 보였다.
    ws.on("close", () => {
      for (const waiter of pending.values()) waiter.reject(new Error("the Lodestar daemon closed the connection"));
      pending.clear();
    });
    ws.on("message", (data) => {
      const message = JSON.parse(String(data));
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(typeof message.error === "string" ? message.error : (message.error.message ?? JSON.stringify(message.error))));
      else waiter.resolve(message.result);
    });
  });
  return socket;
}

async function rpc(method, params = {}) {
  const ws = await connect();
  const id = nextId++;
  return new Promise((resolveCall, reject) => {
    pending.set(id, { resolve: resolveCall, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function done(code = 0) {
  if (socket) (await socket).close();
  process.exit(code);
}

// --- 명령 ---
function printId() {
  if (!SELF_REF) fail("not inside a Lodestar session (LODESTAR_SESSION_REF is not set)");
  console.log(SELF_REF);
}

async function list({ flags }) {
  const [agents, workspaces] = await Promise.all([rpc("agents.list"), rpc("workspaces.list")]);
  const names = new Map(workspaces.map((w) => [w.id, w.name]));
  const rows = agents
    .filter((a) => !a.feedbackId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, flags.all ? undefined : 20);
  if (flags.json) console.log(JSON.stringify(rows.map((a) => ({ ref: refOf(a.id), id: a.id, status: a.status, title: a.title, workspace: names.get(a.workspaceId) ?? null, cwd: a.cwd, updatedAt: a.updatedAt })), null, 2));
  else for (const a of rows) console.log([shortId(a.id), a.status.padEnd(7), ago(a.updatedAt).padEnd(8), (names.get(a.workspaceId) ?? a.cwd).slice(0, 24).padEnd(24), a.title].join("  "));
  await done();
}

async function show({ flags, positional }) {
  if (!positional[0]) usage();
  const agent = resolve(positional[0], await rpc("agents.list"));
  const messages = lastMessages(await rpc("agents.timeline", { agentId: agent.id }), flags.last ?? 10);
  if (flags.json) console.log(JSON.stringify({ ref: refOf(agent.id), id: agent.id, title: agent.title, status: agent.status, cwd: agent.cwd, messages }, null, 2));
  else {
    console.log(`${refOf(agent.id)}\nTitle: ${agent.title}\nStatus: ${agent.status}\nCwd: ${agent.cwd}\n`);
    for (const m of messages) console.log(`${m.role === "user" ? "User" : "Assistant"}: ${m.text}\n`);
  }
  await done();
}

async function send({ positional }) {
  const [target, ...words] = positional;
  if (!target) usage();
  let text = words.join(" ");
  if (!text && !process.stdin.isTTY) text = readFileSync(0, "utf8").trim();
  if (!text) usage();
  const agent = resolve(target, await rpc("agents.list"));
  if (SELF_ID && agent.id === SELF_ID) fail("cannot send a message to your own session");
  // 받는 세션이 누가 썼는지 알도록 보낸 세션의 참조를 맨 앞에 붙인다. 받는 쪽 데몬이 이 참조를 풀어 보낸 세션의 최근 대화를 맥락으로 붙인다.
  const prompt = SELF_REF ? `From session ${SELF_REF}:\n${text}` : text;
  const { queued } = await rpc("agents.send", { agentId: agent.id, prompt });
  console.log(queued ? `Queued for ${refOf(agent.id)} (it is busy and will get it after the current turn)` : `Sent to ${refOf(agent.id)}`);
  await done();
}

// 응답 중(running)이거나 승인 대기(waiting)가 아니면 쉬는 상태다. 보낸 직후에는 상태가 running 으로 바뀌기 전일 수 있어 쉬는 상태를 두 번 연달아 봐야 끝으로 친다.
async function wait({ flags, positional }) {
  if (!positional[0]) usage();
  const agent = resolve(positional[0], await rpc("agents.list"));
  const deadline = Date.now() + (flags.timeout ?? 600) * 1000;
  let idleSeen = 0;
  while (Date.now() < deadline) {
    const current = (await rpc("agents.list")).find((a) => a.id === agent.id);
    if (!current) fail("the session no longer exists");
    idleSeen = current.status === "running" || current.status === "waiting" ? 0 : idleSeen + 1;
    if (idleSeen >= 2) {
      const last = lastMessages(await rpc("agents.timeline", { agentId: agent.id }), 50).findLast((m) => m.role === "assistant");
      console.log(last ? last.text : "(no assistant message yet)");
      await done(current.status === "error" ? 2 : 0);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  fail(`timed out after ${flags.timeout ?? 600}s, ${refOf(agent.id)} is still busy`);
}

// 사용자 메시지(시스템이 넣은 것 제외)와 끝난 어시스턴트 메시지만, 화면에 보이는 글(shown) 기준으로 최근 count 개.
function lastMessages(items, count) {
  const out = [];
  for (const item of items) {
    if (item.kind === "user" && item.source !== "system") out.push({ role: "user", text: item.shown ?? item.text, at: item.at ?? null });
    else if (item.kind === "assistant" && !item.streaming) out.push({ role: "assistant", text: item.text, at: item.at ?? null });
  }
  return out.slice(-count);
}

function ago(iso) {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

main().catch((error) => fail(error.message));
