import { kindFromDetail, lspTypeOf } from "../web/completionResolve";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed++;
};

check("function, class, interface, variable and keyword keep their own names", lspTypeOf(3) === "function" && lspTypeOf(7) === "class" && lspTypeOf(8) === "interface" && lspTypeOf(6) === "variable" && lspTypeOf(14) === "keyword");
check("method and constructor, field and property are told apart", lspTypeOf(2) === "method" && lspTypeOf(4) === "constructor" && lspTypeOf(5) === "field" && lspTypeOf(10) === "property");
check("enum, enum member, constant and struct are told apart", lspTypeOf(13) === "enum" && lspTypeOf(20) === "enumMember" && lspTypeOf(21) === "constant" && lspTypeOf(22) === "struct");
check("snippet, module, event, operator and type parameter", lspTypeOf(15) === "snippet" && lspTypeOf(9) === "module" && lspTypeOf(23) === "event" && lspTypeOf(24) === "operator" && lspTypeOf(25) === "typeParameter");
check("every kind from 1 to 25 maps to a distinct name", new Set(Array.from({ length: 25 }, (_, i) => lspTypeOf(i + 1))).size === 25);
check("an unknown kind falls back to text", lspTypeOf(99) === "text");

check("the detail's first words give the real kind of an imported name", kindFromDetail("(alias) function greet(user: User): string") === "function" && kindFromDetail("(alias) class Greeter") === "class" && kindFromDetail("interface User") === "interface");
check("variables and methods are read from the detail too", kindFromDetail("(local var) x: number") === "variable" && kindFromDetail("(method) Greeter.say(text: string): string") === "method" && kindFromDetail("const a: number") === "variable");
check("an unrelated detail gives nothing", kindFromDetail("Auto import from './util'") === null);

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("completion kinds: all passed");
