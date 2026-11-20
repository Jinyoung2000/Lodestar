// FBNOEL: 요소 없이 보내는 피드백의 순수 계산(화면 상태 수집, 프롬프트 조립, 말풍선 칩) 단독 시험.
// 실행: npm test
import { describeScreen, screenLines, type ScreenInput } from "../shared/feedbackScreen";
import type { ElementInfo, Feedback } from "../shared/protocol";
import { chipsOf, composePrompt } from "../server/feedback";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed++;
};

const input: ScreenInput = {
  centerView: "sessions",
  overlay: null,
  panes: [{ id: "p1", kind: "agent", agentId: "a1" }, { id: "p2", kind: "draft" }],
  activePaneId: "p1",
  agents: [{ id: "a1", title: "Fix the sidebar" }],
  layoutMode: "chat",
  sidebarOpen: true,
  rightOpen: true,
  bottomOpen: false,
  bottomTab: "terminal",
  activeTabKey: "changes",
  tabs: [],
  theme: "dark",
  width: 1440.4,
  height: 900,
};

const screen = describeScreen(input);
check("view, active pane and window size", screen.view === "Sessions" && screen.activePane === "Fix the sidebar" && screen.paneCount === 2 && screen.width === 1440 && screen.height === 900);
check("panels", screen.rightPanel === "Changes" && screen.bottomPanel === null && screen.sidebar);
check("settings overlay is named", describeScreen({ ...input, overlay: { kind: "status" } }).overlay === "Settings");
check("board view, draft pane", (() => {
  const s = describeScreen({ ...input, centerView: "board", activePaneId: "p2" });
  return s.view === "Board" && s.activePane === "New session";
})());
check("file tab is named by file", describeScreen({ ...input, activeTabKey: "t1", tabs: [{ key: "t1", kind: "file", path: "/w/web/App.tsx" }] }).rightPanel === "file App.tsx");
check("closed right panel", describeScreen({ ...input, rightOpen: false }).rightPanel === null);
check("screen lines mention the open screen", screenLines(screen).join("\n").includes("Open screen: Sessions") && screenLines({ ...screen, overlay: "Settings" })[0].includes("Settings open on top"));

const base: Feedback = {
  id: "abc",
  agentId: "a",
  text: "make the header taller",
  element: null,
  screen,
  windowScreenshot: true,
  screenshot: false,
  screenshotNote: null,
  status: "running",
  summary: null,
  changedFiles: [],
  needsRestart: false,
  restartRequested: false,
  restartPending: false,
  checks: [],
  failure: null,
  worktree: "/w",
  seen: false,
  createdAt: "",
  updatedAt: "",
};

const noElement = composePrompt(base, "/fb/abc");
check("no element: says so and lists the screen state", noElement.includes("did not pick an element") && noElement.includes("- Open screen: Sessions"));
check("no element: window screenshot path is in the prompt", noElement.includes("/fb/abc/window.png"));
check("no element: no element section", !noElement.includes("Computed style"));
check("screenshot off: says not attached and has no path", (() => {
  const text = composePrompt({ ...base, windowScreenshot: false }, "/fb/abc");
  return text.includes("Whole-window screenshot: not attached") && !text.includes("window.png");
})());

const element: ElementInfo = { component: "Sidebar", sources: ["web/Sidebar.tsx:105"], tag: "div", domPath: "div.sidebar", width: 240, height: 800, text: "", styles: { display: "flex" } };
const withElement = composePrompt({ ...base, element, screenshot: true }, "/fb/abc");
check("element: element section and element screenshot", withElement.includes("The user picked this element") && withElement.includes("/fb/abc/element.png"));
check("element + window screenshot: both paths", withElement.includes("/fb/abc/window.png"));
check("element without window screenshot: no window path", !composePrompt({ ...base, element, windowScreenshot: false }, "/fb/abc").includes("window.png"));

check("chips: none for plain text", chipsOf(null, null).length === 0);
check("chips: screenshot then element", (() => {
  const chips = chipsOf(element, "data:image/jpeg;base64,AAAA");
  return chips.length === 2 && chips[0].kind === "screenshot" && chips[1].kind === "element";
})());
check("chips: element only", chipsOf(element, null).length === 1);

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("all passed");
