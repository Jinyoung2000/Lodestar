// DIFFFB: diff 줄 피드백의 순수 계산(shared/diffFeedback.ts, server/diffFeedback.ts, web/diffFeedbackEditor.ts 의 덩어리 변환) 단독 시험.
// 실행: npm test
import { Chunk } from "@codemirror/merge";
import { Text } from "@codemirror/state";
import type { DiffFeedback } from "../shared/protocol";
import { chipText, chunksToLineChanges, feedbackChip, FEEDBACK_HEADER, FEEDBACK_INSTRUCTION, formatFeedbackPrompt, groupChanges, groupForPills, hunksForRange, lineRangeLabel } from "../shared/diffFeedback";
import { createFeedback, markSubmitted, pendingFeedback, queuedExtras, restageFeedback, shownOf, trimFeedback } from "../server/diffFeedback";

const cases: { name: string; run: () => Promise<void> | void }[] = [];
const test = (name: string, run: () => Promise<void> | void) => cases.push({ name, run });
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
};
const eq = (actual: unknown, expected: unknown, label: string) => expect(JSON.stringify(actual) === JSON.stringify(expected), `${label}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);

const lines = (n: number, prefix = "line") => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);
const changesOf = (before: string, after: string) => chunksToLineChanges(Chunk.build(Text.of(before.split("\n")), Text.of(after.split("\n"))), Text.of(before.split("\n")), Text.of(after.split("\n")));

test("덩어리를 줄 범위로: 바뀐 줄, 추가만, 삭제만", () => {
  const before = lines(10).join("\n");
  const after = lines(10).map((l) => (l === "line4" ? "LINE4" : l)).join("\n");
  eq(changesOf(before, after), [{ origStart: 4, origEnd: 5, modStart: 4, modEnd: 5 }], "한 줄 바뀜");
  const added = [...lines(10).slice(0, 5), "new", ...lines(10).slice(5)].join("\n");
  eq(changesOf(before, added), [{ origStart: 6, origEnd: 6, modStart: 6, modEnd: 7 }], "추가만(기준 쪽 범위가 비어 있다)");
  const removed = lines(10).filter((l) => l !== "line8").join("\n");
  eq(changesOf(before, removed), [{ origStart: 8, origEnd: 9, modStart: 8, modEnd: 8 }], "삭제만(현재 쪽 범위가 비어 있다)");
});

test("묶기: 앞 변경 끝에서 3줄 안에 다음 변경이 시작하면 한 묶음", () => {
  const near = groupChanges([
    { origStart: 2, origEnd: 3, modStart: 2, modEnd: 3 },
    { origStart: 8, origEnd: 9, modStart: 8, modEnd: 9 },
  ]);
  eq(near.length, 1, "사이 4줄이면 문맥이 겹쳐 한 묶음");
  const far = groupChanges([
    { origStart: 2, origEnd: 3, modStart: 2, modEnd: 3 },
    { origStart: 12, origEnd: 13, modStart: 12, modEnd: 13 },
  ]);
  eq(far.length, 2, "멀면 둘");
});

test("hunk: 변경 앞뒤 3줄 문맥과 헤더, - 와 + 줄", () => {
  const before = lines(12).join("\n");
  const after = lines(12).map((l) => (l === "line6" ? "SIX" : l)).join("\n");
  const hunk = hunksForRange({ startLine: 6, startColumn: 1, endLine: 6, endColumn: 6 }, changesOf(before, after), before, after);
  eq(hunk, ["@@ -3,7 +3,7 @@", " line3", " line4", " line5", "-line6", "+SIX", " line7", " line8", " line9"].join("\n"), "hunk 본문");
});

test("hunk: 선택이 변경을 통째로 품을 때만, caret 은 그 줄을 품은 묶음", () => {
  const before = lines(30).join("\n");
  const after = lines(30).map((l) => (l === "line5" ? "FIVE" : l === "line20" ? "TWENTY" : l)).join("\n");
  const changes = changesOf(before, after);
  const range = (a: number, b: number, c = 1, d = 1) => ({ startLine: a, startColumn: c, endLine: b, endColumn: d });
  expect(hunksForRange(range(1, 8), changes, before, after)?.includes("+FIVE") === true, "5 번 줄을 품은 선택");
  expect(!hunksForRange(range(1, 8), changes, before, after)?.includes("TWENTY"), "20 번 줄은 선택 밖이라 빠진다");
  expect(hunksForRange(range(6, 8), changes, before, after) === undefined, "변경을 품지 않은 선택은 hunk 가 없다");
  expect(hunksForRange(range(5, 5, 2, 2), changes, before, after)?.includes("+FIVE") === true, "caret 은 그 줄의 묶음");
  const both = hunksForRange(range(1, 25), changes, before, after) ?? "";
  expect(both.includes("+FIVE") && both.includes("+TWENTY") && both.split("@@ -").length === 3, "두 묶음 모두");
});

test("hunk: 끝에 줄바꿈이 없으면 No newline 표지가 붙는다", () => {
  const before = "a\nb\nc";
  const after = "a\nB\nc";
  const hunk = hunksForRange({ startLine: 2, startColumn: 1, endLine: 2, endColumn: 2 }, changesOf(before, after), before, after) ?? "";
  expect(hunk.includes("\\ No newline at end of file"), hunk);
});

test("프롬프트: 번들 ADs 와 같은 머리, 줄 범위, Selection, Diff Hunks, Comment (user)", () => {
  const item: DiffFeedback = { id: "1", path: "/w/src/a.ts", rel: "src/a.ts", startLine: 3, startColumn: 1, endLine: 5, endColumn: 4, text: "rename this", codeSelection: "const a = 1;", diffHunks: "@@ -1 +1 @@\n-x\n+y", state: "accepted", createdAt: "2026-10-15T00:00:00Z" };
  const plain: DiffFeedback = { ...item, id: "2", startLine: 9, endLine: 9, text: "why?", codeSelection: undefined, diffHunks: undefined };
  const prompt = formatFeedbackPrompt("", [item, plain]);
  expect(prompt.startsWith(`${FEEDBACK_INSTRUCTION}\n\n${FEEDBACK_HEADER}\n\n[src/a.ts:3-5]\nSelection:\n\`\`\`\nconst a = 1;\n\`\`\`\nDiff Hunks:\n\`\`\`diff\n@@ -1 +1 @@\n-x\n+y\n\`\`\`\nComment (user): rename this\n\n[src/a.ts:9]\nComment (user): why?`), prompt);
  expect(formatFeedbackPrompt("고쳐줘", [plain]).startsWith("고쳐줘\n\n"), "사용자 글이 있으면 지시 문장 대신 맨 앞");
  const fenced = formatFeedbackPrompt("", [{ ...item, codeSelection: "x ``` y" }]);
  expect(fenced.includes("````\nx ``` y\n````"), "코드에 ``` 가 있으면 더 긴 펜스");
});

test("칩: 라벨은 파일:줄 범위, 입력창 칩 글은 한 건이면 25자, 여럿이면 개수", () => {
  const item: DiffFeedback = { id: "1", path: "/w/src/a.ts", rel: "src/a.ts", startLine: 3, startColumn: 1, endLine: 5, endColumn: 4, text: "x".repeat(30), state: "accepted", createdAt: "" };
  eq(feedbackChip(item), { kind: "diffFeedback", label: "a.ts:3-5", path: "/w/src/a.ts", line: 3, endLine: 5, id: "1", text: "x".repeat(30) }, "칩");
  eq(lineRangeLabel({ startLine: 7, endLine: 7 }), "7", "한 줄");
  eq(chipText([item]), `${"x".repeat(25)}…`, "25자 자름");
  eq(chipText([item, item]), "2 comments", "여럿");
});

test("서버 저장 규칙: 검증, 보낸 것 표시, 다시 쌓기, 한도", () => {
  const base = { path: "/w/a.ts", rel: "a.ts", startLine: 2, startColumn: 1, endLine: 3, endColumn: 2, text: "  fix  " };
  const a = createFeedback(base);
  expect(a.text === "fix" && a.state === "accepted" && a.id.length > 10, "글을 다듬고 accepted 로 만든다");
  let threw = false;
  try {
    createFeedback({ ...base, text: "  " });
  } catch {
    threw = true;
  }
  expect(threw, "빈 글은 거절");
  threw = false;
  try {
    createFeedback({ ...base, startLine: 5, endLine: 3 });
  } catch {
    threw = true;
  }
  expect(threw, "줄 범위가 거꾸로면 거절");
  const b = createFeedback({ ...base, text: "second" });
  eq(pendingFeedback([a, b]).length, 2, "쌓인 것 둘");
  eq(pendingFeedback([a, b], [b.id]).map((x) => x.text), ["second"], "ids 로 고른다");
  const sent = markSubmitted([a, b], [a]);
  eq(sent.map((x) => x.state), ["submitted", "accepted"], "보낸 것만 submitted");
  eq(pendingFeedback(sent).map((x) => x.id), [b.id], "보낸 것은 다시 안 보낸다");
  eq(restageFeedback(sent, [a]).map((x) => x.state), ["accepted", "accepted"], "큐에서 빼면 다시 쌓인 상태");
  eq(restageFeedback([b], [a]).map((x) => x.id), [b.id, a.id], "목록에 없으면 다시 넣는다");
  const many = Array.from({ length: 310 }, (_, i) => ({ ...a, id: `s${i}`, state: i < 20 ? ("submitted" as const) : ("accepted" as const) }));
  const trimmed = trimFeedback(many);
  expect(trimmed.length === 300 && trimmed.every((x) => x.state === "accepted" || Number(x.id.slice(1)) >= 10), "쌓인 것은 두고 보낸 것을 오래된 것부터 자른다");
});

test("큐 항목: 화면용 글과 칩과 피드백이 실리고, send 옵션으로는 피드백을 뺀다", () => {
  const item: DiffFeedback = { id: "1", path: "/w/a.ts", rel: "a.ts", startLine: 1, startColumn: 1, endLine: 1, endColumn: 2, text: "t", state: "submitted", createdAt: "" };
  const extras = queuedExtras({ display: "", attachments: [feedbackChip(item)], feedback: [item] });
  expect(extras.shown === "" && extras.attachments?.length === 1 && extras.feedback?.length === 1, "빈 글도 shown 으로 남는다");
  eq(queuedExtras({}), {}, "값이 없으면 필드를 만들지 않는다");
  const opts = shownOf({ id: "q", text: "prompt", ...extras });
  expect(opts.display === "" && opts.attachments?.length === 1 && !("feedback" in opts), "턴이 시작될 때는 shown 과 칩만");
});

test("위젯 묶기: 가까운 피드백은 한 위젯, 먼 것은 따로", () => {
  const mk = (id: string, line: number): DiffFeedback => ({ id, path: "/w/a.ts", rel: "a.ts", startLine: line, startColumn: 1, endLine: line, endColumn: 2, text: "t", state: "accepted", createdAt: id });
  eq(groupForPills([mk("a", 3), mk("b", 6), mk("c", 40)]).map((g) => g.map((x) => x.id)), [["a", "b"], ["c"]], "묶음");
  eq(groupForPills([]), [], "빈 목록");
});

let failed = 0;
for (const c of cases) {
  try {
    await c.run();
    console.log(`ok   ${c.name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${c.name}: ${(error as Error).message}`);
  }
}
console.log(failed ? `${failed} failed` : `${cases.length} passed`);
process.exit(failed ? 1 : 0);
