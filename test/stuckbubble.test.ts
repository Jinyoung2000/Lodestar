import { HOLD_SLACK, holdMargin, isStuckAt, reachedTopByUser } from "../web/stuckBubble";

const cases: { name: string; run: () => string }[] = [];
const test = (name: string, run: () => string) => cases.push({ name, run });
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
  return detail;
};

type Mode = "anchor" | "clamp" | "pin";
function settle(mode: Mode, withHold: boolean, T: number, hx: number, hf: number, rest: number, view: number, scrollTop: number) {
  let stuck = isStuckAt(T - scrollTop, 0, 0);
  let top = scrollTop;
  const frames: boolean[] = [];
  for (let frame = 0; frame < 40; frame++) {
    const height = T + (stuck ? hf : hx) + rest;
    const max = Math.max(0, height - view);
    if (frame > 0) {
      const wasStuck = frames[frame - 1];
      const delta = wasStuck === stuck ? 0 : stuck ? -(hx - hf) : hx - hf;
      top = mode === "pin" ? max : Math.min(Math.max(0, mode === "anchor" ? top + delta : top), max);
    } else top = Math.min(top, max);
    const hold = withHold && stuck ? holdMargin(hx, hf, view) : 0;
    const next = isStuckAt(T - top, 0, hold);
    frames.push(stuck);
    stuck = next;
  }
  const flips = frames.filter((v, i) => i > 0 && v !== frames[i - 1]).length;
  return { flips, tail: frames.slice(-10).every((v) => v === frames[39]) };
}

test("접힘 높이만큼 경계를 물린다. 줄어들지 않으면 그대로, 칸 높이를 넘지 않는다", () => {
  expect(holdMargin(485, 81, 660) === 404 + HOLD_SLACK, "485 -> 81 folds 404px");
  expect(holdMargin(81, 81, 660) === 0, "nothing to fold");
  expect(holdMargin(60, 81, 660) === 0, "never negative");
  return expect(holdMargin(2000, 81, 300) === 300, "capped at the viewport height");
});

test("사용자가 맨 위에 닿았을 때만 맨 위 판정이 켜진다", () => {
  expect(reachedTopByUser(0, 50) === true, "scrolled to the top just now");
  expect(reachedTopByUser(0, 5000) === false, "clamped to 0 with no recent input");
  return expect(reachedTopByUser(12, 10) === false, "not at the top");
});

test("경계를 안 물리면 접힌 직후 판정이 뒤집혀 순환한다(기존 버그)", () => {
  const pinned = settle("pin", false, 357, 485, 81, 407, 660, 685);
  const anchored = settle("anchor", false, 357, 485, 81, 407, 660, 500);
  expect(pinned.flips >= 10, `pin mode flips ${pinned.flips}`);
  return expect(anchored.flips >= 10, `anchor mode flips ${anchored.flips}`);
});

test("경계를 물리면 어느 scrollTop 에서 시작해도 순환 없이 가라앉는다", () => {
  let worst = 0;
  let runs = 0;
  for (const mode of ["clamp", "anchor", "pin"] as Mode[]) {
    for (const rest of [100, 407, 700, 1500]) {
      for (const T of [16, 357, 1200]) {
        for (let top = 0; top <= T + 485 + rest; top += 17) {
          const result = settle(mode, true, T, 485, 81, rest, 660, top);
          runs++;
          worst = Math.max(worst, result.flips);
          expect(result.flips <= 1 && result.tail, `${mode} rest=${rest} T=${T} top=${top} flips=${result.flips}`);
        }
      }
    }
  }
  return `${runs} starts, at most ${worst} state change`;
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
