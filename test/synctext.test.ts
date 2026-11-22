import { S } from "../web/strings";

const cases: { name: string; run: () => string }[] = [];
const test = (name: string, run: () => string) => cases.push({ name, run });
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
  return detail;
};

test("push 만: 무엇을 어디로 보내는지 제목에, 버튼은 Push", () => {
  expect(S.syncConfirmTitle("origin/main", 0, 1) === "Push 1 commit to origin/main?", S.syncConfirmTitle("origin/main", 0, 1));
  expect(S.syncConfirmTitle("origin/main", 0, 3) === "Push 3 commits to origin/main?", "plural");
  expect(S.syncConfirmDetail("main", "origin/main", 0, 1) === "Sends your commits on main to origin/main.", S.syncConfirmDetail("main", "origin/main", 0, 1));
  return expect(S.syncConfirmButton(0, 1) === "Push", "button");
});

test("pull 만, 둘 다", () => {
  expect(S.syncConfirmTitle("origin/main", 2, 0) === "Pull 2 commits from origin/main?", S.syncConfirmTitle("origin/main", 2, 0));
  expect(S.syncConfirmButton(2, 0) === "Pull", "pull button");
  expect(S.syncConfirmTitle("origin/main", 2, 1) === "Pull 2 commits, then push 1 commit?", S.syncConfirmTitle("origin/main", 2, 1));
  expect(S.syncConfirmButton(2, 1) === "Sync", "both button");
  return expect(S.syncConfirmDetail("main", "origin/main", 2, 1).includes("diverged"), "diverged note");
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
