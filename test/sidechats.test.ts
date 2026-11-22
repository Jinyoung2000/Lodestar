import { applySideRun, dropSide, swapSide } from "../web/sideChats";

const cases: { name: string; run: () => string }[] = [];
const test = (name: string, run: () => string) => cases.push({ name, run });
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
  return detail;
};

type S = { id: string; agentId: string; run: { id: string; n?: number } | null; draft?: unknown };
const sideA: S = { id: "side-a", agentId: "A", run: { id: "side-a" } };
const sideB: S = { id: "side-b", agentId: "B", run: { id: "side-b" } };

test("세션 A 의 곁다리는 B 로 가면 보관되고 B 는 곁다리가 없다", () => {
  const r = swapSide<S>(sideA, {}, "A", "B");
  expect(r.side === null, "B 에는 곁다리가 없다(닫힘)");
  expect(r.stash.A === sideA, "A 의 것은 보관");
  return "ok";
});

test("A 로 돌아오면 보관된 곁다리가 그대로 돌아오고 보관함에서 빠진다", () => {
  const r1 = swapSide<S>(sideA, {}, "A", "B");
  const r2 = swapSide<S>(r1.side, r1.stash, "B", "A");
  expect(r2.side === sideA && !("A" in r2.stash), "A 복귀");
  return "ok";
});

test("B 에도 곁다리가 있으면 B 것이 뜨고 A 것은 보관된다", () => {
  const r = swapSide<S>(sideA, { B: sideB }, "A", "B");
  expect(r.side === sideB && r.stash.A === sideA && !("B" in r.stash), "교체");
  return "ok";
});

test("빈 곁다리(질문도 초안도 없음)는 보관하지 않는다", () => {
  const empty: S = { id: "side-e", agentId: "A", run: null };
  const r = swapSide<S>(empty, {}, "A", "B");
  expect(r.side === null && Object.keys(r.stash).length === 0, "버림");
  return "ok";
});

test("새 세션 화면(null)으로 가도 보관하고, 같은 세션이면 그대로", () => {
  const r = swapSide<S>(sideA, {}, "A", null);
  expect(r.side === null && r.stash.A === sideA, "null 로 이동");
  const same = swapSide<S>(sideA, {}, "A", "A");
  expect(same.side === sideA, "같은 세션");
  return "ok";
});

test("실행 상태 이벤트는 화면 것과 보관된 것 중 id 가 맞는 쪽에 반영된다", () => {
  const shown = applySideRun<S>(sideB, { A: sideA }, { id: "side-b", n: 2 } as { id: string });
  expect(shown.side?.run?.id === "side-b" && shown.side !== sideB, "화면 것 갱신");
  const stashed = applySideRun<S>(sideB, { A: sideA }, { id: "side-a", n: 3 } as { id: string });
  expect(stashed.side === sideB && stashed.stash.A !== sideA && stashed.stash.A.run?.n === 3, "보관된 것 갱신");
  const none = applySideRun<S>(sideB, { A: sideA }, { id: "other" });
  expect(none.side === sideB && none.stash.A === sideA, "모르는 id 는 그대로");
  return "ok";
});

test("세션이 지워지면 그 곁다리가 화면과 보관함에서 사라진다", () => {
  const r = dropSide<S>(sideB, { A: sideA }, "A");
  expect(r.side === sideB && !("A" in r.stash), "보관된 것 삭제");
  const shown = dropSide<S>(sideB, {}, "B");
  expect(shown.side === null, "화면 것 삭제");
  return "ok";
});

let failed = 0;
for (const c of cases) {
  try {
    console.log(`PASS ${c.name}: ${c.run()}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${c.name}: ${(e as Error).message}`);
  }
}
if (failed) process.exit(1);
console.log(`${cases.length} passed`);
