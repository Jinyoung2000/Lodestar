import { clampTitle, shortTitle, TITLE_MAX } from "../shared/sessionTitle";

let failed = 0;
const check = (name: string, actual: unknown, expected: unknown) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
  if (!ok) failed++;
};

check("plain one line stays", shortTitle("Fix the login bug"), "Fix the login bug");
check("only the first line", shortTitle("Fix the login bug\n\nSteps:\n1. open the page"), "Fix the login bug");
check("blank lines first are skipped", shortTitle("\n\n  \nFix it\nmore"), "Fix it");
check("heading marker", shortTitle("## Plan the release\ntext"), "Plan the release");
check("quote and list markers", shortTitle("> - [ ] buy milk"), "buy milk");
check("numbered list", shortTitle("1. First do this"), "First do this");
check("code fence lines are skipped", shortTitle("```ts\nconst a = 1;\n```"), "const a = 1;");
check("horizontal rule is skipped", shortTitle("---\nReal title"), "Real title");
check("bold, inline code, link, image", shortTitle("**Fix** `foo()` in [the docs](http://x.y) ![shot](a.png)"), "Fix foo() in the docs shot");
check("emphasis with stars but not snake_case or math", shortTitle("*really* use snake_case and 2 * 3 * 4"), "really use snake_case and 2 * 3 * 4");
check("strikethrough", shortTitle("~~old~~ new"), "old new");
check("empty input gives empty", shortTitle("  \n\n"), "");
check("only fences gives empty", shortTitle("```\n```"), "");

const long = "Do exactly this: 1) Call TodoWrite with three todos: alpha, beta, gamma 2) then read the README and summarize it in one sentence";
const out = shortTitle(long);
check("long first line is cut at a word boundary with an ellipsis", out.endsWith("…") && out.length <= TITLE_MAX && !out.slice(0, -1).endsWith(" ") && long.startsWith(out.slice(0, -1)), true);
console.log(`     ${out}`);
check("a long unbroken word is cut hard", clampTitle("x".repeat(100), 20), `${"x".repeat(19)}…`);
check("clamp leaves short text alone and collapses spaces", clampTitle("a   b\tc", 20), "a b c");
check("clamp respects the max including the ellipsis", clampTitle("alpha beta gamma delta", 12).length <= 12, true);
check("korean text", shortTitle("로그인 버그를 고쳐 줘\n재현 방법은 아래와 같다"), "로그인 버그를 고쳐 줘");

if (failed) {
  console.log(`${failed} failed`);
  process.exit(1);
}
