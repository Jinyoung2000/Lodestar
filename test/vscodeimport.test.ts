import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = realpathSync(mkdtempSync(join(tmpdir(), "agent-nav-import-unit-")));
process.env.AGENT_NAV_HOME = join(root, "home");
process.env.CLAUDE_CONFIG_DIR = join(root, "claude");
const userDir = join(root, "code", "User");
const dataDir = join(root, "code", "agentSessionData");
const projects = join(root, "claude", "projects");
mkdirSync(join(userDir, "globalStorage"), { recursive: true });
mkdirSync(dataDir, { recursive: true });
mkdirSync(projects, { recursive: true });

const { Store } = await import("../server/store");
const { AgentRunner } = await import("../server/agents");
const { collectDrafts, importActivity, importVscodeSessions, listVscodeSessions, markSynced, reconcileBeforeTurn } = await import("../server/vscodeImport");
const { readVscodeState } = await import("../server/vscodeState");
const { buildItems, mergeBuilt, peekTranscript, projectDirName, userSource } = await import("../server/vscodeTimeline");

const cases: { name: string; run: () => Promise<string> | string }[] = [];
const test = (name: string, run: () => Promise<string> | string) => cases.push({ name, run });
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
  return detail;
};


const sh = (file: string, sql: string) => execFileSync("/usr/bin/sqlite3", [file], { input: sql });
const sql = (text: string) => `'${text.replace(/'/g, "''")}'`;
const b64 = (text: string) => Buffer.from(text).toString("base64url");
const sessionUri = (id: string) => `claude:/${id}`;
const chatUri = (authority: string, vsId: string) => `ahp-chat://${authority}/${b64(sessionUri(vsId))}`;
const fileUri = (path: string) => `file://${path}`;

function makeSessionDb(dir: string, meta: Record<string, string>) {
  mkdirSync(join(dataDir, dir), { recursive: true });
  const file = join(dataDir, dir, "session.db");
  sh(file, `create table session_metadata (key text primary key not null, value text not null);${Object.entries(meta).map(([k, v]) => `insert into session_metadata values (${sql(k)}, ${sql(v)});`).join("")}`);
}

function writeState(cached: unknown[]) {
  const file = join(userDir, "globalStorage", "state.vscdb");
  rmSync(file, { force: true });
  sh(file, `create table ItemTable (key text unique on conflict replace, value blob); insert into ItemTable values ('localAgentHost.cachedSessions.v4', ${sql(JSON.stringify(cached))});`);
}

const stamp = (n: number) => new Date(Date.UTC(2026, 9, 1, 0, 0, 0) + n * 1000).toISOString();
type Line = Record<string, unknown>;

function writeTranscript(sessionId: string, cwd: string, lines: Line[]) {
  const dir = join(projects, projectDirName(cwd));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${sessionId}.jsonl`);
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const past = new Date(Date.now() - 3_600_000);
  utimesSync(file, past, past);
  return file;
}

const base = (sessionId: string, cwd: string, parentUuid: string | null, uuid: string, at: number): Line => ({ parentUuid, isSidechain: false, uuid, timestamp: stamp(at), cwd, sessionId, version: "2.1.0", userType: "external", entrypoint: "sdk-ts" });
const userLine = (sessionId: string, cwd: string, parent: string | null, uuid: string, at: number, content: unknown, extra: Line = {}): Line => ({ ...base(sessionId, cwd, parent, uuid, at), type: "user", message: { role: "user", content }, ...extra });
const assistantLine = (sessionId: string, cwd: string, parent: string, uuid: string, at: number, content: unknown[], model = "claude-sonnet-5-5"): Line => ({ ...base(sessionId, cwd, parent, uuid, at), type: "assistant", message: { model, id: `msg_${uuid}`, role: "assistant", content } });

function conversation(sessionId: string, cwd: string): Line[] {
  const sid = sessionId.slice(0, 4);
  return [
    userLine(sessionId, cwd, null, `${sid}-u1`, 0, "first request", { permissionMode: "acceptEdits" }),
    assistantLine(sessionId, cwd, `${sid}-u1`, `${sid}-a1`, 2, [{ type: "thinking", thinking: "let me look", signature: "s" }]),
    assistantLine(sessionId, cwd, `${sid}-a1`, `${sid}-a2`, 3, [{ type: "tool_use", id: `toolu_${sid}1`, name: "Read", input: { file_path: "/x" } }]),
    userLine(sessionId, cwd, `${sid}-a2`, `${sid}-u2`, 4, [{ type: "tool_result", tool_use_id: `toolu_${sid}1`, content: "file body", is_error: false }]),
    assistantLine(sessionId, cwd, `${sid}-u2`, `${sid}-a3`, 5, [{ type: "text", text: "answer one" }]),
    userLine(sessionId, cwd, `${sid}-a3`, `${sid}-u3`, 20, "second request"),
    assistantLine(sessionId, cwd, `${sid}-u3`, `${sid}-a4`, 22, [{ type: "text", text: "answer two" }]),
  ];
}

function compacted(id: string, logicalParent = "c-a2"): Line[] {
  const sys = (uuid: string, parent: string | null, at: number, extra: Line): Line => ({ ...base(id, repo, parent, uuid, at), type: "system", ...extra });
  return [
    userLine(id, repo, null, "c-u1", 0, "before one"),
    assistantLine(id, repo, "c-u1", "c-a1", 2, [{ type: "text", text: "answer before one" }]),
    userLine(id, repo, "c-a1", "c-u2", 10, "before two"),
    assistantLine(id, repo, "c-u2", "c-a2", 12, [{ type: "text", text: "answer before two" }]),
    sys("c-b", null, 20, { subtype: "compact_boundary", logicalParentUuid: logicalParent, content: "Conversation compacted" }),
    userLine(id, repo, "c-b", "c-s", 21, "This session is being continued from a previous conversation...", { isCompactSummary: true, isVisibleInTranscriptOnly: true }),
    userLine(id, repo, "c-s", "c-cmd", 22, "<command-name>/compact</command-name>"),
    userLine(id, repo, "c-cmd", "c-u3", 30, "after compaction"),
    assistantLine(id, repo, "c-u3", "c-a3", 32, [{ type: "text", text: "answer after" }]),
  ];
}

const uuidOf = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-${String(n).padStart(12, "0")}`;

const work = join(root, "work");
const repo = join(work, "proj");
const wt = join(work, "proj.worktrees", "feat");
const gone = join(work, "gone-folder");
mkdirSync(repo, { recursive: true });
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
git(repo, "init", "-q", "-b", "main");
writeFileSync(join(repo, "a.txt"), "a");
git(repo, "add", ".");
git(repo, "commit", "-q", "-m", "init");
mkdirSync(join(work, "proj.worktrees"), { recursive: true });
git(repo, "worktree", "add", "-q", "-b", "feat", wt);
const chatsDir = join(work, "chats", "c1");
mkdirSync(chatsDir, { recursive: true });
const copilotChat = join(work, "home", ".copilot", "chats", "c2");
mkdirSync(copilotChat, { recursive: true });

const VS_A = uuidOf(1);
const S_A = uuidOf(11);
const P1 = uuidOf(21);
const S_P1 = uuidOf(31);
const P2 = uuidOf(22);
const S_P2 = uuidOf(32);
const S_B = uuidOf(12);
const S_C = uuidOf(13);
const VS_D = uuidOf(4);
const S_D = uuidOf(14);
const VS_E = uuidOf(5);
const S_E = uuidOf(15);
const VS_F = uuidOf(6);
const S_F = uuidOf(16);
const VS_G = uuidOf(7);
const S_G = uuidOf(17);
const S_H = uuidOf(18);
const S_I = uuidOf(19);
const S_J = uuidOf(20);

const providerData = (sdk: string, model = "@provider=anthropic:opus%5B1m%5D", level = "high") => JSON.stringify({ sdkSessionId: sdk, model: { id: model, config: { thinkingLevel: level } } });

function build() {
  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true });
  makeSessionDb(VS_A, {
    defaultChatProviderData: providerData(S_A),
    "claude.workingDirectories": JSON.stringify([fileUri(repo)]),
    "claude.permissionMode": "acceptEdits",
    "claude.model": JSON.stringify({ id: "@provider=anthropic:opus%5B1m%5D", config: { thinkingLevel: "high" } }),
    customTitle: "Session A title",
    isArchived: "",
    isRead: "false",
    peerChats: JSON.stringify([{ uri: chatUri(P1, VS_A), isRead: true, providerData: providerData(S_P1, "@provider=anthropic:sonnet", "low"), origin: { kind: "sideChat", chat: chatUri("default", VS_A), turnId: "request_x", selection: { text: "picked text" } } }]),
    [`customChatTitle:${chatUri(P1, VS_A)}`]: "Side chat title",
  });
  makeSessionDb(`${P2}-${b64(sessionUri(VS_A))}`, {
    "agentHost.chatProviderData": providerData(S_P2, "@provider=anthropic:haiku", "medium"),
    "agentHost.chatOrigin": JSON.stringify({ kind: "sideChat", chat: chatUri("default", VS_A) }),
    "claude.workingDirectories": JSON.stringify([fileUri(repo)]),
  });
  makeSessionDb(`subagent-${b64(sessionUri(VS_A))}-toolu_abc`, { unrelated: "x" });
  makeSessionDb(`subagent-${b64(sessionUri(VS_A))}-toolu_def`, { unrelated: "x" });
  makeSessionDb(VS_D, { defaultChatProviderData: providerData(S_D), "claude.workingDirectories": JSON.stringify([fileUri(gone)]), customTitle: "Gone folder" });
  makeSessionDb(VS_E, { defaultChatProviderData: providerData(S_E), "claude.workingDirectories": JSON.stringify([fileUri(chatsDir)]), "agentHost.workspaceless": "true", customTitle: "Chat without folder" });
  makeSessionDb(VS_F, { defaultChatProviderData: providerData(S_F), "claude.workingDirectories": JSON.stringify([fileUri(wt)]), "agentHost.diffBaseBranch": "main", customTitle: "Worktree session" });
  makeSessionDb(VS_G, { defaultChatProviderData: JSON.stringify({ sdkSessionId: S_G }), isArchived: "true", isRead: "true" });
  makeSessionDb(uuidOf(8), { defaultChatProviderData: JSON.stringify({ sessionId: uuidOf(99) }) });
  writeState([
    { session: sessionUri(S_B), provider: "claude", initiator: { name: "claude" }, startTime: Date.UTC(2026, 9, 2), modifiedTime: Date.UTC(2026, 9, 3), summary: "Cached B summary", workingDirectory: fileUri(repo), status: 32, chats: [{ chat: chatUri("default", S_B), summary: "Cached B summary", kind: "default", interactivity: "full", isRead: true }], external: true },
    { session: sessionUri(S_C), provider: "claude", initiator: { name: "claude" }, startTime: Date.UTC(2026, 9, 2), modifiedTime: Date.UTC(2026, 9, 2), summary: "No transcript", workingDirectory: fileUri(repo), status: 32, chats: [{ chat: chatUri("default", S_C), summary: "x", kind: "default", interactivity: "full", isRead: true }], external: true },
    { session: `${sessionUri(VS_A)}?%EF%BF%BD#r`, provider: "claude", initiator: { name: "vscode" }, startTime: Date.UTC(2026, 9, 1), modifiedTime: Date.UTC(2026, 9, 4), summary: "Cached A summary", workingDirectory: fileUri(repo), status: 32, chats: [{ chat: chatUri("default", VS_A), summary: "x", kind: "default", interactivity: "full", isRead: true }, { chat: chatUri(P1, VS_A), summary: "x", kind: "default", interactivity: "full", isRead: true }, { chat: chatUri("ffffffff-0000-4000-8000-000000000001", VS_A), summary: "x", kind: "default", interactivity: "full", isRead: true }] },
    { session: sessionUri(S_H), provider: "claude", initiator: { name: "claude" }, startTime: Date.UTC(2026, 9, 2), modifiedTime: Date.UTC(2026, 9, 2), summary: "Copilot chat folder", workingDirectory: fileUri(copilotChat), status: 32, chats: [{ chat: chatUri("default", S_H), summary: "x", kind: "default", interactivity: "full", isRead: true }], external: true },
    { session: sessionUri(S_I), provider: "claude", initiator: { name: "claude" }, startTime: Date.UTC(2026, 9, 2), modifiedTime: Date.UTC(2026, 9, 2), summary: "Compacted", workingDirectory: fileUri(repo), status: 32, chats: [{ chat: chatUri("default", S_I), summary: "x", kind: "default", interactivity: "full", isRead: true }], external: true },
    { session: sessionUri(S_J), provider: "claude", initiator: { name: "claude" }, startTime: Date.UTC(2026, 9, 2), modifiedTime: Date.UTC(2026, 9, 2), summary: "Compacted 2", workingDirectory: fileUri(repo), status: 32, chats: [{ chat: chatUri("default", S_J), summary: "x", kind: "default", interactivity: "full", isRead: true }], external: true },
    { session: sessionUri("11111111-1111-4111-8111-111111111111"), provider: "codex", summary: "not claude", workingDirectory: fileUri(repo), status: 32, chats: [], external: true },
  ]);
  writeTranscript(S_A, repo, conversation(S_A, repo));
  writeTranscript(S_P1, repo, conversation(S_P1, repo));
  writeTranscript(S_P2, repo, conversation(S_P2, repo));
  writeTranscript(S_B, repo, conversation(S_B, repo));
  writeTranscript(S_D, gone, conversation(S_D, gone));
  writeTranscript(S_E, chatsDir, conversation(S_E, chatsDir));
  writeTranscript(S_F, wt, conversation(S_F, wt));
  writeTranscript(S_I, repo, compacted(S_I));
  writeTranscript(S_J, repo, compacted(S_J, "not-in-the-file"));
  writeTranscript(S_H, copilotChat, conversation(S_H, copilotChat));
  writeTranscript(S_G, repo, conversation(S_G, repo).map((l) => (l.type === "user" ? { ...l, permissionMode: undefined } : l)));
}

function fresh() {
  build();
  rmSync(join(root, "home"), { recursive: true, force: true });
  mkdirSync(join(root, "home"), { recursive: true });
  const store = new Store();
  const events: { type: string }[] = [];
  const runner = new AgentRunner(store, (e) => events.push(e));
  return { store, runner, events, deps: { store, runner, emit: (e: { type: string }) => events.push(e), userDir, projects } as Parameters<typeof listVscodeSessions>[0] };
}

const fingerprint = (path: string): string => {
  const hash = createHash("sha1");
  const walk = (p: string) => {
    for (const name of readdirSync(p).sort()) {
      const full = join(p, name);
      if (statSync(full).isDirectory()) walk(full);
      else hash.update(full).update(String(statSync(full).mtimeMs)).update(String(statSync(full).size)).update(readFileSync(full));
    }
  };
  walk(path);
  return hash.digest("hex");
};

test("Candidates merge the cache, session.db and chat folders by Claude session id", async () => {
  const { deps } = fresh();
  const list = await listVscodeSessions(deps);
  expect(list.available, `available: ${list.reason}`);
  const byKey = new Map(list.candidates.map((c) => [c.key, c]));
  const a = byKey.get(S_A)!;
  expect(!!a && a.vsSessionId === VS_A && a.kind === "main", "VS Code created session is keyed by its sdkSessionId, not the VS Code session id");
  expect(a.title === "Session A title", `customTitle wins: ${a.title}`);
  expect(a.from === "both", `cache and session.db both describe it: ${a.from}`);
  expect(a.cwd === repo && a.cwdExists, "working directory");
  expect(a.unread === true, "isRead=false is unread");
  expect(byKey.get(S_B)?.title === "Cached B summary" && byKey.get(S_B)?.from === "cache", "external cache session: the session uri id is the Claude session id");
  expect(byKey.get(S_B)?.hasJsonl === true, "transcript found");
  expect(byKey.get(S_C)?.problem === "noTranscript", "no transcript is flagged");
  expect(!list.candidates.some((c) => c.title === "not claude"), "codex cache entries are not candidates");
  expect(!list.candidates.some((c) => c.vsSessionId === uuidOf(8)), "Copilot sessions (no sdkSessionId) are not candidates");
  expect(byKey.get(S_G)?.archived === true, "archived flag");
  return `${list.candidates.length} candidates`;
});

test("Other chats become peer candidates under the main chat; subagent chats are only counted", async () => {
  const { deps } = fresh();
  const list = await listVscodeSessions(deps);
  const byKey = new Map(list.candidates.map((c) => [c.key, c]));
  const p1 = byKey.get(S_P1)!;
  const p2 = byKey.get(S_P2)!;
  expect(p1.kind === "peer" && p1.parentKey === S_A && p1.origin === "sideChat" && p1.title === "Side chat title", `peerChats entry: ${JSON.stringify(p1)}`);
  expect(p2.kind === "peer" && p2.parentKey === S_A && p2.hasJsonl, "chat folder that peerChats does not list");
  const unresolved = list.candidates.find((c) => c.key === `${VS_A}:ffffffff-0000-4000-8000-000000000001`);
  expect(unresolved?.problem === "noSessionId" && unresolved.parentKey === S_A, "cache-only chat has no Claude session id");
  const a = byKey.get(S_A)!;
  expect(a.subagentChats === 2, `subagent folders counted: ${a.subagentChats}`);
  expect(a.chats === 1 + 3 + 2, `chats = main + 3 peers + 2 subagents: ${a.chats}`);
  const order = list.candidates.map((c) => c.key);
  const at = order.indexOf(S_A);
  expect(order.slice(at + 1, at + 4).sort().join() === [S_P1, S_P2, `${VS_A}:ffffffff-0000-4000-8000-000000000001`].sort().join(), `the three other chats sit right below their main chat: ${order.slice(at, at + 5).map((k) => k.slice(0, 8))}`);
  return "ok";
});

test("The cache entry with a broken ?...#r suffix is still found by its uuid", async () => {
  const state = await readVscodeState(userDir);
  expect(state.cached.some((c) => c.vsSessionId === VS_A), "VS_A in cache");
  return `${state.cached.length} cached, ${state.sessions.length} sessions, ${state.peers.length} peers`;
});

test("Transcript to timeline: items, ids, tool pairing, turn results", async () => {
  const lines = conversation(S_B, repo);
  const notes = new Map(lines.map((l) => [l.uuid as string, { type: l.type as string, timestamp: l.timestamp as string }]));
  const chain = lines.map((l) => ({ type: l.type as "user" | "assistant", uuid: l.uuid as string, message: l.message, parent_tool_use_id: null, timestamp: l.timestamp as string }));
  const { built, model } = buildItems(chain, notes, { finishLastTurn: true });
  const items = built.map((b) => b.item);
  expect(model === "claude-sonnet-5-5", "model of the last assistant message");
  expect(items.map((i) => i.kind).join() === "user,thinking,tool,assistant,result,user,assistant,result", `kinds: ${items.map((i) => i.kind).join()}`);
  const tool = items.find((i) => i.kind === "tool");
  expect(tool?.kind === "tool" && tool.status === "done" && tool.output === "file body", "tool result paired by tool_use_id");
  const users = items.filter((i) => i.kind === "user");
  expect(users.every((u) => u.kind === "user" && !u.messageId && u.source === "user"), "user items carry no messageId (restore pairs them by text and order)");
  const results = items.filter((i) => i.kind === "result");
  expect(results[0].kind === "result" && results[0].durationMs === 5000 && results[1].kind === "result" && results[1].durationMs === 2000, `turn durations from timestamps: ${JSON.stringify(results)}`);
  const text = items.find((i) => i.kind === "assistant");
  expect(text?.kind === "assistant" && text.id.endsWith(":0") && text.model === "claude-sonnet-5-5" && !!text.at, "assistant id is <uuid>:<block index>, with model and time");
  return `${items.length} items`;
});

test("System-origin user messages, compaction, API errors, interrupted and unfinished tools", () => {
  const sid = "x";
  const mk = (n: number, type: string, extra: Line) => ({ uuid: `${sid}${n}`, type, timestamp: stamp(n), parent_tool_use_id: null, ...extra }) as never;
  const chain = [
    mk(0, "system", {}),
    mk(1, "user", { message: { content: "Base directory for this skill: /x" } }),
    mk(2, "user", { message: { content: "real prompt" } }),
    mk(3, "assistant", { message: { model: "m", content: [{ type: "text", text: "limit reached" }] } }),
    mk(4, "assistant", { message: { model: "m", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }, { type: "tool_use", id: "t2", name: "Bash", input: {} }] } }),
    mk(5, "user", { message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "[Request interrupted by user for tool use]", is_error: true }] } }),
    mk(6, "user", { message: { content: "<task-notification>done</task-notification>" } }),
    mk(7, "user", { message: { content: "This session is being continued from a previous conversation..." } }),
  ];
  const notes = new Map<string, import("../server/vscodeTimeline").RawNote>([
    [`${sid}0`, { type: "system", subtype: "compact_boundary", timestamp: stamp(0) }],
    [`${sid}1`, { type: "user", isMeta: true }],
    [`${sid}3`, { type: "assistant", isApiError: true }],
    [`${sid}7`, { type: "user", isCompactSummary: true }],
  ]);
  const { built } = buildItems(chain, notes, { finishLastTurn: true });
  const items = built.map((b) => b.item);
  expect(items[0].kind === "notice", "compact boundary becomes a notice");
  expect(items[1].kind === "user" && items[1].source === "system", "isMeta user message is an Automated message");
  expect(items[2].kind === "user" && items[2].source === "user", "real prompt");
  expect(items[3].kind === "error", "API error message becomes an error item");
  const tools = items.filter((i) => i.kind === "tool");
  expect(tools[0].kind === "tool" && tools[0].status === "error" && tools[0].cancelled === true, "interrupted tool is cancelled");
  expect(tools[1].kind === "tool" && tools[1].status === "error" && tools[1].cancelled === true, "a tool call without a result does not stay running");
  const lastUser = items.filter((i) => i.kind === "user").at(-1);
  expect(lastUser?.kind === "user" && lastUser.source === "system" && lastUser.text.startsWith("<task-notification>"), "task notification text is system, and the compaction summary after it is not shown");
  expect(userSource({ type: "user", originKind: "task-notification" }, "x") === "system" && userSource({ type: "user", originKind: "human" }, "x") === "user", "origin kinds");
  return "ok";
});

test("Import: same Claude session id, title, times, status, folder, permission/model/effort", async () => {
  const { deps, store } = fresh();
  const [result] = await importVscodeSessions(deps, [S_A]);
  expect(result.outcome === "created" && !!result.agentId, JSON.stringify(result));
  const agent = store.agent(result.agentId!);
  expect(agent.sessionId === S_A && agent.resumeFrom === null && agent.forkedFrom === null, "sessionId is the existing Claude session id");
  expect(agent.title === "Session A title" && agent.status === "idle", `${agent.title} ${agent.status}`);
  expect(agent.cwd === repo, `cwd ${agent.cwd}`);
  expect(agent.createdAt === new Date(Date.UTC(2026, 9, 1)).toISOString() && agent.updatedAt === new Date(Date.UTC(2026, 9, 4)).toISOString(), `VS Code times: ${agent.createdAt} ${agent.updatedAt}`);
  expect(agent.permissionMode === "acceptEdits" && agent.model === "opus[1m]" && agent.effort === "high", `${agent.permissionMode} ${agent.model} ${agent.effort}`);
  expect(agent.unread === true && agent.done === false, "unread carried over");
  expect(agent.imported?.source === "vscode" && agent.imported.vsSessionId === VS_A && agent.imported.chatId === "default", "origin recorded");
  expect(store.workspaces.some((w) => w.dir === repo && w.parentId === null), "working folder registered as a workspace");
  expect(store.timeline(agent.id).length === 8, `timeline built from the transcript: ${store.timeline(agent.id).length}`);
  return `${result.items} items`;
});

test("Import: chats of one VS Code session become children of the main chat, in any order", async () => {
  const { deps, store } = fresh();
  const peerFirst = await importVscodeSessions(deps, [S_P1]);
  expect(peerFirst[0].outcome === "created", "peer imported before its parent");
  expect(store.agent(peerFirst[0].agentId!).forkedFrom === null, "no parent yet, so it is a root");
  expect(store.agent(peerFirst[0].agentId!).model === "sonnet" && store.agent(peerFirst[0].agentId!).effort === "low", "peer has its own model and effort");
  const [main] = await importVscodeSessions(deps, [S_A]);
  expect(store.agent(peerFirst[0].agentId!).forkedFrom === main.agentId, "importing the parent adopts the existing child");
  const second = await importVscodeSessions(deps, [S_P2]);
  expect(store.agent(second[0].agentId!).forkedFrom === main.agentId, "a later peer attaches to the existing parent");
  expect(store.agent(second[0].agentId!).imported?.origin === "sideChat", "origin kept");
  return "ok";
});

test("Import sorts the main chat before its other chats when both are selected", async () => {
  const { deps, store } = fresh();
  const results = await importVscodeSessions(deps, [S_P1, S_P2, S_A]);
  const main = results.find((r) => r.key === S_A)!;
  expect(results.map((r) => r.key).join() === [S_P1, S_P2, S_A].join(), "results come back in the requested order");
  expect(results.filter((r) => r.key !== S_A).every((r) => store.agent(r.agentId!).forkedFrom === main.agentId), "children linked");
  return "ok";
});

test("Duplicates: the same Claude session id is never created twice; re-import adds nothing when nothing changed", async () => {
  const { deps, store } = fresh();
  const [first] = await importVscodeSessions(deps, [S_B]);
  const [again] = await importVscodeSessions(deps, [S_B]);
  expect(again.agentId === first.agentId && again.outcome === "unchanged" && again.added === 0, JSON.stringify(again));
  expect(store.agents.filter((a) => a.sessionId === S_B).length === 1, "one agent");
  const list = await listVscodeSessions(deps);
  expect(list.candidates.find((c) => c.key === S_B)?.importedAgentId === first.agentId && list.stats.alreadyImported === 1, "list marks it as imported");
  return "ok";
});

test("An agent-nav session that already has the Claude session id is not imported again", async () => {
  const { deps, store, runner } = fresh();
  runner.adopt({ id: "native", workspaceId: null, cwd: repo, worktree: null, forkedFrom: null, resumeFrom: null, startCommit: null, feedbackId: null, title: "native", sessionId: S_B, status: "idle", permissionMode: "default", model: null, effort: null, activeModel: null, activeEffort: null, backgroundTasks: 0, createdAt: "", updatedAt: "" }, []);
  const [result] = await importVscodeSessions(deps, [S_B]);
  expect(result.agentId === "native" && result.outcome === "unchanged" && store.agents.length === 1, JSON.stringify(result));
  return "ok";
});

test("Re-import adds only the entries VS Code wrote since; a tool result that arrives late updates its row", async () => {
  const { deps, store } = fresh();
  const lines = conversation(S_B, repo);
  lines.push(assistantLine(S_B, repo, "uuid-none", "late-a", 30, [{ type: "tool_use", id: "toolu_late", name: "Bash", input: { command: "ls" } }]));
  lines[lines.length - 1].parentUuid = lines[lines.length - 2].uuid;
  writeTranscript(S_B, repo, lines);
  const [first] = await importVscodeSessions(deps, [S_B]);
  const before = store.timeline(first.agentId!);
  const late = before.find((i) => i.id === "toolu_late");
  expect(late?.kind === "tool" && late.status === "error" && late.cancelled === true, "unfinished tool is cancelled at first");
  const next = [
    userLine(S_B, repo, "late-a", "late-u", 31, [{ type: "tool_result", tool_use_id: "toolu_late", content: "listing", is_error: false }]),
    assistantLine(S_B, repo, "late-u", "late-a2", 32, [{ type: "text", text: "after the tool" }]),
    userLine(S_B, repo, "late-a2", "late-u3", 50, "third request"),
    assistantLine(S_B, repo, "late-u3", "late-a3", 52, [{ type: "text", text: "answer three" }]),
  ];
  appendFileSync(join(projects, projectDirName(repo), `${S_B}.jsonl`), next.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const [again] = await importVscodeSessions(deps, [S_B]);
  const after = store.timeline(first.agentId!);
  expect(again.outcome === "updated" && again.added > 0, JSON.stringify(again));
  const updated = after.find((i) => i.id === "toolu_late");
  expect(updated?.kind === "tool" && updated.status === "done" && updated.output === "listing" && !updated.cancelled, "late tool result updates the existing row");
  expect(after.filter((i) => i.id === "toolu_late").length === 1, "no duplicate row");
  expect(after.filter((i) => i.kind === "user" && i.source === "user").length === 3, "one new user prompt");
  expect(after.slice(0, before.length - 0).every((item, n) => item.id === before[n].id), "earlier items keep their order");
  const [third] = await importVscodeSessions(deps, [S_B]);
  expect(third.outcome === "unchanged", `a second re-import is a no-op: ${JSON.stringify(third)}`);
  return `${before.length} -> ${after.length} items`;
});

test("An item agent-nav wrote itself (random id, messageId = transcript uuid) is not duplicated by a sync", async () => {
  const { deps, store, runner } = fresh();
  const [first] = await importVscodeSessions(deps, [S_B]);
  const id = first.agentId!;
  const lines = [userLine(S_B, repo, "S_B-a4", "own-u", 100, "sent from agent-nav"), assistantLine(S_B, repo, "own-u", "own-a", 101, [{ type: "text", text: "reply" }])];
  const chainTail = conversation(S_B, repo).at(-1)!.uuid as string;
  lines[0].parentUuid = chainTail;
  appendFileSync(join(projects, projectDirName(repo), `${S_B}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  runner.applyImported(id, [{ id: "random-user-id", kind: "user", text: "sent from agent-nav", source: "user", at: stamp(100), messageId: "own-u" }, { id: "own-a:0", kind: "assistant", text: "reply", streaming: false, at: stamp(101) }]);
  store.patchAgent(id, { imported: { ...store.agent(id).imported!, syncedMtimeMs: statSync(join(projects, projectDirName(repo), `${S_B}.jsonl`)).mtimeMs, syncedUntil: stamp(101) } });
  const before = store.timeline(id).length;
  const [again] = await importVscodeSessions(deps, [S_B]);
  expect(again.outcome === "unchanged" && store.timeline(id).length === before, `no duplicates: ${JSON.stringify(again)}`);
  return "ok";
});

test("Folder gone: imported as an error session with the workingDirectoryFailed message", async () => {
  const { deps, store } = fresh();
  const [result] = await importVscodeSessions(deps, [S_D]);
  const agent = store.agent(result.agentId!);
  expect(agent.status === "error" && agent.imported?.cwdMissing === true, `${agent.status}`);
  const error = store.timeline(agent.id).find((i) => i.kind === "error");
  expect(error?.kind === "error" && /workingDirectoryFailed/.test(error.text), "error item on the timeline");
  expect(result.note !== null, "the result says the folder is missing");
  const list = await listVscodeSessions(deps);
  expect(list.candidates.find((c) => c.key === S_D)?.cwdExists === false, "list shows the folder as missing");
  return "ok";
});

test("Folder-less chat (workspaceless) goes to Chats", async () => {
  const { deps, store } = fresh();
  const [result] = await importVscodeSessions(deps, [S_E]);
  const agent = store.agent(result.agentId!);
  expect(agent.workspaceId === null && agent.cwd === chatsDir && agent.startCommit === null, `${agent.workspaceId} ${agent.cwd}`);
  return "ok";
});

test("A cache-only session that ran in ~/.copilot/chats/<id> is a folder-less chat", async () => {
  const { deps, store } = fresh();
  const [result] = await importVscodeSessions(deps, [S_H]);
  const agent = store.agent(result.agentId!);
  expect(agent.workspaceId === null && agent.cwd === realpathSync(copilotChat), `${agent.workspaceId} ${agent.cwd}`);
  return "ok";
});

test("A git worktree session keeps the worktree/repo relation, like AgentRunner.create", async () => {
  const { deps, store } = fresh();
  const [result] = await importVscodeSessions(deps, [S_F]);
  const agent = store.agent(result.agentId!);
  expect(agent.worktree?.root === wt && agent.worktree.branch === "feat" && agent.worktree.base === "main", JSON.stringify(agent.worktree));
  const workspace = store.workspace(agent.workspaceId!);
  const parent = store.workspace(workspace.parentId!);
  expect(parent.dir === repo && workspace.dir === wt && workspace.name === "proj (feat)", `${parent.dir} -> ${workspace.name}`);
  expect(agent.startCommit === null, "worktree sessions have no startCommit");
  return "ok";
});

test("A plain folder session gets a startCommit and no worktree; archived becomes Done; defaults fill the rest", async () => {
  const { deps, store } = fresh();
  const [g] = await importVscodeSessions(deps, [S_G]);
  const agent = store.agent(g.agentId!);
  expect(agent.worktree === null && !!agent.startCommit, "startCommit of the repo head");
  expect(agent.done === true, "archived is done");
  expect(agent.model === null && agent.effort === null && ["default", "acceptEdits", "plan", "auto", "bypassPermissions"].includes(agent.permissionMode), `defaults: ${agent.permissionMode}`);
  expect(agent.title.length > 0 && agent.title !== "Untitled session", `title from the first prompt: ${agent.title}`);
  return "ok";
});

test("Items with no Claude session id or no transcript are skipped, unknown keys fail", async () => {
  const { deps } = fresh();
  const results = await importVscodeSessions(deps, [S_C, `${VS_A}:ffffffff-0000-4000-8000-000000000001`, "nope"]);
  expect(results[0].outcome === "skipped" && /history file/.test(results[0].note ?? ""), JSON.stringify(results[0]));
  expect(results[1].outcome === "skipped" && /no Claude session id/.test(results[1].note ?? ""), JSON.stringify(results[1]));
  expect(results[2].outcome === "failed", JSON.stringify(results[2]));
  return "ok";
});


test("Before a send: no new records means nothing changes; new records from VS Code are synced and ask for a fresh process", async () => {
  const { deps, store } = fresh();
  const [r] = await importVscodeSessions(deps, [S_B]);
  const id = r.agentId!;
  expect(!(await reconcileBeforeTurn(deps, id)), "unchanged file: no sync");
  const file = join(projects, projectDirName(repo), `${S_B}.jsonl`);
  const tail = conversation(S_B, repo).at(-1)!.uuid as string;
  appendFileSync(file, JSON.stringify(userLine(S_B, repo, tail, "vs-u", 70, "written in VS Code")) + "\n" + JSON.stringify(assistantLine(S_B, repo, "vs-u", "vs-a", 71, [{ type: "text", text: "vs reply" }])) + "\n");
  const future = new Date(Date.now() + 5000);
  utimesSync(file, future, future);
  const before = store.timeline(id).length;
  expect(await reconcileBeforeTurn(deps, id), "new records: synced");
  expect(store.timeline(id).length === before + 2, `user + assistant: ${store.timeline(id).length - before}`);
  expect(!(await reconcileBeforeTurn(deps, id)), "the marker moved, so the next send does not sync again");
  return "ok";
});

test("VS Code activity notice: only when the transcript changed recently and agent-nav is not the writer", async () => {
  const { deps, store } = fresh();
  const [r] = await importVscodeSessions(deps, [S_B]);
  const id = r.agentId!;
  const file = join(projects, projectDirName(repo), `${S_B}.jsonl`);
  const now = Date.now();
  const at = (ms: number) => ({ ...deps, now: () => ms });
  expect(!importActivity(at(now + 60_000), id).active, "an old file is not active");
  const touched = new Date(now + 60_000);
  utimesSync(file, touched, touched);
  expect(importActivity(at(now + 62_000), id).active, "file written 2s ago by someone else");
  store.patchAgent(id, { updatedAt: new Date(now + 55_000).toISOString() });
  expect(!importActivity(at(now + 62_000), id).active, "agent-nav's own turn ended 7s ago: not active");
  store.patchAgent(id, { updatedAt: new Date(now).toISOString(), status: "running" });
  expect(!importActivity(at(now + 62_000), id).active, "while agent-nav runs a turn it is the writer");
  expect(!importActivity(deps, "missing").active, "unknown agent");
  return "ok";
});

test("peekTranscript reads the real tail of a mid-sized file (between the head and tail windows)", async () => {
  const pad = Array.from({ length: 700 }, (_, n) => ({ type: "attachment", uuid: `pad${n}`, timestamp: stamp(200 + n), padding: "x".repeat(120) }));
  const file = writeTranscript(uuidOf(40), repo, [userLine(uuidOf(40), repo, null, "p-u", 0, "first prompt here"), ...pad, { type: "ai-title", aiTitle: "Late title", sessionId: uuidOf(40) }]);
  const peek = await peekTranscript(file);
  expect(statSync(file).size > 64 * 1024 && statSync(file).size < 512 * 1024, `size ${statSync(file).size}`);
  expect(peek?.lastTimestamp === stamp(899) && peek.aiTitle === "Late title" && peek.firstPrompt === "first prompt here" && peek.cwd === repo, JSON.stringify(peek));
  return "ok";
});

test("markSynced moves both markers to the end of the transcript after agent-nav's own turn", async () => {
  const { deps, store } = fresh();
  const [r] = await importVscodeSessions(deps, [S_B]);
  const id = r.agentId!;
  const file = join(projects, projectDirName(repo), `${S_B}.jsonl`);
  const tail = conversation(S_B, repo).at(-1)!.uuid as string;
  appendFileSync(file, JSON.stringify(userLine(S_B, repo, tail, "own2-u", 300, "own turn")) + "\n");
  markSynced(deps, id);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const imported = store.agent(id).imported!;
  expect(imported.syncedUntil === stamp(300) && imported.syncedMtimeMs === statSync(file).mtimeMs, JSON.stringify(imported));
  return "ok";
});

test("Compacted session: the history before the last compaction is shown read-only above a Compacted conversation divider", async () => {
  const { deps, store } = fresh();
  const [result, second] = await importVscodeSessions(deps, [S_I, S_J]);
  expect(result.outcome === "created" && second.outcome === "created", JSON.stringify([result, second]));
  const kindsOf = (agentId: string) => store.timeline(agentId).map((i) => (i.kind === "user" ? `user${i.preCompact ? "(pre)" : ""}` : i.kind === "notice" ? "divider" : i.kind)).join();
  expect(kindsOf(second.agentId!) === kindsOf(result.agentId!), `a boundary whose logicalParentUuid is not in the file still finds the earlier history: ${kindsOf(second.agentId!)}`);
  const items = store.timeline(result.agentId!);
  const kinds = items.map((i) => (i.kind === "user" ? `user${i.preCompact ? "(pre)" : ""}` : i.kind === "notice" ? "divider" : i.kind));
  expect(kinds.join() === "user(pre),assistant,result,user(pre),assistant,result,divider,user,assistant,result", `kinds: ${kinds.join()}`);
  const divider = items.find((i) => i.kind === "notice");
  expect(divider?.kind === "notice" && divider.divider === true && divider.text === "Compacted conversation", "divider wording");
  expect(!items.some((i) => i.kind === "user" && /being continued|command-name/.test(i.text)), "the summary and the /compact command text are not shown");
  const post = items.find((i) => i.kind === "user" && !i.preCompact);
  expect(post?.kind === "user" && post.text === "after compaction" && !post.messageId, "post-compaction prompt keeps the normal checkpoint path");
  const first = items.find((i) => i.kind === "user");
  let blocked = "";
  try {
    await deps.runner.restoreCheckpoint(result.agentId!, first!.id);
  } catch (error) {
    blocked = (error as Error).message;
  }
  expect(/compacted/.test(blocked), `restore of a pre-compaction message is refused: ${blocked}`);
  try {
    await deps.runner.forkBefore(result.agentId!, items.filter((i) => i.kind === "user")[1].id);
    blocked = "";
  } catch (error) {
    blocked = (error as Error).message;
  }
  expect(/compacted/.test(blocked), `fork before a pre-compaction message is refused: ${blocked}`);
  return `${items.length} items`;
});

test("Reading and importing never change the VS Code state or the transcripts", async () => {
  const { deps } = fresh();
  const before = { code: fingerprint(join(root, "code")), claude: fingerprint(projects) };
  await listVscodeSessions(deps);
  await importVscodeSessions(deps, [S_A, S_P1, S_P2, S_B, S_D, S_E, S_F, S_G]);
  await importVscodeSessions(deps, [S_A, S_B]);
  const after = { code: fingerprint(join(root, "code")), claude: fingerprint(projects) };
  expect(before.code === after.code, "VS Code state folder is byte-for-byte the same");
  expect(before.claude === after.claude, "Claude projects folder is byte-for-byte the same");
  return "ok";
});

test("mergeBuilt skips what is already there and what is not newer than the sync marker", () => {
  const user = { id: "u", kind: "user" as const, text: "t", source: "user" as const };
  const mk = (id: string, ts: string) => ({ item: { id, kind: "assistant" as const, text: id, streaming: false }, ts });
  const merged = mergeBuilt([user], [{ item: user, ts: stamp(1) }, mk("old", stamp(2)), mk("new", stamp(9))], stamp(5));
  expect(merged.add.map((i) => i.id).join() === "new", `${merged.add.map((i) => i.id)}`);
  return "ok";
});

test("collectDrafts is pure: unresolved chats and counts come from the state alone", () => {
  const drafts = collectDrafts({ cached: [], sessions: [], peers: [], subagentDirs: new Map() });
  return expect(drafts.length === 0, "empty state");
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
rmSync(root, { recursive: true, force: true });
console.log(failed ? `${failed} failed` : `${cases.length} passed`);
process.exit(failed ? 1 : 0);
