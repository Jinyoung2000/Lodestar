import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Feedback } from "../shared/protocol";

const root = realpathSync(mkdtempSync(join(tmpdir(), "fbresolve-")));
process.env.AGENT_NAV_HOME = join(root, "home");

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed++;
};

const { FeedbackRunner } = await import("../server/feedback");
const { canTidy, improvementRows, matchesImprovement, notAppliedCount } = await import("../web/improvementRows");
const { feedbackBadge } = await import("../web/feedbackBadge");

const src = join(root, "src");
mkdirSync(join(src, "web"), { recursive: true });
writeFileSync(join(src, "web/ui.txt"), "x\n");
execFileSync("git", ["init", "-q"], { cwd: src });

type Runner = InstanceType<typeof FeedbackRunner>;
const agentState = { status: "idle" };
function daemon() {
  const notices: string[] = [];
  const events: Feedback[] = [];
  const runner: Runner = new FeedbackRunner({
    store: { settings: { feedbackModel: "haiku" }, addWorkspace: () => ({ id: "w" }), workspaces: [], agent: () => agentState, timeline: () => [] } as never,
    agents: { adopt: () => undefined, send: async () => undefined, notice: (_id: string, text: string) => void notices.push(text) } as never,
    emit: (event) => {
      const f = (event as { feedback?: Feedback }).feedback;
      if (f) events.push({ ...f });
    },
    srcRoot: src,
    port: 0,
    restart: () => undefined,
    busyCount: () => 0,
    checks: [],
  });
  return { runner, notices, events };
}

async function seeded(patch: Partial<Feedback>) {
  const first = daemon();
  const created = await first.runner.create({ text: "fix the thing", element: null, screenshot: null, screenshotNote: null });
  const file = join(root, "home", "feedback", created.id, "state.json");
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), ...patch }, null, 2));
  return { id: created.id, file, second: daemon() };
}

{
  const { id, file, second } = await seeded({ status: "failed", failure: "Not applied: tsc failed", seen: false, conflict: true });
  const before = second.runner.get(id);
  check("starts as a failed feedback", before.status === "failed" && canTidy(before));
  const done = second.runner.resolve(id);
  check("resolve moves it to resolved and marks it seen", done.status === "resolved" && done.seen === true);
  check("the failure text stays as the record, the conflict mark is cleared", done.failure === "Not applied: tsc failed" && !done.conflict);
  check("a timeline notice says it was resolved by hand", second.notices.some((n) => n.includes("resolved by hand")));
  check("the state file keeps it", JSON.parse(readFileSync(file, "utf8")).status === "resolved");
  const reloaded = daemon().runner.get(id);
  check("a restarted daemon still sees it as resolved", reloaded.status === "resolved" && reloaded.seen === true);
  check("the list event carried the new status", second.events.at(-1)?.status === "resolved");
  let again = "";
  try {
    second.runner.dismiss(id);
  } catch (error) {
    again = (error as Error).message;
  }
  check("a resolved feedback cannot be dismissed", again.includes("was not applied"), again);
}

{
  const { id, file, second } = await seeded({ status: "failed", failure: "Not applied: build failed", seen: false });
  const done = second.runner.dismiss(id);
  check("dismiss moves it to dismissed and marks it seen", done.status === "dismissed" && done.seen === true);
  check("a notice says it was dismissed", second.notices.some((n) => n.includes("Dismissed")));
  check("the state file keeps it", JSON.parse(readFileSync(file, "utf8")).status === "dismissed");
}

{
  const applied = await seeded({ status: "applied" });
  let message = "";
  try {
    applied.second.runner.resolve(applied.id);
  } catch (error) {
    message = (error as Error).message;
  }
  check("an applied feedback cannot be marked resolved", message.includes("was not applied") && applied.second.runner.get(applied.id).status === "applied", message);

  const busy = await seeded({ status: "failed", failure: "Not applied: x" });
  agentState.status = "running";
  message = "";
  try {
    busy.second.runner.dismiss(busy.id);
  } catch (error) {
    message = (error as Error).message;
  }
  agentState.status = "idle";
  check("a failed feedback whose session is running again is refused", message.includes("still running") && busy.second.runner.get(busy.id).status === "failed", message);

  const retrying = await seeded({ status: "failed", failure: "Not applied: x" });
  const item = retrying.second.runner.get(retrying.id);
  item.retrying = true;
  message = "";
  try {
    retrying.second.runner.resolve(retrying.id);
  } catch (error) {
    message = (error as Error).message;
  }
  check("a retry in progress is refused", message.includes("still running"), message);
}

{
  const base = { retrying: false, restartPending: false, failure: null, checks: [], changedFiles: [], createdAt: "2026-10-16T00:00:00Z", updatedAt: "2026-10-16T00:00:00Z" };
  const rows = {
    a: { ...base, id: "a", agentId: "ag1", status: "failed" as const, failure: "Not applied: x" },
    b: { ...base, id: "b", agentId: "ag2", status: "resolved" as const },
    c: { ...base, id: "c", agentId: "ag3", status: "dismissed" as const },
    d: { ...base, id: "d", agentId: "ag4", status: "applied" as const },
  };
  const agents = ["ag1", "ag2", "ag3", "ag4"].map((id) => ({ id, feedbackId: id, status: "idle" as const }));
  const ids = (filter: "all" | "notApplied" | "applied" | "dismissed") => improvementRows(rows, agents, filter, null).map((f) => f.id).sort().join(",");
  check("All hides dismissed ones", ids("all") === "a,b,d", ids("all"));
  check("Not applied lists only the failed one", ids("notApplied") === "a", ids("notApplied"));
  check("Applied also holds the resolved one", ids("applied") === "b,d", ids("applied"));
  check("Dismissed shows only the dismissed one", ids("dismissed") === "c", ids("dismissed"));
  check("the sidebar count of not applied drops both", notAppliedCount(rows, agents) === 1);
  check("the open detail stays listed while selected, even when it no longer matches", improvementRows(rows, agents, "notApplied", "c").map((f) => f.id).sort().join(",") === "a,c");
  check("matchesImprovement agrees for a resolved one", matchesImprovement(rows.b, "applied") && !matchesImprovement(rows.b, "notApplied") && !matchesImprovement(rows.b, "dismissed"));
  check("badges: Resolved manually and Dismissed, both calm", feedbackBadge(rows.b)?.label === "Resolved manually" && feedbackBadge(rows.b)?.tone === "muted" && feedbackBadge(rows.c)?.label === "Dismissed" && feedbackBadge(rows.c)?.tone === "muted");
  check("only a failed, not-retrying row can be tidied", canTidy(rows.a) && !canTidy(rows.b) && !canTidy({ status: "failed", retrying: true }));
}

console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
