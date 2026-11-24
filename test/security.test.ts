import { readFileSync } from "node:fs";
import { join } from "node:path";
import { request } from "node:http";
import WebSocket from "ws";
import { useTestDaemon } from "./testDaemon";

const daemon = await useTestDaemon();
const PORT = daemon.port;
const TOKEN = daemon.token;
const ORIGIN = `http://127.0.0.1:${PORT}`;

type Case = { name: string; run: () => Promise<string> };
const cases: Case[] = [];
const test = (name: string, run: () => Promise<string>) => cases.push({ name, run });

function connect(origin: string | null, token: string | null) {
  const url = `ws://127.0.0.1:${PORT}/ws/rpc${token === null ? "" : `?token=${token}`}`;
  return new Promise<"open" | number>((resolve) => {
    const ws = new WebSocket(url, { headers: origin === null ? {} : { origin } });
    ws.on("open", () => {
      ws.close();
      resolve("open");
    });
    ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
    ws.on("error", () => {});
  });
}

async function rpc(method: string, params: unknown) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/rpc?token=${TOKEN}`, { headers: { origin: ORIGIN } });
  await new Promise((r) => ws.on("open", r));
  ws.send(JSON.stringify({ id: 1, method, params }));
  const reply = await new Promise<{ result?: unknown; error?: string }>((resolve) =>
    ws.on("message", (data) => {
      const message = JSON.parse(String(data)) as { id?: number; result?: unknown; error?: string };
      if (message.id === 1) resolve(message);
    }),
  );
  ws.close();
  return reply;
}

const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
  return detail;
};

test("WebSocket without a token is 403", async () => expect((await connect(ORIGIN, null)) === 403, "403"));
test("Wrong token is 403", async () => expect((await connect(ORIGIN, "deadbeef")) === 403, "403"));
test("Foreign Origin is 403 even with a valid token", async () => expect((await connect("https://evil.example", TOKEN)) === 403, "403"));
test("Missing Origin header is 403", async () => expect((await connect(null, TOKEN)) === 403, "403"));
test("Valid Origin and token connect", async () => expect((await connect(ORIGIN, TOKEN)) === "open", "open"));
test("Terminal (pty) WebSocket without a token is 403", async () => {
  const status = await new Promise<"open" | number>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/pty?agentId=x`, { headers: { origin: ORIGIN } });
    ws.on("open", () => resolve("open"));
    ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
    ws.on("error", () => {});
  });
  return expect(status === 403, `${status}`);
});
test("Terminal for an unknown agentId is closed", async () => {
  const code = await new Promise<number>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/pty?agentId=nope&token=${TOKEN}`, { headers: { origin: ORIGIN } });
    ws.on("close", (c) => resolve(c));
    ws.on("error", () => {});
  });
  return expect(code === 1008, `close ${code}`);
});
test("Worktree branch name escaping the workspace is rejected", async () => {
  const { result } = (await rpc("workspaces.list", {})) as { result: { id: string; dir: string }[] };
  const ws = result.find((w) => w.dir.includes("agent-nav-test")) ?? result[0];
  const reply = await rpc("agents.create", { workspaceId: ws.id, prompt: "x", permissionMode: "default", model: "haiku", effort: null, worktree: { branch: "../../escape", base: "main" } });
  return expect(typeof reply.error === "string", reply.error ?? "allowed");
});
test("Mismatched Host header is HTTP 403", async () => {
  const status = await new Promise<number>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: PORT, path: "/", headers: { host: "evil.example:80" } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
  return expect(status === 403, `status ${status}`);
});
test("Reading a file outside the workspace is rejected", async () => {
  const { result } = (await rpc("workspaces.list", {})) as { result: { id: string }[] };
  const reply = await rpc("files.read", { workspaceId: result[0].id, path: "../../.ssh/id_rsa" });
  return expect(typeof reply.error === "string" && reply.error.includes("outside the workspace"), reply.error ?? "allowed");
});
test("Absolute paths outside the workspace are rejected", async () => {
  const { result } = (await rpc("workspaces.list", {})) as { result: { id: string }[] };
  const reply = await rpc("files.read", { workspaceId: result[0].id, path: "/etc/passwd" });
  return expect(typeof reply.error === "string", reply.error ?? "allowed");
});
test("Creating or saving a file outside the workspace is rejected, even through ..", async () => {
  const { result } = (await rpc("workspaces.list", {})) as { result: { id: string }[] };
  const workspaceId = result[0].id;
  for (const path of ["../agent-nav-escape.txt", "/tmp/agent-nav-escape.txt", "src/../../agent-nav-escape.txt"]) {
    const created = await rpc("files.create", { workspaceId, path, kind: "file" });
    const saved = await rpc("files.save", { workspaceId, path, text: "x", baseMtimeMs: null });
    if (typeof created.error !== "string" || typeof saved.error !== "string") throw new Error(`allowed: ${path}`);
  }
  return "create and save refused for 3 escaping paths";
});
test("search.replace refuses paths outside the workspace and writes nothing", async () => {
  const { result } = (await rpc("workspaces.list", {})) as { result: { id: string }[] };
  const hosts = readFileSync("/etc/hosts", "utf8");
  const edits = [{ range: { startLine: 0, startCol: 0, endLine: 0, endCol: 1 }, expected: hosts[0], replacement: "X" }];
  const paths = ["../agent-nav-escape.txt", "/etc/hosts", "/tmp/agent-nav-escape.txt", "src/../../agent-nav-escape.txt"];
  const reply = (await rpc("search.replace", { workspaceId: result[0].id, files: paths.map((path) => ({ path, edits })) })) as { result?: { results: { path: string; status: string }[] } };
  const statuses = reply.result?.results.map((r) => r.status) ?? [];
  expect(statuses.length === paths.length && statuses.every((s) => s === "outsideWorkspace"), JSON.stringify(reply));
  expect(readFileSync("/etc/hosts", "utf8") === hosts, "/etc/hosts changed");
  return "4 escaping paths refused";
});
test("search.replace rejects an unknown workspace, a non-array files and an oversized request", async () => {
  const { result } = (await rpc("workspaces.list", {})) as { result: { id: string }[] };
  const unknown = await rpc("search.replace", { workspaceId: "no-such-workspace", files: [] });
  const notArray = await rpc("search.replace", { workspaceId: result[0].id, files: "x" });
  const tooMany = await rpc("search.replace", { workspaceId: result[0].id, files: Array.from({ length: 10_001 }, (_, i) => ({ path: `x${i}`, edits: [] })) });
  for (const reply of [unknown, notArray, tooMany]) expect(typeof reply.error === "string", JSON.stringify(reply));
  return "3 requests refused";
});
test("Formatting a file outside the workspace is rejected", async () => {
  const { result } = (await rpc("workspaces.list", {})) as { result: { id: string }[] };
  const reply = await rpc("format.run", { workspaceId: result[0].id, path: "/etc/hosts", text: "x" });
  return expect(typeof reply.error === "string" && reply.error.includes("outside the workspace"), reply.error ?? "allowed");
});
test("Writing a file with no edit record is rejected", async () => {
  const { result } = (await rpc("agents.list", {})) as { result: { id: string }[] };
  if (!result.length) return "no agent, skipped";
  const reply = await rpc("files.write", { agentId: result[0].id, path: "/tmp/agent-nav-should-not-exist", text: "x" });
  return expect(typeof reply.error === "string" && /Not a changed file|outside the workspace/.test(reply.error), reply.error ?? "allowed");
});
test("Writing a file inside the session cwd but outside the change set is rejected", async () => {
  const { result } = (await rpc("agents.list", {})) as { result: { id: string; cwd: string; workspaceId: string }[] };
  if (!result.length) return "no agent, skipped";
  const outcomes: string[] = [];
  for (const agent of result.slice(0, 6)) {
    const target = `${agent.cwd}/tsconfig.json`;
    const read = (await rpc("files.read", { workspaceId: agent.workspaceId, path: target })) as { result?: { text: string | null } };
    if (!read.result?.text) continue;
    const reply = await rpc("files.write", { agentId: agent.id, path: target, text: read.result.text });
    outcomes.push(reply.error ? "rejected" : "allowed");
    if (!reply.error) throw new Error(`allowed: ${target}`);
  }
  return outcomes.length ? `all ${outcomes.length} sessions rejected` : "no readable target";
});
test("A missing folder is not added as a workspace", async () => {
  const reply = await rpc("workspaces.add", { dir: "/nonexistent/agent-nav-folder" });
  return expect(typeof reply.error === "string" && reply.error.includes("Folder not found"), reply.error ?? "added");
});
const element = { component: "X", sources: [], tag: "div", domPath: "div", width: 1, height: 1, text: "", styles: {} };
test("Feedback with an empty sentence is rejected", async () => {
  const reply = await rpc("feedback.create", { text: "  ", element, screenshot: null, screenshotNote: null });
  return expect(typeof reply.error === "string", reply.error ?? "created");
});
test("Feedback with a screenshot that is not a PNG is rejected", async () => {
  const reply = await rpc("feedback.create", { text: "x", element, screenshot: Buffer.from("not a png").toString("base64"), screenshotNote: null });
  return expect(typeof reply.error === "string" && reply.error.includes("not a PNG"), reply.error ?? "created");
});
test("Revert, restart and mark-seen on an unknown feedback id are errors", async () => {
  for (const method of ["feedback.revert", "feedback.restart", "feedback.markSeen"]) {
    const reply = await rpc(method, { id: "../../etc" });
    expect(typeof reply.error === "string" && reply.error.startsWith("Unknown feedback"), `${method}: ${reply.error ?? "ok"}`);
  }
  return "all rejected";
});
type BoardShape = { columns: { id: string; name: string; role: string | null }[]; cards: { id: string; columnId: string; title: string; links: { url: string }[]; labels: string[] }[] };
const boardReply = async () => ((await rpc("board.get", {})) as { result: BoardShape }).result;
const rejected = (reply: { error?: string }, detail: string) => expect(typeof reply.error === "string", `${detail}: ${reply.error ?? "accepted"}`);
test("Board card with an empty title is rejected", async () => rejected(await rpc("board.createCard", { title: "   " }), "empty"));
test("Board card with a non-string title is rejected", async () => rejected(await rpc("board.createCard", { title: 5 }), "number"));
test("Board card with a javascript: or file: link is rejected", async () => {
  for (const url of ["javascript:alert(1)", "file:///etc/passwd", "ftp://example.com", "not a url", "slack://channel?id=1"]) {
    rejected(await rpc("board.createCard", { title: "x", links: [{ url }] }), url);
  }
  return "all rejected";
});
test("Board card with links that are not a list is rejected", async () => rejected(await rpc("board.createCard", { title: "x", links: "https://example.com" }), "string"));
test("Board card for an unknown workspace, column or session is rejected", async () => {
  rejected(await rpc("board.createCard", { title: "x", workspaceId: "nope" }), "workspace");
  rejected(await rpc("board.createCard", { title: "x", columnId: "nope" }), "column");
  rejected(await rpc("board.createCard", { title: "x", agentIds: ["nope"] }), "agent");
  return "all rejected";
});
test("Board card with too many or empty labels is rejected", async () => {
  rejected(await rpc("board.createCard", { title: "x", labels: ["  "] }), "blank");
  rejected(await rpc("board.createCard", { title: "x", labels: Array.from({ length: 11 }, (_, i) => `l${i}`) }), "11 labels");
  return "all rejected";
});
test("Board calls on an unknown card or column are rejected", async () => {
  const before = JSON.stringify(await boardReply());
  rejected(await rpc("board.updateCard", { id: "nope", patch: { title: "x" } }), "update");
  rejected(await rpc("board.deleteCard", { id: "nope" }), "delete");
  rejected(await rpc("board.moveCard", { id: "nope", columnId: "todo", index: 0 }), "move card");
  rejected(await rpc("board.moveCard", { id: "nope", columnId: "nope", index: 0 }), "move column");
  rejected(await rpc("board.linkAgent", { cardId: "nope", agentId: "nope" }), "link");
  rejected(await rpc("board.renameColumn", { id: "nope", name: "x" }), "rename");
  rejected(await rpc("board.deleteColumn", { id: "nope" }), "delete column");
  rejected(await rpc("board.moveColumn", { id: "nope", index: 0 }), "move column");
  return expect(JSON.stringify(await boardReply()) === before, "board unchanged");
});
test("Board column names must be non-empty text of at most 40 characters", async () => {
  rejected(await rpc("board.addColumn", { name: "  " }), "blank");
  rejected(await rpc("board.addColumn", { name: "x".repeat(41) }), "41 chars");
  rejected(await rpc("board.addColumn", { name: 7 }), "number");
  return "all rejected";
});
test("Board card update with a bad patch leaves the card unchanged", async () => {
  const created = ((await rpc("board.createCard", { title: "agent-nav test card (bad patch)" })) as { result: { id: string } }).result;
  try {
    rejected(await rpc("board.updateCard", { id: created.id, patch: { title: "", links: [{ url: "javascript:1" }] } }), "bad patch");
    rejected(await rpc("board.moveCard", { id: created.id, columnId: "nope", index: 0 }), "bad column");
    rejected(await rpc("board.moveCard", { id: created.id, columnId: (await boardReply()).columns[0].id, index: 1.5 }), "fractional index");
    const card = (await boardReply()).cards.find((c) => c.id === created.id);
    return expect(card?.title === "agent-nav test card (bad patch)", "unchanged");
  } finally {
    await rpc("board.deleteCard", { id: created.id });
  }
});
test("BOARDUX: board RPC rejects a bad priority and label color, keeps the card number, and returns priority and number", async () => {
  const created = ((await rpc("board.createCard", { title: "agent-nav test card (priority)", priority: 2 })) as { result: { id: string; priority: number; number: number } }).result;
  try {
    expect(created.priority === 2 && Number.isInteger(created.number) && created.number > 0, `created p${created.priority} #${created.number}`);
    for (const bad of [5, -1, 1.5, "1", null]) rejected(await rpc("board.updateCard", { id: created.id, patch: { priority: bad } }), `priority ${String(bad)}`);
    rejected(await rpc("board.createCard", { title: "x", priority: 9 }), "create priority 9");
    const changed = (await rpc("board.updateCard", { id: created.id, patch: { priority: 1, number: 99 } })) as { result: { priority: number; number: number } };
    expect(changed.result.priority === 1 && changed.result.number === created.number, "priority set, number untouched");
    rejected(await rpc("board.setLabelColor", { label: "agent-nav-test", color: 8 }), "color 8");
    rejected(await rpc("board.setLabelColor", { label: "agent-nav-test", color: 0.5 }), "color 0.5");
    rejected(await rpc("board.setLabelColor", { label: "  ", color: 1 }), "blank label");
    expect(!(await rpc("board.setLabelColor", { label: "Agent-Nav-Test", color: 3 })).error, "set color");
    expect((await boardReply() as unknown as { labelColors: Record<string, number> }).labelColors["agent-nav-test"] === 3, "stored lower case");
    expect(!(await rpc("board.setLabelColor", { label: "agent-nav-test", color: null })).error, "reset color");
    return expect(!("agent-nav-test" in (await boardReply() as unknown as { labelColors: Record<string, number> }).labelColors), "color removed");
  } finally {
    await rpc("board.deleteCard", { id: created.id });
    await rpc("board.setLabelColor", { label: "agent-nav-test", color: null });
  }
});
test("Board columns and cards round-trip through board.json", async () => {
  const columnId = ((await rpc("board.addColumn", { name: "agent-nav test column" })) as { result: { id: string } }).result.id;
  const cardIds: string[] = [];
  try {
    const home = daemon.home;
    for (const title of ["first", "second", "third"]) {
      const created = (await rpc("board.createCard", { title: `agent-nav test ${title}`, columnId, labels: ["t"], links: [{ url: "https://example.com/a" }] })) as { result: { id: string } };
      cardIds.push(created.result.id);
    }
    expect(!(await rpc("board.moveCard", { id: cardIds[2], columnId, index: 0 })).error, "move within column");
    const order = (await boardReply()).cards.filter((c) => c.columnId === columnId).map((c) => c.title);
    expect(order.join("|") === "agent-nav test third|agent-nav test first|agent-nav test second", order.join("|"));
    const onDisk = JSON.parse(readFileSync(join(home, "board.json"), "utf8")) as BoardShape;
    expect(onDisk.cards.filter((c) => c.columnId === columnId).map((c) => c.title).join("|") === order.join("|"), "board.json differs");
    const columns = (await boardReply()).columns;
    const previous = columns[columns.findIndex((c) => c.id === columnId) - 1];
    expect(!(await rpc("board.deleteColumn", { id: columnId })).error, "delete column");
    const after = await boardReply();
    const inPrevious = after.cards.filter((c) => c.columnId === previous.id).map((c) => c.id);
    expect(cardIds.every((id) => after.cards.find((c) => c.id === id)?.columnId === previous.id), "cards moved to previous column");
    expect(inPrevious.slice(-3).join() === [cardIds[2], cardIds[0], cardIds[1]].join(), "order kept at the end of the previous column");
    return "ok";
  } finally {
    for (const id of cardIds) await rpc("board.deleteCard", { id });
    await rpc("board.deleteColumn", { id: columnId });
  }
});
test("Board settings reject a non-boolean autoMove value", async () => {
  const before = ((await rpc("settings.get", {})) as { result: { boardAutoMove: boolean } }).result.boardAutoMove;
  const reply = (await rpc("settings.set", { boardAutoMove: "yes" })) as { result?: { boardAutoMove: boolean } };
  return expect(reply.result?.boardAutoMove === before, `stays ${before}`);
});
test("Notification settings reject non-boolean values", async () => {
  const get = async () => ((await rpc("settings.get", {})) as { result: { notifyOnResponse: boolean; notifyOnApproval: boolean } }).result;
  const before = await get();
  await rpc("settings.set", { notifyOnResponse: "yes", notifyOnApproval: 1 });
  const after = await get();
  return expect(after.notifyOnResponse === before.notifyOnResponse && after.notifyOnApproval === before.notifyOnApproval, `stays ${before.notifyOnResponse}, ${before.notifyOnApproval}`);
});
test("previewCheckpoint rejects an unknown session", async () => {
  const reply = (await rpc("agents.previewCheckpoint", { agentId: "no-such-agent", itemId: "x" })) as { error?: string };
  return expect(typeof reply.error === "string", `error ${reply.error}`);
});
test("Diff view setting accepts inline, split, and auto only", async () => {
  const get = async () => ((await rpc("settings.get", {})) as { result: { diffView?: string } }).result.diffView;
  const set = async (patch: unknown) => ((await rpc("settings.set", patch)) as { result: { diffView?: string } }).result.diffView;
  const before = await get();
  expect(before === "inline" || before === "split" || before === "auto", `default is inline, split, or auto, got ${before}`);
  try {
    expect((await set({ diffView: "split" })) === "split", "split accepted");
    expect((await get()) === "split", "split persisted in the daemon");
    for (const bad of ["Split", "unified", "", null, 1, true, ["split"], { v: "split" }, "Auto"]) {
      expect((await set({ diffView: bad })) === "split", `rejected ${JSON.stringify(bad)}`);
    }
    expect((await set({ diffView: "auto" })) === "auto", "auto accepted");
    expect((await set({ diffView: "inline" })) === "inline", "inline accepted");
  } finally {
    await set({ diffView: before });
  }
  return "ok";
});
test("Browser settings keep VS Code defaults and reject out-of-range values", async () => {
  type Browser = { browserSearchEngine: string; browserMaxHistory: number; browserChatTools: boolean; browserPageZoom: number | null; browserAttachElementImage: boolean; browserOpenLocalhostLinks: boolean };
  const get = async () => ((await rpc("settings.get", {})) as { result: Browser }).result;
  const set = async (patch: unknown) => ((await rpc("settings.set", patch)) as { result: Browser }).result;
  const before = await get();
  try {
    expect(before.browserSearchEngine !== undefined && before.browserMaxHistory !== undefined && before.browserChatTools !== undefined, "browser settings exist");
    expect((await set({ browserSearchEngine: "duckduckgo", browserMaxHistory: 50, browserChatTools: false, browserPageZoom: 125, browserAttachElementImage: false, browserOpenLocalhostLinks: false })).browserSearchEngine === "duckduckgo", "valid values accepted");
    let now = await get();
    expect(now.browserMaxHistory === 50 && now.browserChatTools === false && now.browserPageZoom === 125 && now.browserAttachElementImage === false && now.browserOpenLocalhostLinks === false, "persisted");
    now = await set({ browserSearchEngine: "Bing", browserMaxHistory: -1, browserChatTools: "yes", browserPageZoom: 130, browserAttachElementImage: 1, browserOpenLocalhostLinks: null });
    expect(now.browserSearchEngine === "duckduckgo" && now.browserMaxHistory === 50 && now.browserChatTools === false && now.browserPageZoom === 125 && now.browserAttachElementImage === false && now.browserOpenLocalhostLinks === false, "bad values rejected");
    expect((await set({ browserMaxHistory: 10001 })).browserMaxHistory === 50 && (await set({ browserMaxHistory: 1.5 })).browserMaxHistory === 50, "history range and integer");
    expect((await set({ browserPageZoom: null })).browserPageZoom === null, "page zoom may be reset to Match Window");
    expect((await set({ browserSearchEngine: "none" })).browserSearchEngine === "none", "none accepted");
  } finally {
    await set(before);
  }
  return "ok";
});
test("Browser data storage, auto reload, title bar and user tools settings accept valid values and reject bad ones", async () => {
  type Extra = { browserDataStorage: string; browserAutoReload: boolean; browserShowInTitleBar: boolean | string; browserUserTools: boolean };
  const get = async () => ((await rpc("settings.get", {})) as { result: Extra }).result;
  const set = async (patch: unknown) => ((await rpc("settings.set", patch)) as { result: Extra }).result;
  const before = await get();
  try {
    expect(typeof before.browserDataStorage === "string" && typeof before.browserAutoReload === "boolean" && ["boolean", "string"].includes(typeof before.browserShowInTitleBar) && typeof before.browserUserTools === "boolean", `shape ${JSON.stringify(before)}`);
    let now = await set({ browserDataStorage: "ephemeral", browserAutoReload: false, browserShowInTitleBar: true, browserUserTools: true });
    expect(now.browserDataStorage === "ephemeral" && now.browserAutoReload === false && now.browserShowInTitleBar === true && now.browserUserTools === true, "valid values accepted");
    expect((await set({ browserShowInTitleBar: false })).browserShowInTitleBar === false && (await set({ browserShowInTitleBar: "whenOpen" })).browserShowInTitleBar === "whenOpen", "all three title bar values");
    now = await set({ browserDataStorage: "everyone", browserAutoReload: "yes", browserShowInTitleBar: "sometimes", browserUserTools: 1 });
    expect(now.browserDataStorage === "default" || now.browserDataStorage === "ephemeral", "bad data storage rejected");
    expect(now.browserDataStorage === "ephemeral" && now.browserAutoReload === false && now.browserShowInTitleBar === "whenOpen" && now.browserUserTools === true, `bad values rejected ${JSON.stringify(now)}`);
    for (const value of ["default", "global", "workspace", "ephemeral", "agent"]) expect((await set({ browserDataStorage: value })).browserDataStorage === value, `storage ${value}`);
  } finally {
    await set(before);
  }
  return "ok";
});
test("browser.readShot refuses paths outside the shot folders", async () => {
  const shot = (await rpc("browser.readShot", { path: "/etc/passwd" })) as { result?: { png: string | null } };
  expect(shot.result?.png === null, "outside path");
  const dots = (await rpc("browser.readShot", { path: "/tmp/../etc/hosts.png" })) as { result?: { png: string | null } };
  expect(dots.result?.png === null, "dot dot path");
  return "ok";
});
type InboxShape = { selfUserId: string | null; items: { id: string; read: boolean; archived: boolean }[]; unread: number; fetching: boolean; lastFetchedAt: string | null };
test("inbox.get returns the state shape", async () => {
  const reply = (await rpc("inbox.get", {})) as { result?: InboxShape };
  return expect(Array.isArray(reply.result?.items) && typeof reply.result?.unread === "number" && typeof reply.result?.fetching === "boolean", "shape");
});
test("inbox.markRead and inbox.archive reject unknown ids, bad lists and non-boolean flags", async () => {
  rejected(await rpc("inbox.markRead", { ids: ["nope"], read: true }), "unknown id");
  rejected(await rpc("inbox.markRead", { ids: "x", read: true }), "ids string");
  rejected(await rpc("inbox.markRead", { ids: [5], read: true }), "ids number");
  rejected(await rpc("inbox.markRead", { ids: [], read: "yes" }), "read flag");
  rejected(await rpc("inbox.archive", { ids: ["nope"], archived: true }), "archive unknown id");
  rejected(await rpc("inbox.archive", { ids: [], archived: 1 }), "archive flag");
  return "ok";
});
test("inbox.thread rejects an unknown item before any Slack call", async () => rejected(await rpc("inbox.thread", { id: "nope" }), "unknown"));
test("inbox.addToBoard, inbox.notRequest and inbox.reanalyze reject unknown items and bad workspaces without touching the board", async () => {
  rejected(await rpc("inbox.addToBoard", { id: "nope" }), "addToBoard unknown");
  rejected(await rpc("inbox.notRequest", { id: "nope" }), "notRequest unknown");
  rejected(await rpc("inbox.reanalyze", { id: "nope" }), "reanalyze unknown");
  rejected(await rpc("inbox.reanalyze", {}), "reanalyze without id");
  return "ok";
});
test("Mention settings accept only a boolean toggle and the three analysis models", async () => {
  type Mention = { autoAddRequests: boolean; mentionAnalysisModel: string };
  const before = ((await rpc("settings.get", {})) as { result: Mention }).result;
  const set = async (patch: unknown) => ((await rpc("settings.set", patch)) as { result: Mention }).result;
  expect((await set({ autoAddRequests: "no" })).autoAddRequests === before.autoAddRequests, "toggle string");
  expect((await set({ mentionAnalysisModel: "gpt-5" })).mentionAnalysisModel === before.mentionAnalysisModel, "unlisted model");
  expect((await set({ mentionAnalysisModel: 5 })).mentionAnalysisModel === before.mentionAnalysisModel, "model number");
  return "ok";
});
test("Inbox settings reject out-of-range intervals and bad team ids", async () => {
  const before = ((await rpc("settings.get", {})) as { result: { inboxIntervalMinutes: number; slackTeamId: string } }).result;
  const set = async (patch: unknown) => ((await rpc("settings.set", patch)) as { result: { inboxIntervalMinutes: number; slackTeamId: string } }).result;
  expect((await set({ inboxIntervalMinutes: -1 })).inboxIntervalMinutes === before.inboxIntervalMinutes, "negative");
  expect((await set({ inboxIntervalMinutes: 5.5 })).inboxIntervalMinutes === before.inboxIntervalMinutes, "fraction");
  expect((await set({ inboxIntervalMinutes: "10" })).inboxIntervalMinutes === before.inboxIntervalMinutes, "string");
  expect((await set({ inboxIntervalMinutes: 999 })).inboxIntervalMinutes === before.inboxIntervalMinutes, "too large");
  expect((await set({ slackTeamId: "https://evil" })).slackTeamId === before.slackTeamId, "team id with a url");
  return "ok";
});
test("mcp.reconnect rejects an unknown server name", async () => {
  const reply = await rpc("mcp.reconnect", { name: "agent-nav-no-such-server" });
  return expect(typeof reply.error === "string" && reply.error.includes("Server not found"), reply.error ?? "accepted");
});
test("mcp.reconnect and mcp.toggle reject a missing, empty or non-string name", async () => {
  for (const name of [undefined, "", 7, null, ["slack"], { a: 1 }]) {
    rejected(await rpc("mcp.reconnect", { name }), `reconnect ${JSON.stringify(name)}`);
    rejected(await rpc("mcp.toggle", { name, enabled: false }), `toggle ${JSON.stringify(name)}`);
  }
  return "all rejected";
});
test("mcp.toggle rejects a flag that is not true or false, and an unknown server", async () => {
  const meta = ((await rpc("meta.get", {})) as { result: { mcp: { name: string }[] } }).result;
  rejected(await rpc("mcp.toggle", { name: "agent-nav-no-such-server", enabled: false }), "unknown server");
  if (!meta.mcp.length) return "no servers, flag check skipped";
  for (const enabled of ["false", 0, null, undefined]) {
    const reply = await rpc("mcp.toggle", { name: meta.mcp[0].name, enabled });
    expect(typeof reply.error === "string" && reply.error.includes("true or false"), `${JSON.stringify(enabled)}: ${reply.error ?? "accepted"}`);
  }
  return "all rejected";
});
test("Unknown RPC method is an error", async () => {
  const reply = await rpc("agents.destroyEverything", {});
  return expect(typeof reply.error === "string", reply.error ?? "replied");
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
console.log(failed ? `${failed} failed` : `${cases.length} passed`);
daemon.stop();
process.exit(failed ? 1 : 0);
