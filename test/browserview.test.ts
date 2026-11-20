// Browser 탭의 순수 로직: 확대와 에뮬레이션 계산(web/browserView.ts), History 와 Favorites(web/browserHistory.ts),
// 입력창 첨부 글(web/browserAttach.ts), 새 탭 자리(web/tabOrder.ts), 요소 선택자(electron/pickScript.ts).
// 실행: npm test
import { browserAttachmentLabel, formatBrowserAttachment, trimHtml } from "../web/browserAttach";
import { addVisit, groupByDay, HISTORY_MAX, matchesQuery, retitleVisit, toggleFavorite, type Visit } from "../web/browserHistory";
import { clampZoom, DEFAULT_EMULATION, DEVICE_PRESETS, emulatedFrame, parseDimension, percentToZoom, presetDescription, readFrameLocation, scaleLabel, SCALE_CHOICES, ZOOM_MAX, ZOOM_MIN, zoomFactor } from "../web/browserView";
import { insertNextToActive, removedFilesIndex } from "../web/tabOrder";
import { cssPathOf, PICK_READ_SCRIPT, pickScript, type PickMode } from "../electron/pickScript";
import { CLICK_SCRIPT, FOCUS_SCRIPT, resolveScript, snapshotScript } from "../electron/guestScripts";

const cases: { name: string; run: () => string }[] = [];
const test = (name: string, run: () => string) => cases.push({ name, run });
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
  return detail;
};

test("새 탭 자리: 활성 탭 바로 옆, 변경이 활성이면 변경과 파일 사이, 파일이 활성이면 파일 바로 뒤", () => {
  const keys = (r: { tabs: { key: string }[] }) => r.tabs.map((t) => t.key).join();
  const tabs = [{ key: "a" }, { key: "b" }, { key: "c" }];
  // filesIndex 1: a 는 변경과 파일 사이, b 와 c 는 파일 뒤
  const slots = { tabs, filesIndex: 1 };
  const afterA = insertNextToActive(slots, "a", { key: "n" });
  expect(keys(afterA) === "a,n,b,c" && afterA.filesIndex === 2, "파일 앞 탭 뒤에 넣으면 새 탭도 파일 앞");
  const afterB = insertNextToActive(slots, "b", { key: "n" });
  expect(keys(afterB) === "a,b,n,c" && afterB.filesIndex === 1, "파일 뒤 탭 뒤");
  const afterC = insertNextToActive(slots, "c", { key: "n" });
  expect(keys(afterC) === "a,b,c,n" && afterC.filesIndex === 1, "끝");
  const afterChanges = insertNextToActive(slots, "changes", { key: "n" });
  expect(keys(afterChanges) === "n,a,b,c" && afterChanges.filesIndex === 2, "변경이 활성이면 변경 바로 뒤(파일 앞)");
  const afterFiles = insertNextToActive(slots, "files", { key: "n" });
  expect(keys(afterFiles) === "a,n,b,c" && afterFiles.filesIndex === 1, "파일이 활성이면 파일 바로 뒤");
  expect(keys(insertNextToActive({ tabs: [], filesIndex: 0 }, "files", { key: "n" })) === "n", "빈 목록");
  expect(tabs.length === 3, "원본은 그대로");
  return "ok";
});

test("탭 닫기: 파일 탭 앞의 탭을 닫으면 filesIndex 가 줄고, 뒤의 탭이면 그대로", () => {
  const tabs = [{ key: "a" }, { key: "b" }, { key: "c" }];
  expect(removedFilesIndex(tabs, 2, "a") === 1 && removedFilesIndex(tabs, 2, "b") === 1, "앞");
  expect(removedFilesIndex(tabs, 2, "c") === 2 && removedFilesIndex(tabs, 0, "a") === 0, "뒤와 0");
  return "ok";
});

test("확대: 단계는 범위 안, 한 단계에 1.2 배", () => {
  expect(clampZoom(99) === ZOOM_MAX && clampZoom(-99) === ZOOM_MIN && clampZoom(2) === 2, "clamp");
  expect(zoomFactor(0) === 1 && zoomFactor(1) === 1.2 && zoomFactor(-1) === 0.83, `factor ${zoomFactor(-1)}`);
  return "ok";
});

test("에뮬레이션: 크기 입력은 auto 나 1 에서 9999, 칸보다 넓으면 배율을 줄인다", () => {
  expect(parseDimension("") === 0 && parseDimension(" Auto ") === 0 && parseDimension("375") === 375 && parseDimension("1") === 1, "허용");
  expect(parseDimension("0") === null && parseDimension("10000") === null && parseDimension("12px") === null && parseDimension("-5") === null, "거절");
  const avail = { width: 600, height: 800 };
  const emu = (patch: object) => ({ ...DEFAULT_EMULATION, ...patch });
  expect(JSON.stringify(emulatedFrame(emu({}), avail)) === JSON.stringify({ width: 584, height: 784, scale: 1 }), "auto 는 손잡이 자리를 뺀 칸을 채움");
  const wide = emulatedFrame(emu({ width: 1200, height: 900, dpr: 2 }), avail);
  expect(wide.width === 1200 && Math.abs(wide.scale - 584 / 1200) < 1e-9, `넓으면 줄임 ${wide.scale}`);
  expect(emulatedFrame(emu({ width: 1200, height: 900, scale: 1.25 }), avail).scale === 1.25, "고른 배율");
  expect(emulatedFrame(emu({ width: 375, height: 667 }), avail).scale === 1, "좁으면 그대로");
  expect(emulatedFrame(emu({ width: 393, height: 852 }), avail).scale === 784 / 852, "높이가 칸을 넘어도 줄인다(VS Code Auto 85%)");
  return "ok";
});

test("VS Code 의 에뮬레이션 목록: 기기 프리셋 넷, Scale 은 Auto 와 50%에서 200%", () => {
  expect(DEVICE_PRESETS.map((p) => p.name).join() === "iPhone 15 Pro,iPhone SE,Pixel 8,iPad Mini", "프리셋 이름");
  const pixel = DEVICE_PRESETS[2];
  expect(pixel.width === 412 && pixel.height === 915 && pixel.dpr === 2.625 && pixel.mobile && /Pixel 8/.test(pixel.userAgent), "Pixel 8");
  expect(presetDescription(DEVICE_PRESETS[0]) === "393\u00d7852 \u2022 mobile", presetDescription(DEVICE_PRESETS[0]));
  expect(SCALE_CHOICES.join() === "auto,0.5,0.75,1,1.25,1.5,2", "scale 목록");
  expect(scaleLabel("auto", 68) === "Auto (68%)" && scaleLabel(1.25) === "125%", "scale 이름");
  expect(percentToZoom(100) === 0 && percentToZoom(50) < 0 && percentToZoom(200) > 0, "퍼센트를 단계로");
  return "ok";
});

test("iframe 위치 읽기: 같은 출처면 주소와 제목, 접근이 막히면 null", () => {
  const same = { location: { href: "http://a.test/x" }, document: { title: "X" } };
  expect(JSON.stringify(readFrameLocation(same)) === JSON.stringify({ url: "http://a.test/x", title: "X" }), "같은 출처");
  const blocked = {
    get location(): { href: string } {
      throw new DOMException("Blocked a frame with origin", "SecurityError");
    },
    document: { title: "" },
  };
  expect(readFrameLocation(blocked) === null, "다른 출처");
  expect(readFrameLocation(null) === null && readFrameLocation({ location: { href: "about:blank" }, document: { title: "" } }) === null, "빈 프레임");
  return "ok";
});

const visit = (url: string, title: string, at: number): Visit => ({ url, title, at });

test("History: 같은 주소는 한 줄로 맨 위에 오르고 제목을 지키며 200개까지", () => {
  let list: Visit[] = [];
  list = addVisit(list, visit("http://a/", "A", 1));
  list = addVisit(list, visit("http://b/", "B", 2));
  list = addVisit(list, visit("http://a/", "", 3));
  expect(list.map((v) => v.url).join() === "http://a/,http://b/", "순서");
  expect(list[0].title === "A" && list[0].at === 3, "제목 유지, 시각 갱신");
  expect(retitleVisit(list, "http://b/", "B2")[1].title === "B2" && retitleVisit(list, "http://b/", "B") === list, "제목 갱신과 변화 없음");
  let many: Visit[] = [];
  for (let i = 0; i < HISTORY_MAX + 20; i++) many = addVisit(many, visit(`http://x/${i}`, "", i));
  expect(many.length === HISTORY_MAX && many[0].url === `http://x/${HISTORY_MAX + 19}`, "상한");
  return "ok";
});

test("History: 낱말이 모두 제목이나 주소에 들어야 남고 날짜별로 묶인다", () => {
  const item = { url: "http://localhost:7801/two", title: "Second Page" };
  expect(matchesQuery(item, "second 7801") && matchesQuery(item, "") && !matchesQuery(item, "second nope"), "match");
  const now = new Date(2026, 9, 15, 12).getTime();
  const day = 24 * 60 * 60 * 1000;
  const groups = groupByDay([visit("a", "", now), visit("b", "", now - 1000), visit("c", "", now - day), visit("d", "", now - 5 * day)], now);
  expect(groups.map((g) => g.label).slice(0, 2).join() === "Today,Yesterday" && groups[0].items.length === 2 && groups.length === 3, groups.map((g) => g.label).join());
  return "ok";
});

test("Favorites: 같은 주소를 다시 누르면 빠지고 새로 넣으면 맨 앞", () => {
  let list = toggleFavorite([], { url: "http://a/", title: " A " });
  list = toggleFavorite(list, { url: "http://b/", title: "B" });
  expect(list.map((f) => f.url).join() === "http://b/,http://a/" && list[1].title === "A", "추가");
  list = toggleFavorite(list, { url: "http://b/", title: "B" });
  expect(list.length === 1 && list[0].url === "http://a/", "제거");
  return "ok";
});

test("첨부 글: 요소는 선택자와 HTML 을 믿을 수 없는 내용으로 표시하고, 페이지는 주소와 스크린샷 경로", () => {
  const element = formatBrowserAttachment({ kind: "element", url: "http://localhost:7801/", title: "T", selector: "body > h1", tag: "h1", html: "<h1>Hi</h1>" });
  expect(element.includes("[Browser element from http://localhost:7801/]") && element.includes("Selector: body > h1") && element.includes("untrusted") && element.includes("```html\n<h1>Hi</h1>\n```"), element);
  const page = formatBrowserAttachment({ kind: "page", url: "http://localhost:7801/", title: "Static Preview", shot: "/tmp/x.png" });
  expect(page.includes("[Browser page: Static Preview]") && page.includes("Screenshot: /tmp/x.png (read this image file to see the page)"), page);
  expect(formatBrowserAttachment({ kind: "page", url: "http://a/", title: "", shot: null }).includes("not available"), "스크린샷 없음");
  expect(browserAttachmentLabel({ kind: "element", url: "http://localhost:7801/", title: "", selector: "h1", tag: "h1", html: "" }) === "h1 (localhost:7801)", "요소 칩");
  expect(browserAttachmentLabel({ kind: "page", url: "http://localhost:7801/", title: "", shot: null }) === "Browser Screenshot", "페이지 칩");
  expect(browserAttachmentLabel({ kind: "page", url: "http://localhost:7801/", title: "", shot: null, area: true }) === "Browser Area Screenshot", "영역 칩");
  expect(browserAttachmentLabel({ kind: "console", url: "http://localhost:7801/", title: "", text: "" }) === "Console Logs", "콘솔 칩");
  expect(browserAttachmentLabel({ kind: "element", url: "http://localhost:7801/", title: "", selector: "h1", tag: "h1", html: "", comment: { number: 2, text: "make it bigger" } }) === "Comment 2: make it bigger", "댓글 칩");
  const comment = formatBrowserAttachment({ kind: "element", url: "http://localhost:7801/", title: "", selector: "h1", tag: "h1", html: "<h1>x</h1>", shot: "/tmp/a.png", comment: { number: 1, text: "bigger" } });
  expect(comment.startsWith("[Browser element comment 1 from http://localhost:7801/]\nComment: bigger\nSelector: h1\nScreenshot: /tmp/a.png") && comment.includes("untrusted"), comment);
  const logs = formatBrowserAttachment({ kind: "console", url: "http://x.test/", title: "", text: "[error] boom" });
  expect(logs.includes("untrusted page output") && logs.includes("[error] boom"), "콘솔 첨부 글");
  const area = formatBrowserAttachment({ kind: "page", url: "http://x.test/", title: "T", shot: "/tmp/b.png", area: true });
  expect(area.startsWith("[Browser area screenshot: T]") && area.includes("Screenshot: /tmp/b.png"), area);
  return "ok";
});

test("HTML 줄이기: 긴 data 주소는 줄이고 너무 길면 자른다", () => {
  const long = `<img src="data:image/png;base64,${"A".repeat(500)}">`;
  expect(trimHtml(long) === '<img src="data:...">', trimHtml(long));
  const cut = trimHtml("x".repeat(5000));
  expect(cut.length < 4100 && cut.endsWith("<!-- truncated -->"), "자름");
  return "ok";
});

// 가짜 DOM 요소. cssPathOf 는 tagName, id, classList, parentElement, children 만 읽는다.
type Fake = { nodeType: number; tagName: string; id?: string; classList: string[]; parentElement: Fake | null; children: Fake[] };
const node = (tagName: string, parent: Fake | null, extra: Partial<Fake> = {}): Fake => {
  const n: Fake = { nodeType: 1, tagName, classList: [], parentElement: parent, children: [], ...extra };
  parent?.children.push(n);
  return n;
};

test("요소 선택자: 고유한 id 에서 끝내고, 아니면 태그와 클래스와 nth-of-type 으로 body 까지", () => {
  const html = node("HTML", null);
  const body = node("BODY", html);
  const main = node("MAIN", body, { id: "app" });
  const list = node("UL", main, { classList: ["list", "wide", "third"] });
  const first = node("LI", list);
  const second = node("LI", list);
  const doc = { querySelectorAll: (sel: string) => (sel === "#app" ? [main] : []) };
  expect(cssPathOf(second, doc) === "#app > ul.list.wide > li:nth-of-type(2)", cssPathOf(second, doc));
  expect(cssPathOf(first, doc) === "#app > ul.list.wide > li:nth-of-type(1)", "첫 li");
  const loose = node("DIV", body, { id: "dup" });
  const dupDoc = { querySelectorAll: () => [loose, loose] };
  expect(cssPathOf(loose, dupDoc) === "body > div", cssPathOf(loose, dupDoc));
  return "ok";
});

const THEME = { focus: "#0078d4", buttonBg: "#0078d4", buttonFg: "#ffffff", widgetBg: "#202020", widgetFg: "#cccccc", widgetBorder: "#454545", widgetShadow: "rgba(0,0,0,0.36)", placeholder: "#9d9d9d", hover: "#2a2d2e", font: "system-ui" };

test("요소 선택 스크립트: 세 모드 모두 문법에 맞고 네트워크 통로가 없다", () => {
  for (const mode of ["element", "comment", "area"] as PickMode[]) {
    const script = pickScript(mode, THEME);
    new Function(script);
    // tsx 는 함수 이름을 지키는 __name 보조를 끼워 넣지만 앱 번들(esbuild, keepNames 없음)에는 없다. 번들에 없는지는 빌드 뒤 dist-electron/main.mjs 로 따로 본다.
    expect(script.includes("__agentNavPickQueue") && script.includes(JSON.stringify(mode)), `${mode}: 결과 큐와 모드`);
    expect(!/\bfetch\(|XMLHttpRequest|WebSocket|postMessage/.test(script), `${mode}: 네트워크와 메시지 통로 없음`);
  }
  new Function(PICK_READ_SCRIPT);
  expect(pickScript("comment", THEME).includes("Add a comment") && pickScript("comment", THEME).includes("comment-pin") && pickScript("element", THEME).includes("label-dims"), "댓글 입력줄과 핀, 라벨");
  return "ok";
});

test("에이전트 도구 스크립트: 읽기, 요소 찾기, 포커스, 클릭이 문법에 맞고 네트워크 통로가 없다", () => {
  const scripts = [snapshotScript("snapshot"), snapshotScript("text"), resolveScript("e1", null)!, resolveScript(null, "a[href]")!, resolveScript(null, "text=Save >> nth=0")!, FOCUS_SCRIPT, CLICK_SCRIPT];
  for (const script of scripts) {
    new Function(script);
    expect(!/\bfetch\(|XMLHttpRequest|WebSocket|postMessage/.test(script), "네트워크와 메시지 통로 없음");
  }
  expect(snapshotScript("snapshot").includes("__anRefs") && resolveScript("e3", null)!.includes('"e3"'), "ref 목록과 인자");
  return "ok";
});

let failed = 0;
for (const c of cases) {
  try {
    console.log(`ok   ${c.name} (${c.run()})`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${c.name}: ${(error as Error).message}`);
  }
}
console.log(failed ? `${failed} failed` : `${cases.length} passed`);
process.exit(failed ? 1 : 0);
