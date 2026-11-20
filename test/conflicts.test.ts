// FIX6B: 충돌 마커를 읽고 한쪽으로 푸는 순수 함수(shared/conflicts.ts) 시험.
// 실행: npm test
import { parseConflicts, resolveAllConflicts, resolveConflict, hasConflictMarkers } from "../shared/conflicts";

const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
};

const text = [
  "top",
  "<<<<<<< HEAD",
  "mine 1",
  "mine 2",
  "=======",
  "theirs 1",
  ">>>>>>> origin/main",
  "middle",
  "<<<<<<< HEAD",
  "only mine",
  "=======",
  ">>>>>>> feature/x",
  "bottom",
].join("\n");

{
  const blocks = parseConflicts(text.split("\n"));
  expect(blocks.length === 2, `two blocks ${blocks.length}`);
  expect(blocks[0].start === 1 && blocks[0].mid === 4 && blocks[0].end === 6 && blocks[0].base === -1, "first block lines");
  expect(blocks[0].currentLabel === "HEAD" && blocks[0].incomingLabel === "origin/main", "labels");
  expect(blocks[0].current.join("|") === "mine 1|mine 2" && blocks[0].incoming.join("|") === "theirs 1", "sides");
  expect(blocks[1].incoming.length === 0 && blocks[1].current.join("|") === "only mine", "empty incoming side");
}

{
  expect(resolveConflict(text, 0, "current") === text.replace("<<<<<<< HEAD\nmine 1\nmine 2\n=======\ntheirs 1\n>>>>>>> origin/main", "mine 1\nmine 2"), "accept current on the first block");
  const incoming = resolveConflict(text, 0, "incoming");
  expect(incoming.startsWith("top\ntheirs 1\nmiddle\n<<<<<<< HEAD"), `accept incoming keeps the second block: ${incoming}`);
  const both = resolveConflict(text, 0, "both");
  expect(both.startsWith("top\nmine 1\nmine 2\ntheirs 1\nmiddle"), "accept both keeps current first");
  // 두 번째 블록을 먼저 풀어도 첫 블록의 번호는 그대로 0 이다
  const second = resolveConflict(text, 1, "incoming");
  expect(second.endsWith("middle\nbottom") && parseConflicts(second.split("\n")).length === 1, "accept incoming on a block with no incoming lines removes it");
  expect(resolveConflict(text, 9, "current") === text, "unknown index is a no-op");
}

{
  const everything = resolveAllConflicts(text, "current");
  expect(everything === "top\nmine 1\nmine 2\nmiddle\nonly mine\nbottom", `all current: ${everything}`);
  expect(!hasConflictMarkers(everything) && hasConflictMarkers(text), "marker detection");
  expect(resolveAllConflicts(text, "both") === "top\nmine 1\nmine 2\ntheirs 1\nmiddle\nonly mine\nbottom", "all both");
}

// diff3 스타일: 베이스 구간은 어느 쪽에도 들어가지 않는다
{
  const diff3 = ["<<<<<<< HEAD", "ours", "||||||| merged common ancestors", "base", "=======", "theirs", ">>>>>>> other"].join("\n");
  const [block] = parseConflicts(diff3.split("\n"));
  expect(block.base === 2 && block.current.join() === "ours" && block.incoming.join() === "theirs", "diff3 sides");
  expect(resolveConflict(diff3, 0, "both") === "ours\ntheirs", "diff3 both");
}

// CRLF: \r 는 줄 안에 남고 마커 판정을 막지 않는다
{
  const crlf = "a\r\n<<<<<<< HEAD\r\nx\r\n=======\r\ny\r\n>>>>>>> o\r\nz\r\n";
  const resolved = resolveConflict(crlf, 0, "incoming");
  expect(resolved === "a\r\ny\r\nz\r\n", `crlf ${JSON.stringify(resolved)}`);
}

// 닫히지 않은 블록과 평범한 글은 건드리지 않는다
{
  const open = "a\n<<<<<<< HEAD\nx\n=======\ny\n";
  expect(parseConflicts(open.split("\n")).length === 0 && resolveAllConflicts(open, "current") === open, "unterminated block ignored");
  expect(!hasConflictMarkers("a ======= b\n<<< not a marker\n"), "plain text");
  // 마커처럼 보이지만 7개가 아닌 줄
  expect(parseConflicts("<<<<<<<< x\n=======\n>>>>>>>> y".split("\n")).length === 0, "eight angle brackets is not a marker");
}

console.log("conflicts.test.ts 통과");
