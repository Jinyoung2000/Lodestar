import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerEvent } from "../../shared/protocol";
import { MobileDevices, MobileServer, PairingCodes } from "../../server/mobileAccess";
import { RpcClient, type ConnStatus } from "../src/net/rpc";
import { pairWithHost } from "../src/net/pair";
import { parsePairing } from "../src/logic/pairing";
import { uploadToMac } from "../src/net/upload";
import { expect, run, sleep, test, waitFor } from "./harness";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

async function setup(port = 0) {
  const dir = mkdtempSync(join(tmpdir(), "mobile-rpc-"));
  const devices = new MobileDevices(join(dir, "devices.json"));
  const pairing = new PairingCodes();
  const saved: { size: number; type: string }[] = [];
  const flags = { hangPing: false };
  const server = new MobileServer({
    devices,
    pairing,
    call: (method) => {
      if (method === "mobile.ping") return flags.hangPing ? new Promise(() => {}) : { now: Date.now() };
      if (method === "agents.list") return [{ id: "a1", title: "one" }];
      throw new Error("not in this test");
    },
    saveImage: (bytes, type) => {
      saved.push({ size: bytes.length, type });
      return { id: "11111111-1111-4111-8111-111111111111" };
    },
    hostName: "TestMac",
  });
  await server.start(port, "127.0.0.1");
  const pair = () => {
    const { code } = pairing.issue();
    return { code };
  };
  const token = devices.add("test").token;
  return { dir, server, devices, pairing, saved, flags, token, pair, stop: async () => { await server.stop(); rmSync(dir, { recursive: true, force: true }); } };
}

const fast = { backoff: () => 40, pingIntervalMs: 200, pingTimeoutMs: 300, connectTimeoutMs: 1000 };

test("인증하고 호출한다: ready 이후 online, 첫 프레임 인증이라 주소에 토큰이 없다", async () => {
  const s = await setup();
  const client = new RpcClient(fast);
  try {
    const statuses: ConnStatus[] = [];
    client.onStatus((st) => statuses.push(st));
    let readies = 0;
    client.onReady(() => readies++);
    client.configure({ hosts: ["127.0.0.1"], port: s.server.port, token: s.token });
    await waitFor(() => client.status === "online", 2000, "online");
    expect(readies === 1 && statuses.join() === "connecting,online", statuses.join());
    const list = await client.call("agents.list", {});
    expect((list as unknown as { id: string }[])[0].id === "a1", "call result");
    const denied = await client.call("agents.remove" as never, {} as never).catch((e: Error) => e.message);
    expect(/cannot call/.test(String(denied)), `server refuses non-allowed methods: ${denied}`);
    return statuses.join();
  } finally {
    client.stop();
    await s.stop();
  }
});

test("틀린 토큰은 unauthorized 로 멈추고 다시 두드리지 않는다", async () => {
  const s = await setup();
  const client = new RpcClient(fast);
  try {
    const statuses: ConnStatus[] = [];
    client.onStatus((st) => statuses.push(st));
    client.configure({ hosts: ["127.0.0.1"], port: s.server.port, token: "0".repeat(64) });
    await waitFor(() => client.status === "unauthorized", 2000, "unauthorized");
    await sleep(400);
    expect(client.status === "unauthorized" && !statuses.includes("online"), statuses.join());
    expect(s.server.onlineDeviceIds().size === 0, "never authenticated");
    return statuses.join();
  } finally {
    client.stop();
    await s.stop();
  }
});

test("서버가 내려갔다 올라오면 자동으로 다시 붙고 onReady 가 다시 불린다", async () => {
  const s = await setup();
  const port = s.server.port;
  const client = new RpcClient(fast);
  try {
    let readies = 0;
    client.onReady(() => readies++);
    client.configure({ hosts: ["127.0.0.1"], port, token: s.token });
    await waitFor(() => client.status === "online", 2000, "online");
    const pendingCall = client.call("agents.list", {}).then(() => "answered", (e: Error) => e.message);
    await s.server.stop();
    await waitFor(() => client.status === "offline", 2000, "offline");
    const rejected = String(await client.call("agents.list", {}).catch((e: Error) => e.message));
    expect(/Not connected/.test(rejected), `calls fail fast while offline: ${rejected}`);
    await pendingCall;
    const downAt = Date.now();
    await s.server.start(port, "127.0.0.1");
    await waitFor(() => client.status === "online", 4000, "reconnected");
    const ms = Date.now() - downAt;
    expect(readies === 2, `onReady fired ${readies} times`);
    expect(((await client.call("agents.list", {})) as unknown as unknown[]).length === 1, "works after reconnect");
    return `reconnected ${ms}ms after the server came back`;
  } finally {
    client.stop();
    await s.stop();
  }
});

test("resume(): 앱이 앞으로 오면 백오프를 기다리지 않고 바로 붙는다", async () => {
  const s = await setup();
  const port = s.server.port;
  const client = new RpcClient({ ...fast, backoff: () => 5000 });
  try {
    client.configure({ hosts: ["127.0.0.1"], port, token: s.token });
    await waitFor(() => client.status === "online", 2000, "online");
    await s.server.stop();
    await waitFor(() => client.status === "offline", 2000, "offline");
    await s.server.start(port, "127.0.0.1");
    const started = Date.now();
    client.resume();
    await waitFor(() => client.status === "online", 2000, "online after resume");
    const ms = Date.now() - started;
    expect(ms < 1000, `resume reconnect took ${ms}ms with a 5s backoff`);
    return `${ms}ms`;
  } finally {
    client.stop();
    await s.stop();
  }
});

test("resume(): 살아 있는 연결은 그대로 둔다", async () => {
  const s = await setup();
  const client = new RpcClient(fast);
  try {
    client.configure({ hosts: ["127.0.0.1"], port: s.server.port, token: s.token });
    await waitFor(() => client.status === "online", 2000, "online");
    let readies = 0;
    client.onReady(() => readies++);
    client.resume();
    await sleep(300);
    expect(client.status === "online" && readies === 0, "healthy connection untouched");
    return "ok";
  } finally {
    client.stop();
    await s.stop();
  }
});

test("resume(): 소켓은 열려 있는데 Mac 이 응답하지 않으면(Wi-Fi 가 바뀐 뒤 같은) 닫고 다시 붙는다", async () => {
  const s = await setup();
  const client = new RpcClient({ ...fast, pingIntervalMs: 60_000 });
  try {
    client.configure({ hosts: ["127.0.0.1"], port: s.server.port, token: s.token });
    await waitFor(() => client.status === "online", 2000, "online");
    let readies = 0;
    client.onReady(() => readies++);
    s.flags.hangPing = true;
    const started = Date.now();
    client.resume();
    await waitFor(() => client.status === "offline", 2000, "dropped");
    s.flags.hangPing = false;
    await waitFor(() => client.status === "online" && readies === 1, 3000, "reconnected");
    return `dead socket detected and replaced in ${Date.now() - started}ms`;
  } finally {
    client.stop();
    await s.stop();
  }
});

test("주소 후보: 안 닿는 주소가 앞에 있어도 다음 후보로 붙고, 성공한 주소를 기억한다", async () => {
  const s = await setup();
  const client = new RpcClient(fast);
  try {
    client.configure({ hosts: ["192.0.2.1", "127.0.0.2", "127.0.0.1"], port: s.server.port, token: s.token });
    await waitFor(() => client.status === "online", 3000, "online through a later host");
    expect(client.host === "127.0.0.1", `connected via ${client.host}`);
    return `via ${client.host}`;
  } finally {
    client.stop();
    await s.stop();
  }
});

test("장치 해제: 데스크톱에서 해제하면 연결이 끊기고 unauthorized 로 멈춘다", async () => {
  const s = await setup();
  const client = new RpcClient(fast);
  try {
    client.configure({ hosts: ["127.0.0.1"], port: s.server.port, token: s.token });
    await waitFor(() => client.status === "online", 2000, "online");
    const id = s.devices.list()[0].id;
    s.server.revokeDevice(id);
    await waitFor(() => client.status === "unauthorized", 3000, "unauthorized after revoke");
    return "ok";
  } finally {
    client.stop();
    await s.stop();
  }
});

test("이벤트: 서버 이벤트를 받고 같은 항목의 빠른 갱신은 묶여 온다", async () => {
  const s = await setup();
  const client = new RpcClient(fast);
  try {
    const got: ServerEvent[] = [];
    client.onEvent((e) => got.push(e));
    client.configure({ hosts: ["127.0.0.1"], port: s.server.port, token: s.token });
    await waitFor(() => client.status === "online", 2000, "online");
    for (let i = 1; i <= 30; i++) s.server.broadcast({ type: "timelineUpsert", agentId: "a", item: { id: "m", kind: "assistant", text: "x".repeat(i), streaming: true } });
    s.server.broadcast({ type: "settings", settings: {} as never });
    await waitFor(() => got.length > 0, 1000, "event");
    await sleep(120);
    expect(got.length === 1 && got[0].type === "timelineUpsert" && (got[0].item as { text: string }).text.length === 30, `${got.length} events`);
    return "ok";
  } finally {
    client.stop();
    await s.stop();
  }
});

test("페어링: 코드로 장치 토큰을 받고, 틀린 코드와 안 닿는 주소는 이유를 돌려준다", async () => {
  const s = await setup();
  try {
    const { code } = s.pairing.issue();
    const info = parsePairing(`127.0.0.1:${s.server.port} ${code}`)!;
    const ok = await pairWithHost(info, "Test iPhone");
    expect(ok.ok && /^[0-9a-f]{64}$/.test(ok.result.deviceToken) && ok.host === "127.0.0.1", JSON.stringify(ok));
    const again = await pairWithHost(info, "Test iPhone");
    expect(!again.ok && again.reason === "rejected", "a code works once");
    const unreachable = await pairWithHost({ hosts: ["127.0.0.1"], port: 1, code: "ABCD2345", name: null }, "x", { timeoutMs: 500 });
    expect(!unreachable.ok && unreachable.reason === "unreachable", JSON.stringify(unreachable));
    const mixed = s.pairing.issue();
    const viaSecond = await pairWithHost({ hosts: ["192.0.2.1", "127.0.0.1"], port: s.server.port, code: mixed.code, name: null }, "x", { timeoutMs: 800 });
    expect(viaSecond.ok && viaSecond.host === "127.0.0.1", "first host that answers wins");
    return "ok";
  } finally {
    await s.stop();
  }
});

test("이미지 업로드: 바이너리로 올리고 진행률이 1 로 끝나며, 서버 거절(이미지 아님)은 오류로 돌려준다", async () => {
  const s = await setup();
  try {
    const target = { host: "127.0.0.1", port: s.server.port, token: s.token };
    const progress: number[] = [];
    const result = await uploadToMac(target, PNG, "a.png", "image/png", { onProgress: (f) => progress.push(f) });
    expect(result.id.length === 36 && progress.at(-1) === 1 && s.saved.length === 1 && s.saved[0].size === PNG.length, JSON.stringify(s.saved));
    const bad = await uploadToMac({ ...target, token: "0".repeat(64) }, PNG, "a.png", "image/png").catch((e: Error) => e.message);
    expect(/Upload failed \(401\)|unauthorized/.test(String(bad)), `bad token: ${bad}`);
    return "ok";
  } finally {
    await s.stop();
  }
});

void run();
