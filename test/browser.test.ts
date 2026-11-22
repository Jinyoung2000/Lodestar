import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { frameBlockReason, parseHttpUrl, probeFrame } from "../server/frameProbe";
import { isOwnOrigin, localhostTarget, parseBrowsable, resolveAddress, tabLabel, tabTooltip } from "../web/browserUrl";
import { paletteCommands } from "../web/commands";

const cases: { name: string; run: () => string | Promise<string> }[] = [];
const test = (name: string, run: () => string | Promise<string>) => cases.push({ name, run });
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
  return detail;
};
const url = (input: string) => {
  const result = resolveAddress(input);
  return result.ok ? result.url : `ERR ${result.reason}`;
};

test("resolveAddress: host:port 와 localhost 는 http", () => {
  expect(url("localhost:7801") === "http://localhost:7801/", "localhost:7801");
  expect(url("127.0.0.1:3000/app?x=1") === "http://127.0.0.1:3000/app?x=1", "127.0.0.1");
  expect(url("localhost") === "http://localhost/", "localhost");
  expect(url("192.168.0.5:8080") === "http://192.168.0.5:8080/", "private ip");
  return "ok";
});

test("resolveAddress: 점이 든 이름은 https, 스킴이 있으면 그대로", () => {
  expect(url("example.com") === "https://example.com/", "example.com");
  expect(url("https://example.com/a b") === "https://example.com/a%20b", "https with space");
  expect(url("http://localhost:5173/") === "http://localhost:5173/", "http");
  return "ok";
});

test("resolveAddress: 공백이 든 글이나 점 없는 낱말은 검색", () => {
  expect(url("react hooks").startsWith("https://www.bing.com/search?q=react+hooks"), "words");
  expect(url("dogs").startsWith("https://www.bing.com/search?q=dogs"), "single word");
  return "ok";
});

test("resolveAddress: http, https, 호스트 없는 file: 이 아닌 스킴은 거절", () => {
  for (const bad of ["file://server/share/x", "javascript:alert(1)", "data:text/html,hi", "ftp://x.com", "chrome://settings"]) expect(url(bad).startsWith("ERR"), bad);
  expect(url("file:///tmp/a.html") === "file:///tmp/a.html", "file:///");
  expect(url("   ").startsWith("ERR"), "blank");
  return "ok";
});

test("isOwnOrigin: 데몬 주소와 같은 포트의 loopback 이름은 모두 자기 자신", () => {
  const own = { hostname: "127.0.0.1", port: "7796", origin: "http://127.0.0.1:7796" };
  expect(isOwnOrigin("http://127.0.0.1:7796/", own), "same origin");
  expect(isOwnOrigin("http://localhost:7796/x", own), "localhost same port");
  expect(!isOwnOrigin("http://localhost:7801/", own), "other port");
  expect(!isOwnOrigin("https://example.com/", own), "external");
  expect(isOwnOrigin("http://0.0.0.0:7796/", own) && isOwnOrigin("http://[::]:7796/", own), "all-interfaces names");
  return "ok";
});

test("localhostTarget: 이 기기 서버 링크만 Browser 탭으로, agent-nav 자기 주소와 다른 호스트는 제외", () => {
  const own = { hostname: "127.0.0.1", port: "7796", origin: "http://127.0.0.1:7796" };
  expect(localhostTarget("http://localhost:7801/a", own) === "http://localhost:7801/a" && localhostTarget("http://0.0.0.0:3000/", own) === "http://0.0.0.0:3000/", "열림");
  expect(localhostTarget("http://127.0.0.1:7796/", own) === null && localhostTarget("http://0.0.0.0:7796/", own) === null && localhostTarget("http://localhost:7796/x", own) === null, "자기 자신은 제외");
  expect(localhostTarget("https://example.com/", own) === null && localhostTarget("file:///etc/hosts", own) === null && localhostTarget("javascript:alert(1)", own) === null, "그 밖은 제외");
  return "ok";
});

test("parseBrowsable 과 탭 제목", () => {
  expect(parseBrowsable("http://a.test/") !== null && parseBrowsable("file:///x") === null && parseBrowsable("nope") === null, "parse");
  expect(tabLabel("") === "Browser" && tabLabel(" Docs ") === "Docs", "label");
  expect(tabTooltip("Static Preview", "http://localhost:7801/") === "Static Preview (localhost:7801)", "tooltip");
  expect(tabTooltip("localhost:7801", "http://localhost:7801/") === "http://localhost:7801/", "web mode host title");
  return "ok";
});

test("팔레트: 키 없는 명령(Keep, Undo)과 Browser 탭 전용 키가 보인다", () => {
  const list = paletteCommands();
  for (const command of ["keepFile", "undoFile"]) {
    const entry = list.find((c) => c.command === command);
    expect(!!entry && entry.keycaps.length === 0, command);
  }
  const keys: Record<string, string> = { openBrowser: "⌘T", browserZoomIn: "⌘=", browserZoomOut: "⌘-", browserZoomReset: "⌘NumPad0", browserFind: "⌘F", browserHistory: "⌘Y", browserFavorite: "⌘D", addElement: "⇧⌘C", commentElements: "⌥⌘C", findInFiles: "⇧⌘F" };
  for (const [command, caps] of Object.entries(keys)) {
    const entry = list.find((c) => c.command === command);
    expect(!!entry && entry.keycaps.join("") === caps, `${command} ${entry?.keycaps.join("")}`);
  }
  return "ok";
});

test("frameBlockReason: X-Frame-Options 와 frame-ancestors", () => {
  const h = (init: Record<string, string>) => new Headers(init);
  expect(frameBlockReason(h({})) === null, "no headers");
  expect(frameBlockReason(h({ "x-frame-options": "DENY" }))?.includes("DENY") === true, "deny");
  expect(frameBlockReason(h({ "x-frame-options": "sameorigin" })) !== null, "sameorigin");
  expect(frameBlockReason(h({ "content-security-policy": "default-src 'self'; frame-ancestors 'none'" })) !== null, "csp none");
  expect(frameBlockReason(h({ "content-security-policy": "frame-ancestors 'self' https://a.test" })) !== null, "csp list");
  expect(frameBlockReason(h({ "content-security-policy": "frame-ancestors *" })) === null, "csp star");
  expect(frameBlockReason(h({ "content-security-policy": "default-src 'self'" })) === null, "csp without ancestors");
  return "ok";
});

test("parseHttpUrl: http 와 https 만", () => {
  expect(parseHttpUrl("http://a.test") !== null && parseHttpUrl("https://a.test") !== null, "ok");
  expect(parseHttpUrl("file:///x") === null && parseHttpUrl("nope") === null, "rejected");
  return "ok";
});

test("probeFrame: 로컬 서버 응답 머리로 판정하고 연결 실패는 이유를 준다", async () => {
  const server: Server = createServer((req, res) => {
    if (req.url === "/deny") res.setHeader("x-frame-options", "DENY");
    if (req.url === "/csp") res.setHeader("content-security-policy", "frame-ancestors 'none'");
    res.end("<html></html>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const open = await probeFrame(`${base}/`);
    expect(open.ok && open.status === 200 && open.reason === null, "open");
    const denied = await probeFrame(`${base}/deny`);
    expect(!denied.ok && denied.status === 200 && denied.reason?.includes("X-Frame-Options") === true, "deny");
    const csp = await probeFrame(`${base}/csp`);
    expect(!csp.ok && csp.reason?.includes("frame-ancestors") === true, "csp");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  const refused = await probeFrame(`${base}/`);
  expect(!refused.ok && refused.status === null && refused.reason !== null, `refused: ${refused.reason}`);
  const scheme = await probeFrame("file:///etc/passwd");
  expect(!scheme.ok && scheme.status === null, "scheme");
  return "ok";
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
process.exit(failed ? 1 : 0);
