import { readFileSync } from "node:fs";
import { partsFromHoverMarkdown } from "../web/hoverParts";
import { signatureFromParts, typeFromParts } from "../web/typeParts";

const hovers = JSON.parse(readFileSync(new URL("./fixtures/native-hover.json", import.meta.url), "utf8")) as Record<string, string>;

let failed = 0;
const check = (name: string, actual: unknown, expected: unknown) => {
  const ok = actual === expected;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` (${JSON.stringify(actual)} !== ${JSON.stringify(expected)})`}`);
  if (!ok) failed++;
};
const parts = (key: string) => partsFromHoverMarkdown(hovers[key]!);
const type = (key: string) => {
  const p = parts(key);
  return p ? typeFromParts(p) : null;
};
const signature = (key: string) => {
  const p = parts(key);
  return p ? signatureFromParts(p) : null;
};

check("별칭 const 는 이름", type("longValue"), "Long");
check("type 별칭 선언은 이름", type("Long"), "Long");
check("8단계 중첩 객체를 한 줄로", type("deep"), "{ a: { b: { c: { d: { e: { f: { g: { h: number } } } } } } } }");
check("객체 리터럴 타입", type("anon"), "{ id: number; tags: string[]; nested: { ok: boolean } }");
check("함수 선언은 반환 타입", type("makeState"), "State");
check("함수 선언 시그니처", signature("makeState"), "(n: number) => State");
check("제네릭 함수 시그니처와 튜플 반환", signature("pair"), "<T>(a: T, b: T) => [T, T]");
check("제네릭 함수 반환 타입", type("pair"), "[T, T]");
check("클래스는 이름", type("Counter"), "Counter");
check("프로퍼티 타입", type("total"), "number");
check("옵셔널 프로퍼티는 undefined 까지", type("step"), "number | undefined");
check("메서드 반환 타입", type("add"), "number");
check("메서드 시그니처(옵셔널 매개변수)", signature("add"), "(a: string, b?: number) => number");
check("화살표 함수를 가진 const: 타입", type("arrow"), "(name: string) => number");
check("화살표 함수를 가진 const: 시그니처", signature("arrow"), "(name: string) => number");
check("제네릭 화살표 함수", type("fnGeneric"), "<T extends object>(value: T, key: keyof T) => T[keyof T]");
check("async 화살표의 Promise 객체", signature("asyncFn"), "(id: number) => Promise<{ id: number }>");
check("인터페이스는 이름", type("Shape"), "Shape");
check("열거형은 이름", type("Color"), "Color");
check("인터페이스 메서드 시그니처", signature("area"), "() => number");
check("객체 매개변수와 나머지 매개변수", signature("withParam"), "(param: { x: number; y?: string }, ...rest: number[]) => number");
check("변수 이름이 type 이어도 변수로 읽음", type("typeVar"), "{ kind: string; n: number }");
check("import 별칭 함수는 안쪽 선언으로", type("importAlias"), "State");
check("import 별칭 함수 시그니처", signature("stateUse"), "(n: number) => State");
check("함수가 아닌 값은 시그니처 없음", signature("anon"), null);
check("클래스는 시그니처 없음", signature("Counter"), null);
check("tsserver 가 import 줄을 덧붙인 별칭도 안쪽 선언으로", (() => {
  const p = partsFromHoverMarkdown("```typescript\n(alias) function makeState(n: number): State\nimport makeState\n```\n");
  return p ? typeFromParts(p) : null;
})(), "State");
check("코드 블록이 없으면 null", partsFromHoverMarkdown("just text"), null);
check("빈 블록이면 null", partsFromHoverMarkdown("```typescript\n```\n"), null);
check("첫 블록만 읽음", (() => {
  const p = partsFromHoverMarkdown("```typescript\nconst a: number\n```\n\nDocs\n\n```ts\nconst b: string\n```\n");
  return p ? typeFromParts(p) : null;
})(), "number");

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("all passed");
