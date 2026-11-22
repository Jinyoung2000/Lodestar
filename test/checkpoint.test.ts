import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TimelineItem } from "../shared/protocol";

const home = mkdtempSync(join(tmpdir(), "agent-nav-checkpoint-unit-"));
process.env.AGENT_NAV_HOME = join(home, "nav");
mkdirSync(process.env.AGENT_NAV_HOME, { recursive: true });
const { checkpointMode, checkpointSession, findMessageId, keptEntryBefore, messageText, occurrenceOf, resolveMessageId, splitTimeline } = await import("../server/checkpoints");
const { currentStep, formatClock, groupTurns, modelLabel, splitTurns, stepsChanges, toolChanges, turnFooter } = await import("../web/timelineModel");

const cases: { name: string; run: () => void | Promise<void> }[] = [];
const test = (name: string, run: () => void | Promise<void>) => cases.push({ name, run });
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
};

const chain = [
  { type: "user" as const, uuid: "u1", message: { role: "user", content: "first" }, parent_tool_use_id: null },
  { type: "assistant" as const, uuid: "a1", message: { role: "assistant", content: [{ type: "text", text: "ok" }] }, parent_tool_use_id: null },
  { type: "user" as const, uuid: "t1", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "r" }] }, parent_tool_use_id: null },
  { type: "assistant" as const, uuid: "a2", message: { role: "assistant", content: [{ type: "text", text: "done" }] }, parent_tool_use_id: null },
  { type: "user" as const, uuid: "u2", message: { role: "user", content: [{ type: "text", text: "same" }] }, parent_tool_use_id: null },
  { type: "assistant" as const, uuid: "a3", message: { role: "assistant", content: [] }, parent_tool_use_id: null },
  { type: "user" as const, uuid: "u3", message: { role: "user", content: "same" }, parent_tool_use_id: null },
];

test("keptEntryBefore: 앞 항목, 첫 메시지 null, 없는 id undefined", () => {
  expect(keptEntryBefore(chain, "u2") === "a2", "u2 앞은 a2");
  expect(keptEntryBefore(chain, "u1") === null, "첫 메시지는 null");
  expect(keptEntryBefore(chain, "nope") === undefined, "없는 id 는 undefined");
});

test("messageText: 도구 결과 항목은 사용자 글이 아니다", () => {
  expect(messageText(chain[0]) === "first", "문자열 내용");
  expect(messageText(chain[2]) === null, "tool_result 는 null");
  expect(messageText(chain[4]) === "same", "text 블록");
  expect(messageText(chain[1]) === null, "assistant 는 null");
});

test("findMessageId: 같은 글이 여럿이면 타임라인 순번으로 고른다", () => {
  expect(findMessageId(chain, "same", 0) === "u2", "첫 번째 same");
  expect(findMessageId(chain, "same", 1) === "u3", "두 번째 same");
  expect(findMessageId(chain, "same", 2) === null, "없는 순번");
  expect(findMessageId(chain, " first ", 0) === "u1", "앞뒤 공백 무시");
});

const legacy: TimelineItem[] = [
  { id: "L1", kind: "user", text: "first", source: "user" },
  { id: "LS", kind: "user", text: "same", source: "system" },
  { id: "L2", kind: "user", text: "same", source: "user" },
  { id: "L3", kind: "user", text: "same", source: "user", messageId: "u3" },
  { id: "L4", kind: "user", text: "never in the history", source: "user" },
];
const agentWith = (sessionId: string | null) => ({ id: "agent", cwd: "/tmp", sessionId }) as never;

test("occurrenceOf: 시스템 항목은 세지 않고 messageId 가 있는 항목은 센다", () => {
  expect(occurrenceOf(legacy, "L2") === 0, "첫 same 은 0");
  expect(occurrenceOf(legacy, "L3") === 1, "둘째 same 은 1");
  expect(occurrenceOf(legacy, "L1") === 0, "유일한 글은 0");
  expect(occurrenceOf(legacy, "nope") === -1, "없는 항목은 -1");
});

test("resolveMessageId: messageId 가 있으면 그대로, 없으면 기록에서 글과 순번으로", async () => {
  expect((await resolveMessageId(agentWith("s"), legacy, "L1", chain)) === "u1", "L1 은 u1");
  expect((await resolveMessageId(agentWith("s"), legacy, "L2", chain)) === "u2", "L2 는 첫 same 인 u2");
  expect((await resolveMessageId(agentWith("s"), legacy, "L3", chain)) === "u3", "L3 은 자기 messageId");
  expect((await resolveMessageId(agentWith("s"), legacy, "L4", chain)) === null, "기록에 없는 글은 null");
  expect((await resolveMessageId(agentWith("s"), legacy, "LS", chain)) === null, "시스템 항목은 null");
  expect((await resolveMessageId(agentWith(null), legacy, "L1", chain)) === null, "세션이 없으면 null");
});

test("checkpointMode: 짝 없음, 스냅샷 없음, 있음, 그 밖의 거절", () => {
  expect(checkpointMode(null, null).mode === "none", "짝이 없으면 none");
  expect(checkpointMode("u1", { canRewind: true, filesChanged: [] } as never).mode === "files", "복원 가능하면 files");
  expect(checkpointMode("u1", { canRewind: false, error: "No file checkpoint found for this message." }).mode === "chat", "스냅샷 없음은 chat");
  const other = checkpointMode("u1", { canRewind: false, error: "File checkpointing is not enabled" });
  expect(other.mode === "none" && other.reason === "File checkpointing is not enabled", "다른 거절은 none 과 사유");
  expect(checkpointMode("u1", null).mode === "none", "dryRun 결과가 없으면 none");
});

const user = (id: string, text: string, extra: object = {}): TimelineItem => ({ id, kind: "user", text, source: "user", ...extra });
const assistant = (id: string, text: string, extra: object = {}): TimelineItem => ({ id, kind: "assistant", text, streaming: false, ...extra });
const tool = (id: string, name: string, input: Record<string, unknown>, status: "running" | "done" | "error" = "done"): TimelineItem => ({ id, kind: "tool", name, input, status, output: null });
const result = (id: string, durationMs: number, extra: object = {}): TimelineItem => ({ id, kind: "result", isError: false, durationMs, costUsd: null, ...extra });

const items: TimelineItem[] = [
  user("U1", "one"),
  tool("T1", "Edit", { file_path: "/a.ts", old_string: "a\nb", new_string: "a\nc\nd" }),
  assistant("A1", "first answer", { at: "2026-10-14T12:11:00Z", model: "claude-haiku-4-5-20251001" }),
  result("R1", 4000, { changes: { files: 1, additions: 2, deletions: 1 } }),
  { id: "S", kind: "user", text: "bg done", source: "system" },
  assistant("A2", "after background"),
  user("U2", "two"),
  assistant("A3", "second"),
];

test("splitTimeline: 항목 앞에서 자른다", () => {
  const split = splitTimeline(items, "U2");
  expect(!!split && split.kept.length === 6 && split.removed.length === 2 && split.removed[0].id === "U2", "U2 부터 제거");
  expect(splitTimeline(items, "nope") === null, "없는 항목은 null");
  expect(splitTimeline(items, "U1")?.kept.length === 0, "첫 메시지 앞은 비어 있다");
});

test("splitTurns: 사용자 메시지 단위, 시스템 메시지는 턴을 나누지 않는다", () => {
  const turns = splitTurns(groupTurns(items));
  expect(turns.length === 2, `턴 수 ${turns.length}`);
  expect(turns[0].user?.id === "U1" && turns[1].user?.id === "U2", "턴의 사용자");
  expect(turns[0].blocks.some((b) => b.kind === "item" && b.item.id === "S"), "시스템 메시지는 앞 턴 안에 남는다");
  const head = splitTurns(groupTurns([assistant("X", "orphan"), ...items]));
  expect(head.length === 3 && head[0].user === null, "첫 메시지 앞 항목은 user 없는 턴");
});

test("turnFooter: 마지막 확정 응답과 result, 복사 글", () => {
  const first = turnFooter(splitTurns(groupTurns(items))[0]);
  expect(first.assistant?.id === "A2" && first.result?.id === "R1", "마지막 응답과 result");
  expect(first.text === "first answer\n\nafter background", "복사 글은 확정 응답 전부");
  const draft = turnFooter({ key: "d", user: null, blocks: [{ kind: "item", item: { id: "D", kind: "assistant", text: "...", streaming: true } }] });
  expect(draft.assistant === null, "스트리밍 초안은 제외");
});

test("toolChanges: Edit 은 줄 변경, Write 는 전부 추가", () => {
  const edit = toolChanges("Edit", { old_string: "a\nb", new_string: "a\nc\nd" });
  expect(edit?.additions === 2 && edit.deletions === 1, JSON.stringify(edit));
  const write = toolChanges("Write", { content: "x\ny\nz\n" });
  expect(write?.additions === 3 && write.deletions === 0, JSON.stringify(write));
  const multi = toolChanges("MultiEdit", { edits: [{ old_string: "a", new_string: "b" }, { old_string: "", new_string: "c" }] });
  expect(multi?.additions === 2 && multi.deletions === 1, JSON.stringify(multi));
  expect(toolChanges("Bash", { command: "ls" }) === null, "Bash 는 null");
});

test("stepsChanges: 실패한 호출은 세지 않는다", () => {
  const blocks = groupTurns([user("U", "x"), tool("E1", "Edit", { old_string: "a", new_string: "b" }), tool("E2", "Edit", { old_string: "a", new_string: "b\nc" }, "error")]);
  const steps = blocks.find((b) => b.kind === "steps");
  expect(steps?.kind === "steps" && JSON.stringify(stepsChanges(steps.items)) === JSON.stringify({ additions: 1, deletions: 1 }), "성공한 호출만");
  expect(stepsChanges([]) === null, "변경 없으면 null");
});

test("currentStep: 진행 중인 마지막 도구", () => {
  const blocks = groupTurns([user("U", "x"), tool("R", "Read", { file_path: "/a" }), tool("B", "Bash", { command: "sleep 9" }, "running")]);
  const steps = blocks.find((b) => b.kind === "steps");
  expect(steps?.kind === "steps" && currentStep(steps.items)?.id === "B", "Bash 가 진행 중");
});

test("formatClock: 12시간제 AM, PM", () => {
  const text = formatClock(new Date(2026, 9, 14, 21, 5).toISOString());
  expect(text === "9:05 PM", String(text));
  expect(formatClock(undefined) === null && formatClock("garbage") === null, "없는 값은 null");
});

test("modelLabel: 표시 이름과 실제 id 를 함께", () => {
  const models = [{ value: "haiku", resolvedModel: "claude-haiku-4-5-20251001", displayName: "Haiku 4.5" }];
  expect(modelLabel("claude-haiku-4-5-20251001", models) === "Haiku 4.5 (claude-haiku-4-5-20251001)", "목록에 있으면 그 이름");
  expect(modelLabel("claude-opus-4-7", []) === "Opus 4.7 (claude-opus-4-7)", "id 에서 이름을 만든다");
  expect(modelLabel("mystery", []) === "mystery", "모르면 id 만");
});

test("checkpointSession: 첫 턴 전의 갈래는 원 세션(resumeFrom)에서 체크포인트를 읽고, 자기 세션이 생기면 그쪽을 쓴다", () => {
  expect(checkpointSession({ sessionId: "own", resumeFrom: "src" }) === "own", "자기 세션이 먼저");
  expect(checkpointSession({ sessionId: null, resumeFrom: "src" }) === "src", "첫 턴 전 갈래");
  expect(checkpointSession({ sessionId: null, resumeFrom: null }) === null, "세션이 없으면 없음");
});

test("갈래 첫 메시지의 복원 범위: 갈래는 원 세션 기록과 같은 uuid 를 쓰니 글과 순번으로 원 세션 기록에서 짝을 찾는다", async () => {
  const chain = [
    { type: "user", uuid: "u1", message: { role: "user", content: "same" }, parent_tool_use_id: null },
    { type: "assistant", uuid: "a1", message: { role: "assistant", content: [] }, parent_tool_use_id: null },
    { type: "user", uuid: "u2", message: { role: "user", content: "same" }, parent_tool_use_id: null },
  ] as never;
  const items: TimelineItem[] = [
    { id: "x:1", kind: "user", text: "same" },
    { id: "x:2", kind: "user", text: "same" },
  ];
  const agent = { sessionId: null, resumeFrom: "src", cwd: "/tmp" } as never;
  expect((await resolveMessageId(agent, items, "x:1", chain)) === "u1", "첫 번째");
  expect((await resolveMessageId(agent, items, "x:2", chain)) === "u2", "두 번째");
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
rmSync(home, { recursive: true, force: true });
console.log(failed ? `${failed} failed` : `${cases.length} passed`);
process.exit(failed ? 1 : 0);
