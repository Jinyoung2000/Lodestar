// 에이전트의 Browser 도구(server/browserBridge.ts, server/browserTools.ts): 공유된 탭에만 닿고, 다른 세션과 공유 안 된 탭은 거절하며, 페이지 내용은 믿을 수 없는 데이터로 표시한다.
// 화면 쪽 공유 목록(web/browserHost.ts)과 타임라인 문구(web/browserToolLabels.ts)도 함께 본다. 실행: npm test
import type { BrowserSharedPage, ServerMessage } from "../shared/protocol";
import { BrowserBridge, type BridgeClient } from "../server/browserBridge";
import { browserMcpServer, browserToolNeedsApproval, fileUrlInside, isBrowserToolName, listBrowserPages, openBrowserPage, runBrowserTool } from "../server/browserTools";
import { browserApproval, browserToolLabel } from "../web/browserToolLabels";
import { similarPage } from "../web/browserUrl";

const cases: { name: string; run: () => string | Promise<string> }[] = [];
const test = (name: string, run: () => string | Promise<string>) => cases.push({ name, run });
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
  return detail;
};

// 보낸 이벤트를 모아 두는 가짜 연결
const fakeClient = () => {
  const sent: { event: { type: string; id: string; agentId: string; pageId: string; tool: string; args: Record<string, unknown> } }[] = [];
  const client: BridgeClient & { sent: typeof sent } = { sent, send: (text) => sent.push(JSON.parse(text) as ServerMessage as never) };
  return client;
};
const page = (pageId: string, agentId: string, url = "http://localhost:7801/", title = "Static Preview"): BrowserSharedPage => ({ pageId, agentId, url, title });
const on = () => true;

test("공유 목록: 연결마다 따로 두고 세션별로 걸러 보고, 모양이 틀린 항목은 버린다", () => {
  const bridge = new BrowserBridge();
  const a = fakeClient();
  const b = fakeClient();
  bridge.setShares(a, [page("p1", "A"), { pageId: 5, agentId: "A" }, null, page("p2", "B")]);
  bridge.setShares(b, [page("p3", "A")]);
  expect(bridge.pagesFor("A").map((m) => m.page.pageId).sort().join() === "p1,p3", "A 의 페이지");
  expect(bridge.pagesFor("B").map((m) => m.page.pageId).join() === "p2", "B 의 페이지");
  bridge.setShares(a, []);
  expect(bridge.pagesFor("B").length === 0 && bridge.pagesFor("A").length === 1, "연결 a 의 목록을 비우면 그 연결 것만 사라짐");
  bridge.dropClient(b);
  expect(bridge.pagesFor("A").length === 0, "연결이 끊기면 공유도 사라짐");
  return "ok";
});

test("list_browser_pages: 이 세션에 공유된 것만, 없으면 VS Code 와 같은 안내", () => {
  const bridge = new BrowserBridge();
  bridge.setShares(fakeClient(), [page("p1", "A", "http://localhost:7801/", "Static Preview"), page("p2", "B")]);
  const mine = listBrowserPages(bridge, on, "A");
  const text = (mine.content[0] as { text: string }).text;
  expect(text.includes("- [p1] Static Preview (http://localhost:7801/) (not visible)") && !text.includes("p2") && !mine.isError, text);
  expect(text.includes("The following browser pages are currently shared with you and can be interacted with using the browser tools:"), "VS Code 안내문");
  expect(text.includes("untrusted"), "제목과 주소는 믿을 수 없는 데이터");
  const none = (listBrowserPages(bridge, on, "C").content[0] as { text: string }).text;
  expect(none === "No browser pages are currently open.", none);
  const withOpen = new BrowserBridge();
  withOpen.setShares(fakeClient(), [], 1);
  const openText = (listBrowserPages(withOpen, on, "C").content[0] as { text: string }).text;
  expect(openText.startsWith("No browser pages are currently shared with you.\n\n1 page is open but not shared."), openText);
  expect(listBrowserPages(bridge, () => false, "A").isError === true, "설정에서 끄면 오류");
  return "ok";
});

test("도구 호출: 공유한 화면에만 이벤트를 보내고 결과에 믿을 수 없는 데이터 경고를 붙인다", async () => {
  const bridge = new BrowserBridge();
  const owner = fakeClient();
  const other = fakeClient();
  bridge.setShares(owner, [page("p1", "A", "http://localhost:7801/two.html")]);
  bridge.setShares(other, [page("p9", "Z")]);
  const running = runBrowserTool(bridge, on, "A", "read_page", { pageId: "p1", mode: "text" });
  expect(owner.sent.length === 1 && other.sent.length === 0, "공유한 연결에만");
  const event = owner.sent[0].event;
  expect(event.type === "browserTool" && event.agentId === "A" && event.pageId === "p1" && event.tool === "read_page" && event.args.mode === "text", JSON.stringify(event));
  bridge.settle(other, event.id, { text: "forged" }, undefined);
  bridge.settle(owner, event.id, { text: "Second page" }, undefined);
  const result = await running;
  const text = (result.content[0] as { text: string }).text;
  expect(!result.isError && text.includes("http://localhost:7801/two.html") && text.includes("untrusted data") && text.endsWith("Second page") && !text.includes("forged"), text);
  return "ok";
});

test("거절: 다른 세션의 페이지, 공유되지 않은 id, 여럿일 때 id 없음", async () => {
  const bridge = new BrowserBridge();
  const client = fakeClient();
  bridge.setShares(client, [page("p1", "A"), page("p2", "A"), page("p3", "B")]);
  const text = (r: { content: unknown[] }) => (r.content[0] as { text: string }).text;
  const foreign = await runBrowserTool(bridge, on, "A", "click_element", { pageId: "p3", ref: "e1" });
  expect(foreign.isError === true && text(foreign).includes("not shared with this session"), text(foreign));
  const unknown = await runBrowserTool(bridge, on, "A", "read_page", { pageId: "nope" });
  expect(unknown.isError === true && text(unknown).includes("nope"), text(unknown));
  const ambiguous = await runBrowserTool(bridge, on, "A", "read_page", {});
  expect(ambiguous.isError === true && text(ambiguous).includes("Pass pageId"), text(ambiguous));
  const nobody = await runBrowserTool(bridge, on, "C", "read_page", {});
  expect(nobody.isError === true && text(nobody).startsWith("No browser pages"), text(nobody));
  expect(client.sent.length === 0, "거절된 호출은 화면에 가지 않음");
  const off = await runBrowserTool(bridge, () => false, "A", "read_page", { pageId: "p1" });
  expect(off.isError === true && text(off).includes("Enable Chat Tools") && client.sent.length === 0, text(off));
  return "ok";
});

test("스크린샷은 image 블록, 화면 오류와 시간 초과와 연결 끊김은 isError", async () => {
  const bridge = new BrowserBridge(60);
  const client = fakeClient();
  bridge.setShares(client, [page("p1", "A")]);
  const shot = runBrowserTool(bridge, on, "A", "screenshot_page", {});
  bridge.settle(client, client.sent[0].event.id, { image: "iVBORw0KGgo=", text: "Page: x" }, undefined);
  const done = await shot;
  const kinds = done.content.map((c) => c.type).join();
  expect(kinds === "text,image" && (done.content[1] as { mimeType: string }).mimeType === "image/png", kinds);
  const failing = runBrowserTool(bridge, on, "A", "click_element", { ref: "e9" });
  bridge.settle(client, client.sent[1].event.id, undefined, "Element e9 was not found.");
  const failed = await failing;
  expect(failed.isError === true && (failed.content[0] as { text: string }).text.includes("e9"), "화면 오류");
  const slow = await runBrowserTool(bridge, on, "A", "read_page", {});
  expect(slow.isError === true && (slow.content[0] as { text: string }).text.includes("did not answer"), "시간 초과");
  const pending = runBrowserTool(bridge, on, "A", "read_page", {});
  bridge.dropClient(client);
  const dropped = await pending;
  expect(dropped.isError === true && (dropped.content[0] as { text: string }).text.includes("closed"), "연결 끊김");
  return "ok";
});

test("MCP 서버: 이름은 browser, 도구 이름 접두사로 승인 우회 대상을 알아본다", () => {
  const server = browserMcpServer(new BrowserBridge(), on, "A");
  expect(server.type === "sdk" && server.name === "browser", `${server.type} ${server.name}`);
  expect(isBrowserToolName("mcp__browser__read_page") && !isBrowserToolName("mcp__slack__read") && !isBrowserToolName("Bash"), "접두사");
  return "ok";
});

test("타임라인 문구: VS Code 의 진행 중과 끝난 문구, 호출 시점의 페이지 제목", () => {
  const label = (name: string, input: Record<string, unknown>, phase: "running" | "done" = "done", title: string | null = "Second Page") => browserToolLabel(`mcp__browser__${name}`, input, title, phase);
  expect(JSON.stringify(label("read_page", { pageId: "p1" })) === JSON.stringify({ verb: "Read", page: "Second Page" }), "Read");
  expect(label("read_page", {}, "running")?.verb === "Reading", "Reading");
  expect(label("click_element", { element: "second page link", ref: "e1" })?.verb === "Clicked second page link in", "Clicked");
  expect(label("click_element", { element: "menu", button: "right" }, "running")?.verb === "Right-clicking menu in" && label("click_element", { element: "x", button: "middle" })?.verb === "Middle-clicked x in" && label("click_element", { element: "x", dblClick: true })?.verb === "Double-clicked x in", "클릭 종류");
  expect(label("drag_element", { fromElement: "card", toElement: "column" })?.verb === "Dragged card to column in", "drag");
  expect(label("handle_dialog", {})?.verb === "Handled dialog in" && label("handle_dialog", {}, "running")?.verb === "Handling dialog in", "dialog");
  expect(label("hover_element", { element: "menu" })?.verb === "Hovered over menu in", "hover");
  expect(label("screenshot_page", {})?.verb === "Captured browser screenshot" && label("screenshot_page", { element: "chart" })?.verb === "Captured screenshot of chart", "screenshot");
  expect(label("navigate_page", { type: "url", url: "http://x.test/" })?.verb === "Navigated to http://x.test/ in" && label("navigate_page", { type: "back" })?.verb === "Navigated backward in" && label("navigate_page", { type: "forward" }, "running")?.verb === "Navigating forward in" && label("navigate_page", { type: "reload" })?.verb === "Reloaded", "navigate");
  expect(label("type_in_page", { key: "Enter" })?.verb === "Pressed key `Enter` in" && label("type_in_page", { text: "a" })?.verb === "Typed text in", "type");
  const submit = label("type_in_page", { text: "a", submit: true, element: "search box", selector: "#q" });
  expect(submit?.verb === "Typed text in search box in" && submit.after === " and pressed Enter", JSON.stringify(submit));
  expect(label("run_playwright_code", { code: "x" })?.verb === "Ran Playwright code" && label("run_playwright_code", { code: "x" }, "running")?.verb === "Running Playwright code..." && label("run_playwright_code", { deferredResultId: "d" })?.verb === "Waited for Playwright code", "playwright");
  expect(label("open_browser_page", { url: "http://x.test/" }, "running", null)?.verb === "Opening browser page at http://x.test/" && label("open_browser_page", { url: "http://x.test/" })?.verb === "Opened", "open");
  expect(browserToolLabel("Bash", {}, null) === null && label("unknown", {}) === null, "다른 도구는 건드리지 않음");
  return "ok";
});

test("승인이 필요한 도구: 새 페이지 열기, 주소로 이동, Playwright 코드 셋뿐", () => {
  const needs = (id: string, input: Record<string, unknown>) => browserToolNeedsApproval(`mcp__browser__${id}`, input);
  expect(needs("open_browser_page", { url: "http://x.test/" }) && !needs("open_browser_page", {}), "열기(주소가 있을 때)");
  expect(needs("navigate_page", { type: "url", url: "http://x.test/" }) && needs("navigate_page", { url: "http://x.test/" }) && !needs("navigate_page", { type: "back" }) && !needs("navigate_page", { type: "reload" }), "이동");
  expect(needs("run_playwright_code", { code: "return 1" }) && !needs("run_playwright_code", { deferredResultId: "d" }), "코드 실행");
  for (const id of ["read_page", "click_element", "drag_element", "handle_dialog", "hover_element", "screenshot_page", "type_in_page", "list_browser_pages"]) expect(!needs(id, { ref: "e1" }), `${id} 는 공유가 곧 허락`);
  expect(!browserToolNeedsApproval("Bash", { command: "ls" }), "다른 도구");
  const card = browserApproval("mcp__browser__run_playwright_code", { code: "  return page.title()  " });
  expect(card?.title === "Run Playwright Code?" && card.code === "return page.title()" && card.disclaimer === "Make sure you trust the code before continuing.", JSON.stringify(card));
  expect(browserApproval("mcp__browser__navigate_page", { type: "url", url: "http://x.test/" })?.message === "This will navigate the browser to http://x.test/ and allow the agent to access its contents." && browserApproval("mcp__browser__open_browser_page", { url: "http://x.test/" })?.title === "Open Browser Page?", "문구");
  return "ok";
});

test("MCP 서버: VS Code 의 도구 열한 개와 같은 이름(과 read_console_logs 하나)", () => {
  const server = browserMcpServer(new BrowserBridge(), on, "A") as unknown as { instance?: { _registeredTools?: Record<string, unknown> } };
  const names = Object.keys(server.instance?._registeredTools ?? {}).sort();
  const want = ["click_element", "drag_element", "handle_dialog", "hover_element", "list_browser_pages", "navigate_page", "open_browser_page", "read_console_logs", "read_page", "run_playwright_code", "screenshot_page", "type_in_page"];
  expect(JSON.stringify(names) === JSON.stringify(want), names.join());
  return "ok";
});

test("open_browser_page: 화면에 보내고, 주소가 틀리면 보내지 않으며, 화면이 없으면 안내한다", async () => {
  const bridge = new BrowserBridge(60);
  const text = (r: { content: unknown[] }) => (r.content[0] as { text: string }).text;
  const none = await openBrowserPage(bridge, on, "A", { url: "http://x.test/" });
  expect(none.isError === true && text(none).includes("No Lodestar desktop window"), text(none));
  const client = fakeClient();
  bridge.setShares(client, [], 2);
  const bad = await openBrowserPage(bridge, on, "A", { url: "javascript:alert(1)" });
  expect(bad.isError === true && text(bad) === "You must provide a complete, valid URL." && client.sent.length === 0, text(bad));
  const running = openBrowserPage(bridge, on, "A", { url: "http://x.test/", forceNew: true });
  const event = client.sent[0].event as unknown as { type: string; id: string; agentId: string; url: string; forceNew: boolean };
  expect(event.type === "browserOpen" && event.agentId === "A" && event.url === "http://x.test/" && event.forceNew === true, JSON.stringify(event));
  bridge.settle(client, event.id, { text: "Page ID: browser:1\n\nSummary:\n- link \"x\"" }, undefined);
  const done = await running;
  expect(!done.isError && text(done).includes("untrusted data") && text(done).includes("Page ID: browser:1"), text(done));
  const listed = text(listBrowserPages(bridge, on, "A"));
  expect(listed.startsWith("No browser pages are currently shared with you.") && listed.includes("2 pages are open but not shared.") && listed.includes("open_browser_page"), listed);
  return "ok";
});

test("file: 이동은 허락된 폴더 안으로만, 확인한 호출에만 fileOk 가 붙고 모델이 보낸 값은 덮어쓴다", async () => {
  const roots = ["/tmp/an-fix8-root"];
  expect(fileUrlInside("file:///tmp/an-fix8-root/a.html", roots) && fileUrlInside("file:///tmp/an-fix8-root", roots), "안");
  expect(!fileUrlInside("file:///tmp/an-fix8-root/../etc/passwd", roots) && !fileUrlInside("file:///tmp/an-fix8-rootx/a.html", roots) && !fileUrlInside("file://host/tmp/an-fix8-root/a", roots) && !fileUrlInside("http://x.test/", roots) && !fileUrlInside("file:///etc/passwd", roots) && !fileUrlInside("file:///tmp/an-fix8-root/a.html", []), "밖, 상위 경로, 같은 접두사, 호스트, 다른 스킴, 빈 허용 목록");
  const bridge = new BrowserBridge();
  const client = fakeClient();
  bridge.setShares(client, [page("p1", "A")]);
  const text = (r: { content: unknown[] }) => (r.content[0] as { text: string }).text;
  const outside = await runBrowserTool(bridge, on, "A", "navigate_page", { type: "url", url: "file:///etc/passwd" }, () => roots);
  expect(outside.isError === true && text(outside).includes("inside this session's folder") && client.sent.length === 0, text(outside));
  const inside = runBrowserTool(bridge, on, "A", "navigate_page", { type: "url", url: "file:///tmp/an-fix8-root/a.html", fileOk: false }, () => roots);
  expect(client.sent.length === 1 && client.sent[0].event.args.fileOk === true, JSON.stringify(client.sent[0]?.event.args));
  bridge.settle(client, client.sent[0].event.id, { text: "ok" }, undefined);
  await inside;
  const spoof = runBrowserTool(bridge, on, "A", "navigate_page", { type: "url", url: "http://x.test/", fileOk: true }, () => roots);
  expect(client.sent[1].event.args.fileOk === false, "http 이동에 모델이 보낸 fileOk 는 덮어씀");
  bridge.settle(client, client.sent[1].event.id, { text: "ok" }, undefined);
  await spoof;
  const open = await openBrowserPage(bridge, on, "A", { url: "file:///etc/passwd" }, () => roots);
  expect(open.isError === true, "open_browser_page 도 같은 제한");
  return "ok";
});

test("handle_dialog: 파일 선택은 세션 폴더 안의 경로만", async () => {
  const bridge = new BrowserBridge();
  const server = browserMcpServer(bridge, on, "A", () => ["/tmp/an-fix8-root"]) as unknown as { instance: { _registeredTools: Record<string, { handler: (args: unknown, extra: unknown) => Promise<{ isError?: boolean; content: { text: string }[] }> }> } };
  const handler = server.instance._registeredTools.handle_dialog.handler;
  const outside = await handler({ selectFiles: ["/etc/passwd"] }, {});
  expect(outside.isError === true && outside.content[0].text.includes("inside this session's folder"), outside.content[0].text);
  const inside = await handler({ selectFiles: ["/tmp/an-fix8-root/a.txt"] }, {});
  expect(inside.isError === true && !inside.content[0].text.includes("inside this session's folder"), "허용된 경로는 여기서 막히지 않고 공유 페이지 검사로 간다: " + inside.content[0].text);
  const dismiss = await handler({ selectFiles: [] }, {});
  expect(!dismiss.content[0].text.includes("inside this session's folder"), "빈 목록은 취소");
  return "ok";
});

test("비슷한 페이지: 같은 호스트나 상위 도메인, file: 끼리", () => {
  expect(similarPage("http://localhost:7801/two.html", "http://localhost:7801/") && similarPage("https://docs.x.test/a", "https://x.test/") && !similarPage("https://y.test/", "https://x.test/"), "호스트");
  expect(similarPage("file:///a/b.html", "file:///c/d.html") && !similarPage("", "http://x.test/") && similarPage("about:blank", "http://x.test/", true) && !similarPage("http://x.test/", "mailto:a@b.c"), "file, 빈 탭, 스킴");
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
