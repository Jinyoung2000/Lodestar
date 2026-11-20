// tsserver quickinfo-full 의 displayParts 에서 만든 Copy Type, Copy Signature 문자열(web/typeParts.ts)을 확인한다.
// 조각은 typescript-language-server 6.0.2 로 /tmp 임시 저장소의 실제 TS 파일에서 받은 것이다(test/fixtures/quickinfo-parts.json).
// 실행: npm test
import { readFileSync } from "node:fs";
import { signatureFromParts, typeFromParts, isFunctionType, type DisplayPart } from "../web/typeParts";

const data = JSON.parse(readFileSync(new URL("./fixtures/quickinfo-parts.json", import.meta.url), "utf8")) as Record<string, { parts: DisplayPart[] }>;

const cases: { name: string; run: () => string }[] = [];
const test = (name: string, run: () => string) => cases.push({ name, run });
const expect = (actual: unknown, expected: unknown, label: string) => {
  if (actual !== expected) throw new Error(`${label}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
  return label;
};
const type = (key: string) => typeFromParts(data[key]!.parts);
const signature = (key: string) => signatureFromParts(data[key]!.parts);

test("객체 타입은 한 줄로 펴고 닫는 괄호 앞 세미콜론을 뺀다", () => {
  expect(type("values"), "{ [x: string]: string | boolean | undefined }", "index signature");
  expect(type("anon"), "{ id: number; tags: string[]; nested: { ok: boolean } }", "nested object");
  expect(type("deep"), "{ a: { b: { c: { d: { e: { f: { g: { h: number } } } } } } } }", "deep");
  expect(type("paramX"), "{ x: number; y?: string }", "parameter");
  return "ok";
});

test("별칭, 인터페이스, 클래스, 열거형은 이름을 쓴다", () => {
  expect(type("state"), "State", "const of alias");
  expect(type("Long"), "Long", "type alias declaration");
  expect(type("longValue"), "Long", "const of union alias");
  expect(type("Shape"), "Shape", "interface");
  expect(type("Counter"), "Counter", "class");
  expect(type("Color"), "Color", "enum");
  expect(type("p"), "Pair<number>", "generic instance");
  return "ok";
});

test("긴 유니온과 튜플이 잘리지 않는다", () => {
  const union = type("item")!;
  expect(union.split(" | ").length, 20, "20 members");
  expect(union.includes("..."), false, "no ellipsis");
  expect(union.startsWith('"alpha" | "bravo"') && union.endsWith('"tango"'), true, "ends");
  expect(type("mixed")!.includes('b: "alpha" | "bravo"'), true, "union inside object");
  return "ok";
});

test("함수 선언과 메서드는 반환 타입, 시그니처는 화살표 타입", () => {
  expect(type("makeState"), "State", "return type");
  expect(signature("makeState"), "(n: number) => State", "signature");
  expect(type("pair"), "Pair<T>", "generic return");
  expect(signature("pair"), "<T>(a: T, b: T) => Pair<T>", "generic signature");
  expect(type("add"), "number", "method return");
  expect(signature("add"), "(a: string, b?: number) => number", "method signature with optional");
  expect(signature("area"), "() => number", "no params");
  expect(signature("withParam"), "(param: { x: number; y?: string }, ...rest: number[]) => number", "object param and rest");
  return "ok";
});

test("오버로드 표시(+1 overload)는 반환 타입에 들어가지 않는다", () => {
  expect(type("over"), "string", "return");
  expect(signature("over"), "(a: string) => string", "signature");
  return "ok";
});

test("값의 타입: 변수, 프로퍼티, 옵셔널", () => {
  expect(type("total"), "number", "property");
  expect(type("step"), "number | undefined", "optional property");
  expect(type("totalConst"), "number", "const");
  expect(type("counter"), "Counter", "instance");
  return "ok";
});

test("함수 타입을 가진 변수: 타입은 그 함수 타입, 시그니처도 같다", () => {
  expect(type("arrow"), "(name: string) => number", "arrow type");
  expect(signature("arrow"), "(name: string) => number", "arrow signature");
  expect(type("fnGeneric"), "<T extends object>(value: T, key: keyof T) => T[keyof T]", "generic arrow");
  expect(signature("asyncFn"), "(id: number) => Promise<{ id: number }>", "async arrow");
  return "ok";
});

test("함수가 아니면 시그니처가 없다", () => {
  expect(signature("values"), null, "variable");
  expect(signature("state"), null, "alias const");
  expect(signature("Counter"), null, "class");
  return "ok";
});

test("import 별칭의 hover 는 import 줄을 버리고 안쪽 선언으로 본다", () => {
  const alias: DisplayPart[] = [
    { text: "(", kind: "punctuation" },
    { text: "alias", kind: "text" },
    { text: ")", kind: "punctuation" },
    { text: " ", kind: "space" },
    ...data.makeState!.parts,
    { text: "\n", kind: "lineBreak" },
    { text: "import", kind: "keyword" },
    { text: " ", kind: "space" },
    { text: "makeState", kind: "aliasName" },
  ];
  expect(typeFromParts(alias), "State", "alias function return");
  expect(signatureFromParts(alias), "(n: number) => State", "alias function signature");
  return "ok";
});

test("모르는 모양이면 null", () => {
  expect(typeFromParts([{ text: "hello", kind: "text" }]), null, "plain text");
  expect(typeFromParts([]), null, "empty");
  return "ok";
});

test("isFunctionType: 최상위 =>", () => {
  expect(isFunctionType("(a: string) => void"), true, "arrow");
  expect(isFunctionType("<T>(a: T) => T"), true, "generic");
  expect(isFunctionType("{ f: (a: string) => void }"), false, "nested only");
  expect(isFunctionType("Promise<() => void>"), false, "inside generic");
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
