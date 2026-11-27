import { showsTaskNotice } from "../server/taskNotice";

type Item = import("../shared/protocol").TimelineItem;
const tool = (input: Record<string, unknown>): Item => ({ id: "t1", kind: "tool", name: "Bash", input, status: "done", output: null });

const checks: [string, boolean][] = [
  ["completed, Bash called without run_in_background: hidden (the Ran row already shows it)", showsTaskNotice("completed", tool({ command: "sleep 6 && wc -l README.md" })) === false],
  ["completed, Bash called with run_in_background: hidden (the task row shows it finished)", showsTaskNotice("completed", tool({ command: "npm run dev", run_in_background: true })) === false],
  ["completed, no matching tool call: hidden", showsTaskNotice("completed", undefined) === false],
  ["failed, Bash called without run_in_background: hidden (the Ran row shows the failure)", showsTaskNotice("failed", tool({ command: "false" })) === false],
  ["failed, background task: shown", showsTaskNotice("failed", tool({ command: "false", run_in_background: true })) === true],
  ["failed, no matching tool call: shown", showsTaskNotice("failed", undefined) === true],
  ["stopped: never shown", showsTaskNotice("stopped", tool({ command: "x", run_in_background: true })) === false],
];
let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) failed++;
}
console.log(failed ? `${failed} failed` : `${checks.length} passed`);
process.exit(failed ? 1 : 0);
