// 렌더 성능 조각의 단독 시험: 턴 재사용(reuseTurns), 같은 항목 갱신 묶기(UpsertHold), 서브에이전트 단계 색인, 시계 글자. 실행: npm test
import type { TimelineItem } from "../shared/protocol";
import { subagentSteps } from "../shared/subagents";
import { formatClock, groupTurns, reuseTurns, splitTurns } from "../web/timelineModel";
import { noteHidden, pickEvictions } from "../web/timelineEvict";
import { UpsertHold } from "../web/upsertHold";

type Item = TimelineItem;
const cases: { name: string; run: () => string }[] = [];
const test = (name: string, run: () => string) => cases.push({ name, run });
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
  return detail;
};

const user = (id: string, text: string): Item => ({ id, kind: "user", text, at: "2026-10-22T09:11:00.000Z" });
const assistant = (id: string, text: string, streaming = false): Item => ({ id, kind: "assistant", text, streaming });
const tool = (id: string, status: "running" | "done" = "done", extra: Record<string, unknown> = {}): Item => ({ id, kind: "tool", name: "Read", input: { file_path: `/a/${id}` }, status, output: status === "done" ? "ok" : null, ...extra }) as Item;
const turnsOf = (items: Item[]) => splitTurns(groupTurns(items));

const base = (): Item[] => [user("U1", "one"), tool("T1"), tool("T2"), assistant("A1", "done one"), user("U2", "two"), tool("T3"), assistant("A2", "partial", true)];

test("reuseTurns: 항목이 그대로면 이전 턴 배열을 그대로 돌려준다", () => {
  const items = base();
  const first = reuseTurns([], turnsOf(items));
  const again = reuseTurns(first, turnsOf(items));
  expect(again === first, "same array");
  return `${first.length} turns reused`;
});

test("reuseTurns: 마지막 항목이 바뀌면 마지막 턴만 새 객체, 앞 턴과 앞 블록은 그대로", () => {
  const items = base();
  const first = reuseTurns([], turnsOf(items));
  const streamed = [...items.slice(0, -1), assistant("A2", "partial and more", true)];
  const next = reuseTurns(first, turnsOf(streamed));
  expect(next !== first, "array changes");
  expect(next[0] === first[0], "first turn kept");
  expect(next[1] !== first[1], "last turn replaced");
  expect(next[1].user === first[1].user, "user bubble item kept");
  expect(next[1].blocks[0] === first[1].blocks[0], "steps block before the streamed answer kept");
  expect(next[1].blocks[1] !== first[1].blocks[1], "streamed answer block replaced");
  return "only the last turn rebuilt";
});

test("reuseTurns: 단계 하나의 상태가 바뀌면 그 묶음만 새 객체", () => {
  const items = base();
  const first = reuseTurns([], turnsOf(items));
  const running = [...items.slice(0, 5), tool("T3", "running"), items[6]];
  const mid = reuseTurns(first, turnsOf(running));
  expect(mid[0] === first[0], "turn 1 kept");
  const done = reuseTurns(mid, turnsOf(items));
  const stepBlock = (turns: typeof first) => turns[1].blocks.find((b) => b.kind === "steps");
  expect(stepBlock(done) !== stepBlock(mid), "steps block replaced on status change");
  expect(done[0] === first[0], "turn 1 still the original object");
  return "steps block follows its items";
});

test("reuseTurns: 턴이 늘거나 줄어도 남은 턴은 재사용한다", () => {
  const items = base();
  const first = reuseTurns([], turnsOf(items));
  const grown = reuseTurns(first, turnsOf([...items, user("U3", "three")]));
  expect(grown.length === 3 && grown[0] === first[0] && grown[1] === first[1], "kept turns reused, got " + [grown[0] === first[0], grown[1] === first[1]].join(","));
  const shrunk = reuseTurns(grown, turnsOf(items));
  expect(shrunk.length === 2 && shrunk[0] === first[0], "shrunk keeps first");
  return "3 turns then 2";
});

test("reuseTurns: 사용자 메시지가 바뀐 턴은 새 객체", () => {
  const items = base();
  const first = reuseTurns([], turnsOf(items));
  const edited = [user("U1", "one edited"), ...items.slice(1)];
  const next = reuseTurns(first, turnsOf(edited));
  expect(next[0] !== first[0] && next[1] === first[1], "only turn 1 replaced");
  return "edit detected";
});

test("UpsertHold: 같은 키는 마지막 값 하나, 처음 나온 순서를 지킨다", () => {
  const out: string[][] = [];
  let scheduled: (() => void) | null = null;
  const hold = new UpsertHold<string, string>((events) => out.push(events), (run) => {
    scheduled = run;
    return () => {
      scheduled = null;
    };
  });
  hold.hold("a", "a1");
  hold.hold("b", "b1");
  hold.hold("a", "a2");
  hold.hold("a", "a3");
  expect(out.length === 0 && hold.size === 2, "nothing delivered before the frame");
  scheduled!();
  expect(out.length === 1 && out[0].join() === "a3,b1", "delivered " + JSON.stringify(out));
  return "a3,b1 in first-seen order";
});

test("UpsertHold: release 는 예약을 취소하고 즉시 내보내며, 비어 있으면 아무것도 안 한다", () => {
  const out: string[][] = [];
  let pending = 0;
  const hold = new UpsertHold<string, string>((events) => out.push(events), () => {
    pending++;
    return () => {
      pending--;
    };
  });
  hold.release();
  expect(out.length === 0, "empty release delivers nothing");
  hold.hold("a", "a1");
  expect(pending === 1, "one schedule");
  hold.hold("b", "b1");
  expect(pending === 1, "no second schedule while holding");
  hold.release();
  expect(pending === 0 && out.length === 1 && out[0].join() === "a1,b1", "released immediately, schedule cancelled");
  hold.hold("a", "a2");
  expect(pending === 1, "schedules again after release");
  return "release cancels schedule";
});

test("subagentSteps: 부모 id 별로 모으고, 같은 배열이면 색인을 다시 만들지 않는다", () => {
  const items: Item[] = [tool("P1", "done", { parentToolUseId: undefined }), tool("C1", "done", { parentToolUseId: "P1" }), tool("C2", "running", { parentToolUseId: "P1" }), tool("C3", "done", { parentToolUseId: "P2" }), user("U", "x")];
  const steps = subagentSteps(items, "P1");
  expect(steps.map((s) => s.id).join() === "C1,C2", "P1 children " + steps.map((s) => s.id).join());
  expect(subagentSteps(items, "P1") === steps, "same array back for the same timeline");
  expect(subagentSteps(items, "none").length === 0 && subagentSteps(undefined, "P1").length === 0, "empty cases");
  expect(subagentSteps([...items, tool("C4", "done", { parentToolUseId: "P1" })], "P1").length === 3, "new timeline array rebuilds the index");
  return "indexed by parent";
});

test("formatClock: toLocaleTimeString 과 같은 글자", () => {
  for (const iso of ["2026-10-22T09:11:00.000Z", "2026-01-01T00:05:00.000Z", "2026-07-04T23:59:00.000Z", "2026-10-22T12:00:00.000Z"]) {
    const expected = new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    expect(formatClock(iso) === expected, `${iso}: ${formatClock(iso)} vs ${expected}`);
  }
  expect(formatClock(undefined) === null && formatClock("nope") === null, "bad input is null");
  return "matches";
});

test("pickEvictions: 보이는 세션, 최근에 닫은 세션, 응답 중인 세션은 남기고 나머지를 내린다", () => {
  const loaded = ["a", "b", "c", "d", "e", "f"];
  const drop = pickEvictions(loaded, new Set(["a"]), ["b", "c", "d", "x"], (id) => id === "f", 3);
  expect(drop.join() === "e", "dropped " + drop.join());
  expect(pickEvictions(loaded, new Set(), [], () => false, 3).join() === loaded.join(), "nothing protected drops all");
  expect(pickEvictions([], new Set(), ["b"], () => false, 3).length === 0, "empty");
  return "a shown, b-c-d recent, f busy kept; e dropped";
});

test("noteHidden: 닫은 순서대로 앞에 쌓고 중복은 앞으로 옮긴다", () => {
  let recent: string[] = [];
  for (const id of ["a", "b", "c", "a"]) recent = noteHidden(recent, id);
  expect(recent.join() === "a,c,b", "order " + recent.join());
  return "a,c,b";
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
if (failed) process.exit(1);
