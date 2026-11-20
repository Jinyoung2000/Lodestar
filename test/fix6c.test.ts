// 6회차 묶음 C(FIX6C)의 순수 로직: 바쁜 세션 판정, 복원 토스트 개수, 첨부 키, 핸드오프 칩 저장, 단축키 목록, 변경 거터, 문제 목록, 칸 폭. 실행: npm test
import { Text } from "@codemirror/state";
import type { Agent } from "../shared/protocol";
import { isBusyAgent } from "../shared/agentBusy";
import { restoreToastText } from "../web/checkpointToast";
import { attachmentKey } from "../web/composerState";
import { gutterMarks } from "../web/changeGutter";
import { BINDINGS } from "../web/keymap";
import { groupProblems, countProblems, severityOf } from "../web/problemsModel";
import { stretchedMin, panesMinWidth } from "../web/paneFit";
import { categoryOf, filterShortcuts, groupByCategory, shortcutRows, strokeLabel } from "../web/shortcutList";
import { restoreHandoffs, sanitizeExtras, snapshotHandoffs } from "../web/windowState";
import { busyAgents, removeFolder, type FolderState } from "../server/removedFolders";

const cases: { name: string; run: () => string }[] = [];
const test = (name: string, run: () => string) => cases.push({ name, run });
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
  return detail;
};
const same = (actual: unknown, wanted: unknown, label: string) => {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(wanted);
  if (a !== b) throw new Error(`${label}: ${a} != ${b}`);
};

const NOW = "2026-10-16T00:00:00.000Z";
const agent = (id: string, workspaceId: string, patch: Partial<Agent> = {}): Agent => ({ id, workspaceId, cwd: "/tmp", worktree: null, forkedFrom: null, resumeFrom: null, startCommit: null, feedbackId: null, title: id, sessionId: id, status: "idle", permissionMode: "default", model: null, effort: null, activeModel: null, activeEffort: null, backgroundTasks: 0, createdAt: NOW, updatedAt: NOW, ...patch });

// --- 발견 3: 바쁜 세션 판정 ---

test("isBusyAgent: running, waiting, 백그라운드 작업이 남은 idle 만 바쁘다. error 는 CLI 가 죽었으니 아니다", () => {
  expect(isBusyAgent({ status: "running", backgroundTasks: 0 }), "running");
  expect(isBusyAgent({ status: "waiting", backgroundTasks: 0 }), "waiting");
  expect(isBusyAgent({ status: "idle", backgroundTasks: 2 }), "idle + background");
  expect(!isBusyAgent({ status: "idle", backgroundTasks: 0 }), "idle");
  expect(!isBusyAgent({ status: "error", backgroundTasks: 0 }), "error");
  expect(!isBusyAgent({ status: "error", backgroundTasks: 3 }), "error 는 남은 백그라운드 수도 무시");
  return "5 cases";
});

test("removeFolder: 사라진 폴더에서 error 로 끝난 세션만 있으면 제거가 거절되지 않고 숨겨진다", () => {
  const state: FolderState = {
    workspaces: [{ id: "w1", dir: "/tmp/gone", name: "gone", parentId: null } as never],
    agents: [agent("a1", "w1", { status: "error" }), agent("a2", "w1")],
  };
  expect(busyAgents(state.agents).length === 0, "바쁜 세션 0");
  const result = removeFolder(state, "w1");
  expect(result.hidden === 2 && state.agents.length === 0 && state.removed?.length === 1, `hidden ${result.hidden}`);
  return "hidden 2";
});

test("removeFolder: 도는 세션이 하나라도 있으면 그대로 거절한다", () => {
  const state: FolderState = { workspaces: [{ id: "w1", dir: "/tmp/x", name: "x", parentId: null } as never], agents: [agent("a1", "w1", { status: "running" }), agent("a2", "w1", { status: "error" })] };
  let message = "";
  try {
    removeFolder(state, "w1");
  } catch (error) {
    message = (error as Error).message;
  }
  expect(message.length > 0 && state.agents.length === 2, `message ${message}`);
  return "rejected";
});

// --- 발견 13: 복원 토스트 개수 ---

test("restoreToastText: 확인 창의 되돌림 2, 휴지통 1 이 토스트에도 그대로 나온다", () => {
  const text = restoreToastText({ files: 3, reverted: 2, removed: 1 });
  expect(text.startsWith("2 files restored, 1 moved to the Trash"), text);
  return text;
});

test("restoreToastText: reverted 가 없으면 files 에서 휴지통 수를 뺀다. 휴지통만 있으면 그 문장", () => {
  expect(restoreToastText({ files: 3, removed: 1 }).startsWith("2 files restored, 1 moved"), "fallback");
  expect(restoreToastText({ files: 1, reverted: 0, removed: 1 }).startsWith("1 file moved to the Trash"), "trash only");
  expect(restoreToastText({ files: 1, reverted: 1 }).startsWith("1 file restored."), "no trash");
  return "3 cases";
});

// --- 발견 10: 첨부는 세션 id 에 묶인다 ---

test("attachmentKey: 세션이 열린 칸은 세션 id, 새 세션 화면은 new:<칸 id>", () => {
  const panes = [
    { id: "pane-1", kind: "draft" },
    { id: "pane-2", kind: "agent", agentId: "sess-B" },
  ];
  expect(attachmentKey(panes, "pane-1") === "new:pane-1", "draft");
  expect(attachmentKey(panes, "pane-2") === "sess-B", "agent");
  expect(attachmentKey(panes, "pane-9") === "new:pane-9", "없는 칸");
  return "ok";
});

test("attachmentKey: 같은 칸 id 에 다른 세션이 들어와도 앞 칸의 첨부 키와 겹치지 않는다(⇧⌘T 시나리오)", () => {
  const before = [{ id: "pane-1", kind: "draft" }];
  const handoffKey = attachmentKey(before, "pane-1");
  const after = [{ id: "pane-1", kind: "agent", agentId: "sess-B" }];
  expect(attachmentKey(after, "pane-1") !== handoffKey, "B 의 키는 핸드오프 칩이 든 키와 다르다");
  return `${handoffKey} -> ${attachmentKey(after, "pane-1")}`;
});

// --- 발견 20: 핸드오프 칩 저장 ---

test("snapshotHandoffs 와 restoreHandoffs: 문서가 다 만들어진 칩만 저장하고 같은 모양으로 되살린다", () => {
  const ready = { id: "c1", workspaceId: "w1", text: "doc", handoff: { sourceId: "s1", title: "Do it", status: "ready", id: "h1" } };
  const generating = { id: "c2", workspaceId: "w1", text: null, handoff: { sourceId: "s1", title: "Do it", status: "generating", id: null } };
  const file = { id: "c3", workspaceId: "w1", text: "x" };
  const saved = snapshotHandoffs({ "new:pane-1": [ready, generating, file], other: [file] });
  same(Object.keys(saved), ["new:pane-1"], "키");
  expect(saved["new:pane-1"].length === 1 && saved["new:pane-1"][0].docId === "h1", "ready 하나");
  const json = JSON.stringify({ handoffs: saved });
  const extras = sanitizeExtras(JSON.parse(json));
  const restored = restoreHandoffs(extras.handoffs, new Set(["pane-1"]));
  expect(restored["new:pane-1"][0].handoff.status === "ready" && restored["new:pane-1"][0].text === "doc" && restored["new:pane-1"][0].id === "c1", "되살림");
  expect(Object.keys(restoreHandoffs(extras.handoffs, new Set(["pane-7"]))).length === 0, "없어진 칸의 것은 안 되살린다");
  return "ok";
});

test("sanitizeExtras: handoffs 의 깨진 항목은 버린다", () => {
  const extras = sanitizeExtras({ handoffs: { "new:pane-1": [{ id: "c", sourceId: "s", title: "t", docId: "d", text: "x" }, { id: 3 }, null], bad: "x" } });
  expect(extras.handoffs["new:pane-1"].length === 1 && !("bad" in extras.handoffs), JSON.stringify(extras.handoffs));
  return "ok";
});

// --- 발견 11: 단축키 목록 ---

test("shortcutRows: 단축키 표(BINDINGS)의 모든 명령(escape 제외)이 이름과 범주와 함께 한 줄씩 나온다", () => {
  const rows = shortcutRows();
  const commands = new Set(BINDINGS.map((b) => b.command));
  commands.delete("escape");
  expect(rows.length === commands.size, `행 ${rows.length}, 명령 ${commands.size}`);
  expect(rows.every((r) => r.keys.length > 0 && r.title && r.category), "키, 이름, 범주");
  expect(new Set(rows.map((r) => r.command)).size === rows.length, "명령 중복 없음");
  return `${rows.length} rows`;
});

test("shortcutRows: 새 단축키를 표에 더하면 목록에 바로 나온다(문서와 어긋나지 않는다)", () => {
  const extra = [...BINDINGS, { keys: ["Alt+Meta+KeyZ"] as [string], command: "save" }];
  const save = shortcutRows(extra).find((r) => r.command === "save");
  expect(!!save && save.keys.length === 2, JSON.stringify(save?.keys));
  return "save 키 2개";
});

test("strokeLabel: 수정키는 기호로 붙이고 키 이름은 앱의 다른 곳과 같은 기호 규칙(⇧⌘K, ⌘↵)", () => {
  same(strokeLabel("Shift+Meta+KeyK"), "⇧⌘K", "사이드바");
  same(strokeLabel("Meta+Enter"), "⌘↵", "승인 카드");
  same(strokeLabel("Alt+Meta+Enter"), "⌥⌘↵", "Skip");
  same([strokeLabel("Meta+Period"), strokeLabel("Meta+Slash"), strokeLabel("Meta+Backslash"), strokeLabel("Meta+Digit0"), strokeLabel("F8"), strokeLabel("Ctrl+Meta+ArrowLeft")], ["⌘.", "⌘/", "⌘\\", "⌘0", "F8", "⌃⌘←"], "기호");
  return "ok";
});

test("shortcutRows: chord 는 단계마다 붙인 글자 하나(⌘K ⌘F), 단계 사이는 별개 항목. 키 이름도 검색된다", () => {
  const rows = shortcutRows();
  const by = (command: string) => rows.find((r) => r.command === command);
  same(by("formatSelection")?.keys, [["⌘K", "⌘F"]], "chord");
  same(by("quickFix")?.keys, [["⌘."]], "Period");
  same(by("acceptTool")?.keys, [["⌘↵"]], "Enter");
  same(by("zoomIn")?.keys, [["⌘="], ["⇧⌘="], ["⌘NumPad+"]], "여러 키");
  expect(filterShortcuts(rows, "period").some((r) => r.command === "quickFix"), "period");
  expect(filterShortcuts(rows, "enter").some((r) => r.command === "acceptTool"), "enter");
  expect(rows.every((r) => r.keys.flat().every((step) => step.length > 0 && !step.includes(" "))), "단계 글자에 공백 없음");
  return "ok";
});

test("shortcutRows: 웹 접속(desktop false)에서는 앱 전용(electron) 키만 가진 명령이 빠진다", () => {
  const web = shortcutRows(undefined, { desktop: false });
  expect(!web.some((r) => r.command === "zoomIn"), "zoomIn 없음");
  expect(shortcutRows(undefined, { desktop: true }).some((r) => r.command === "zoomIn"), "앱에서는 있음");
  return "ok";
});

test("filterShortcuts: 이름, 범주, 키 이름(cmd, shift)으로 찾고 입력이 비면 전부", () => {
  const rows = shortcutRows();
  expect(filterShortcuts(rows, "").length === rows.length, "빈 입력");
  expect(filterShortcuts(rows, "keyboard shortcuts").some((r) => r.command === "keyboardShortcuts"), "이름");
  expect(filterShortcuts(rows, "terminal").every((r) => r.search.includes("terminal")), "범주");
  const byKey = filterShortcuts(rows, "shift cmd p");
  expect(byKey.some((r) => r.command === "commandPalette"), "키 이름");
  expect(filterShortcuts(rows, "zzzzzz").length === 0, "없는 말");
  return `shift cmd p -> ${byKey.length}`;
});

test("keyboardShortcuts: ⌘K ⌘S 로 열리고 목록에 자기 자신도 있다", () => {
  const binding = BINDINGS.find((b) => b.command === "keyboardShortcuts");
  same(binding?.keys, ["Meta+KeyK", "Meta+KeyS"], "chord");
  expect(shortcutRows().some((r) => r.command === "keyboardShortcuts"), "목록");
  return "ok";
});

test("categoryOf 와 groupByCategory: 이름 앞의 범주, 없으면 General 이 맨 앞", () => {
  expect(categoryOf("Agents: New Session") === "Agents" && categoryOf("Go to File...") === "General", "범주");
  const groups = groupByCategory(shortcutRows());
  expect(groups[0].category === "General", `첫 범주 ${groups[0].category}`);
  expect(new Set(groups.map((g) => g.category)).size === groups.length, "범주가 한 번씩만");
  return groups.map((g) => g.category).join(", ");
});

// --- 발견 18: 변경 거터와 문제 목록 ---

const lines = (text: string) => Text.of(text.split("\n"));

test("gutterMarks: 추가, 수정, 삭제 줄을 현재 문서의 줄 번호로 돌려준다", () => {
  const base = lines("a\nb\nc\nd\ne");
  same(gutterMarks(base, lines("a\nb\nc\nd\ne")), [], "같음");
  same(gutterMarks(base, lines("a\nb\nNEW\nc\nd\ne")), [{ line: 3, kind: "added" }], "추가");
  same(gutterMarks(base, lines("a\nB\nc\nd\ne")), [{ line: 2, kind: "modified" }], "수정");
  same(gutterMarks(base, lines("a\nb\nd\ne")), [{ line: 3, kind: "removed" }], "삭제는 지운 자리 아래 줄");
  return "4 cases";
});

test("gutterMarks: 여러 덩어리와 문서 끝 삭제", () => {
  // 파일은 보통 줄바꿈으로 끝나서 문서의 마지막 줄이 빈 줄이다
  const base = lines("1\n2\n3\n4\n5\n6\n");
  const marks = gutterMarks(base, lines("1\nTWO\n3\n4\n5\n6\n7\n"));
  same(marks, [{ line: 2, kind: "modified" }, { line: 7, kind: "added" }], "수정과 끝 추가");
  const tail = gutterMarks(base, lines("1\n2\n3\n"));
  expect(tail.length === 1 && tail[0].kind === "removed", JSON.stringify(tail));
  return "ok";
});

test("severityOf 와 groupProblems: 파일은 경로순, 문제는 줄순, 줄과 열은 1부터", () => {
  same([severityOf(1), severityOf(2), severityOf(3), severityOf(4), severityOf(undefined)], ["error", "warning", "info", "hint", "error"], "심각도");
  const d = (line: number, character: number, message: string, severity?: number) => ({ range: { start: { line, character }, end: { line, character: character + 1 } }, message, severity });
  const files = groupProblems([
    { workspaceId: "w", path: "src/b.ts", diagnostics: [d(9, 4, "late", 2), d(1, 0, "early", 1)] },
    { workspaceId: "w", path: "src/a.ts", diagnostics: [d(0, 0, "x", 1)] },
    { workspaceId: "w", path: "src/c.ts", diagnostics: [] },
  ]);
  same(files.map((f) => f.path), ["src/a.ts", "src/b.ts"], "빈 파일은 뺀다");
  same(files[1].rows.map((r) => [r.line, r.column, r.message]), [[2, 1, "early"], [10, 5, "late"]], "줄순");
  same(countProblems(files), { errors: 2, warnings: 1, total: 3 }, "개수");
  return "ok";
});

// --- 발견 14: 칸 폭 ---

test("stretchedMin: 칸이 모두 최소 폭 이상으로 들어가면 늘리지 않는다(스크롤 없이 나눠 갖는다)", () => {
  let checked = 0;
  for (let region = 1; region <= 3000; region++) {
    for (const cols of [1, 2, 3, 4, 5]) {
      if (panesMinWidth([cols], 360) <= region) {
        expect(stretchedMin(360, region, [cols]) === 360, `region ${region} cols ${cols} 가 늘어남`);
        checked++;
      }
    }
  }
  return `${checked} combinations`;
});

test("stretchedMin: 6회차 발견 14 의 수치. 679 에 칸 둘은 721 이 필요해 안 들어가므로 한 칸씩, 721 부터는 360 씩", () => {
  expect(panesMinWidth([2], 360) === 721, "칸 둘의 최소 폭");
  expect(stretchedMin(360, 679, [2]) === 679, "679");
  expect(stretchedMin(360, 720, [2]) === 720, "720");
  expect(stretchedMin(360, 721, [2]) === 360, "721");
  return "679 -> 679, 720 -> 720, 721 -> 360";
});

let failed = 0;
for (const c of cases) {
  try {
    console.log(`ok   ${c.name}: ${c.run()}`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${c.name}: ${(error as Error).message}`);
  }
}
if (failed) {
  console.log(`${failed} failed`);
  process.exit(1);
}
console.log(`${cases.length} passed`);
