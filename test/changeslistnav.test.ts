// Editor 배치 Changes 목록의 키보드 이동(web/changesListNav.ts)과 Checks 구역 상태(web/changesState.ts).
// 실행: npm test
import { getChangesView, setChecksOpen } from "../web/changesState";
import { listNav, parentOf, type NavRow } from "../web/changesListNav";

const cases: { name: string; run: () => string }[] = [];
const test = (name: string, run: () => string) => cases.push({ name, run });
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
  return detail;
};
const focusAt = (action: ReturnType<typeof listNav>) => (action?.type === "focus" ? action.index : null);

const file = (depth = 0): NavRow => ({ depth, folder: false, expanded: false });
const folder = (depth: number, expanded: boolean): NavRow => ({ depth, folder: true, expanded });

test("목록 보기: 위아래는 한 칸, 끝에서는 멈춘다(돌아 나가지 않는다)", () => {
  const rows = [file(), file(), file()];
  expect(focusAt(listNav("ArrowDown", rows, 0)) === 1, "0 에서 아래");
  expect(focusAt(listNav("ArrowDown", rows, 2)) === 2, "마지막에서 아래는 그대로");
  expect(focusAt(listNav("ArrowUp", rows, 0)) === 0, "처음에서 위는 그대로");
  expect(focusAt(listNav("ArrowUp", rows, 2)) === 1, "2 에서 위");
  return "ok";
});

test("행 밖에서(자리 -1) 아래는 처음 행, 위는 마지막 행", () => {
  const rows = [file(), file(), file()];
  expect(focusAt(listNav("ArrowDown", rows, -1)) === 0 && focusAt(listNav("ArrowUp", rows, -1)) === 2, "진입");
  return "ok";
});

test("Home, End, PageUp, PageDown 은 범위 안으로 맞춘다", () => {
  const rows = Array.from({ length: 25 }, () => file());
  expect(focusAt(listNav("Home", rows, 12)) === 0 && focusAt(listNav("End", rows, 12)) === 24, "처음과 끝");
  expect(focusAt(listNav("PageDown", rows, 12)) === 22, "PageDown 기본 10행");
  expect(focusAt(listNav("PageDown", rows, 20)) === 24, "PageDown 은 끝에서 멈춤");
  expect(focusAt(listNav("PageUp", rows, 3)) === 0, "PageUp 은 처음에서 멈춤");
  expect(focusAt(listNav("PageDown", rows, 0, 4)) === 4, "행 수를 알면 그만큼");
  return "ok";
});

test("행이 없으면 아무것도 하지 않는다", () => {
  expect(listNav("ArrowDown", [], -1) === null && listNav("End", [], -1) === null, "빈 목록");
  return "ok";
});

// src(폴더, 펴짐) / a.ts / b.ts, docs(폴더, 접힘), z.md
const tree: NavRow[] = [folder(0, true), file(1), file(1), folder(0, false), file(0)];

test("트리: 오른쪽은 접힌 폴더를 펴고, 펴진 폴더에서는 첫 자식으로", () => {
  expect(listNav("ArrowRight", tree, 3)?.type === "toggle", "접힌 폴더 펴기");
  expect(focusAt(listNav("ArrowRight", tree, 0)) === 1, "펴진 폴더에서 첫 자식");
  expect(listNav("ArrowRight", tree, 1) === null, "파일에서는 아무 일도 없다");
  return "ok";
});

test("트리: 왼쪽은 펴진 폴더를 접고, 파일이나 접힌 폴더에서는 부모 폴더로", () => {
  expect(listNav("ArrowLeft", tree, 0)?.type === "toggle", "펴진 폴더 접기");
  expect(focusAt(listNav("ArrowLeft", tree, 2)) === 0, "파일에서 부모 폴더");
  expect(listNav("ArrowLeft", tree, 3) === null, "맨 위 단계의 접힌 폴더는 부모가 없다");
  expect(listNav("ArrowLeft", tree, 4) === null, "맨 위 단계 파일도 부모가 없다");
  return "ok";
});

test("트리: 자식이 없는 펴진 폴더에서 오른쪽은 가만히", () => {
  const rows: NavRow[] = [folder(0, true), folder(0, false)];
  expect(listNav("ArrowRight", rows, 0) === null, "다음 행이 형제면 자식이 아니다");
  return "ok";
});

test("부모 찾기: 위로 올라가며 처음 만나는 더 얕은 행", () => {
  const rows: NavRow[] = [folder(0, true), folder(1, true), file(2), file(1)];
  expect(parentOf(rows, 2) === 1 && parentOf(rows, 3) === 0 && parentOf(rows, 1) === 0 && parentOf(rows, 0) === -1, "부모");
  return "ok";
});

test("다루지 않는 키는 null(Enter, Space 는 행이 직접 처리한다)", () => {
  expect(listNav("Enter", tree, 1) === null && listNav(" ", tree, 1) === null && listNav("a", tree, 1) === null, "그 밖의 키");
  return "ok";
});

test("Checks 구역: 처음은 접힘, 같은 값은 상태 객체를 바꾸지 않는다", () => {
  expect(getChangesView().checksOpen === false, "기본 접힘");
  setChecksOpen(true);
  expect(getChangesView().checksOpen, "펴짐");
  const same = getChangesView();
  setChecksOpen(true);
  expect(getChangesView() === same, "같은 값은 그대로");
  setChecksOpen(false);
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
