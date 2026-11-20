// PR: GitHub Pull Requests 의 서버 로직과 diff 모델을 확인한다. GitHub 에는 닿지 않는다: gh 는 test/fixtures/pr/bin/gh (가짜)가 대신한다.
// 실행: npm test
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findRow, parsePatch, placeThreads, rangeRows, rightText, splitSuggestions, suggestionTemplate, toSplit, type DiffLine } from "../shared/prDiff";
import { parseDetail, parseFiles, parseList, listVariables } from "../server/prParse";
import { formatDuration, sortChecks, summarizeChecks } from "../web/prChecks";
import { mergeRepos, parseRemotes, parseRemoteUrl } from "../server/prRepos";

const here = dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(readFileSync(join(here, "fixtures/pr/data.json"), "utf8"));
const tmp = mkdtempSync(join(tmpdir(), "agent-nav-pr-"));
const logFile = join(tmp, "gh.log");
// 가짜 gh 를 PATH 맨 앞에 둔다. 이 시험 프로세스에서만 유효하다.
process.env.PATH = `${resolve(here, "fixtures/pr/bin")}:${process.env.PATH}`;
process.env.FAKE_GH_LOG = logFile;
const calls = () => (existsSync(logFile) ? readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { args: string[]; stdin: string | null }) : []);
const reset = () => rmSync(logFile, { force: true });

try {
  // 원격 주소 읽기
  assert.equal(parseRemoteUrl("https://github.com/acme/widgets.git"), "acme/widgets");
  assert.equal(parseRemoteUrl("https://github.com/acme/widgets"), "acme/widgets");
  assert.equal(parseRemoteUrl("git@github.com:acme/wid.gets.git"), "acme/wid.gets");
  assert.equal(parseRemoteUrl("ssh://git@github.com/acme/widgets.git"), "acme/widgets");
  assert.equal(parseRemoteUrl("https://x-access-token:abc@github.com/acme/widgets.git"), "acme/widgets");
  assert.equal(parseRemoteUrl("https://gitlab.com/acme/widgets.git"), null);
  assert.equal(parseRemoteUrl("/tmp/bare.git"), null);
  const remotes = parseRemotes("remote.origin.url git@github.com:me/widgets.git\nremote.upstream.url https://github.com/acme/widgets.git\nremote.lab.url https://gitlab.com/a/b.git");
  assert.deepEqual(remotes, [{ name: "origin", repo: "me/widgets" }, { name: "upstream", repo: "acme/widgets" }]);
  // fork 의 부모(upstream)는 원격에 없어도 저장소 목록에 들어간다. 같은 저장소는 폴더를 모은다.
  const repos = mergeRepos([{ dir: "/a", remotes }, { dir: "/b", remotes: [{ name: "origin", repo: "me/widgets" }] }], { "me/widgets": "acme/widgets", "acme/widgets": null });
  assert.deepEqual(repos.map((r) => r.fullName), ["me/widgets", "acme/widgets"]);
  assert.deepEqual(repos[0].dirs, ["/a", "/b"]);
  assert.deepEqual([repos[1].upstreamOf, repos[1].remote], ["me/widgets", "upstream"], "fork 의 upstream 은 그 저장소를 가리키는 원격 이름을 쓴다");
  const forkOnly = mergeRepos([{ dir: "/c", remotes: [{ name: "origin", repo: "me/tool" }] }], { "me/tool": "org/tool" });
  assert.deepEqual(forkOnly.map((r) => [r.fullName, r.upstreamOf, r.remote]), [["me/tool", null, "origin"], ["org/tool", "me/tool", "origin"]]);

  // 목록 변환
  assert.match(listVariables("acme/widgets").waiting, /repo:acme\/widgets is:pr is:open .*review-requested:@me/);
  const list = parseList("acme/widgets", data.list);
  assert.deepEqual([list.waiting.length, list.assigned.length, list.created.length, list.all.length], [2, 1, 1, 4]);
  const first = list.waiting[0];
  assert.deepEqual([first.number, first.title, first.author?.login, first.isDraft, first.checks, first.reviewDecision, first.comments], [42, "Add loud option to greet", "mina", false, "SUCCESS", "REVIEW_REQUIRED", 2]);
  assert.equal(list.assigned[0].isDraft, true);
  assert.equal(list.assigned[0].checks, "PENDING");
  assert.equal(list.created[0].checks, "FAILURE");
  assert.equal(list.waiting[1].checks, null, "체크 정보가 없는 PR");

  // 상세 변환
  const detail = parseDetail("acme/widgets", data.detail);
  assert.equal(detail.id, "PR_node_42");
  assert.equal(detail.headSha, "abc1234def5678");
  assert.equal(detail.headRepo, null);
  assert.equal(detail.viewer?.login, "me-test");
  assert.deepEqual(detail.labels.map((l) => l.name), ["enhancement", "needs-docs"]);
  assert.deepEqual(detail.reviewers.map((r) => [r.name, r.state]), [["me-test", "REQUESTED"], ["web-team", "REQUESTED"], ["jun", "APPROVED"]]);
  assert.deepEqual(detail.checkList.map((c) => [c.name, c.state]), [["build", "success"], ["lint", "failure"], ["e2e", "pending"], ["license/check", "success"]]);
  assert.deepEqual(detail.checkList.map((c) => c.durationMs), [133_000, 41_000, null, null], "끝난 체크 실행만 걸린 시간이 있다");
  assert.deepEqual(detail.timeline.map((e) => e.kind), ["review", "comment"], "시간순");
  assert.equal(detail.threads.length, 4);
  assert.equal(detail.threads[0].comments.length, 3);
  assert.equal(detail.threads[0].comments[2].viewerCanDelete, true);
  assert.equal(detail.threads[2].line, null);
  assert.equal(detail.pendingReview, null);
  // PRLINK: 주소의 #discussion_r, #issuecomment-, #pullrequestreview- 번호와 커밋 목록
  assert.deepEqual(detail.threads[0].comments.map((c) => c.anchorId), ["9001", "9002", "9003"]);
  assert.equal(detail.timeline.flatMap((e) => (e.kind === "comment" ? [e.comment.anchorId] : [])).join(), "5001");
  assert.equal(detail.timeline.flatMap((e) => (e.kind === "review" ? [e.anchorId] : [])).join(), "7001");
  assert.deepEqual(detail.commitList.map((c) => [c.abbreviatedOid, c.headline, c.author?.login ?? c.authorName]), [["1111111", "Add loud option to greet", "mina"], ["2222222", "Document the loud option", "mina"], ["3333333", "Fix lint", "A Bot"]]);
  assert.equal(detail.commitCount, 3);
  assert.equal(parseDetail("acme/widgets", { ...data.detail, repository: { pullRequest: { ...data.detail.repository.pullRequest, commitList: undefined } } }).commitList.length, 0, "커밋 응답이 없어도 깨지지 않는다");
  const withPending = parseDetail("acme/widgets", { ...data.detail, repository: { pullRequest: { ...data.detail.repository.pullRequest, pendingReviews: { nodes: [{ id: "PRR_pending", comments: { totalCount: 2 } }] } } } });
  assert.deepEqual(withPending.pendingReview, { id: "PRR_pending", comments: 2 });
  const fork = parseDetail("acme/widgets", { ...data.detail, repository: { pullRequest: { ...data.detail.repository.pullRequest, headRepository: { nameWithOwner: "me/widgets" } } } });
  assert.equal(fork.headRepo, "me/widgets");

  // Checks 구역: 실패, 진행 중을 위로, 상태별 요약, 걸린 시간
  assert.deepEqual(sortChecks(detail.checkList).map((c) => c.name), ["lint", "e2e", "build", "license/check"]);
  assert.equal(summarizeChecks(detail.checkList), "1 failing, 1 pending, 2 passing");
  assert.equal(summarizeChecks([]), "");
  assert.equal(summarizeChecks([{ name: "a", state: "neutral", detail: "", url: null, durationMs: null }]), "1 skipped");
  assert.deepEqual([formatDuration(133_000), formatDuration(41_000), formatDuration(400), formatDuration(3_780_000), formatDuration(null)], ["2m 13s", "41s", "<1s", "1h 3m", ""]);

  // 파일 목록: REST 항목과 viewed 상태 합치기
  const files = parseFiles(data.files, data.viewed);
  assert.deepEqual(files.map((f) => [f.path, f.viewed, f.patch !== null]), [["src/greet.ts", false, true], ["src/list.tsx", true, true], ["docs/logo.png", false, false], ["src/new-name.ts", false, false]]);
  assert.equal(files[3].previousPath, "src/old-name.ts");

  // patch 파싱과 줄 번호 매핑
  const rows = parsePatch(files[0].patch ?? "");
  assert.equal(rows[0].kind, "hunk");
  const lines = rows.filter((r): r is DiffLine => r.kind === "line");
  assert.deepEqual(lines.map((l) => l.type).join(","), "ctx,ctx,del,del,add,add,add,ctx,ctx,ctx,add");
  assert.deepEqual([lines[0].oldLine, lines[0].newLine], [1, 1]);
  assert.deepEqual([lines[2].oldLine, lines[2].newLine], [3, null], "삭제 줄은 옛 번호만");
  assert.deepEqual([lines[4].oldLine, lines[4].newLine], [null, 3], "추가 줄은 새 번호만");
  assert.deepEqual([lines[9].oldLine, lines[9].newLine], [7, 8]);
  assert.deepEqual([lines[10].oldLine, lines[10].newLine], [null, 9]);
  assert.equal(findRow(rows, "RIGHT", 3), 5, "RIGHT 3 은 첫 추가 줄(행 5, hunk 행이 0)");
  assert.equal(findRow(rows, "LEFT", 3), 3, "LEFT 3 은 첫 삭제 줄");
  assert.equal(findRow(rows, "RIGHT", 99), -1);
  assert.equal(parsePatch("@@ -1 +1 @@\n-a\n+b\n\\ No newline at end of file").filter((r) => r.kind === "line").some((r) => (r as DiffLine).noNewline), true);

  // 스레드를 줄에 붙이기: RT_1 은 RIGHT 3, RT_2 는 8~9 범위(끝줄 9), RT_3 은 낡음, RT_4 는 다른 파일
  const greetThreads = detail.threads.filter((t) => t.path === "src/greet.ts");
  const placed = placeThreads(rows, greetThreads);
  assert.deepEqual([...placed.byRow.entries()].map(([row, ts]) => [row, ts.map((t) => t.id)]), [[5, ["RT_1"]], [11, ["RT_2"]]]);
  assert.deepEqual(placed.unplaced.map((t) => t.id), ["RT_3"]);
  const listRows = parsePatch(files[1].patch ?? "");
  const listPlaced = placeThreads(listRows, detail.threads.filter((t) => t.path === "src/list.tsx"));
  assert.deepEqual([...listPlaced.byRow.keys()], [2], "LEFT 2 는 삭제 줄");
  assert.deepEqual(rangeRows(rows, { line: 9, side: "RIGHT", startLine: 8, startSide: "RIGHT" }), { from: 10, to: 11 });
  assert.deepEqual(rangeRows(rows, { line: 3, side: "RIGHT" }), { from: 5, to: 5 });
  assert.equal(rangeRows(rows, { line: 77, side: "RIGHT" }), null);
  assert.deepEqual(rightText(rows, 3, 4), ["export function greet(user: string, loud = false) {", "  const text = `Hello ${user}`;"]);

  // 제안 블록
  const parts = splitSuggestions("Try this\n\n```suggestion\nconst a = 1;\n  indented\n```\nAnd done");
  assert.deepEqual(parts.map((p) => p.kind), ["text", "suggestion", "text"]);
  assert.equal(parts[1].kind === "suggestion" && parts[1].code, "const a = 1;\n  indented");
  assert.equal(splitSuggestions("```suggestion\n```").length, 1);
  assert.deepEqual(splitSuggestions("plain ``` code ```"), [{ kind: "text", text: "plain ``` code ```" }]);
  assert.equal(suggestionTemplate(["a", "b"]), "```suggestion\na\nb\n```");
  assert.equal(splitSuggestions(suggestionTemplate(["x = 1"]))[0].kind, "suggestion");

  // Split 짝짓기: 삭제 2, 추가 3 은 앞에서부터 짝짓고 모자란 쪽은 비운다
  const split = toSplit(rows);
  const pairs = split.filter((r): r is Exclude<typeof r, { hunk: unknown }> => "left" in r);
  assert.deepEqual(pairs.slice(2, 5).map((p) => [p.left?.type ?? null, p.right?.type ?? null]), [["del", "add"], ["del", "add"], [null, "add"]]);

  // 서버: 읽기
  const { prHandlers, requireConfirmed } = await import("../server/pr");
  const deps = { workspaces: () => [], addWorkspace: () => { throw new Error("unused"); }, workspaceOfDir: () => undefined, announce: () => undefined };
  const handlers = prHandlers(deps as never);
  reset();
  const listed = await handlers["pr.list"]({ repo: "acme/widgets" });
  assert.equal(listed.all.length, 4);
  const got = await handlers["pr.get"]({ repo: "acme/widgets", number: 42 });
  assert.equal(got.threads.length, 4);
  const got2 = await handlers["pr.files"]({ repo: "acme/widgets", number: 42, prId: "PR_node_42" });
  assert.equal(got2.length, 4);
  assert.ok(calls().every((c) => !/mutation/.test(c.stdin ?? "") && !c.args.includes("-X")), "읽기는 변경 호출을 하지 않는다");
  assert.deepEqual(JSON.parse(calls()[0].stdin ?? "{}").variables.waiting.includes("review-requested:@me"), true);
  await assert.rejects(() => handlers["pr.list"]({ repo: "acme/widgets; rm -rf" }), /Not a GitHub repository/);

  // 서버: 쓰기는 confirmed 없이는 gh 를 부르지 않고 거절한다
  assert.throws(() => requireConfirmed({}), /explicit confirmation/);
  assert.throws(() => requireConfirmed({ confirmed: "true" }), /explicit confirmation/);
  reset();
  const unconfirmed: [string, () => Promise<unknown>][] = [
    ["addComment", () => handlers["pr.addComment"]({ repo: "acme/widgets", number: 42, prId: "x", body: "hi" } as never)],
    ["createThread", () => handlers["pr.createThread"]({ repo: "acme/widgets", number: 42, prId: "x", headSha: "s", path: "a", line: 1, side: "RIGHT", body: "b", mode: "single", pendingReviewId: null } as never)],
    ["reply", () => handlers["pr.reply"]({ repo: "acme/widgets", number: 42, threadId: "t", body: "b", pendingReviewId: null } as never)],
    ["editComment", () => handlers["pr.editComment"]({ id: "c", kind: "review", body: "b" } as never)],
    ["deleteComment", () => handlers["pr.deleteComment"]({ id: "c", kind: "issue" } as never)],
    ["setResolved", () => handlers["pr.setResolved"]({ threadId: "t", resolved: true } as never)],
    ["submitReview", () => handlers["pr.submitReview"]({ repo: "acme/widgets", number: 42, prId: "x", event: "APPROVE", body: "", pendingReviewId: null } as never)],
    ["discardReview", () => handlers["pr.discardReview"]({ pendingReviewId: "r" } as never)],
    ["setViewed", () => handlers["pr.setViewed"]({ repo: "acme/widgets", number: 42, prId: "x", path: "a", viewed: true } as never)],
    ["checkout", () => handlers["pr.checkout"]({ repo: "acme/widgets", number: 42 } as never)],
  ];
  for (const [name, run] of unconfirmed) await assert.rejects(run, /explicit confirmation/, name);
  assert.equal(calls().length, 0, "확인 없는 쓰기 요청은 gh 를 부르지 않는다");

  // 서버: 확인된 쓰기가 gh 에 싣는 내용
  const ok = { confirmed: true as const };
  const ref = { repo: "acme/widgets", number: 42 };
  await handlers["pr.createThread"]({ ...ref, ...ok, prId: "PR_node_42", headSha: "abc", path: "src/greet.ts", line: 9, side: "RIGHT", startLine: 8, startSide: "RIGHT", body: "single @file.txt", mode: "single", pendingReviewId: null });
  const single = calls()[0];
  assert.deepEqual(single.args, ["api", "-X", "POST", "repos/acme/widgets/pulls/42/comments", "--input", "-"]);
  assert.deepEqual(JSON.parse(single.stdin ?? ""), { body: "single @file.txt", commit_id: "abc", path: "src/greet.ts", line: 9, side: "RIGHT", start_line: 8, start_side: "RIGHT" });
  reset();
  await handlers["pr.createThread"]({ ...ref, ...ok, prId: "PR_node_42", headSha: "abc", path: "src/greet.ts", line: 3, side: "RIGHT", body: "queued", mode: "review", pendingReviewId: "PRR_pending" });
  const queued = JSON.parse(calls()[0].stdin ?? "");
  assert.match(queued.query, /mutation PrAddThread/);
  assert.deepEqual(queued.variables.input, { pullRequestId: "PR_node_42", pullRequestReviewId: "PRR_pending", path: "src/greet.ts", body: "queued", line: 3, side: "RIGHT" });
  reset();
  await handlers["pr.reply"]({ ...ok, ...ref, threadId: "RT_1", body: "pending reply", pendingReviewId: null });
  assert.deepEqual(JSON.parse(calls()[0].stdin ?? "").variables.input, { pullRequestReviewThreadId: "RT_1", body: "pending reply" });
  reset();
  await handlers["pr.setResolved"]({ ...ok, threadId: "RT_1", resolved: true });
  await handlers["pr.setResolved"]({ ...ok, threadId: "RT_1", resolved: false });
  assert.deepEqual(calls().map((c) => /mutation (\w+)/.exec(JSON.parse(c.stdin ?? "").query)?.[1]), ["PrResolve", "PrUnresolve"]);
  reset();
  await handlers["pr.submitReview"]({ ...ok, ...ref, prId: "PR_node_42", event: "REQUEST_CHANGES", body: "please fix", pendingReviewId: "PRR_pending" });
  await handlers["pr.submitReview"]({ ...ok, ...ref, prId: "PR_node_42", event: "APPROVE", body: "", pendingReviewId: null });
  const submits = calls().map((c) => JSON.parse(c.stdin ?? ""));
  assert.match(submits[0].query, /submitPullRequestReview/);
  assert.deepEqual(submits[0].variables.input, { pullRequestId: "PR_node_42", pullRequestReviewId: "PRR_pending", event: "REQUEST_CHANGES", body: "please fix" });
  assert.match(submits[1].query, /addPullRequestReview/);
  assert.deepEqual(submits[1].variables.input, { pullRequestId: "PR_node_42", event: "APPROVE", body: "" });
  reset();
  await handlers["pr.editComment"]({ ...ok, id: "RC_3", kind: "review", body: "edited" });
  await handlers["pr.deleteComment"]({ ...ok, id: "IC_1", kind: "issue" });
  await handlers["pr.setViewed"]({ ...ok, ...ref, prId: "PR_node_42", path: "src/greet.ts", viewed: true });
  assert.deepEqual(calls().map((c) => /mutation (\w+)/.exec(JSON.parse(c.stdin ?? "").query)?.[1]), ["PrEditReviewComment", "PrDeleteIssueComment", "PrMarkViewed"]);

  // 체크아웃: 임시 저장소 + 로컬 bare 원격. 워크스페이스의 지금 브랜치는 그대로이고 새 worktree 가 생긴다.
  const run = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();
  const bare = join(tmp, "origin.git");
  run(tmp, "init", "-q", "--bare", "-b", "main", bare);
  const repo = realpathSync(mkdtempSync(join(tmp, "repo-")));
  run(repo, "init", "-q", "-b", "main");
  run(repo, "config", "user.email", "t@example.com");
  run(repo, "config", "user.name", "t");
  writeFileSync(join(repo, "a.txt"), "one\n");
  run(repo, "add", ".");
  run(repo, "commit", "-q", "-m", "init");
  run(repo, "remote", "add", "origin", "https://github.com/acme/widgets.git");
  run(repo, "config", `url.${bare}.insteadOf`, "https://github.com/acme/widgets.git");
  run(repo, "push", "-q", "origin", "main");
  run(repo, "checkout", "-q", "-b", "feature/42");
  writeFileSync(join(repo, "b.txt"), "two\n");
  run(repo, "add", ".");
  run(repo, "commit", "-q", "-m", "feature");
  run(repo, "push", "-q", "origin", "feature/42");
  run(repo, "checkout", "-q", "main");
  run(repo, "branch", "-q", "-D", "feature/42");
  const added: { dir: string; parentId: string | null; name: string }[] = [];
  const workspaces: { id: string; name: string; dir: string; parentId: string | null }[] = [{ id: "ws-1", name: "widgets", dir: repo, parentId: null }];
  const checkoutHandlers = prHandlers({
    workspaces: () => workspaces as never,
    addWorkspace: (dir, parentId, name) => {
      added.push({ dir, parentId, name });
      const w = { id: `ws-${workspaces.length + 1}`, name, dir, parentId };
      workspaces.push(w);
      return w as never;
    },
    workspaceOfDir: (dir) => workspaces.find((w) => w.dir === dir) as never,
    announce: () => undefined,
  });
  const result = await checkoutHandlers["pr.checkout"]({ ...ok, ...ref });
  assert.equal(result.branch, "feature/42");
  assert.equal(result.reused, false);
  assert.equal(result.dir, join(dirname(repo), `${repo.split("/").pop()}.worktrees`, "feature/42"));
  assert.equal(run(repo, "rev-parse", "--abbrev-ref", "HEAD"), "main", "워크스페이스의 브랜치는 바뀌지 않는다");
  assert.equal(run(result.dir, "rev-parse", "--abbrev-ref", "HEAD"), "feature/42");
  assert.equal(existsSync(join(result.dir, "b.txt")), true);
  assert.equal(run(result.dir, "rev-parse", "--abbrev-ref", "@{upstream}"), "origin/feature/42", "push 가 되도록 추적 브랜치가 잡힌다");
  assert.deepEqual(added.map((a) => [a.dir, a.parentId]), [[result.dir, "ws-1"]]);
  const again = await checkoutHandlers["pr.checkout"]({ ...ok, ...ref });
  assert.equal(again.reused, true, "이미 체크아웃된 브랜치는 그 폴더를 다시 쓴다");
  assert.equal(again.workspaceId, result.workspaceId);
  assert.equal(added.length, 1);
  rmSync(result.dir, { recursive: true, force: true });
  rmSync(dirname(result.dir), { recursive: true, force: true });

  // 방패 gh: 쓰기로 보이는 호출은 진짜 gh 를 부르지 않고 거절한다
  const guardLog = join(tmp, "guard.log");
  const guard = (args: string[], stdin: string) => {
    try {
      execFileSync(join(here, "fixtures/pr/guard-gh/gh"), args, { input: stdin, env: { ...process.env, GUARD_GH_LOG: guardLog }, stdio: ["pipe", "pipe", "pipe"] });
      return 0;
    } catch (error) {
      return (error as { status: number }).status;
    }
  };
  assert.equal(guard(["api", "graphql", "--input", "-"], JSON.stringify({ query: "mutation PrResolve { x }" })), 1);
  assert.equal(guard(["api", "-X", "POST", "repos/a/b/pulls/1/comments", "--input", "-"], "{}"), 1);
  assert.equal(guard(["api", "repos/a/b/issues/1/comments", "-f", "body=x"], ""), 1);
  assert.equal(guard(["pr", "merge", "1"], ""), 1);
  assert.deepEqual(readFileSync(guardLog, "utf8").trim().split("\n").map((l) => JSON.parse(l).verdict), ["blocked", "blocked", "blocked", "blocked"]);

  console.log("pr: 모든 확인 통과");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
