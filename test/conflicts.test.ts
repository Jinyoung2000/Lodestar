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

{
  const diff3 = ["<<<<<<< HEAD", "ours", "||||||| merged common ancestors", "base", "=======", "theirs", ">>>>>>> other"].join("\n");
  const [block] = parseConflicts(diff3.split("\n"));
  expect(block.base === 2 && block.current.join() === "ours" && block.incoming.join() === "theirs", "diff3 sides");
  expect(resolveConflict(diff3, 0, "both") === "ours\ntheirs", "diff3 both");
}

{
  const crlf = "a\r\n<<<<<<< HEAD\r\nx\r\n=======\r\ny\r\n>>>>>>> o\r\nz\r\n";
  const resolved = resolveConflict(crlf, 0, "incoming");
  expect(resolved === "a\r\ny\r\nz\r\n", `crlf ${JSON.stringify(resolved)}`);
}

{
  const open = "a\n<<<<<<< HEAD\nx\n=======\ny\n";
  expect(parseConflicts(open.split("\n")).length === 0 && resolveAllConflicts(open, "current") === open, "unterminated block ignored");
  expect(!hasConflictMarkers("a ======= b\n<<< not a marker\n"), "plain text");
  expect(parseConflicts("<<<<<<<< x\n=======\n>>>>>>>> y".split("\n")).length === 0, "eight angle brackets is not a marker");
}

console.log("conflicts.test.ts 통과");
