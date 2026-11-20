// 경계 끌개 단독 시험: 크기 계산(web/resizeDrag.ts dragSize), 끄는 동안 표시(beginResize, endResize, onResizeEnd), 붙는 말풍선 재측정 묶기(web/stuckBubble.ts queueRemeasure). 실행: npm test
import { beginResize, dragSize, endResize, isResizing, onResizeEnd } from "../web/resizeDrag";
import { queueRemeasure, type Remeasure } from "../web/stuckBubble";

const cases: { name: string; run: () => string }[] = [];
const test = (name: string, run: () => string) => cases.push({ name, run });
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
  return detail;
};

test("오른쪽으로 끌면 direction 1 은 커지고 -1 은 작아진다", () => {
  const a = dragSize(300, 40, 1, 180, 600);
  const b = dragSize(300, 40, -1, 180, 600);
  return expect(a === 340 && b === 260, `${a}, ${b}`);
});

test("min 과 limit 로 자른다", () => {
  const low = dragSize(300, -500, 1, 180, 600);
  const high = dragSize(300, 500, 1, 180, 600);
  return expect(low === 180 && high === 600, `${low}, ${high}`);
});

test("limit 이 min 보다 작으면 min 이 이긴다(창이 좁을 때)", () => {
  const size = dragSize(300, 100, 1, 220, 150);
  return expect(size === 220, `${size}`);
});

test("소수 시작 크기는 반올림한다", () => {
  const size = dragSize(626.4, 0.2, 1, 100, 900);
  return expect(size === 627, `${size}`);
});

test("끄는 동안 표시는 중첩을 세고 모두 끝나야 끝난다", () => {
  let ended = 0;
  const off = onResizeEnd(() => ended++);
  beginResize();
  beginResize();
  endResize();
  const mid = isResizing() && ended === 0;
  endResize();
  const done = !isResizing() && ended === 1;
  off();
  beginResize();
  endResize();
  return expect(mid && done && ended === 1, `mid ${mid}, done ${done}, ended ${ended}`);
});

test("짝이 안 맞는 endResize 는 표시를 음수로 만들지 않는다", () => {
  endResize();
  endResize();
  beginResize();
  const on = isResizing();
  endResize();
  return expect(on && !isResizing(), `on ${on}`);
});

// 붙은 말풍선 N개의 재측정은 레이아웃을 두 번만 강제해야 한다(펼친 높이 읽기 한 번, 접은 높이 읽기 한 번).
// 가짜 말풍선이 속성 쓰기 뒤 첫 높이 읽기를 "레이아웃 강제" 로 센다.
test("말풍선 재측정은 쓰기와 읽기를 갈라 레이아웃을 두 번만 강제한다", () => {
  const frames: (() => void)[] = [];
  (globalThis as unknown as { requestAnimationFrame: (cb: () => void) => number }).requestAnimationFrame = (cb) => frames.push(cb);
  let dirty = false;
  let layouts = 0;
  const holds: number[] = [];
  const make = (folded: number, expanded: number) => {
    let mark: string | null = "";
    const bubble = {
      getAttribute: () => mark,
      removeAttribute: () => {
        mark = null;
        dirty = true;
      },
      setAttribute: (_: string, value: string) => {
        mark = value;
        dirty = true;
      },
      get offsetHeight() {
        if (dirty) {
          layouts++;
          dirty = false;
        }
        return mark === null ? expanded : folded;
      },
    };
    const job: Remeasure = { bubble: bubble as unknown as HTMLElement, root: { clientHeight: 500 } as HTMLElement, apply: (hold) => holds.push(hold) };
    return job;
  };
  for (let i = 0; i < 300; i++) queueRemeasure(make(40, 90));
  const scheduled = frames.length;
  frames.shift()?.();
  return expect(scheduled === 1 && layouts === 2 && holds.length === 300 && holds.every((h) => h === 54), `scheduled ${scheduled}, layouts ${layouts}, applied ${holds.length}, hold ${holds[0]}`);
});

test("끄는 동안에는 재측정을 미루고 놓으면 한 번 한다", () => {
  const frames: (() => void)[] = [];
  (globalThis as unknown as { requestAnimationFrame: (cb: () => void) => number }).requestAnimationFrame = (cb) => frames.push(cb);
  const applied: number[] = [];
  const job: Remeasure = { bubble: { getAttribute: () => null, offsetHeight: 40 } as unknown as HTMLElement, root: { clientHeight: 500 } as HTMLElement, apply: (hold) => applied.push(hold) };
  beginResize();
  queueRemeasure(job);
  const during = frames.length;
  endResize();
  const after = frames.length;
  frames.shift()?.();
  return expect(during === 0 && after === 1 && applied.length === 1, `during ${during}, after ${after}, applied ${applied.length}`);
});

let failed = 0;
for (const { name, run } of cases) {
  try {
    console.log(`ok   ${name} - ${run()}`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${name} - ${(error as Error).message}`);
  }
}
if (failed) process.exit(1);
console.log(`${cases.length}건 통과`);
