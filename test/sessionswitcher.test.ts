import type { Agent, Workspace } from "../shared/protocol";
import { BINDINGS, INTERCEPT_STROKES, stepKey, type KeyContext } from "../web/keymap";
import { SESSION_SWITCHER_MAX, openSwitcher, pushRecent, reduceSwitcher, switcherSessions, type SwitcherEvent, type SwitcherState } from "../web/sessionSwitcherModel";

const cases: { name: string; run: () => string }[] = [];
const test = (name: string, run: () => string) => cases.push({ name, run });
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
  return detail;
};

const agent = (id: string, patch: Partial<Agent> = {}): Agent => ({ id, workspaceId: "w1", cwd: "/r", worktree: null, forkedFrom: null, resumeFrom: null, startCommit: null, feedbackId: null, title: `Session ${id}`, sessionId: null, status: "idle", permissionMode: "default", model: null, effort: null, activeModel: null, activeEffort: null, backgroundTasks: 0, createdAt: "", updatedAt: "", ...patch });
const workspaces = [{ id: "w1", name: "repo", dir: "/r" }] as unknown as Workspace[];
const ids = (rows: { id: string }[]) => rows.map((r) => r.id).join(",");
const rowsOf = (agents: Agent[], recentIds: string[], activeAgentId: string | null, openIds: string[] = []) => switcherSessions({ agents, workspaces, recentIds, openIds, activeAgentId });
const a = ["a", "b", "c", "d"].map((id) => agent(id));

test("MRU: 포커스한 세션이 맨 앞으로 오고 12개를 넘으면 오래된 쪽을 자른다", () => {
  let list: string[] = [];
  for (const id of ["a", "b", "c", "a"]) list = pushRecent(list, id, 12);
  expect(list.join(",") === "a,c,b", `a,b,c 다음 a 를 다시 포커스: ${list.join(",")}`);
  expect(pushRecent(list, "a", 12) === list, "맨 앞이 이미 그 세션이면 같은 배열");
  const many = Array.from({ length: 15 }, (_, i) => `s${i}`).reduce<string[]>((acc, id) => pushRecent(acc, id, SESSION_SWITCHER_MAX), []);
  expect(many.length === 12 && many[0] === "s14" && many[11] === "s3", `12개 절단: ${many[0]}..${many[11]}`);
  return "a,c,b / 12개";
});

test("목록: 현재 세션이 맨 앞, 그 뒤로 최근 포커스 순서", () => {
  const rows = rowsOf(a, ["c", "a", "d", "b"], "a");
  expect(ids(rows) === "a,c,d,b", ids(rows));
  expect(rows[0].current && !rows[1].current, "현재 표시는 첫 행만");
  return ids(rows);
});

test("목록: 기록이 비어도 칸에 열린 세션이 따라온다(첫 실행, 새로고침 직후)", () => {
  const rows = rowsOf(a, [], "b", ["a", "b", "c"]);
  expect(ids(rows) === "b,a,c,d", ids(rows));
  return ids(rows);
});

test("목록: 한 번도 연 적 없는 세션은 기록 뒤에 최근 활동(updatedAt) 순으로 12개까지 채운다", () => {
  const many = Array.from({ length: 20 }, (_, i) => agent(`s${String(i).padStart(2, "0")}`, { updatedAt: `2026-10-${String(i + 1).padStart(2, "0")}T00:00:00Z` }));
  const rows = rowsOf(many, ["s03", "s01"], "s05", ["s07"]);
  expect(ids(rows) === "s05,s03,s01,s07,s19,s18,s17,s16,s15,s14,s13,s12", ids(rows));
  const fresh = rowsOf(many.slice(0, 4), [], null);
  expect(ids(fresh) === "s03,s02,s01,s00", ids(fresh));
  const skipped = rowsOf([agent("a", { updatedAt: "2026-10-01" }), agent("b", { updatedAt: "2026-10-03", done: true }), agent("c", { updatedAt: "2026-10-04", feedbackId: "f1" }), agent("d", { updatedAt: "2026-10-02" })], ["a"], "a");
  expect(ids(skipped) === "a,d", ids(skipped));
  return "채움";
});

test("목록: 보관(done), 지워진 세션, 피드백 개선 세션은 빠진다. 현재 세션은 보관했어도 남는다", () => {
  const withDone = [agent("a"), agent("b", { done: true }), agent("c", { feedbackId: "f1" }), agent("e")];
  const rows = rowsOf(withDone, ["a", "b", "ghost", "c", "e"], "a");
  expect(ids(rows) === "a,e", ids(rows));
  const currentDone = rowsOf([agent("a", { done: true }), agent("b")], ["b"], "a");
  expect(ids(currentDone) === "a,b" && currentDone[0].current, ids(currentDone));
  return "a,e";
});

test("목록: 최대 12개, 상태와 폴더와 브랜치를 싣는다", () => {
  const many = Array.from({ length: 20 }, (_, i) => agent(`s${i}`));
  expect(rowsOf(many, many.map((x) => x.id), "s0").length === 12, "12개");
  const wt = rowsOf([agent("a", { status: "running", unread: true, worktree: { root: "/r.worktrees/x", branch: "feat/x", base: "main" } }), agent("q", { workspaceId: null })], ["a", "q"], "q");
  const row = wt.find((r) => r.id === "a")!;
  expect(row.status === "running" && row.unread && row.branch === "feat/x" && row.folder === "repo", JSON.stringify(row));
  expect(wt.find((r) => r.id === "q")!.folder === "Chats", "폴더 없는 세션은 Chats");
  return "ok";
});

test("첫 선택: 열면 두 번째 항목(직전 세션), 뒤로 열면 마지막", () => {
  const rows = rowsOf(a, ["a", "b", "c", "d"], "a");
  expect(openSwitcher(rows, 1, true)?.index === 1, "앞으로 열기는 둘째");
  expect(openSwitcher(rows, -1, true)?.index === 3, "뒤로 열기는 마지막");
  const opened = openSwitcher(rows, 1, true)!;
  expect(!opened.visible && opened.hold, "열린 직후는 보이지 않고 키를 누른 채 쓰는 모드");
  return "1 / 3";
});

test("첫 선택: 현재 세션이 목록에 없으면(새 세션 화면) 첫 행이 직전 세션, 갈 곳이 없으면 열지 않는다", () => {
  const draftActive = rowsOf(a, ["b", "a"], null);
  expect(openSwitcher(draftActive, 1, true)?.index === 0, "현재 없음이면 0 번");
  expect(openSwitcher(rowsOf([a[0]], ["a"], "a"), 1, true) === null, "세션이 현재 것 하나뿐이면 열지 않는다");
  expect(openSwitcher([], 1, true) === null, "빈 목록");
  expect(openSwitcher(rowsOf(a, ["a"], null), 1, true)?.index === 0, "현재 없음에 세션 하나면 그 세션");
  return "ok";
});

const play = (state: SwitcherState | null, events: SwitcherEvent[]) => {
  let current = state;
  const actions: string[] = [];
  for (const event of events) {
    const next = reduceSwitcher(current, event);
    current = next.state;
    if (next.action) actions.push(next.action.kind === "commit" ? `commit:${next.action.id}` : "close");
  }
  return { state: current, actions };
};
const opened = () => openSwitcher(rowsOf(a, ["a", "b", "c", "d"], "a"), 1, true)!;

test("상태 기계: 탭을 반복하면 순환하고 ⌃ 를 떼면 고른 세션으로 간다", () => {
  const r = play(opened(), [{ type: "step", delta: 1 }, { type: "step", delta: 1 }, { type: "controlUp" }]);
  expect(r.actions.join() === "commit:d" && r.state === null, `${r.actions.join()} (b, c, d 순서)`);
  const wrap = play(opened(), [{ type: "step", delta: 1 }, { type: "step", delta: 1 }, { type: "step", delta: 1 }, { type: "controlUp" }]);
  expect(wrap.actions.join() === "commit:a", `끝에서 처음으로: ${wrap.actions.join()}`);
  return "d / a";
});

test("상태 기계: 빨리 눌렀다 떼면 창을 보이지 않고 직전 세션으로 간다", () => {
  const r = play(opened(), [{ type: "controlUp" }]);
  expect(r.actions.join() === "commit:b", r.actions.join());
  const shown = play(opened(), [{ type: "show" }]);
  expect(shown.state?.visible === true, "show 가 오면 보인다");
  return "commit:b";
});

test("상태 기계: Shift+Tab 과 ↑ 는 위로, ↓ 는 아래로", () => {
  const up = play(opened(), [{ type: "step", delta: 1 }, { type: "step", delta: -1 }, { type: "controlUp" }]);
  expect(up.actions.join() === "commit:b", `위로: ${up.actions.join()}`);
  const wrap = play(opened(), [{ type: "step", delta: -1 }, { type: "step", delta: -1 }, { type: "controlUp" }]);
  expect(wrap.actions.join() === "commit:d", `첫 행에서 위로는 마지막: ${wrap.actions.join()}`);
  return "ok";
});

test("상태 기계: Esc 와 창 포커스 잃기는 취소, 클릭과 Enter 는 확정", () => {
  expect(play(opened(), [{ type: "step", delta: 1 }, { type: "escape" }, { type: "controlUp" }]).actions.join() === "close", "Esc 뒤 ⌃ 떼기는 아무 일도 없다");
  expect(play(opened(), [{ type: "blur" }]).actions.join() === "close", "blur 는 취소");
  expect(play(opened(), [{ type: "pick", index: 3 }]).actions.join() === "commit:d", "클릭");
  expect(play(opened(), [{ type: "step", delta: 1 }, { type: "enter" }]).actions.join() === "commit:c", "Enter");
  return "ok";
});

test("상태 기계: ⌃ 없이 눌린 키는 keyup 을 놓친 것으로 보고 확정하고, 팔레트로 연 창은 ⌃ 를 떼도 닫히지 않는다", () => {
  expect(play(opened(), [{ type: "keyDown", ctrlKey: false }]).actions.join() === "commit:b", "보험");
  expect(play(opened(), [{ type: "keyDown", ctrlKey: true }]).actions.length === 0, "⌃ 를 누른 채 다른 키는 그대로");
  const palette = openSwitcher(rowsOf(a, ["a", "b", "c", "d"], "a"), 1, false)!;
  const r = play(palette, [{ type: "controlUp" }, { type: "keyDown", ctrlKey: false }]);
  expect(r.actions.length === 0 && r.state !== null, "hold 가 아니면 keyup 으로 확정하지 않는다");
  expect(play(palette, [{ type: "step", delta: 1 }, { type: "enter" }]).actions.join() === "commit:c", "Enter 로 확정");
  expect(play(null, [{ type: "controlUp" }]).actions.length === 0, "닫힌 뒤의 이벤트는 무시");
  return "ok";
});

const base: KeyContext = { inTerminal: false, inEditor: false };
const verdict = (stroke: string, ctx: KeyContext) => {
  const step = stepKey(null, stroke, ctx, 0);
  return step.kind === "run" ? step.command : step.kind;
};

test("키 표: 에디터 안은 탭 전환, 그 밖은 세션 전환 창", () => {
  expect(verdict("Ctrl+Tab", { ...base, inEditor: true, inEditorArea: true }) === "cycleRecentEditor", "에디터 본문");
  expect(verdict("Ctrl+Tab", { ...base, inEditorArea: true }) === "cycleRecentEditor", "에디터 영역(탭줄)");
  expect(verdict("Ctrl+Shift+Tab", { ...base, inEditorArea: true }) === "cycleRecentEditorBack", "에디터 영역 역방향");
  for (const [name, ctx] of [["메모 편집기(.cm-editor 지만 에디터 그룹 밖)", { ...base, inEditor: true }], ["대화", { ...base, inChat: true }], ["입력창", { ...base, inChat: true, inComposer: true }], ["밖", base], ["터미널", { ...base, inTerminal: true }], ["포커스 모드 입력창", { ...base, inChat: true, inComposer: true, inFocusLayout: true }], ["포커스 모드 사이드바", { ...base, inFocusLayout: true }]] as const) {
    expect(verdict("Ctrl+Tab", ctx) === "sessionSwitcher" && verdict("Ctrl+Shift+Tab", ctx) === "sessionSwitcherBack", `${name}: ${verdict("Ctrl+Tab", ctx)}`);
  }
  return "ok";
});

test("키 표: ⌃Tab 은 Electron 메인이 가로채지 않아 ⌃ 를 떼는 keyup 이 페이지에 온다(메인 변경 없음)", () => {
  expect(!INTERCEPT_STROKES.has("Ctrl+Tab") && !INTERCEPT_STROKES.has("Ctrl+Shift+Tab"), "가로채기 집합에 없음");
  expect(!BINDINGS.some((b) => b.command === "focusPaneNext" || b.command === "focusPanePrev"), "칸 이동은 팔레트 명령으로만");
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
