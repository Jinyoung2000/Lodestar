import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import type { ServerMessage } from "../shared/protocol";
import { Daemon, type DaemonState } from "../vscode-extension/src/daemon";
import { useTestDaemon } from "./testDaemon";

const daemon = await useTestDaemon();
const cases: { name: string; run: () => Promise<string> }[] = [];
const test = (name: string, run: () => Promise<string>) => cases.push({ name, run });
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
  return detail;
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(condition: () => boolean, what: string, ms = 8000) {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await sleep(50);
  }
}

const tmp = mkdtempSync(join(tmpdir(), "agent-nav-vsext-home-"));
const homeWith = (token: string | null) => {
  const dir = mkdtempSync(join(tmp, "h-"));
  if (token !== null) writeFileSync(join(dir, "token"), token);
  return dir;
};
const quiet = () => undefined;
function client(settings: { port: number; home: string }) {
  const d = new Daemon(() => settings, quiet);
  d.start();
  return d;
}
const states = (d: Daemon) => {
  const seen: DaemonState[] = [];
  d.onChange(() => seen.push(d.state));
  return seen;
};
const closedPort = () =>
  new Promise<number>((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });

test("토큰으로 붙어 워크스페이스와 세션 목록을 받는다 (Origin 은 데몬 자신의 출처)", async () => {
  const d = client({ port: daemon.port, home: daemon.home });
  try {
    await until(() => d.state === "online" && d.loaded, "online");
    return expect(d.workspaces.length >= 1 && d.agents.some((a) => a.title === "seeded session"), `workspaces=${d.workspaces.length} agents=${d.agents.map((a) => a.title).join()}`);
  } finally {
    d.stop();
  }
});

test("틀린 토큰은 거절된다 (rejected)", async () => {
  const d = client({ port: daemon.port, home: homeWith("not-the-token") });
  try {
    await until(() => d.state === "rejected", "rejected");
    return expect(!d.loaded && d.agents.length === 0, `state=${d.state}`);
  } finally {
    d.stop();
  }
});

test("포트에 데몬이 없으면 offline, 토큰 파일이 없으면 noToken", async () => {
  const off = client({ port: await closedPort(), home: homeWith(daemon.token) });
  const none = client({ port: daemon.port, home: homeWith(null) });
  try {
    await until(() => off.state === "offline", "offline");
    await until(() => none.state === "noToken", "noToken");
    return expect(true, `offline=${off.state} noToken=${none.state}`);
  } finally {
    off.stop();
    none.stop();
  }
});

test("토큰 파일이 나중에 생기면 스스로 붙는다 (재시도)", async () => {
  const home = homeWith(null);
  const d = client({ port: daemon.port, home });
  try {
    await until(() => d.state === "noToken", "noToken");
    writeFileSync(join(home, "token"), daemon.token);
    await until(() => d.state === "online", "online after token", 6000);
    return expect(true, "noToken 에서 online");
  } finally {
    d.stop();
  }
});

test("이름 바꾸기와 완료는 이벤트로 목록에 바로 반영된다", async () => {
  const d = client({ port: daemon.port, home: daemon.home });
  try {
    await until(() => d.loaded, "loaded");
    const seen = states(d);
    const agent = d.agents[0];
    await d.call("agents.rename", { agentId: agent.id, title: "renamed from vscode" });
    await until(() => d.agents.find((a) => a.id === agent.id)?.title === "renamed from vscode", "rename event");
    await d.call("agents.setDone", { agentId: agent.id, done: true });
    await until(() => d.agents.find((a) => a.id === agent.id)?.done === true, "done event");
    await d.call("agents.setDone", { agentId: agent.id, done: false });
    await d.call("agents.rename", { agentId: agent.id, title: "seeded session" });
    return expect(seen.length >= 2, `이벤트 ${seen.length}번`);
  } finally {
    d.stop();
  }
});

test("app.showAgent 는 다른 화면에 showAgent 이벤트로 가고, 없는 세션은 오류", async () => {
  const d = client({ port: daemon.port, home: daemon.home });
  const other = new WebSocket(`ws://127.0.0.1:${daemon.port}/ws/rpc?token=${daemon.token}`, { headers: { origin: `http://127.0.0.1:${daemon.port}` } });
  const events: string[] = [];
  try {
    await new Promise((resolve) => other.once("open", resolve));
    other.on("message", (data) => {
      const message = JSON.parse(data.toString()) as ServerMessage;
      if ("event" in message && message.event.type === "showAgent") events.push(message.event.agentId);
    });
    await until(() => d.loaded, "loaded");
    const id = d.agents[0].id;
    await d.call("app.showAgent", { agentId: id });
    await until(() => events.length === 1, "showAgent event");
    const failure = await d.call("app.showAgent", { agentId: "missing" }).then(
      () => null,
      (error: Error) => error.message,
    );
    return expect(events[0] === id && failure !== null, `event=${events[0] === id} error=${failure}`);
  } finally {
    other.close();
    d.stop();
  }
});

test("단일 세션 화면 주소를 데몬이 서빙하고, 토큰 없는 웹소켓은 거절한다", async () => {
  const page = await fetch(`http://127.0.0.1:${daemon.port}/?embed=session&agent=x&theme=dark`);
  const html = await page.text();
  const denied = await new Promise<number | string>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${daemon.port}/ws/rpc?token=wrong`, { headers: { origin: `http://127.0.0.1:${daemon.port}` } });
    ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
    ws.on("open", () => resolve("opened"));
    ws.on("error", () => undefined);
  });
  const foreign = await new Promise<number | string>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${daemon.port}/ws/rpc?token=${daemon.token}`, { headers: { origin: "https://evil.example" } });
    ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
    ws.on("open", () => resolve("opened"));
    ws.on("error", () => undefined);
  });
  return expect(page.status === 200 && html.includes('name="agent-nav-token"') && denied === 403 && foreign === 403, `status=${page.status} wrongToken=${denied} foreignOrigin=${foreign}`);
});

let failed = 0;
for (const { name, run } of cases) {
  try {
    console.log(`ok   ${name}: ${await run()}`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
daemon.stop();
rmSync(tmp, { recursive: true, force: true });
if (failed) {
  console.log(`${failed}/${cases.length} failed`);
  process.exit(1);
}
console.log(`${cases.length}/${cases.length} passed`);
process.exit(0);
