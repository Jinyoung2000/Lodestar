import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const root = realpathSync(mkdtempSync(join(tmpdir(), "chkbase-")));
process.env.AGENT_NAV_HOME = join(root, "home");
const countFile = join(root, "runs.txt");
process.env.CHKBASE_COUNT = countFile;

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed++;
};

const { FeedbackRunner } = await import("../server/feedback");
const { newFailures, testFailures, tscFailures, baselineKey, quotedStrings } = await import("../server/checkBaseline");

{
  const tsc = (lines: string[]) => tscFailures(lines.join("\n"));
  const base = tsc(["web/Timeline.tsx(159,23): error TS2339: Property 'path' does not exist on type 'X'.", "  Property 'path' does not exist on type 'Y'.", "Found 1 error in web/Timeline.tsx:159"]);
  check("tsc: one error with its continuation line, summary line dropped", base.length === 1 && base[0].key.includes("Property 'path' does not exist on type 'Y'") && !base[0].key.includes("Found"));
  const shifted = tsc(["web/Timeline.tsx(171,23): error TS2339: Property 'path' does not exist on type 'X'.", "  Property 'path' does not exist on type 'Y'."]);
  check("tsc: same error on a shifted line is not new", newFailures(shifted, base).length === 0);
  const extra = tsc(["web/Timeline.tsx(171,23): error TS2339: Property 'path' does not exist on type 'X'.", "  Property 'path' does not exist on type 'Y'.", "web/Other.tsx(3,1): error TS2304: Cannot find name 'z'."]);
  const fresh = newFailures(extra, base);
  check("tsc: only the new error is reported", fresh.length === 1 && fresh[0].text.startsWith("web/Other.tsx(3,1)"));
  const twice = tsc(["a.ts(1,1): error TS1: m", "a.ts(2,1): error TS1: m"]);
  check("tsc: a second copy of the same message counts as new", newFailures(twice, tsc(["a.ts(1,1): error TS1: m"])).length === 1);
  check("tsc: unparseable output still yields one failure", tscFailures("boom\nmore").length === 1);

  const tests = testFailures("tsx test/a.test.ts", "ok  one\nFAIL two (got 5 want 6)\nFAIL three\n");
  check("tests: FAIL names without the detail", tests.map((t) => t.key).join("|") === "tsx test/a.test.ts: two|tsx test/a.test.ts: three");
  const crashA = testFailures("tsx test/a.test.ts", "Error: listen EADDRINUSE :::7802\n");
  const crashB = testFailures("tsx test/a.test.ts", "Error: listen EADDRINUSE :::7806\n");
  check("tests: a crash without FAIL lines matches across port numbers", crashA[0].key === crashB[0].key);
  const png = "Feedback with a screenshot that is not a PNG is rejected";
  const inWorktree = testFailures("tsx test/security.test.ts", `ok  one\nFAIL ${png}: The Lodestar source folder is not a git repo: /Users/me/Repository/agent-nav.worktrees/feedback-86e9782f\n`);
  const inBase = testFailures("tsx test/security.test.ts", `FAIL ${png}: The Lodestar source folder is not a git repo: /Users/me/.agent-nav/feedback/86e9782f/base\n`);
  check("tests: the same test failing with a different path in the error is not new", inWorktree[0].key === `tsx test/security.test.ts: ${png}` && newFailures(inWorktree, inBase).length === 0);
  check("tests: a different test with the same error text is new", newFailures(testFailures("tsx test/security.test.ts", "FAIL Another test: The Lodestar source folder is not a git repo: /x\n"), inBase).length === 1);
  const named = "Developer 명령: Reload Window 는 ⌘R, Restart Daemon 은 키 없이 있다";
  const known = quotedStrings(`test("${named}", () => 1); test("Other 명령: Something else", () => 1);`);
  const sameNamed = testFailures("tsx test/o.test.ts", `FAIL ${named}: developer 로 둘 다 찾는다\n`, known);
  const diffDetail = testFailures("tsx test/o.test.ts", `FAIL ${named}: other message\n`, known);
  const otherNamed = testFailures("tsx test/o.test.ts", "FAIL Other 명령: Something else: boom\n", known);
  check("tests: a name containing a colon keeps its full name when the file lists it", sameNamed[0].key === `tsx test/o.test.ts: ${named}` && newFailures(diffDetail, sameNamed).length === 0);
  check("tests: two tests sharing the part before the colon stay distinct", newFailures(otherNamed, sameNamed).length === 1);
  check("tests: judgment reads the whole output, a FAIL line after a long prefix is still found", testFailures("t", `${"x".repeat(5000)}\nFAIL late failure: y\n`)[0].key === "t: late failure");
  check("baselineKey follows file hashes", baselineKey({ a: "1", b: "2" }) === baselineKey({ b: "2", a: "1" }) && baselineKey({ a: "1" }) !== baselineKey({ a: "2" }));
}

const NOTE = `import { appendFileSync } from "node:fs";
appendFileSync(process.env.CHKBASE_COUNT, process.cwd() + "\\n");
`;
const TSC_SCRIPT = `${NOTE}
import { readFileSync } from "node:fs";
const ui = readFileSync("web/ui.txt", "utf8");
const preexisting = readFileSync("test/preexisting.txt", "utf8").trim() === "on";
const shift = ui === "after\\n" ? 12 : 10;
const lines = [];
if (preexisting) lines.push("web/Old.tsx(" + shift + ",5): error TS2339: Property 'path' does not exist.");
if (ui === "newerror\\n") lines.push("web/New.tsx(1,1): error TS2304: Cannot find name 'fresh'.");
if (lines.length) { console.log(lines.join("\\n")); process.exit(1); }
`;
const TEST_A = `${NOTE}
console.log("FAIL always broken (x)");
process.exit(1);
`;
const TEST_B = `import { readFileSync } from "node:fs";
if (readFileSync("web/ui.txt", "utf8") === "newerror\\n") { console.log("FAIL second file broke"); process.exit(1); }
`;
const BUILD = `${NOTE}
import { mkdirSync, writeFileSync } from "node:fs";
if (process.env.BUILD_FAIL !== "0") process.exit(1);
mkdirSync("dist", { recursive: true });
writeFileSync("dist/index.html", "built");
`;

function sourceRepo(name: string, files: Record<string, string>) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const put = (rel: string, text: string) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  };
  put("web/ui.txt", "before\n");
  put("test/preexisting.txt", "on");
  put("tsc.mjs", TSC_SCRIPT);
  put("build.mjs", BUILD);
  put("t1.mjs", TEST_A);
  put("t2.mjs", TEST_B);
  put("package.json", JSON.stringify({ scripts: { test: "node t1.mjs && node t2.mjs" } }));
  for (const [rel, text] of Object.entries(files)) put(rel, text);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return { dir };
}

type Spec = ConstructorParameters<typeof FeedbackRunner>[0]["checks"];
function harness(src: string, checks: Spec) {
  const notices: { text: string; detail?: string; fold?: { label: string; text: string } }[] = [];
  const agents = { adopt: () => undefined, send: async () => undefined, notice: (_id: string, text: string, detail?: string, fold?: { label: string; text: string }) => void notices.push({ text, detail, fold }) };
  const store = { settings: { feedbackModel: "haiku" }, addWorkspace: () => ({ id: "w" }), workspaces: [], agent: () => ({ status: "idle" }), timeline: () => [] };
  const runner = new FeedbackRunner({ store: store as never, agents: agents as never, emit: () => undefined, srcRoot: src, port: 0, restart: () => undefined, busyCount: () => 0, checks, autoFixes: 0 });
  return { runner, notices };
}

async function runFeedback(runner: InstanceType<typeof FeedbackRunner>, ui: string) {
  const feedback = await runner.create({ text: "change the ui text", element: null, screenshot: null, screenshotNote: null });
  writeFileSync(join(feedback.worktree, "web/ui.txt"), ui);
  runner.afterTurn(feedback.agentId);
  for (let i = 0; i < 1200; i++) {
    const status = runner.get(feedback.id).status;
    if (status === "applied" || status === "failed" || status === "awaitingRestart" || status === "noChanges") break;
    await new Promise((r) => setTimeout(r, 50));
  }
  return runner.get(feedback.id);
}

const baseRuns = () => (existsSync(countFile) ? readFileSync(countFile, "utf8").split("\n").filter((l) => l.includes("/base")).length : 0);
const DIST = { name: "dist", command: "node", args: ["-e", "require('fs').mkdirSync('dist',{recursive:true});require('fs').writeFileSync('dist/index.html','x')"], timeoutMs: 30_000 };
const TSC = [{ name: "tsc", command: "node", args: ["tsc.mjs"], timeoutMs: 30_000, kind: "tsc" as const }, DIST];

{
  const src = sourceRepo("tscOld", {});
  const { runner, notices } = harness(src.dir, TSC);
  const f = await runFeedback(runner, "after\n");
  check("pre-existing tsc error (shifted line) is ignored and applied", f.status === "applied" && f.checks[0].ok && f.checks[0].ignored === 1, `${f.status} ${f.failure ?? ""}`);
  check("applied notice says how many were ignored", notices.some((n) => n.text.startsWith("Applied (pre-existing check failures ignored: 1):")));
  check("applied notice folds the baseline output", notices.some((n) => n.fold?.text.includes("also fails without this feedback") && n.fold.text.includes("web/Old.tsx(10,5)")));
  check("main folder got the feedback change", readFileSync(join(src.dir, "web/ui.txt"), "utf8") === "after\n");
  check("base copy is removed after the run", !existsSync(join(process.env.AGENT_NAV_HOME!, "feedback", f.id, "base")));
}

{
  const src = sourceRepo("tscNew", { "web/other.txt": "x" });
  const { runner, notices } = harness(src.dir, TSC);
  const before = baseRuns();
  const f = await runFeedback(runner, "newerror\n");
  check("a new tsc error fails the feedback", f.status === "failed" && !f.checks[0].ok && f.checks[0].ignored === 1);
  check("only the new error is shown", (f.failure ?? "").includes("web/New.tsx(1,1)") && !(f.failure ?? "").includes("web/Old.tsx"), f.failure ?? "");
  check("failure notice carries the baseline fold", notices.some((n) => n.text.startsWith("Not applied") && n.fold?.text.includes("web/Old.tsx")));
  check("main folder is untouched", readFileSync(join(src.dir, "web/ui.txt"), "utf8") === "before\n");
  check("baseline ran once", baseRuns() - before === 1, String(baseRuns() - before));
  const g = await runFeedback(runner, "newerror\n");
  check("second feedback on the same base state hits the cache", g.status === "failed" && baseRuns() - before === 1, String(baseRuns() - before));
}

{
  const src = sourceRepo("tscClean", { "test/preexisting.txt": "off" });
  const { runner } = harness(src.dir, TSC);
  const f = await runFeedback(runner, "newerror\n");
  check("baseline passes: the whole output is shown and nothing is ignored", f.status === "failed" && !f.checks[0].ignored && (f.failure ?? "").includes("web/New.tsx(1,1)"));
}

{
  const src = sourceRepo("tests", {});
  const specs = [{ name: "npm test", command: "npm", args: ["test"], timeoutMs: 60_000, kind: "tests" as const }, DIST];
  const { runner } = harness(src.dir, specs);
  const ok = await runFeedback(runner, "after\n");
  check("only the always-broken test fails: ignored", ok.status === "applied" && ok.checks[0].ignored === 1, `${ok.status} ${ok.failure ?? ""}`);
  const { runner: second } = harness(sourceRepo("tests2", {}).dir, specs);
  const bad = await runFeedback(second, "newerror\n");
  check("a failure in the second test file is new even though the first file fails too", bad.status === "failed" && (bad.failure ?? "").includes("second file broke") && !(bad.failure ?? "").includes("always broken"), bad.failure ?? "");
}

{
  const src = sourceRepo("build", {});
  const specs = [{ name: "npm run build", command: "node", args: ["build.mjs"], timeoutMs: 30_000, kind: "build" as const }];
  const { runner } = harness(src.dir, specs);
  const f = await runFeedback(runner, "after\n");
  check("failed build with no dist is not ignored", f.status === "failed" && !f.checks[0].ok && !f.checks[0].ignored, `${f.status}`);
}

rmSync(root, { recursive: true, force: true });
if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("all passed");
