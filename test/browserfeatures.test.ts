import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { WebContents } from "electron";
import { DeviceRequests } from "../electron/browserDevices";
import { dialogSummary } from "../electron/guestDebugger";
import { pressKey } from "../electron/guestInput";
import { describeChain, engineMain, locateScript, parseSelector, resolveByChainScript } from "../electron/pwEngine";
import { runtimeMain } from "../electron/pwRuntime";
import { resolveScript } from "../electron/guestScripts";
import { bluetoothItem, devicePickerTitle, filterDevices, hidItem, serialItem, usbItem } from "../web/browserDevices";
import { BROWSER_PARTITION, filePathOf, isBrowserPartition, parseBrowsable, parseOpenable, partitionFor, resolveAddress } from "../web/browserUrl";
import { MIN_EMULATION_SIZE, resizedDimension } from "../web/browserView";
import { buildSearchDoc, rowAt, syntaxRanges } from "../web/searchEditor";

const cases: { name: string; run: () => string | Promise<string> }[] = [];
const test = (name: string, run: () => string | Promise<string>) => cases.push({ name, run });
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
  return detail;
};
const root = join(import.meta.dirname, "..");

test("선택자: css, text=, role=, xpath=, aria-ref=, >> 연쇄, nth=", () => {
  expect(JSON.stringify(parseSelector("button.primary")) === JSON.stringify([{ k: "css", v: "button.primary" }]), "css");
  expect(JSON.stringify(parseSelector("text=Save")) === JSON.stringify([{ k: "text", v: "Save", exact: false }]) && JSON.stringify(parseSelector('text="Save now"')) === JSON.stringify([{ k: "text", v: "Save now", exact: true }]), "text");
  const re = parseSelector("text=/sa.e/i")[0] as { re?: { src: string; flags: string } };
  expect(re.re?.src === "sa.e" && re.re.flags === "i", "text 정규식");
  const role = parseSelector('role=button[name="Submit"]')[0] as { k: string; v: string; name?: string };
  expect(role.k === "role" && role.v === "button" && role.name === "Submit", "role");
  expect(JSON.stringify(parseSelector("aria-ref=e12")) === JSON.stringify([{ k: "ref", v: "e12" }]) && (parseSelector("//a[@id='x']")[0] as { k: string }).k === "xpath" && (parseSelector("xpath=//a")[0] as { k: string }).k === "xpath", "ref, xpath");
  const chain = parseSelector("#list >> text=Beta >> nth=0");
  expect(chain.length === 3 && (chain[0] as { v: string }).v === "#list" && (chain[2] as { v: number }).v === 0, JSON.stringify(chain));
  expect(parseSelector('a[title="a >> b"]').length === 1, "따옴표 안의 >> 는 연쇄가 아님");
  expect((parseSelector("id=main")[0] as { v: string }).v === '[id="main"]' && (parseSelector("data-testid=save")[0] as { k: string }).k === "testid", "id, data-testid");
  expect(describeChain(parseSelector('text=Hi >> nth=0')).includes('getByText("Hi")') && describeChain([{ k: "css", v: "a" }]) === 'locator("a")', "오류 문구용 설명");
  return "ok";
});

test("페이지 안에서 도는 스크립트는 문법에 맞고 네트워크 통로가 없다", () => {
  const scripts = [locateScript('locator("a")', { chain: [{ k: "css", v: "a" }], mode: "text", timeout: 100, strict: true }), resolveByChainScript([{ k: "text", v: "x" }]), resolveScript(null, "text=Save >> nth=0")!, resolveScript("e2", null)!];
  for (const script of scripts) {
    new Function(script);
    expect(!/\bfetch\(|XMLHttpRequest|WebSocket|postMessage|sendBeacon/.test(script), "네트워크와 메시지 통로 없음");
  }
  new Function(`return (${engineMain.toString()})`);
  new Function(`return (${runtimeMain.toString()})`);
  const runtime = runtimeMain.toString();
  expect(!/\brequire\(|\bprocess\b|child_process|ipcRenderer/.test(runtime), "샌드박스 런타임에 Node 와 IPC 가 없다");
  expect(runtime.includes("__pwHost") && !/\bfetch\(|XMLHttpRequest|WebSocket/.test(runtime), "메인과 통하는 길은 __pwHost 하나");
  return "ok";
});

test("run_playwright_code 샌드박스 창: Node 없음, 격리, 네트워크 차단, 연산 목록이 정해져 있다", () => {
  const runner = readFileSync(join(root, "electron/pwRunner.ts"), "utf8");
  expect(/sandbox: true/.test(runner) && /contextIsolation: true/.test(runner) && /nodeIntegration: false/.test(runner) && /devTools: false/.test(runner), "창 설정");
  expect(/partition: `pw-runner-/.test(runner) && !/persist:/.test(runner.slice(runner.indexOf("partition:"), runner.indexOf("partition:") + 80)), "메모리 partition");
  expect(/onBeforeRequest/.test(runner) && /cancel: !details\.url\.startsWith\("data:"\)/.test(runner) && /setWindowOpenHandler/.test(runner) && /will-navigate/.test(runner), "네트워크, 새 창, 이동 차단");
  expect(/default-src 'none'/.test(runner), "CSP");
  expect(/event\.sender\.id/.test(runner) && /byRunner\.get/.test(runner), "연산은 자기 창이 맡은 페이지에만");
  const ops = [...runner.matchAll(/case "(\w+)":/g)].map((m) => m[1]).sort();
  expect(JSON.stringify(ops) === JSON.stringify(["drag", "evaluate", "goto", "info", "insert", "key", "locate", "mouse", "nav", "screenshot", "typeChars", "waitLoad"]), `연산 목록 ${ops.join()}`);
  const preload = readFileSync(join(root, "electron/pwPreload.ts"), "utf8");
  expect(/exposeInMainWorld\("__pwHost"/.test(preload) && !/require\(["']fs|child_process/.test(preload) && (preload.match(/ipcRenderer\./g) ?? []).length === 1, "preload 는 호출 하나만");
  return "ok";
});

test("키 조합: 수정키와 키 이름을 Electron 입력으로 바꾼다", () => {
  const sent: { type: string; keyCode?: string; modifiers?: string[] }[] = [];
  const guest = { id: 1, sendInputEvent: (e: (typeof sent)[number]) => sent.push(e) } as unknown as WebContents;
  pressKey(guest, "Control+c");
  expect(sent[0].keyCode === "c" && sent[0].modifiers?.join() === "control" && sent.every((e) => e.type !== "char"), `Control+c ${JSON.stringify(sent)}`);
  sent.length = 0;
  pressKey(guest, "Shift+ArrowDown");
  expect(sent[0].keyCode === "Down" && sent[0].modifiers?.join() === "shift", "Shift+ArrowDown");
  sent.length = 0;
  pressKey(guest, "Enter");
  expect(sent.map((e) => e.type).join() === "keyDown,char,keyUp", "Enter 는 char 도 보낸다");
  sent.length = 0;
  pressKey(guest, "a");
  expect(sent.map((e) => e.type).join() === "keyDown,char,keyUp", "글자");
  let bad = "";
  try {
    pressKey(guest, "Hyper+x");
  } catch (error) {
    bad = (error as Error).message;
  }
  expect(bad.startsWith("Unknown key"), bad);
  expect(dialogSummary({ type: "alert", message: "hi", defaultPrompt: "", url: "" }).startsWith("An alert dialog") && dialogSummary({ type: "confirm", message: "ok?", defaultPrompt: "", url: "" }).startsWith("A confirm dialog"), "대화상자 안내문");
  return "ok";
});

test("기기 선택: 항목 모양과 제목, 필터", () => {
  expect(JSON.stringify(usbItem({ deviceId: "u", productName: "Receiver", vendorId: 0x46d, productId: 0xc534, serialNumber: "S1" })) === JSON.stringify({ deviceId: "u", label: "Receiver", detail: "046d:c534, S1" }), "usb");
  expect(usbItem({ deviceId: "u", vendorId: 1, productId: 2 }).label === "USB Device 0001:0002", "usb 이름이 없으면");
  expect(serialItem({ portId: "p", portName: "/dev/tty.x", displayName: "USB Serial", vendorId: "1a86", productId: "7523" }).label === "/dev/tty.x (USB Serial)" && serialItem({ portId: "p", portName: "COM3" }).detail === undefined, "serial");
  expect(hidItem({ deviceId: "h", vendorId: 4, productId: 5 }).label === "HID Device 0004:0005" && bluetoothItem({ deviceId: "b1" }).label === "b1" && bluetoothItem({ deviceId: "b1", deviceName: "Buds" }).label === "Buds", "hid, bluetooth");
  expect(devicePickerTitle("http://localhost:7801", "usb") === "localhost:7801 wants to connect to a USB device" && devicePickerTitle("https://x.test", "serial").endsWith("a serial port") && devicePickerTitle("https://x.test", "hid").endsWith("an HID device") && devicePickerTitle("https://x.test", "bluetooth").endsWith("a Bluetooth device"), "제목");
  const list = [usbItem({ deviceId: "1", productName: "Alpha", vendorId: 1, productId: 1 }), usbItem({ deviceId: "2", productName: "Beta", vendorId: 2, productId: 2, serialNumber: "XYZ" })];
  expect(filterDevices(list, "be").length === 1 && filterDevices(list, "xyz").length === 1 && filterDevices(list, "").length === 2 && filterDevices(list, "nope").length === 0, "이름과 상세로 거른다");
  return "ok";
});

test("기기 요청 흐름: 허용된 사이트만 선택창으로, 고르기와 취소, 목록 갱신, 창이 닫히면 취소", () => {
  const emitted: { requestId: string; devices: { deviceId: string }[] }[] = [];
  let allowed = true;
  const requests = new DeviceRequests((r) => (emitted.push(r), true), () => allowed);
  const answers: (string | null)[] = [];
  const device = (id: string) => ({ deviceId: id, label: id });
  const id = requests.begin({ guest: null, origin: "http://localhost:7801", deviceType: "usb", devices: [device("a")], invoke: (d) => answers.push(d) })!;
  expect(emitted.length === 1 && emitted[0].requestId === id, "화면에 보냄");
  requests.add(null, "usb", device("b"));
  requests.add(null, "usb", device("b"));
  expect(emitted.length === 2 && emitted[1].devices.length === 2, "기기가 늘면 같은 요청을 갱신(중복 무시)");
  requests.remove(null, "usb", "a");
  expect(emitted[emitted.length - 1].devices.map((d) => d.deviceId).join() === "b", "빠지면 갱신");
  requests.resolve(id, "zzz");
  expect(answers.length === 0, "목록에 없는 기기는 무시");
  requests.resolve(id, "b");
  requests.resolve(id, null);
  expect(answers.join() === "b", "한 번만 답함");
  const id2 = requests.begin({ guest: null, origin: "http://localhost:7801", deviceType: "serial", devices: [device("s")], invoke: (d) => answers.push(d) })!;
  requests.resolve(id2, null);
  expect(answers[1] === null, "취소는 null");
  allowed = false;
  const before = emitted.length;
  expect(requests.begin({ guest: null, origin: "http://x.test", deviceType: "hid", devices: [device("h")], invoke: (d) => answers.push(d) }) === null && emitted.length === before && answers[2] === null, "Devices 를 차단한 사이트는 선택창 없이 취소");
  allowed = true;
  const none = new DeviceRequests(() => false, () => true);
  let closed: string | null | undefined;
  none.begin({ guest: null, origin: "http://localhost:7801", deviceType: "usb", devices: [], invoke: (d) => (closed = d) });
  expect(closed === null, "화면에 보내지 못하면 취소");
  return "ok";
});

test("저장 범위: 설정에 따라 partition 이 정해지고, 메인은 정해진 모양만 허락한다", () => {
  expect(partitionFor("default", null, "browser:a1").partition === BROWSER_PARTITION && partitionFor("global", "w1", "browser:a1").scope === "global", "default 와 global 은 같은 지속 세션");
  const ws = partitionFor("workspace", "ws-1_2", "browser:a1");
  expect(ws.partition === "persist:agent-nav-browser-ws-ws12" && ws.scope === "workspace", ws.partition);
  expect(partitionFor("workspace", null, "browser:a1").scope === "ephemeral", "작업 폴더가 없으면 ephemeral");
  const eph1 = partitionFor("ephemeral", null, "browser:a1").partition;
  expect(eph1 !== partitionFor("ephemeral", null, "browser:b2").partition && !eph1.startsWith("persist:"), "탭마다 다른 메모리 세션");
  expect(partitionFor("agent", null, "x").partition === "agent-nav-browser-agent" && !partitionFor("agent", null, "x").partition.startsWith("persist:"), "agent 는 하나를 같이 쓰는 메모리 세션");
  for (const ok of [BROWSER_PARTITION, ws.partition, eph1, "agent-nav-browser-agent"]) expect(isBrowserPartition(ok), `허락 ${ok}`);
  for (const bad of ["persist:agent-nav", "persist:other", "", "default", "agent-nav-browser-eph-", "persist:agent-nav-browser-ws-A B", null, 5]) expect(!isBrowserPartition(bad), `거절 ${String(bad)}`);
  return "ok";
});

test("file: 주소: 주소창과 에이전트 이동이 열 수 있고(호스트 없는 것만), 파일 경로를 읽는다", () => {
  expect(resolveAddress("file:///tmp/a.html").ok === true && resolveAddress("file://server/share/x").ok === false && resolveAddress("javascript:alert(1)").ok === false && resolveAddress("data:text/html,hi").ok === false, "주소창");
  expect(parseOpenable("file:///tmp/a.html") !== null && parseOpenable("http://x.test/") !== null && parseOpenable("file://host/x") === null && parseOpenable("javascript:1") === null && parseBrowsable("file:///tmp/a.html") === null, "parseOpenable 만 file: 을 연다");
  expect(filePathOf("file:///tmp/a%20b.html") === "/tmp/a b.html" && filePathOf("http://x.test/") === null && filePathOf("file://host/x") === null, "파일 경로");
  return "ok";
});

test("에뮬레이션 손잡이: 틀이 가운데라 가로와 세로 모두 2배, 칸을 넘거나 50 아래로 줄지 않고 배율로 나눈다", () => {
  const start = { container: 393, scale: 1, pane: 800 };
  expect(resizedDimension(start, 50) === 493 && resizedDimension(start, 50) === 493, "가로와 세로 모두 2배");
  expect(resizedDimension(start, 1000) === 800 && resizedDimension(start, -1000) === MIN_EMULATION_SIZE, "칸 크기와 최소값");
  expect(resizedDimension({ container: 200, scale: 0.5, pane: 600 }, 20) === 480, "배율 0.5 에서는 CSS px 로 환산");
  expect(resizedDimension({ container: 100, scale: 1, pane: 500 }, -10) === 80 && resizedDimension({ container: 393 * 0.85, scale: 0.85, pane: 800 }, -38) === 304, "줄이기와 실측(배율 85%에서 38px)");
  return "ok";
});

test("검색 결과 편집기: 문서 모양, 접는 범위, 줄 번호 열 맞춤, 앞뒤 줄", () => {
  const doc = buildSearchDoc({
    files: [
      { path: "src/a.ts", rows: [{ line: 8, text: "export const a = 10;", match: true }, { line: 9, text: "const x = 1;", match: false }, { line: 12, text: "export const c = 3;", match: true }] },
      { path: "src/b.ts", rows: [{ line: 1, text: "export const b = 2;", match: true }] },
    ],
    matches: 3,
    truncated: false,
    engine: "rg",
  });
  const lines = doc.text.split("\n");
  expect(lines[0] === "3 results - 2 files" && lines[1] === "" && lines[2] === "src/a.ts:", lines.slice(0, 3).join("|"));
  expect(lines[3] === "   8: export const a = 10;" && lines[4] === "   9  const x = 1;" && lines[5] === "" && lines[6] === "  12: export const c = 3;", `열 맞춤 ${JSON.stringify(lines.slice(3, 7))}`);
  expect(lines[7] === "" && lines[8] === "src/b.ts:" && lines[9] === "  1: export const b = 2;", "파일 사이 빈 줄과 자리수");
  const path = doc.lines[2] as { kind: string; lastRow: number };
  expect(path.kind === "path" && path.lastRow === 7 && (doc.lines[8] as { lastRow: number }).lastRow === 10, "접는 범위는 경로 줄 다음부터 마지막 결과 줄");
  expect(rowAt(doc, 4)?.line === 8 && rowAt(doc, 4)?.prefix === 6 && rowAt(doc, 3) === null && rowAt(doc, 6) === null, "줄에서 결과 찾기");
  expect(doc.lines[4].kind === "row" && (doc.lines[4] as { match: boolean }).match === false, "앞뒤 줄은 일치가 아님");
  return "ok";
});

test("검색 결과 편집기: 확장자별 구문 색 범위", () => {
  const ts = syntaxRanges("src/a.ts", "export const a = 10;");
  expect(ts.length > 0 && ts.some((r) => r.cls.includes("cm-syn-")), `ts ${ts.length}`);
  expect(syntaxRanges("data.json", '{"a": 1}').length > 0 && syntaxRanges("a.css", "a { color: red }").length > 0, "json, css");
  expect(syntaxRanges("README.md", "# title").length === 0 && syntaxRanges("a.ts", "   ").length === 0, "다른 확장자와 빈 줄은 칠하지 않는다");
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
