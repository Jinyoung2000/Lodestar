import { countNotApplied, feedbackBadge, feedbackFailureReason } from "../web/feedbackBadge";
import type { Feedback } from "../shared/protocol";

const cases: { name: string; run: () => string }[] = [];
const test = (name: string, run: () => string) => cases.push({ name, run });
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
  return detail;
};

type Input = Pick<Feedback, "status" | "retrying" | "restartPending" | "failure">;
const fb = (patch: Partial<Input>): Input => ({ status: "applied", retrying: false, restartPending: false, failure: null, ...patch });
const show = (b: ReturnType<typeof feedbackBadge>) => (b ? `${b.label}/${b.tone}/${b.icon}` : "null");

test("running has no badge (the row's own running indicator covers it)", () => {
  return expect(feedbackBadge(fb({ status: "running" })) === null, show(feedbackBadge(fb({ status: "running" }))));
});
test("a row without a feedback record has no badge", () => expect(feedbackBadge(undefined) === null, "undefined"));
test("checking is Checking with the info tone", () => {
  const b = feedbackBadge(fb({ status: "checking" }));
  return expect(b?.label === "Checking" && b.tone === "info" && b.spin === true, show(b));
});
test("fixing is Fixing with a dim muted tone and a spinner", () => {
  const b = feedbackBadge(fb({ status: "fixing" }));
  return expect(b?.label === "Fixing" && b.tone === "muted" && b.spin === true && b.status === "fixing", show(b));
});
test("fixing while re-applying onto the main folder reads Re-applying", () => {
  const b = feedbackBadge({ ...fb({ status: "fixing" }), reapplying: true });
  return expect(b?.label === "Re-applying" && b.status === "fixing" && b.spin === true, show(b));
});
test("a retry of failed checks reads Checking, not Not applied", () => {
  const b = feedbackBadge(fb({ status: "failed", retrying: true, failure: "Not applied: tsc failed" }));
  return expect(b?.label === "Checking" && b.status === "checking", show(b));
});
test("applied is Applied with the success tone", () => {
  const b = feedbackBadge(fb({ status: "applied" }));
  return expect(b?.label === "Applied" && b.tone === "success", show(b));
});
test("awaitingRestart is Restart needed with the warning tone", () => {
  const b = feedbackBadge(fb({ status: "awaitingRestart" }));
  return expect(b?.label === "Restart needed" && b.tone === "warning", show(b));
});
test("reverted with restartPending still needs a restart", () => {
  const b = feedbackBadge(fb({ status: "reverted", restartPending: true }));
  return expect(b?.label === "Restart needed" && b.tone === "warning", show(b));
});
test("reverted without restartPending is Reverted, muted", () => {
  const b = feedbackBadge(fb({ status: "reverted" }));
  return expect(b?.label === "Reverted" && b.tone === "muted", show(b));
});
test("noChanges is No changes, muted", () => {
  const b = feedbackBadge(fb({ status: "noChanges" }));
  return expect(b?.label === "No changes" && b.tone === "muted", show(b));
});
test("needsInput is Needs your reply with the accent tone, not a failure look", () => {
  const b = feedbackBadge(fb({ status: "needsInput" }));
  return expect(b?.label === "Needs your reply" && b.tone === "accent" && b.status === "needsInput" && countNotApplied([fb({ status: "needsInput" })]) === 0, show(b));
});
test("failed is Not applied with the calm failed tone and an error icon, not No changes' dash (check failure, conflict, session error alike)", () => {
  const reasons = ["Not applied: tsc failed", "Not applied: conflict in web/store.ts", "Agent session failed", null];
  const bad = reasons.filter((failure) => feedbackBadge(fb({ status: "failed", failure }))?.label !== "Not applied" || feedbackBadge(fb({ status: "failed", failure }))?.tone !== "failed" || feedbackBadge(fb({ status: "failed", failure }))?.icon !== "error");
  return expect(bad.length === 0 && feedbackBadge(fb({ status: "failed" }))?.icon !== feedbackBadge(fb({ status: "noChanges" }))?.icon, `${reasons.length} reasons`);
});
test("every status maps to a distinct badge except running", () => {
  const statuses = ["checking", "awaitingRestart", "applied", "failed", "reverted", "noChanges", "needsInput"] as const;
  const labels = new Set(statuses.map((status) => feedbackBadge(fb({ status }))?.label));
  return expect(labels.size === statuses.length && !labels.has(undefined), [...labels].join(","));
});
test("failure reason is the first line without the Not applied prefix", () => {
  const reason = feedbackFailureReason(fb({ status: "failed", failure: "Not applied: tsc failed\nweb/a.ts(3,1): error TS2322" }));
  return expect(reason === "Not applied: tsc failed", String(reason));
});
test("failure reason is null for non-failed and while retrying", () => {
  const values = [feedbackFailureReason(fb({ status: "applied" })), feedbackFailureReason(fb({ status: "failed", retrying: true, failure: "x" })), feedbackFailureReason(fb({ status: "failed", failure: "" }))];
  return expect(values.every((v) => v === null), values.join(","));
});
test("countNotApplied counts failed rows only, ignoring missing records and retries", () => {
  const n = countNotApplied([fb({ status: "failed" }), fb({ status: "failed" }), fb({ status: "failed", retrying: true }), fb({ status: "applied" }), fb({ status: "noChanges" }), undefined]);
  return expect(n === 2, String(n));
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
