import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checksSummary, commitTextFor, commitTexts, defaultMergeMethod, mergeArea, mergeReadiness, requiredReviews, requiredReviewSummary } from "../shared/prMerge";
import type { PrCheck, PrDetail } from "../shared/prTypes";
import { parseDetail, parseMergeInfo } from "../server/prParse";

const here = dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(readFileSync(join(here, "fixtures/pr/data.json"), "utf8"));
const tmp = mkdtempSync(join(tmpdir(), "agent-nav-prmerge-"));
const logFile = join(tmp, "gh.log");
const stateFile = join(tmp, "gh-state.json");
process.env.PATH = `${resolve(here, "fixtures/pr/bin")}:${process.env.PATH}`;
process.env.FAKE_GH_LOG = logFile;
process.env.FAKE_GH_STATE = stateFile;
const calls = () => (existsSync(logFile) ? readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { args: string[]; stdin: string | null }) : []);
const ops = () => calls().map((c) => (c.args[1] === "graphql" ? (/(?:query|mutation)\s+(\w+)/.exec(JSON.parse(c.stdin ?? "{}").query)?.[1] ?? "") : c.args.join(" ")));
const reset = () => rmSync(logFile, { force: true });
const scenario = (name: string, extra: Record<string, unknown> = {}) => writeFileSync(stateFile, JSON.stringify({ replies: {}, pending: null, threads: [], comments: {}, deleted: [], resolved: {}, viewed: {}, reviews: [], issue: [], seq: 100, scenario: name, ...extra }));

try {
  const base = data.detail.repository;
  const info = parseMergeInfo("acme/widgets", base, base.pullRequest);
  assert.deepEqual(info.methods, { merge: true, squash: true, rebase: false });
  assert.equal(info.canWrite, true);
  assert.equal(info.headRefId, "REF_feature_42");
  assert.equal(info.headLabel, "acme:feature/42");
  assert.equal(info.headIsDefault, false);
  assert.equal(info.canDeleteHead, true);
  assert.deepEqual(parseMergeInfo("acme/widgets", {}, { number: 1, title: "t" }).methods, { merge: false, squash: false, rebase: false }, "필드가 없으면 방식 전부 꺼짐");
  assert.equal(parseMergeInfo("acme/widgets", { viewerPermission: "READ" }, {}).canWrite, false);
  assert.equal(parseMergeInfo("acme/widgets", { viewerPermission: "MAINTAIN" }, {}).canWrite, true);
  assert.equal(parseMergeInfo("acme/widgets", { viewerPermission: "ADMIN" }, {}).canWrite, true);
  assert.equal(parseMergeInfo("acme/widgets", { viewerPermission: "TRIAGE" }, {}).canWrite, false);
  assert.equal(parseMergeInfo("acme/widgets", { viewerPermission: "ADMIN" }, { headRepository: { nameWithOwner: "me/widgets", viewerPermission: "READ" } }).canDeleteHead, false);
  assert.equal(parseMergeInfo("acme/widgets", {}, { headRefName: "main", headRepository: { nameWithOwner: "acme/widgets", defaultBranchRef: { name: "main" } } }).headIsDefault, true);
  assert.equal(parseMergeInfo("acme/widgets", {}, { headRef: null }).headRefId, null, "원격 head 가 지워졌으면 null");

  assert.equal(defaultMergeMethod({ merge: true, squash: true, rebase: true }), "merge");
  assert.equal(defaultMergeMethod({ merge: false, squash: true, rebase: true }), "squash");
  assert.equal(defaultMergeMethod({ merge: false, squash: false, rebase: true }), "rebase");
  assert.equal(defaultMergeMethod({ merge: false, squash: false, rebase: false }), null);
  assert.equal(defaultMergeMethod({ merge: true, squash: true, rebase: true }, "squash"), "squash", "설정한 방식이 허용되면 그것");

  assert.equal(mergeReadiness("CONFLICTING", "BLOCKED"), "conflict");
  assert.equal(mergeReadiness("MERGEABLE", "BLOCKED"), "blocked");
  assert.equal(mergeReadiness("MERGEABLE", "BEHIND"), "behind");
  assert.equal(mergeReadiness("UNKNOWN", "BLOCKED"), "blocked");
  assert.equal(mergeReadiness("MERGEABLE", "UNSTABLE"), "mergeable");
  assert.equal(mergeReadiness("MERGEABLE", "HAS_HOOKS"), "mergeable");
  assert.equal(mergeReadiness("MERGEABLE", "CLEAN"), "mergeable");
  assert.equal(mergeReadiness("UNKNOWN", "UNKNOWN"), "unknown");
  assert.equal(mergeReadiness("UNKNOWN", null), "unknown");

  const pr = (patch: Partial<PrDetail>, merge: Partial<PrDetail["merge"]> = {}) => ({ state: "OPEN", isDraft: false, ...patch, merge: { ...info, ...merge } }) as Pick<PrDetail, "state" | "isDraft" | "merge">;
  assert.deepEqual(mergeArea(pr({})), { state: "open", readiness: "mergeable", action: "merge", canDeleteBranch: false });
  assert.equal(mergeArea(pr({}, { canWrite: false })).action, null, "쓰기 권한이 없으면 머지 버튼 없음");
  assert.deepEqual(mergeArea(pr({}, { mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" })), { state: "open", readiness: "conflict", action: null, canDeleteBranch: false });
  assert.equal(mergeArea(pr({}, { mergeStateStatus: "BLOCKED" })).action, null, "보호 규칙 미충족(필수 체크 실패, 필수 리뷰)이면 머지 버튼 없음");
  assert.equal(mergeArea(pr({}, { mergeStateStatus: "BEHIND" })).action, null);
  assert.equal(mergeArea(pr({}, { mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" })).action, null);
  assert.equal(mergeArea(pr({ isDraft: true }, { mergeStateStatus: "DRAFT" })).action, "ready");
  assert.equal(mergeArea(pr({ isDraft: true }, { canUpdate: false })).action, null, "고칠 수 없는 draft 는 Ready for Review 도 없음");
  assert.deepEqual(mergeArea(pr({ state: "MERGED" })), { state: "merged", readiness: "mergeable", action: null, canDeleteBranch: true });
  assert.equal(mergeArea(pr({ state: "CLOSED" })).state, "closed");
  assert.equal(mergeArea(pr({ state: "MERGED" }, { headRefId: null })).canDeleteBranch, false, "원격 브랜치가 이미 없으면 제안하지 않음");
  assert.equal(mergeArea(pr({ state: "MERGED" }, { headIsDefault: true })).canDeleteBranch, false, "기본 브랜치는 제안하지 않음");
  assert.equal(mergeArea(pr({ state: "MERGED" }, { canDeleteHead: false })).canDeleteBranch, false, "head 저장소에 쓰기 권한이 없으면 제안하지 않음");

  const src = { number: 42, title: "Add loud option", body: "Body text", headLabel: "acme:feature/42", commitMessages: ["First line\n\nmore detail"] };
  assert.deepEqual(commitTextFor("MERGE_MESSAGE", "PR_TITLE", src), { title: "Merge pull request #42 from acme:feature/42", body: "Add loud option" });
  assert.deepEqual(commitTextFor("PR_TITLE", "PR_BODY", src), { title: "Add loud option (#42)", body: "Body text" });
  assert.deepEqual(commitTextFor("PR_TITLE", "BLANK", src), { title: "Add loud option (#42)", body: "" });
  assert.deepEqual(commitTextFor("COMMIT_OR_PR_TITLE", "COMMIT_MESSAGES", src), { title: "First line (#42)", body: "more detail" }, "커밋 하나면 그 커밋의 첫 줄과 나머지");
  assert.deepEqual(commitTextFor("COMMIT_OR_PR_TITLE", "COMMIT_MESSAGES", { ...src, commitMessages: ["a", "b"] }), { title: "Add loud option (#42)", body: "* a\n\n* b" });
  assert.deepEqual(commitTexts({ mergeCommitTitle: null, mergeCommitMessage: null, squashMergeCommitTitle: null, squashMergeCommitMessage: null }, src), { merge: { title: "Merge pull request #42 from acme:feature/42", body: "Add loud option" }, squash: { title: "Add loud option (#42)", body: "" } }, "설정을 못 읽으면 확장의 기본 문구");
  const detail = parseDetail("acme/widgets", data.detail);
  assert.deepEqual(detail.merge.commitText.merge, { title: "Merge pull request #42 from acme:feature/42", body: "Add loud option to greet" });
  assert.equal(detail.merge.commitText.squash.title, "Add loud option to greet (#42)", "커밋 셋이면 PR 제목");
  assert.match(detail.merge.commitText.squash.body, /^\* Add loud option to greet\n\n\* Document the loud option/);

  assert.equal(requiredReviews(0, [], []), null);
  assert.deepEqual(detail.merge.requiredReviews, { count: 1, approvals: ["jun"], requestedChanges: [], state: "success" });
  assert.equal(requiredReviewSummary(requiredReviews(2, ["a"], [])!), "At least 2 approving reviews is required by reviewers with write access.");
  assert.equal(requiredReviewSummary(requiredReviews(1, [], ["b"])!), "1 review requesting changes by reviewers with write access.");
  assert.equal(requiredReviewSummary(requiredReviews(1, ["a"], [])!), "1 approving review by reviewers with write access.");
  const check = (state: PrCheck["state"]): PrCheck => ({ name: state, state, detail: "", url: null, durationMs: null });
  assert.equal(checksSummary([check("success"), check("failure"), check("success")]), "2 successful checks and 1 failed check");
  assert.equal(checksSummary(detail.checkList), "2 successful checks and 1 failed check and 1 pending check", "처음 나온 상태 순서로 센다");

  const { prHandlers } = await import("../server/pr");
  const handlers = prHandlers({ workspaces: () => [], addWorkspace: () => { throw new Error("unused"); }, workspaceOfDir: () => undefined, announce: () => undefined } as never);
  const ref = { repo: "acme/widgets", number: 42 };
  reset();
  await assert.rejects(() => handlers["pr.merge"]({ ...ref, prId: "PR_node_42", method: "squash", expectedHeadOid: "abc", commitHeadline: "t", commitBody: "" } as never), /explicit confirmation/);
  await assert.rejects(() => handlers["pr.merge"]({ ...ref, confirmed: "true", prId: "PR_node_42", method: "merge", expectedHeadOid: "abc", commitHeadline: "t", commitBody: "" } as never), /explicit confirmation/);
  await assert.rejects(() => handlers["pr.readyForReview"]({ ...ref, prId: "PR_node_42" } as never), /explicit confirmation/);
  await assert.rejects(() => handlers["pr.deleteBranch"]({ ...ref, headRefId: "REF_feature_42" } as never), /explicit confirmation/);
  assert.equal(calls().length, 0, "확인 없는 요청은 gh 를 한 번도 부르지 않는다");
  await assert.rejects(() => handlers["pr.merge"]({ ...ref, confirmed: true, prId: "PR_node_42", method: "fast-forward", expectedHeadOid: "abc", commitHeadline: "t", commitBody: "" } as never), /Unknown merge method/);
  assert.equal(calls().length, 0, "모르는 방식도 gh 전에 거절");

  const ok = { confirmed: true as const };
  scenario("");
  await handlers["pr.merge"]({ ...ref, ...ok, prId: "PR_node_42", method: "squash", expectedHeadOid: "abc1234def5678", commitHeadline: "Add loud option (#42) @file", commitBody: "* a" });
  const merged = calls()[0];
  assert.deepEqual(merged.args, ["api", "graphql", "--input", "-"]);
  const mergeBody = JSON.parse(merged.stdin ?? "");
  assert.match(mergeBody.query, /^mutation PrMerge\b/);
  assert.match(mergeBody.query, /mergePullRequest\(input: \$input\)/);
  assert.deepEqual(mergeBody.variables.input, { pullRequestId: "PR_node_42", mergeMethod: "SQUASH", expectedHeadOid: "abc1234def5678", commitHeadline: "Add loud option (#42) @file", commitBody: "* a" });
  reset();
  await handlers["pr.merge"]({ ...ref, ...ok, prId: "PR_node_42", method: "rebase", expectedHeadOid: "abc", commitHeadline: "ignored", commitBody: "ignored" });
  assert.deepEqual(JSON.parse(calls()[0].stdin ?? "").variables.input, { pullRequestId: "PR_node_42", mergeMethod: "REBASE", expectedHeadOid: "abc" }, "rebase 는 커밋 문구를 싣지 않는다");
  reset();
  await handlers["pr.merge"]({ ...ref, ...ok, prId: "PR_node_42", method: "merge", expectedHeadOid: "abc", commitHeadline: "Merge pull request #42 from acme:feature/42", commitBody: "Add loud option" });
  assert.equal(JSON.parse(calls()[0].stdin ?? "").variables.input.mergeMethod, "MERGE");
  const afterMerge = await handlers["pr.get"](ref);
  assert.equal(afterMerge.state, "MERGED", "가짜 gh 는 머지 뒤 MERGED 를 준다");
  assert.equal(mergeArea(afterMerge).canDeleteBranch, true, "저장소가 자동 삭제하지 않으면 머지 뒤 브랜치 삭제를 제안");

  scenario("draft");
  reset();
  assert.equal(mergeArea(await handlers["pr.get"](ref)).action, "ready");
  await handlers["pr.readyForReview"]({ ...ref, ...ok, prId: "PR_node_42" });
  assert.deepEqual(ops(), ["PrDetail", "PrReadyForReview"]);
  assert.deepEqual(JSON.parse(calls()[1].stdin ?? "").variables.input, { pullRequestId: "PR_node_42" });
  assert.equal((await handlers["pr.get"](ref)).isDraft, false);

  scenario("", { merged: "MERGE" });
  reset();
  assert.deepEqual(await handlers["pr.deleteBranch"]({ ...ref, ...ok, headRefId: "REF_feature_42" }), { branch: "feature/42" });
  assert.deepEqual(ops(), ["PrDeleteBranchInfo", "PrDeleteRef"]);
  assert.deepEqual(JSON.parse(calls()[1].stdin ?? "").variables.input, { refId: "REF_feature_42" });
  assert.equal((await handlers["pr.get"](ref)).merge.headRefId, null, "지운 뒤에는 head ref 가 없다");
  scenario("");
  reset();
  await assert.rejects(() => handlers["pr.deleteBranch"]({ ...ref, ...ok, headRefId: "REF_feature_42" }), /merged or closed/, "열린 PR 의 브랜치는 지우지 않는다");
  scenario("", { merged: "MERGE" });
  await assert.rejects(() => handlers["pr.deleteBranch"]({ ...ref, ...ok, headRefId: "REF_other" }), /changed or was already deleted/, "화면이 본 ref 와 다르면 지우지 않는다");
  scenario("autodelete", { merged: "MERGE" });
  await assert.rejects(() => handlers["pr.deleteBranch"]({ ...ref, ...ok, headRefId: "REF_feature_42" }), /changed or was already deleted/);
  assert.equal(mergeArea(await handlers["pr.get"](ref)).canDeleteBranch, false, "저장소가 머지 뒤 지웠으면 제안하지 않음");
  assert.ok(!ops().includes("PrDeleteRef"), "거절된 삭제는 deleteRef 를 부르지 않는다");

  const areaOf = async (name: string) => {
    scenario(name);
    return mergeArea(await handlers["pr.get"](ref));
  };
  assert.equal((await areaOf("conflict")).readiness, "conflict");
  assert.deepEqual(await areaOf("blocked"), { state: "open", readiness: "blocked", action: null, canDeleteBranch: false });
  assert.equal((await areaOf("behind")).readiness, "behind");
  assert.equal((await areaOf("unknown")).readiness, "unknown");
  assert.equal((await areaOf("nowrite")).action, null);
  scenario("blocked");
  assert.equal((await handlers["pr.get"](ref)).merge.requiredReviews?.state, "failure", "승인이 없으면 필수 리뷰 실패");
  scenario("rebaseonly");
  assert.equal(defaultMergeMethod((await handlers["pr.get"](ref)).merge.methods), "rebase");

  const guardLog = join(tmp, "guard.log");
  const guard = (args: string[], stdin: string) => {
    try {
      execFileSync(join(here, "fixtures/pr/guard-gh/gh"), args, { input: stdin, env: { ...process.env, GUARD_GH_LOG: guardLog }, stdio: ["pipe", "pipe", "pipe"] });
      return 0;
    } catch (error) {
      return (error as { status: number }).status;
    }
  };
  assert.equal(guard(["pr", "merge", "42", "--squash"], ""), 1);
  assert.equal(guard(["api", "graphql", "--input", "-"], JSON.stringify({ query: "mutation PrMerge($input: MergePullRequestInput!) { mergePullRequest(input: $input) { pullRequest { id } } }" })), 1);
  assert.equal(guard(["api", "graphql", "--input", "-"], JSON.stringify({ query: "mutation PrDeleteRef($input: DeleteRefInput!) { deleteRef(input: $input) { clientMutationId } }" })), 1);
  assert.equal(guard(["api", "-X", "DELETE", "repos/acme/widgets/git/refs/heads/feature/42"], ""), 1);
  assert.deepEqual(readFileSync(guardLog, "utf8").trim().split("\n").map((l) => JSON.parse(l).verdict), ["blocked", "blocked", "blocked", "blocked"]);

  console.log("prmerge: 모든 확인 통과");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
