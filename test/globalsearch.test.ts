import type { Agent, BoardCard, InboxItem, Workspace } from "../shared/protocol";
import type { PrSummary } from "../shared/prTypes";
import { BINDINGS, CHORD_TIMEOUT_MS, stepKey, type KeyContext, type Pending } from "../web/keymap";
import { ALL_GROUP_CAP, altLabel, DEFAULT_ACTIONS, flatRows, mentionItems, noteStamp, parseSlash, plainSlack, RECENT_LIMIT, recentRows, searchGroups, STAMP_LIMIT, tabKeyStep, uniquePrs, visibleTabs, type SearchData, type SearchScope } from "../web/searchModel";

const cases: { name: string; run: () => string }[] = [];
const test = (name: string, run: () => string) => cases.push({ name, run });
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
  return detail;
};

const ctx: KeyContext = { inTerminal: false, inEditor: false };
const overlayCtx: KeyContext = { ...ctx, inSearchOverlay: true };
const prefix = (at = 0): Pending => ({ prefix: "Meta+KeyK", at });

const NOW = Date.parse("2026-10-15T12:00:00Z");
const minutesAgo = (n: number) => new Date(NOW - n * 60_000).toISOString();

const agent = (id: string, title: string, extra: Partial<Agent> = {}): Agent => ({ id, title, workspaceId: "w1", cwd: "/Users/g/Repository/app", worktree: null, status: "idle", updatedAt: minutesAgo(30), createdAt: minutesAgo(60), ...extra }) as unknown as Agent;
const workspaces: Workspace[] = [
  { id: "w1", name: "app", dir: "/Users/g/Repository/app", parentId: null },
  { id: "w2", name: "docs", dir: "/Users/g/Repository/docs", parentId: null },
  { id: "w1-wt", name: "app-wt", dir: "/Users/g/Repository/app-wt", parentId: "w1" },
  { id: "wf", name: "feedback", dir: "/tmp/feedback", parentId: null, feedback: true },
];
const pr = (n: number, title: string, repo = "acme/app", updatedAt = minutesAgo(n)): PrSummary => ({ repo, number: n, title, url: `https://github.com/${repo}/pull/${n}`, author: { login: "me", avatarUrl: null }, isDraft: false, state: "OPEN", updatedAt, reviewDecision: null, checks: null, comments: 0, baseRef: "main", headRef: `feat-${n}` });
const card = (id: string, title: string, workspaceId: string | null = null): BoardCard => ({ id, columnId: "todo", title, body: "", labels: ["ui"], priority: 0, number: 1, workspaceId, agentIds: [], links: [], createdAt: minutesAgo(90), updatedAt: minutesAgo(90) });
const mention = (id: string, text: string, extra: Partial<InboxItem> = {}): InboxItem => ({ id, kind: "mention", channelId: "C1", channelName: "#team", ts: "1.0", threadTs: null, from: { id: "U1", name: "Ann" }, text, permalink: "https://example.slack.com/archives/C1/p1", time: minutesAgo(5), read: false, archived: false, fetchedAt: minutesAgo(1), ...extra });

const base = (): SearchData => ({
  agents: [agent("a1", "Fix login bug", { updatedAt: minutesAgo(10) }), agent("a2", "Refactor sidebar", { updatedAt: minutesAgo(20) }), agent("a3", "Write docs", { workspaceId: "w2", updatedAt: minutesAgo(40) }), agent("a4", "Login redesign", { workspaceId: "w1-wt", updatedAt: minutesAgo(50) })],
  workspaces,
  recentAgentIds: ["a2", "a1"],
  fileWorkspaceId: "w1",
  files: ["src/login.ts", "src/App.tsx", "README.md", "web/Login.tsx"],
  recentFiles: [{ workspaceId: "w1", path: "src/App.tsx" }, { workspaceId: "w2", path: "docs/intro.md" }],
  prs: [pr(3, "Add login page"), pr(8, "Sidebar fix")],
  cards: [card("c1", "Login polish", "w1"), card("c2", "Other thing")],
  columns: [{ id: "todo", name: "Todo", role: "todo" }],
  mentions: [mention("m1", "<@U2> please check login")],
  stamps: {},
  now: NOW,
});

const titles = (rows: { title: string }[]) => rows.map((r) => r.title);

const chordContext = (when: string | undefined): KeyContext => ({ ...ctx, inEditor: when === "editor", inEditorArea: when === "editorArea" || when === "editor", inBrowser: when === "browserTab", inSearch: when === "searchTab", inElectron: when === "electron" });

test("chord 표: ⌘K 로 시작하는 모든 chord 는 검색창이 닫혀 있을 때 예전과 똑같이 실행된다", () => {
  const chords = BINDINGS.filter((b) => b.keys.length === 2);
  expect(chords.length >= 14 && chords.every((b) => b.keys[0] === "Meta+KeyK"), `chord ${chords.length}개, 모두 ⌘K 시작`);
  for (const b of chords) {
    const second2 = b.keys[1] as string;
    const c = chordContext(b.when);
    const second = stepKey(prefix(), second2, c, 100);
    const winner = BINDINGS.find((x) => x.keys.length === 2 && x.keys[1] === second2 && (x.when === undefined || (x.when === "editor" && c.inEditor) || (x.when === "editorArea" && c.inEditorArea)));
    expect(second.kind === "run" && second.command === (winner ?? b).command, `⌘K ${second2} (${b.when ?? "any"}) -> ${b.command}, 실제 ${second.kind === "run" ? second.command : second.kind}`);
  }
  return `${chords.length}개`;
});

test("⌘K 첫 키: 에디터 밖에서는 검색창을 열고 chord 도 기다리며, 에디터에서는 chord 만 기다린다", () => {
  const out = stepKey(null, "Meta+KeyK", ctx, 0);
  expect(out.kind === "pending" && out.opens === "search" && out.pending.prefix === "Meta+KeyK", "에디터 밖");
  const terminal = stepKey(null, "Meta+KeyK", { inTerminal: true, inEditor: false }, 0);
  expect(terminal.kind === "run" && terminal.command === "terminalClear", "터미널");
  const editor = stepKey(null, "Meta+KeyK", { inTerminal: false, inEditor: true, inEditorArea: true }, 0);
  expect(editor.kind === "pending" && editor.opens === undefined, "에디터는 opens 없음");
  const format = stepKey(editor.kind === "pending" ? editor.pending : null, "Meta+KeyF", { inTerminal: false, inEditor: true, inEditorArea: true }, 10);
  expect(format.kind === "run" && format.command === "formatSelection", "⌘K ⌘F");
  const down = stepKey(editor.kind === "pending" ? editor.pending : null, "Meta+Backslash", { inTerminal: false, inEditor: true, inEditorArea: true }, 10);
  expect(down.kind === "run" && down.command === "splitEditorDown", "⌘K ⌘\\");
  return "ok";
});

test("검색창이 열린 뒤: 수정키가 붙은 chord 키는 실행하고, 글자와 방향키와 Esc 는 검색창에 넘긴다", () => {
  for (const [stroke, command] of [["Meta+Backslash", "splitDown"], ["Meta+KeyW", "closeAllSessions"], ["Meta+KeyN", "quickChat"], ["Meta+ArrowLeft", "focusPaneLeft"], ["Meta+ArrowRight", "focusPaneRight"], ["Meta+ArrowUp", "focusPaneUp"], ["Meta+ArrowDown", "focusPaneDown"]] as const) {
    const step = stepKey(prefix(), stroke, overlayCtx, 100);
    expect(step.kind === "run" && step.command === command, `⌘K ${stroke}: ${step.kind === "run" ? step.command : step.kind}`);
  }
  for (const stroke of ["KeyW", "KeyA", "Shift+KeyW", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Escape", "Enter", "Tab", "Meta+KeyV", "Meta+KeyA"]) {
    const step = stepKey(prefix(), stroke, overlayCtx, 100);
    expect(step.kind === "pass" && step.pending === null, `${stroke} 은 검색창이 받는다: ${step.kind}`);
  }
  return "ok";
});

test("검색창이 열린 채 ⌘K 를 다시 누르면 닫고 chord 를 다시 기다린다(⌘K ⌘K 뒤 W 가 closeAllChats 로 가는 길)", () => {
  const again = stepKey(prefix(), "Meta+KeyK", overlayCtx, 100);
  expect(again.kind === "pending" && again.opens === "search" && again.pending.at === 100, "다시 누름");
  const late = stepKey(null, "Meta+KeyK", overlayCtx, 5000);
  expect(late.kind === "pending" && late.opens === "search", "대기 없이 누름");
  const w = stepKey(again.kind === "pending" ? again.pending : null, "KeyW", ctx, 200);
  const left = stepKey(again.kind === "pending" ? again.pending : null, "ArrowLeft", ctx, 200);
  expect(w.kind === "run" && w.command === "closeAllChats" && left.kind === "run" && left.command === "focusPaneLeft", "plain chord");
  return "ok";
});

test("검색창이 없으면 chord 의 예전 정책이 그대로다: 모르는 두 번째 키는 취소, 1.5초가 지나면 처음 누른 것으로", () => {
  expect(stepKey(prefix(), "KeyZ", ctx, 10).kind === "cancel", "cancel");
  expect(stepKey(prefix(), "KeyW", ctx, CHORD_TIMEOUT_MS + 1).kind === "pass", "시간 지남");
  const late = stepKey(prefix(), "Meta+KeyK", ctx, CHORD_TIMEOUT_MS + 1);
  expect(late.kind === "pending" && late.opens === "search", "시간이 지난 뒤 ⌘K 는 다시 검색창");
  return "ok";
});

test("⌃⌥R 은 그대로 sessions 명령이고 ⇧⌘K 는 보드로 남는다", () => {
  const sessions = stepKey(null, "Ctrl+Alt+KeyR", ctx, 0);
  expect(sessions.kind === "run" && sessions.command === "sessions", "⌃⌥R");
  const board = stepKey(null, "Shift+Meta+KeyK", ctx, 0);
  expect(board.kind === "run" && board.command === "board", "⇧⌘K");
  return "ok";
});

const tabs: SearchScope[] = ["all", "sessions", "files", "prs"];
const arrow = (key: string, extra: Partial<{ shiftKey: boolean; altKey: boolean; metaKey: boolean; ctrlKey: boolean; isComposing: boolean }> = {}) => ({ key, shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, ...extra });
const caret = (value: string, start: number, end = start) => ({ value, selectionStart: start, selectionEnd: end });

test("tabKeyStep: 빈 입력에서는 ←→ 가 탭을 바꾸고 양 끝에서는 돌지 않는다", () => {
  expect(tabKeyStep(arrow("ArrowRight"), caret("", 0), tabs, "all") === "sessions", "→");
  expect(tabKeyStep(arrow("ArrowLeft"), caret("", 0), tabs, "files") === "sessions", "←");
  expect(tabKeyStep(arrow("ArrowLeft"), caret("", 0), tabs, "all") === null, "첫 탭에서 ←");
  expect(tabKeyStep(arrow("ArrowRight"), caret("", 0), tabs, "prs") === null, "끝 탭에서 →");
  return "ok";
});

test("tabKeyStep: 글자가 있으면 커서가 처음이나 끝일 때만 탭을 바꾸고 글자 사이에서는 커서가 움직인다", () => {
  expect(tabKeyStep(arrow("ArrowRight"), caret("login", 5), tabs, "all") === "sessions", "끝에서 →");
  expect(tabKeyStep(arrow("ArrowRight"), caret("login", 2), tabs, "all") === null, "글자 사이에서 →");
  expect(tabKeyStep(arrow("ArrowLeft"), caret("login", 0), tabs, "files") === "sessions", "처음에서 ←");
  expect(tabKeyStep(arrow("ArrowLeft"), caret("login", 5), tabs, "files") === null, "끝에서 ← 는 커서 이동");
  expect(tabKeyStep(arrow("ArrowLeft"), caret("login", 3), tabs, "files") === null, "글자 사이에서 ←");
  return "ok";
});

test("tabKeyStep: 선택 영역, 수정키, 한글 조합 중, 다른 키는 탭을 바꾸지 않는다", () => {
  expect(tabKeyStep(arrow("ArrowRight"), caret("login", 0, 5), tabs, "all") === null, "선택 영역");
  for (const extra of [{ shiftKey: true }, { altKey: true }, { metaKey: true }, { ctrlKey: true }, { isComposing: true }]) expect(tabKeyStep(arrow("ArrowRight", extra), caret("", 0), tabs, "all") === null, JSON.stringify(extra));
  expect(tabKeyStep(arrow("ArrowDown"), caret("", 0), tabs, "all") === null && tabKeyStep(arrow("a"), caret("", 0), tabs, "all") === null, "다른 키");
  expect(tabKeyStep(arrow("ArrowRight"), { value: "ab", selectionStart: null, selectionEnd: null }, tabs, "all") === "sessions", "커서 정보가 없으면 끝으로 본다");
  expect(tabKeyStep(arrow("ArrowRight"), caret("", 0), tabs, "board") === null, "보이지 않는 탭에서는 아무것도 안 한다");
  return "ok";
});

test("parseSlash: / 만 치면 보이는 모든 유형, 낱말을 치면 그 낱말로 시작하는 유형", () => {
  const all = parseSlash("/", tabs);
  expect(all?.kind === "suggest" && all.tabs.join() === tabs.join(), "전부");
  const ses = parseSlash("/ses", tabs);
  expect(ses?.kind === "suggest" && ses.tabs.join() === "sessions", "/ses");
  const pr = parseSlash("/pull", tabs);
  expect(pr?.kind === "suggest" && pr.tabs.join() === "prs", "/pull 은 Pull Requests");
  const none = parseSlash("/zzz", tabs);
  expect(none?.kind === "suggest" && none.tabs.length === 0, "맞는 유형 없음");
  const hidden = parseSlash("/board", tabs);
  expect(hidden?.kind === "suggest" && hidden.tabs.length === 0, "보이지 않는 탭은 제안하지 않는다");
  return "ok";
});

test("parseSlash: 알려진 낱말 뒤의 공백은 그 유형으로 좁히고 나머지가 검색어, 모르는 낱말과 일반 글자는 null", () => {
  const scoped = parseSlash("/sessions login bug", tabs);
  expect(scoped?.kind === "scope" && scoped.tab === "sessions" && scoped.rest === "login bug", "scope");
  const empty = parseSlash("/files ", tabs);
  expect(empty?.kind === "scope" && empty.tab === "files" && empty.rest === "", "공백만");
  const alias = parseSlash("/pr fix", tabs);
  expect(alias?.kind === "scope" && alias.tab === "prs", "별칭");
  expect(parseSlash("/zzz fix", tabs) === null, "모르는 낱말");
  expect(parseSlash("/board x", tabs) === null, "보이지 않는 탭");
  expect(parseSlash("login /sessions", tabs) === null && parseSlash("", tabs) === null, "/ 로 시작하지 않음");
  return "ok";
});

test("visibleTabs: 데이터가 없는 탭은 숨기고 All 은 늘 있다", () => {
  expect(visibleTabs(base()).join() === "all,sessions,files,workspaces,prs,board,mentions", "전부 있음");
  const empty: SearchData = { ...base(), agents: [], workspaces: [], fileWorkspaceId: null, files: undefined, prs: [], cards: [], mentions: [] };
  expect(visibleTabs(empty).join() === "all", "All 만");
  const part: SearchData = { ...base(), prs: [], cards: [], mentions: [], files: [] };
  expect(visibleTabs(part).join() === "all,sessions,workspaces", "빈 파일 목록과 PR, 보드, 멘션 없음");
  expect(visibleTabs({ ...base(), files: undefined }).includes("files"), "파일을 읽는 중에는 Files 탭을 보인다");
  expect(!visibleTabs({ ...base(), workspaces: [workspaces[2], workspaces[3]] }).includes("workspaces"), "worktree 와 피드백 폴더는 Workspaces 가 아니다");
  return "ok";
});

test("searchGroups: All 은 입력이 있으면 유형별 묶음으로, 한 묶음은 최대 5개", () => {
  const groups = searchGroups(base(), "all", "login");
  expect(groups.map((g) => g.id).join() === "session,file,pr,card,mention", `묶음 ${groups.map((g) => g.id).join()}`);
  expect(titles(groups[0].rows).join() === "Fix login bug,Login redesign", `세션 ${titles(groups[0].rows).join()}`);
  expect(titles(groups[1].rows).join() === "login.ts,Login.tsx", `파일 ${titles(groups[1].rows).join()}`);
  const many: SearchData = { ...base(), agents: Array.from({ length: 9 }, (_, i) => agent(`s${i}`, `login ${i}`)) };
  expect(searchGroups(many, "all", "login")[0].rows.length === ALL_GROUP_CAP, "5개 상한");
  return "ok";
});

test("searchGroups: 탭을 고르면 그 유형의 묶음 하나만, 이름으로 거른다", () => {
  const sessions = searchGroups(base(), "sessions", "login");
  expect(sessions.length === 1 && sessions[0].id === "session" && sessions[0].rows.length === 2, "sessions");
  expect(searchGroups(base(), "sessions", "docs").map((g) => titles(g.rows).join()).join() === "Write docs", "폴더 이름도 맞는다");
  expect(titles(searchGroups(base(), "prs", "sidebar")[0].rows).join() === "Sidebar fix", "PR 제목");
  expect(titles(searchGroups(base(), "prs", "#3")[0].rows).join() === "Add login page", "PR 번호");
  expect(titles(searchGroups(base(), "board", "ui")[0].rows).join() === "Login polish,Other thing", "보드는 라벨도 맞는다");
  expect(titles(searchGroups(base(), "workspaces", "doc")[0].rows).join() === "docs", "폴더");
  expect(titles(searchGroups(base(), "mentions", "ann")[0].rows).join() === "@user please check login", "멘션은 보낸 사람으로도 찾고 제목은 슬랙 서식을 푼 글");
  expect(searchGroups(base(), "sessions", "zzzz").length === 0, "없으면 묶음 없음");
  return "ok";
});

test("searchGroups: 세션은 최근에 연 것이 앞, 나머지는 updatedAt 순", () => {
  const rows = flatRows(searchGroups(base(), "sessions", ""));
  expect(titles(rows).join() === "Refactor sidebar,Fix login bug,Write docs,Login redesign", titles(rows).join());
  return "ok";
});

test("searchGroups: Files 탭은 입력이 비면 이 폴더의 최근 파일(묶음 이름 Recent), 입력이 있으면 폴더 전체에서 찾는다", () => {
  const empty = searchGroups(base(), "files", "");
  expect(empty.length === 1 && empty[0].id === "recent" && titles(empty[0].rows).join() === "App.tsx", `비었을 때 ${titles(flatRows(empty)).join()}`);
  const typed = searchGroups(base(), "files", "app");
  expect(typed[0].id === "file" && typed[0].rows[0].kind === "file" && typed[0].rows[0].path === "src/App.tsx", "입력");
  expect(searchGroups({ ...base(), files: undefined }, "files", "app").length === 0, "아직 못 읽었으면 빈 목록");
  return "ok";
});

test("searchGroups: Workspaces 는 최상위 폴더만 세고 worktree 세션은 원 프로젝트에 합친다", () => {
  const rows = flatRows(searchGroups(base(), "workspaces", ""));
  expect(titles(rows).join() === "app,docs", titles(rows).join());
  expect(rows[0].aux === "3 sessions" && rows[1].aux === "1 session", `${rows[0].aux}, ${rows[1].aux}`);
  expect(rows[0].muted === "~/Repository/app", String(rows[0].muted));
  return "ok";
});

test("Recent: 입력이 비면 Recent 와 Actions 두 묶음, 최대 8개, 연 시각이 최근인 것부터", () => {
  const data: SearchData = { ...base(), stamps: { "session:a1": NOW - 1000, "file:w1:src/App.tsx": NOW - 5000, "pr:acme/app#8": NOW - 2000, "card:c1": NOW - 9000, "mention:m1": NOW - 500, "session:a2": NOW - 20_000 } };
  const groups = searchGroups(data, "all", "");
  expect(groups.map((g) => g.id).join() === "recent,action", groups.map((g) => g.id).join());
  expect(groups[0].rows.map((r) => r.key).join() === "mention:m1,session:a1,pr:acme/app#8,file:w1:src/App.tsx,card:c1,session:a2,file:w2:docs/intro.md", groups[0].rows.map((r) => r.key).join());
  expect(groups[1].rows.map((r) => r.key.replace("action:", "")).join() === DEFAULT_ACTIONS.join(), "기본 Actions");
  const crowded: SearchData = { ...base(), recentAgentIds: Array.from({ length: 12 }, (_, i) => `s${i}`), agents: Array.from({ length: 12 }, (_, i) => agent(`s${i}`, `t${i}`)) };
  expect(recentRows(crowded).length === RECENT_LIMIT, "8개 상한");
  return "ok";
});

test("Recent: 시각을 모르는 세션은 updatedAt, 시각을 모르는 파일은 목록 순서로 맨 아래, 기록 없는 PR 과 카드는 안 나온다", () => {
  const rows = recentRows(base());
  expect(rows.map((r) => r.key).join() === "session:a1,session:a2,file:w1:src/App.tsx,file:w2:docs/intro.md", rows.map((r) => r.key).join());
  expect(!rows.some((r) => r.kind === "pr" || r.kind === "card" || r.kind === "mention"), "기록 없음");
  return "ok";
});

test("Recent: 세션은 폴더와 시간, PR 은 번호, 둘 이상의 폴더가 있으면 파일에 폴더 이름이 붙는다", () => {
  const data: SearchData = { ...base(), stamps: { "pr:acme/app#3": NOW } };
  const rows = recentRows(data);
  const session = rows.find((r) => r.kind === "session");
  expect(session?.muted === "app" && session.aux === "10 mins ago", `세션 ${session?.muted} ${session?.aux}`);
  const prRow = rows.find((r) => r.kind === "pr");
  expect(prRow?.aux === "#3" && prRow.muted === "app", `PR ${prRow?.aux} ${prRow?.muted}`);
  const file = rows.find((r) => r.key === "file:w2:docs/intro.md");
  expect(file?.aux === "docs" && file.muted === "docs/" && file.title === "intro.md", `파일 ${file?.aux} ${file?.muted}`);
  return "ok";
});

test("noteStamp: 같은 키는 시각만 갱신하고 80개를 넘으면 가장 오래된 것부터 버린다", () => {
  let stamps: Record<string, number> = {};
  for (let i = 0; i < STAMP_LIMIT + 5; i++) stamps = noteStamp(stamps, `k${i}`, 1000 + i);
  expect(Object.keys(stamps).length === STAMP_LIMIT && !("k0" in stamps) && "k84" in stamps, `${Object.keys(stamps).length}개`);
  expect(noteStamp({ a: 1 }, "a", 9).a === 9, "갱신");
  return "ok";
});

test("Actions: 입력으로 이름을 거르고 단축키 키캡을 붙인다", () => {
  const found = searchGroups(base(), "all", "board").find((g) => g.id === "action");
  const row = found?.rows[0];
  expect(row?.kind === "action" && row.command === "openBoard" && row.keycaps.join(" ") === "⇧ ⌘ K", `Open Board ${row?.kind === "action" ? row.keycaps.join(" ") : ""}`);
  const create = searchGroups(base(), "all", "new session").find((g) => g.id === "action");
  expect(create?.rows[0].kind === "action" && create.rows[0].keycaps.join(" ") === "⌘ N", "New Session 은 ⌘N");
  expect(searchGroups(base(), "sessions", "board").length === 0, "Actions 는 All 탭에만");
  return "ok";
});

test("altLabel: 행 종류마다 ⌥↵ 의 이름이 다르고 보조 동작이 없는 행은 null", () => {
  const rows = flatRows([...searchGroups(base(), "all", "login"), ...searchGroups(base(), "all", "new session")]);
  const label = (kind: string) => altLabel(rows.find((r) => r.kind === kind)!);
  expect(label("session") === "Open in new pane" && label("file") === "Open to the side" && label("pr") === "Open on GitHub" && label("mention") === "Open in Slack", "labels");
  expect(label("card") === "Start session", "폴더가 있는 카드는 세션 시작");
  expect(altLabel(searchGroups({ ...base(), cards: [card("c9", "login x", null)] }, "board", "login")[0].rows[0]) === null, "폴더 없는 카드는 보조 동작 없음");
  expect(label("action") === null, "action");
  return "ok";
});

test("uniquePrs: 저장소와 번호로 겹침을 없애고 갱신이 최근인 순", () => {
  const a = pr(1, "one", "acme/app", "2026-10-01T00:00:00Z");
  const b = pr(2, "two", "acme/app", "2026-10-03T00:00:00Z");
  const list = { waiting: [a], assigned: [a, b], created: [], all: [b] };
  const out = uniquePrs({ "acme/app": { data: list }, "acme/other": { data: null } });
  expect(out.map((p) => p.number).join() === "2,1", out.map((p) => p.number).join());
  return "ok";
});

test("mentionItems 와 plainSlack: 보관한 항목은 빼고 최근 것이 앞, 슬랙 서식은 글로", () => {
  const items = [mention("a", "old", { time: minutesAgo(50) }), mention("b", "new", { time: minutesAgo(2) }), mention("c", "gone", { archived: true })];
  expect(mentionItems(items).map((i) => i.id).join() === "b,a" && mentionItems(undefined).length === 0, "정렬과 보관");
  expect(plainSlack("<@U1> see <https://x.dev/a|the doc>  now <#C1>") === "@user see the doc now #C1", plainSlack("<@U1> see <https://x.dev/a|the doc>  now <#C1>"));
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
