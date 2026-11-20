// 대화 바닥 고정 판정(web/timelineScroll.ts) 단독 시험. 실행: npm test
import { BOTTOM_SLACK, followsBottom } from "../web/timelineScroll";

const cases: { name: string; run: () => string }[] = [];
const test = (name: string, run: () => string) => cases.push({ name, run });
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
  return detail;
};

test("사용자가 위로 올리면 바닥 고정이 풀리고, 바닥으로 돌아오면 다시 붙는다", () => {
  expect(followsBottom(true, 300, false) === false, "scrolled up 300px");
  expect(followsBottom(false, 0, false) === true, "back at the bottom");
  expect(followsBottom(true, BOTTOM_SLACK - 1, false) === true, "inside the slack still follows");
  return expect(followsBottom(true, BOTTOM_SLACK, false) === false, "slack edge is not the bottom");
});

test("높이가 바뀌어 생긴 스크롤은 판단을 바꾸지 않는다(터미널 열기, 창 줄이기)", () => {
  expect(followsBottom(true, 241, true) === true, "following stays following after the viewport shrank 241px");
  return expect(followsBottom(false, 0, true) === false, "a reader who scrolled up stays unpinned");
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
console.log(`${cases.length} passed`);
