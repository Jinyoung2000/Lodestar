import { decide, groupRefs, nearestIndex, noResultMessage, peekMeta, previewLine, stepIndex, type PeekRef } from "../web/peekModel";

const cases: { name: string; run: () => string }[] = [];
const test = (name: string, run: () => string) => cases.push({ name, run });
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
  return detail;
};

const ref = (uri: string, line: number, from = 0, to = from + 3): PeekRef => ({ uri, range: { start: { line, character: from }, end: { line, character: to } } });
const cursor = (uri: string, line: number, character: number) => ({ uri, line, character });

test("결과 없음", () => expect(decide([], { kind: "definition", openInPeek: false, cursor: cursor("a", 0, 0) }).type === "none", "none"));

test("결과 하나면 바로 이동(정의, 구현, 참조 모두)", () => {
  const kinds = ["definition", "implementation", "reference"] as const;
  for (const kind of kinds) {
    const d = decide([ref("b", 3)], { kind, openInPeek: false, cursor: cursor("a", 0, 0) });
    expect(d.type === "jump", `${kind}: ${d.type}`);
  }
  return "3 kinds";
});

test("결과 여럿이면 peek, 같은 위치는 한 번만", () => {
  const d = decide([ref("b", 3), ref("a", 1), ref("a", 1)], { kind: "reference", openInPeek: false, cursor: cursor("c", 0, 0) });
  expect(d.type === "peek", d.type);
  if (d.type !== "peek") return "";
  expect(d.groups.length === 2 && d.groups[0].uri === "a" && d.groups[0].refs.length === 1, JSON.stringify(d.groups.map((g) => [g.uri, g.refs.length])));
  return "2 groups";
});

test("한 건이 중복이면 하나로 세어 바로 이동", () => expect(decide([ref("b", 3), ref("b", 3)], { kind: "implementation", openInPeek: false, cursor: cursor("a", 0, 0) }).type === "jump", "dedupe then jump"));

test("Peek 명령은 결과가 하나여도 peek", () => expect(decide([ref("b", 3)], { kind: "definition", openInPeek: true, cursor: cursor("a", 0, 0) }).type === "peek", "peek"));

test("정의 이동에서 결과가 커서 자신이면 참조로", () => {
  const self = decide([ref("a", 4, 10, 15)], { kind: "definition", openInPeek: false, cursor: cursor("a", 4, 12) });
  expect(self.type === "references", self.type);
  const other = decide([ref("a", 4, 10, 15)], { kind: "definition", openInPeek: false, cursor: cursor("a", 9, 12) });
  expect(other.type === "jump", other.type);
  const refs = decide([ref("a", 4, 10, 15)], { kind: "reference", openInPeek: false, cursor: cursor("a", 4, 12) });
  expect(refs.type === "jump", refs.type);
  return "definition only";
});

test("파일 주소, 줄, 열 순으로 정렬하고 파일별로 묶는다", () => {
  const groups = groupRefs([ref("b", 2), ref("a", 9), ref("a", 1, 8), ref("a", 1, 2)]);
  expect(groups.map((g) => g.uri).join() === "a,b", groups.map((g) => g.uri).join());
  expect(groups[0].refs.map((r) => `${r.range.start.line}:${r.range.start.character}`).join() === "1:2,1:8,9:0", "order");
  return "a(3) b(1)";
});

test("커서와 가장 가까운 결과", () => {
  const groups = groupRefs([ref("a", 2), ref("a", 10), ref("b", 1)]);
  expect(nearestIndex(groups, "a", 10, 1) === 1, "inside");
  expect(nearestIndex(groups, "a", 8, 0) === 1, "closest line");
  expect(nearestIndex(groups, "z", 0, 0) === 0, "other file");
  return "ok";
});

test("다음, 이전 결과는 끝에서 돌아간다", () => expect(stepIndex(2, 1, 3) === 0 && stepIndex(0, -1, 3) === 2 && stepIndex(1, 1, 3) === 2, "wrap"));

test("결과 줄 미리보기: 앞 8글자는 단어 경계까지, 앞 공백은 뺀다", () => {
  const line = "      const message = greet(\"a\");";
  const start = line.indexOf("greet");
  const preview = previewLine(line, start, start + 5);
  expect(preview.text === 'message = greet("a");' && preview.text.slice(preview.matchStart, preview.matchEnd) === "greet", JSON.stringify(preview));
  const short = previewLine("greet(1)", 0, 5);
  expect(short.text === "greet(1)" && short.matchStart === 0 && short.matchEnd === 5, JSON.stringify(short));
  return preview.text;
});

test("머리줄 meta 와 결과 없음 문구", () => {
  expect(peekMeta("reference", 12) === "References (12)" && peekMeta("definition", 1) === "Definitions (1)" && peekMeta("implementation", 3) === "Implementations (3)", "meta");
  expect(noResultMessage("definition", "foo") === "No definition found for 'foo'" && noResultMessage("reference", null) === "No references found", "message");
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
