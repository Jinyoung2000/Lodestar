#!/usr/bin/env node
import { execFile } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(realpathSync(fileURLToPath(import.meta.url)));
const WebSocket = require("ws");

const HOME = process.env.AGENT_NAV_HOME || process.env.LODESTAR_DAEMON_HOME || join(homedir(), ".agent-nav");
const PORT = process.env.AGENT_NAV_PORT || process.env.LODESTAR_DAEMON_PORT || "7788";
const SELF_REF = process.env.LODESTAR_SESSION_REF || "";
const SELF_ID = process.env.LODESTAR_SESSION_ID || "";

const USAGE = `Usage: lodestar <path>[:line[:column]] ...   Open folders or files in the Lodestar app
       lodestar session <command>

  list [--all] [--json]                  Recent sessions, newest first (default 20)
  show <ref> [--last N] [--json]         Header and the last N user/assistant messages (default 10)
  send <ref> <message...>                Message another session (reads stdin when no message is given)
  wait <ref> [--timeout SECONDS]         Wait until the session is idle, then print its last reply (default 600)
  move <folder>                          Move this chat (one without a folder) into <folder>; the next message starts there
  id                                     Print this session's own reference
       lodestar automation <command>

  list [--json]                          Automations with their state, next run and last run
  show <automation> [--json]             Settings and recent runs of one automation
  create <schedule> [target] [options] <prompt...>
                                         Run a prompt on a schedule (reads stdin when no prompt is given)
      schedule: --every MINUTES | --daily HH:MM [--days mon,tue,...|weekdays|weekends|all]
                | --once "YYYY-MM-DD HH:MM" (local time)
      target:   --workspace <name|folder> (default: the workspace containing this folder)
                [--worktree] [--base BRANCH]
                | --session <ref> (message an existing session instead of starting one)
      options:  --title TEXT --model ID --effort LEVEL --permission MODE --paused
  run <automation>                       Run it now
  pause <automation> | resume <automation>
  delete <automation>

<ref> is lodestar://session/<id>, a full uuid, or a unique id prefix of 6+ hex chars.
<automation> is an automation id, a unique id prefix, or its exact title.`;

async function main() {
  const [group, command, ...rest] = process.argv.slice(2);
  if (!group || group === "help" || group === "--help" || group === "-h") return console.log(USAGE);
  if (group === "automation" || group === "automations") return automationCommand(command, rest);
  if (group !== "session") return openPaths(process.argv.slice(2));
  if (!command) return usage();
  const args = parseArgs(rest);
  if (command === "id") return printId();
  if (command === "list") return list(args);
  if (command === "show") return show(args);
  if (command === "send") return send(args);
  if (command === "wait") return wait(args);
  if (command === "move") return move(args);
  usage();
}

const APP_ID = "dev.gene.agent-nav";
const POSITION_SUFFIX = /:\d+(?::\d+)?$/;

function openPaths(args) {
  const paths = args.filter((arg) => arg !== "-g" && arg !== "--goto").map((arg) => (arg.startsWith("file://") ? arg : resolvePath(process.cwd(), arg)));
  if (!paths.length) usage();
  const positioned = paths.some((path) => POSITION_SUFFIX.test(path) && !existsSync(path));
  const openArgs = positioned ? ["-n", "-b", APP_ID, "--args", ...paths] : ["-b", APP_ID, ...paths];
  execFile("open", openArgs, (error, _stdout, stderr) => {
    if (error) fail(stderr.trim() || error.message);
  });
}

function usage() {
  console.error(USAGE);
  process.exit(1);
}

function fail(message, code = 1) {
  console.error(`lodestar: ${message}`);
  process.exit(code);
}

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
  const prompt = SELF_REF ? `From session ${SELF_REF}:\n${text}` : text;
  const { queued } = await rpc("agents.send", { agentId: agent.id, prompt });
  console.log(queued ? `Queued for ${refOf(agent.id)} (it is busy and will get it after the current turn)` : `Sent to ${refOf(agent.id)}`);
  await done();
}

async function move({ positional }) {
  const [target] = positional;
  if (!target || positional.length > 1) usage();
  const dir = resolvePath(process.cwd(), target.replace(/^~(?=\/|$)/, homedir()));
  if (!existsSync(dir)) fail(`${dir} does not exist. Create the folder first.`);
  const agents = await rpc("agents.list");
  const self = SELF_ID ? agents.find((a) => a.id === SELF_ID) : chatAt(agents, process.cwd());
  if (!self) fail(SELF_ID ? `this session (${SELF_ID}) is not in the Lodestar daemon on port ${PORT}` : "not inside a Lodestar session (LODESTAR_SESSION_ID is not set)");
  const moved = await rpc("agents.moveToFolder", { agentId: self.id, dir });
  console.log(`Moved ${refOf(moved.id)} to ${moved.cwd}. The next message continues there.`);
  await done();
}

function chatAt(agents, cwd) {
  const real = realpathSync(cwd);
  const matches = agents.filter((a) => a.workspaceId === null && a.cwd && existsSync(a.cwd) && realpathSync(a.cwd) === real);
  return matches.length === 1 ? matches[0] : null;
}

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

const AUTOMATION_VALUE_FLAGS = new Set(["--every", "--daily", "--days", "--once", "--workspace", "--base", "--session", "--title", "--model", "--effort", "--permission"]);
const WEEKDAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

async function automationCommand(command, argv) {
  if (!command) usage();
  const args = parseAutomationArgs(argv);
  await rpc("automations.list").catch((error) => {
    if (/Unknown method/.test(error.message)) fail("the running Lodestar app predates automations. Let it update (Settings > Update when idle) or restart it, then try again.");
    throw error;
  });
  if (command === "list") return automationList(args);
  if (command === "show") return automationShow(args);
  if (command === "create" || command === "add") return automationCreate(args);
  if (command === "run") return automationRun(args);
  if (command === "pause") return automationSetEnabled(args, false);
  if (command === "resume") return automationSetEnabled(args, true);
  if (command === "delete" || command === "rm") return automationDelete(args);
  usage();
}

function parseAutomationArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (AUTOMATION_VALUE_FLAGS.has(arg)) {
      const value = argv[++i];
      if (value === undefined) fail(`${arg} needs a value`);
      flags[arg.slice(2)] = value;
    } else if (arg === "--worktree" || arg === "--json" || arg === "--paused") flags[arg.slice(2)] = true;
    else positional.push(arg);
  }
  return { flags, positional };
}

function scheduleFrom(flags) {
  const given = ["every", "daily", "once"].filter((key) => flags[key] !== undefined);
  if (given.length !== 1) fail('give exactly one schedule: --every MINUTES, --daily HH:MM or --once "YYYY-MM-DD HH:MM"');
  if (flags.every !== undefined) {
    const minutes = Number(flags.every);
    if (!Number.isInteger(minutes)) fail("--every needs whole minutes");
    return { kind: "interval", minutes };
  }
  if (flags.daily !== undefined) return { kind: "daily", time: flags.daily, weekdays: weekdaysFrom(flags.days) };
  const at = localDateTime(flags.once);
  if (!at) fail(`--once needs "YYYY-MM-DD HH:MM" in local time, got "${flags.once}"`);
  return { kind: "once", at: at.toISOString() };
}

function weekdaysFrom(text) {
  if (text === undefined || text === "weekdays") return [1, 2, 3, 4, 5];
  if (text === "all" || text === "everyday") return [0, 1, 2, 3, 4, 5, 6];
  if (text === "weekends") return [0, 6];
  const days = text.split(",").map((part) => WEEKDAY_NAMES.indexOf(part.trim().slice(0, 3).toLowerCase()));
  if (!days.length || days.includes(-1)) fail(`--days takes mon,tue,wed,thu,fri,sat,sun, weekdays, weekends or all, got "${text}"`);
  return [...new Set(days)].sort();
}

function localDateTime(text) {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})$/.exec(String(text).trim());
  if (!match) return null;
  const [, y, mo, d, h, mi] = match.map(Number);
  const date = new Date(y, mo - 1, d, h, mi, 0, 0);
  return Number.isNaN(date.getTime()) ? null : date;
}

async function targetFrom(flags) {
  if (flags.session !== undefined) {
    if (flags.workspace !== undefined || flags.worktree || flags.base !== undefined) fail("--session cannot be combined with --workspace, --worktree or --base");
    const agent = resolve(flags.session, await rpc("agents.list"));
    return { kind: "session", agentId: agent.id };
  }
  if (flags.base !== undefined && !flags.worktree) fail("--base only applies with --worktree");
  const workspace = await workspaceFor(flags.workspace);
  return { kind: "newSession", workspaceId: workspace.id, worktree: flags.worktree ? { base: flags.base ?? "" } : null };
}

async function workspaceFor(input) {
  const workspaces = (await rpc("workspaces.list")).filter((w) => !w.feedback && !w.archived);
  const realOf = (dir) => (existsSync(dir) ? realpathSync(dir) : dir);
  if (input !== undefined) {
    const dir = realOf(resolvePath(process.cwd(), input.replace(/^~(?=\/|$)/, homedir())));
    const byDir = workspaces.find((w) => realOf(w.dir) === dir);
    if (byDir) return byDir;
    const byName = workspaces.filter((w) => w.name === input);
    if (byName.length === 1) return byName[0];
    fail(`no single workspace matches "${input}". Workspaces:\n${workspaces.map((w) => `  ${w.name}  ${w.dir}`).join("\n")}`);
  }
  const here = realOf(process.cwd());
  const containing = workspaces
    .map((w) => ({ w, dir: realOf(w.dir) }))
    .filter(({ dir }) => here === dir || here.startsWith(`${dir}/`))
    .sort((a, b) => b.dir.length - a.dir.length);
  if (containing[0]) return containing[0].w;
  fail("this folder is not inside a Lodestar workspace; pass --workspace <name|folder> or --session <ref>");
}

async function automationCreate({ flags, positional }) {
  let prompt = positional.join(" ").trim();
  if (!prompt && !process.stdin.isTTY) prompt = readFileSync(0, "utf8").trim();
  if (!prompt) fail("give the prompt to run as the last argument or on stdin");
  const schedule = scheduleFrom(flags);
  const target = await targetFrom(flags);
  const permissionMode = flags.permission ?? (await rpc("defaults.get")).permissionMode.value;
  const created = await rpc("automations.create", {
    title: (flags.title ?? prompt.split("\n")[0]).slice(0, 120).trim(),
    prompt,
    enabled: !flags.paused,
    schedule,
    target,
    harness: "claude",
    model: flags.model ?? null,
    effort: flags.effort ?? null,
    permissionMode,
  });
  console.log(`Created automation ${shortId(created.id)} "${created.title}": ${scheduleText(created.schedule)}, ${created.enabled ? `next run ${whenText(created.nextRunAt)}` : "paused"}, permission mode ${created.permissionMode}.`);
  await done();
}

function resolveAutomation(input, automations) {
  if (!input) usage();
  const exact = automations.find((a) => a.id === input || a.title === input);
  if (exact) return exact;
  const matches = automations.filter((a) => a.id.startsWith(input.toLowerCase()));
  if (matches.length === 1) return matches[0];
  if (!matches.length) fail(`no automation matches "${input}". Run \`lodestar automation list\` to see them.`);
  fail(`"${input}" matches ${matches.length} automations, use a longer prefix`);
}

function scheduleText(schedule) {
  if (schedule.kind === "interval") return `every ${schedule.minutes} min`;
  if (schedule.kind === "once") return `once on ${localStamp(schedule.at)}`;
  const days = schedule.weekdays.length === 7 ? "every day" : schedule.weekdays.map((d) => WEEKDAY_NAMES[d]).join(",");
  return `${days} at ${schedule.time}`;
}

function localStamp(iso) {
  const date = new Date(iso);
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const whenText = (iso) => (iso ? localStamp(iso) : "none");

function latestRun(runs, automationId) {
  return runs.filter((r) => r.automationId === automationId).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
}

async function automationList({ flags }) {
  const { automations, runs } = await rpc("automations.list");
  if (flags.json) {
    console.log(JSON.stringify(automations.map((a) => ({ ...a, lastRun: latestRun(runs, a.id) ?? null })), null, 2));
    return done();
  }
  if (!automations.length) console.log("No automations. Create one with `lodestar automation create`.");
  for (const a of automations) {
    const last = latestRun(runs, a.id);
    const active = last && (last.status === "running" || last.status === "needsInput");
    const state = active ? last.status : a.enabled ? `next ${whenText(a.nextRunAt)}` : "paused";
    const lastText = last ? `last ${last.status} ${localStamp(last.startedAt)}` : "never ran";
    console.log([shortId(a.id), state.padEnd(22), scheduleText(a.schedule).padEnd(28), lastText.padEnd(34), a.title].join("  "));
  }
  await done();
}

async function automationShow({ flags, positional }) {
  const automation = resolveAutomation(positional[0], (await rpc("automations.list")).automations);
  const runs = await rpc("automations.runs", { automationId: automation.id });
  if (flags.json) {
    console.log(JSON.stringify({ ...automation, runs }, null, 2));
    return done();
  }
  const { target } = automation;
  const workspaceName = target.kind === "newSession" ? ((await rpc("workspaces.list")).find((w) => w.id === target.workspaceId)?.name ?? target.workspaceId) : null;
  const targetText = target.kind === "session" ? `existing session ${refOf(target.agentId)}` : `new session in ${workspaceName}${target.worktree ? `, new worktree from ${target.worktree.base || "the default branch"}` : ""}`;
  console.log(`${automation.title} (${automation.id})
Schedule: ${scheduleText(automation.schedule)}
State: ${automation.enabled ? `on, next run ${whenText(automation.nextRunAt)}` : "paused"}
Target: ${targetText}
Model: ${automation.model ?? "default"}  Effort: ${automation.effort ?? "default"}  Permission mode: ${automation.permissionMode}

Prompt:
${automation.prompt}

Runs:`);
  if (!runs.length) console.log("  none yet");
  for (const run of runs) console.log(`  ${localStamp(run.startedAt)}  ${run.trigger.padEnd(9)}  ${run.status.padEnd(10)}  ${run.agentId ? refOf(run.agentId) : ""}${run.error ? `  ${run.error}` : ""}`);
  await done();
}

async function automationRun({ positional }) {
  const automation = resolveAutomation(positional[0], (await rpc("automations.list")).automations);
  const run = await rpc("automations.runNow", { id: automation.id });
  console.log(`Ran "${automation.title}": ${run.status}${run.agentId ? ` in ${refOf(run.agentId)}` : ""}${run.error ? ` (${run.error})` : ""}`);
  await done();
}

async function automationSetEnabled({ positional }, enabled) {
  const automation = resolveAutomation(positional[0], (await rpc("automations.list")).automations);
  const updated = await rpc("automations.setEnabled", { id: automation.id, enabled });
  console.log(enabled ? `Resumed "${updated.title}", next run ${whenText(updated.nextRunAt)}` : `Paused "${updated.title}"`);
  await done();
}

async function automationDelete({ positional }) {
  const automation = resolveAutomation(positional[0], (await rpc("automations.list")).automations);
  await rpc("automations.delete", { id: automation.id });
  console.log(`Deleted "${automation.title}"`);
  await done();
}

main().catch((error) => fail(error.message));
