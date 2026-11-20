// 붙는 말풍선 판정(web/stuckBubble.ts) 단독 시험. 접힘이 스크롤 위치를 바꿔 판정을 뒤집는 순환을 레이아웃 모델로 돌려 본다. 실행: npm test
import { HOLD_SLACK, holdMargin, isStuckAt, reachedTopByUser } from "../web/stuckBubble";

const cases: { name: string; run: () => string }[] = [];
const test = (name: string, run: () => string) => cases.push({ name, run });
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
  return detail;
};

// 턴 맨 위 T, 펼친 말풍선 높이 hx, 접은 높이 hf, 말풍선 아래 내용 높이 rest, 칸 높이 view.
// 판정은 감시선(T)이 화면 맨 위(scrollTop)를 지났는지(hold 만큼 아래로 물린 경계)다. 접히면 레이아웃이 hx - hf 줄고,
// anchor 모드는 앵커링이 scrollTop 도 같이 옮기는 경우, clamp 모드는 줄어든 스크롤 범위에 눌리기만 하는 경우,
// pin 모드는 바닥을 따라가는 대화가 레이아웃이 바뀔 때마다 바닥으로 다시 붙는 경우다(스트리밍 중).
type Mode = "anchor" | "clamp" | "pin";
function settle(mode: Mode, withHold: boolean, T: number, hx: number, hf: number, rest: number, view: number, scrollTop: number) {
  let stuck = isStuckAt(T - scrollTop, 0, 0);
  let top = scrollTop;
  const frames: boolean[] = [];
  for (let frame = 0; frame < 40; frame++) {
    const height = T + (stuck ? hf : hx) + rest;
    const max = Math.max(0, height - view);
    // 이 프레임의 레이아웃이 만든 scrollTop
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
  // 기록 영상의 구도: 긴 말풍선이 마지막 턴이고 그 아래 내용이 접으면 칸에 들어가는 높이
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
