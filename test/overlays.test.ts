// B6 세션 검색 목록(web/sessionSearch.ts), 긴 상대 시간(web/sessionList.ts), 명령 팔레트 목록(web/commands.ts)을 DOM 없이 확인한다.
// 실행: npm test
import type { Agent, Workspace } from "../shared/protocol";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BINDINGS, INTERCEPT_STROKES } from "../web/keymap";
import { filterCommands, KEYLESS_COMMANDS, keycapsOf, paletteCommands } from "../web/commands";
import { relativeTimeLong } from "../web/sessionList";
import { sessionOptions, startsSection } from "../web/sessionSearch";

const cases: { name: string; run: () => string }[] = [];
const test = (name: string, run: () => string) => cases.push({ name, run });
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
  return detail;
};

const NOW = new Date(2026, 9, 14, 15, 0, 0).getTime();
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

let seq = 0;
const agent = (patch: Partial<Agent>): Agent => ({
  id: `a${++seq}`,
  workspaceId: "w1",
  cwd: "/tmp/one",
  worktree: null,
  forkedFrom: null,
  resumeFrom: null,
  startCommit: null,
  feedbackId: null,
  title: `title ${seq}`,
  sessionId: null,
  status: "idle",
  permissionMode: "default",
  model: null,
  effort: null,
  activeModel: null,
  activeEffort: null,
  backgroundTasks: 0,
  createdAt: at(100),
  updatedAt: at(100),
  ...patch,
});

const workspaces: Workspace[] = [
  { id: "w1", name: "one", dir: "/tmp/one", parentId: null },
  { id: "w2", name: "two", dir: "/tmp/two", parentId: null },
  { id: "w1-wt", name: "one-wt", dir: "/tmp/one-wt", parentId: "w1" },
];

test("relativeTimeLong: 단위를 길게 쓰고 단수를 구분한다", () => {
  const ago = (min: number) => relativeTimeLong(at(min), NOW);
  expect(ago(0) === "now", ago(0));
  expect(ago(1) === "1 minute ago", ago(1));
  expect(ago(2) === "2 minutes ago", ago(2));
  expect(ago(60) === "1 hour ago", ago(60));
  expect(ago(180) === "3 hours ago", ago(180));
  expect(ago(24 * 60) === "1 day ago", ago(24 * 60));
  expect(ago(3 * 24 * 60) === "3 days ago", ago(3 * 24 * 60));
  expect(ago(10 * 24 * 60) === "1 week ago", ago(10 * 24 * 60));
  expect(ago(90) === "2 hours ago", ago(90));
  expect(relativeTimeLong("bad", NOW) === "", "invalid");
  return "ok";
});

test("sessionOptions: recently opened 가 연 순서 역순으로 앞, 나머지는 updatedAt 최신순", () => {
  const a = agent({ id: "A", updatedAt: at(50) });
  const b = agent({ id: "B", updatedAt: at(5) });
  const c = agent({ id: "C", updatedAt: at(20) });
  const d = agent({ id: "D", updatedAt: at(1) });
  const list = sessionOptions({ agents: [a, b, c, d], workspaces, recentIds: ["C", "gone", "A"], query: "" });
  expect(list.map((o) => o.agent.id).join() === "C,A,D,B", list.map((o) => o.agent.id).join());
  expect(list.map((o) => o.section).join() === "recent,recent,other,other", "sections");
  expect([0, 1, 2, 3].map((i) => startsSection(list, i)).join() === "true,false,true,false", "section starts");
  return "ok";
});

test("sessionOptions: 제목과 폴더 이름으로 거르고, worktree 는 원 프로젝트 이름, 모르는 폴더는 cwd 이름", () => {
  const plain = agent({ id: "P", title: "Fix login" });
  const wt = agent({ id: "W", title: "Refactor", workspaceId: "w1-wt", cwd: "/tmp/one-wt", worktree: { root: "/tmp/one-wt", branch: "x" } as Agent["worktree"] });
  const stray = agent({ id: "S", title: "Elsewhere", workspaceId: "missing", cwd: "/Users/me/other-proj" });
  const all = sessionOptions({ agents: [plain, wt, stray], workspaces, recentIds: [], query: "" });
  expect(all.find((o) => o.agent.id === "W")?.folder === "one" && all.find((o) => o.agent.id === "W")?.worktree === true, "worktree");
  expect(all.find((o) => o.agent.id === "S")?.folder === "other-proj", "stray");
  const chat = agent({ id: "C", title: "Quick question", workspaceId: null, cwd: "/tmp/nav/chats/C" });
  expect(sessionOptions({ agents: [chat], workspaces, recentIds: [], query: "" })[0]?.folder === "Chats", "퀵 챗은 Chats");
  expect(sessionOptions({ agents: [plain, wt, stray], workspaces, recentIds: [], query: "login" }).map((o) => o.agent.id).join() === "P", "title");
  expect(sessionOptions({ agents: [plain, wt, stray], workspaces, recentIds: [], query: "OTHER-pro" }).map((o) => o.agent.id).join() === "S", "folder");
  expect(sessionOptions({ agents: [plain], workspaces, recentIds: [], query: "zzz" }).length === 0, "none");
  return "ok";
});

test("paletteCommands: 표의 모든 명령이 이름을 갖고 이름순이며 escape 는 빠진다", () => {
  const list = paletteCommands();
  const commands = new Set(BINDINGS.map((b) => b.command));
  commands.delete("escape");
  expect(list.length === commands.size + KEYLESS_COMMANDS.length, `표 ${commands.size}개와 키 없는 명령 ${KEYLESS_COMMANDS.length}개, 목록 ${list.length}개`);
  const titles = list.map((c) => c.title);
  expect(titles.every((t, i) => i === 0 || titles[i - 1].localeCompare(t) <= 0), "이름순");
  expect(new Set(titles).size === titles.length, "이름 중복 없음");
  expect(!list.some((c) => c.command === "escape"), "escape");
  return `${list.length}개`;
});

test("paletteCommands: 명세의 예시 이름과 키", () => {
  const by = (command: string) => paletteCommands().find((c) => c.command === command);
  expect(by("sessions")?.title === "Agents: Show Sessions Picker" && by("sessions")?.keycaps.join(" ") === "⌃ ⌥ R", `sessions ${by("sessions")?.keycaps.join(" ")}`);
  expect(by("quickChat")?.title === "Agents: New Chat" && by("quickChat")?.keycaps.join(" ") === "⌘ K ⌘ N", `quickChat ${by("quickChat")?.keycaps.join(" ")}`);
  expect(by("split")?.title === "Agents: New Session to the Right" && by("split")?.keycaps.join(" ") === "⌘ \\", "split");
  expect(by("commandPalette")?.keycaps.join(" ") === "⇧ ⌘ P", "commandPalette");
  expect(by("focusPaneIndex:0")?.title === "Agents: Focus Session 1" && by("focusPaneIndex:last")?.title === "Agents: Focus Last Session", "index");
  expect(by("focusPaneUp")?.keycaps.join(" ") === "⌘ K ⌘ ↑", "첫 키만 보인다");
  return "ok";
});

test("keycapsOf: 한 키와 chord", () => {
  expect(keycapsOf({ keys: ["Alt+Meta+ArrowLeft"], command: "x" }).join(" ") === "⌥ ⌘ ←", "arrow");
  expect(keycapsOf({ keys: ["Meta+Digit3"], command: "x" }).join(" ") === "⌘ 3", "digit");
  return "ok";
});

test("filterCommands: 낱말이 모두 들어 있는 것만, 앞의 > 는 무시, 순서 유지", () => {
  const list = paletteCommands();
  const hit = filterCommands(list, "> new session");
  expect(hit.length === 4 && hit.every((c) => /new session/i.test(c.title)), hit.map((c) => c.title).join());
  expect(filterCommands(list, ">").length === list.length, "빈 입력은 전부");
  expect(filterCommands(list, ">zzzz").length === 0, "없음");
  expect(filterCommands(list, ">NEW chat").map((c) => c.command).join() === "quickChat", "대소문자 무시");
  return "ok";
});

test("Developer 명령: Reload Window 는 ⌘R, Restart Daemon 은 키 없이 있고 웹 접속에서는 Restart Daemon 만 빠진다", () => {
  const by = (list: ReturnType<typeof paletteCommands>, command: string) => list.find((c) => c.command === command);
  const desktop = paletteCommands();
  expect(by(desktop, "reloadWindow")?.title === "Developer: Reload Window" && by(desktop, "reloadWindow")?.keycaps.join(" ") === "⌘ R", "reload");
  expect(by(desktop, "restartDaemon")?.title === "Developer: Restart Daemon" && by(desktop, "restartDaemon")?.keycaps.length === 0, "restart");
  const web = paletteCommands(undefined, { desktop: false });
  expect(!by(web, "restartDaemon") && !!by(web, "reloadWindow") && web.length === desktop.length - 1 - 3 - 2 && !by(web, "zoomIn") && !by(web, "newWindow") && !by(web, "closeWindow") && !!by(desktop, "zoomIn"), "웹 접속(Restart Daemon, 창 확대 3개, 새 창과 창 닫기만 빠진다)");
  const developer = filterCommands(desktop, ">developer").map((c) => c.command);
  expect(developer.includes("reloadWindow") && developer.includes("restartDaemon"), "developer 로 둘 다 찾는다");
  expect(INTERCEPT_STROKES.has("Meta+KeyR"), "⌘R 은 메뉴 가속키와 겹치므로 메인이 가로챈다");
  return "ok";
});

test("Developer 명령: preload 의 IPC 이름마다 메인에 핸들러가 있고 메뉴가 같은 명령을 보낸다", () => {
  const preload = readFileSync(join(import.meta.dirname, "../electron/preload.ts"), "utf8");
  const main = readFileSync(join(import.meta.dirname, "../electron/main.ts"), "utf8");
  const menu = readFileSync(join(import.meta.dirname, "../electron/appMenu.ts"), "utf8");
  for (const channel of ["agent-nav:reload-window", "agent-nav:restart-daemon"]) {
    expect(preload.includes(`invoke("${channel}")`) && main.includes(`ipcMain.handle("${channel}"`), channel);
  }
  expect(main.includes('send("reloadWindow")') && menu.includes('actions.reloadCurrentWindow()') && menu.includes('send("restartDaemon")') && !menu.includes('role: "reload"') && !main.includes('role: "reload"'), "메뉴");
  return "ok";
});

let failed = 0;
for (const c of cases) {
  try {
    console.log(`PASS ${c.name}: ${c.run()}`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${c.name}: ${(error as Error).message}`);
  }
}
if (failed) process.exit(1);
console.log(`${cases.length}개 통과`);
