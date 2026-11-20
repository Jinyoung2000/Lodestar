// FIX6B: pull, push, fetch 의 실패 분류와 병합, 리베이스, 충돌 해결, 중단(server/scm.ts)을 로컬 bare 원격과 /tmp 저장소로 끝까지 시험한다.
// 실행: npm test
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = realpathSync(mkdtempSync(join(tmpdir(), "agent-nav-sync-")));
writeFileSync(join(base, "gitconfig"), "[user]\n\tname = t\n\temail = t@t\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n");
process.env.GIT_CONFIG_GLOBAL = join(base, "gitconfig");
process.env.GIT_CONFIG_NOSYSTEM = "1";

const scm = await import("../server/scm");
const conflicts = await import("../shared/conflicts");

const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
};
const run = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const write = (dir: string, rel: string, text: string) => {
  mkdirSync(join(dir, rel, ".."), { recursive: true });
  writeFileSync(join(dir, rel), text);
};
const read = (dir: string, rel: string) => readFileSync(join(dir, rel), "utf8");
const commit = (dir: string, rel: string, text: string, message: string) => {
  write(dir, rel, text);
  run(dir, "add", "-A");
  run(dir, "commit", "-q", "-m", message);
};
const parents = (dir: string, rev = "HEAD") => run(dir, "log", "-1", "--format=%P", rev).trim().split(" ").filter(Boolean).length;
const nums = (n: number, mark = "") => Array.from({ length: n }, (_, i) => `line ${i + 1}${i + 1 === 5 ? mark : ""}`).join("\n") + "\n";

let counter = 0;
// 원격 하나와 같은 시작 커밋을 가진 두 클론(a 는 원격에 올리는 쪽, b 는 앱이 보는 쪽)
function world() {
  const root = join(base, `w${counter++}`);
  mkdirSync(root);
  const remote = join(root, "remote.git");
  run(root, "init", "-q", "--bare", remote);
  const a = join(root, "a");
  run(root, "clone", "-q", remote, a);
  commit(a, "f.txt", nums(10), "init");
  run(a, "push", "-q", "-u", "origin", "main");
  const b = join(root, "b");
  run(root, "clone", "-q", remote, b);
  return { root, remote, a, b };
}

try {
  // --- 갈라짐: ff 는 이유를 알려 주고 멈추고, merge 와 rebase 는 합친다 ---
  {
    const { a, b } = world();
    commit(a, "remote.txt", "r\n", "remote work");
    run(a, "push", "-q");
    commit(b, "local.txt", "l\n", "local work");
    const fetched = await scm.fetchOp(b);
    expect(fetched.ok, "fetch ok");
    const st = await scm.status(b);
    expect(st.ahead === 1 && st.behind === 1, `diverged counts ${st.ahead}/${st.behind}`);
    const ff = await scm.pullOp(b, "ff");
    expect(!ff.ok && ff.problem.kind === "diverged", `ff diverged: ${JSON.stringify(ff)}`);
    expect(!ff.ok && /fast-forward/.test(ff.output), "raw output kept");
    expect(!existsSync(join(b, "remote.txt")), "nothing changed by the failed ff");
    const merged = await scm.pullOp(b, "merge");
    expect(merged.ok, `merge ok ${JSON.stringify(merged)}`);
    expect(parents(b) === 2 && existsSync(join(b, "remote.txt")) && existsSync(join(b, "local.txt")), "merge commit with both files");
    const pushed = await scm.pushOp(b);
    expect(pushed.ok, "push after merge");
    expect((await scm.status(b)).ahead === 0, "nothing ahead after push");
  }
  {
    const { a, b } = world();
    commit(a, "remote.txt", "r\n", "remote work");
    run(a, "push", "-q");
    commit(b, "local.txt", "l\n", "local work");
    await scm.fetchOp(b);
    const rebased = await scm.pullOp(b, "rebase");
    expect(rebased.ok, `rebase ok ${JSON.stringify(rebased)}`);
    expect(parents(b) === 1 && run(b, "log", "--format=%s", "-3").trim().split("\n").join("|") === "local work|remote work|init", "linear history, local on top");
  }

  // --- push 거절 ---
  {
    const { a, b } = world();
    commit(a, "remote.txt", "r\n", "remote work");
    run(a, "push", "-q");
    commit(b, "local.txt", "l\n", "local work");
    const push = await scm.pushOp(b);
    expect(!push.ok && push.problem.kind === "pushRejected", `push rejected: ${JSON.stringify(push)}`);
    expect((await scm.status(b)).ahead === 1, "rejected push changes nothing");
  }

  // --- 작업 트리가 더러움 ---
  {
    const { a, b } = world();
    commit(a, "f.txt", nums(10, " theirs"), "remote edit");
    run(a, "push", "-q");
    write(b, "f.txt", nums(10, " mine uncommitted"));
    await scm.fetchOp(b);
    const pull = await scm.pullOp(b, "merge");
    expect(!pull.ok && pull.problem.kind === "dirty" && pull.problem.files?.includes("f.txt") === true, `dirty: ${JSON.stringify(pull)}`);
    expect(read(b, "f.txt") === nums(10, " mine uncommitted"), "local edit untouched");
  }

  // --- 병합 충돌: 해결하고 이어가기 ---
  {
    const { a, b } = world();
    commit(a, "f.txt", nums(10, " theirs"), "remote edit");
    run(a, "push", "-q");
    commit(b, "f.txt", nums(10, " mine"), "local edit");
    await scm.fetchOp(b);
    const pull = await scm.pullOp(b, "merge");
    expect(!pull.ok && pull.problem.kind === "conflict" && pull.conflicts === 1, `merge conflict: ${JSON.stringify(pull)}`);
    const st = await scm.status(b);
    expect(st.operation === "merge" && st.merging && st.conflicts.length === 1 && st.conflicts[0].rel === "f.txt", "status shows the merge in progress");
    expect(/^Merge /.test(st.mergeMessage ?? "") && !(st.mergeMessage ?? "").includes("#"), `merge message ${JSON.stringify(st.mergeMessage)}`);
    expect((st.operationText ?? "").startsWith("Merge "), `operation text ${st.operationText}`);
    // 충돌이 남았을 때 이어가기는 이유를 알리고 아무것도 하지 않는다
    const early = await scm.continueOperation(b);
    expect(!early.ok && early.problem.kind === "conflict", "continue refused while conflicts remain");
    const text = read(b, "f.txt");
    expect(conflicts.parseConflicts(text.split("\n")).length === 1, "markers are in the file");
    write(b, "f.txt", conflicts.resolveAllConflicts(text, "both"));
    await scm.stage(b, ["f.txt"]);
    expect((await scm.status(b)).conflicts.length === 0, "resolved after staging");
    const done = await scm.continueOperation(b);
    expect(done.ok, `continue ok ${JSON.stringify(done)}`);
    const after = await scm.status(b);
    expect(after.operation === null && !after.merging && parents(b) === 2, "merge commit created");
    expect(read(b, "f.txt").includes("theirs") && read(b, "f.txt").includes("mine"), "both sides kept");
    expect(run(b, "log", "-1", "--format=%s").startsWith("Merge "), "default merge message used");
  }

  // --- 병합 충돌: 중단 ---
  {
    const { a, b } = world();
    commit(a, "f.txt", nums(10, " theirs"), "remote edit");
    run(a, "push", "-q");
    commit(b, "f.txt", nums(10, " mine"), "local edit");
    await scm.fetchOp(b);
    await scm.pullOp(b, "merge");
    expect((await scm.status(b)).operation === "merge", "in merge");
    await scm.abortOperation(b);
    const st = await scm.status(b);
    expect(st.operation === null && st.conflicts.length === 0, "operation cleared");
    expect(read(b, "f.txt") === nums(10, " mine") && !read(b, "f.txt").includes("<<<<<<<"), "file back to the local version");
    const again = await scm.abortOperation(b).then(() => null, (e: Error) => e.message);
    expect(again === "There is no merge or rebase in progress.", `abort without operation: ${again}`);
  }

  // --- 리베이스 충돌: 해결하고 이어가기, 중단 ---
  {
    const { a, b } = world();
    commit(a, "f.txt", nums(10, " theirs"), "remote edit");
    run(a, "push", "-q");
    commit(b, "f.txt", nums(10, " mine"), "local edit");
    await scm.fetchOp(b);
    const pull = await scm.pullOp(b, "rebase");
    expect(!pull.ok && pull.problem.kind === "conflict" && pull.problem.title.startsWith("Rebase") && pull.conflicts === 1, `rebase conflict: ${JSON.stringify(pull)}`);
    const st = await scm.status(b);
    expect(st.operation === "rebase" && !st.merging && st.conflicts.length === 1, "status shows the rebase");
    expect(/^main 1\/1$/.test(st.operationText ?? ""), `rebase text ${st.operationText}`);
    const text = read(b, "f.txt");
    // 리베이스에서 current 는 원격 쪽(위에 쌓는 기준)이고 incoming 이 내 커밋이다
    expect(conflicts.parseConflicts(text.split("\n"))[0].current.some((l) => l.includes("theirs")), "current side is the upstream during a rebase");
    write(b, "f.txt", conflicts.resolveAllConflicts(text, "incoming"));
    await scm.stage(b, ["f.txt"]);
    const done = await scm.continueOperation(b);
    expect(done.ok, `rebase continue ${JSON.stringify(done)}`);
    const after = await scm.status(b);
    expect(after.operation === null && parents(b) === 1 && read(b, "f.txt") === nums(10, " mine"), "rebase finished with my version");
    expect(after.ahead === 1 && after.behind === 0, "my commit sits on top of the remote");
  }
  {
    const { a, b } = world();
    commit(a, "f.txt", nums(10, " theirs"), "remote edit");
    run(a, "push", "-q");
    commit(b, "f.txt", nums(10, " mine"), "local edit");
    await scm.fetchOp(b);
    await scm.pullOp(b, "rebase");
    await scm.abortOperation(b);
    const st = await scm.status(b);
    expect(st.operation === null && st.branch === "main" && read(b, "f.txt") === nums(10, " mine") && st.ahead === 1 && st.behind === 1, `rebase aborted: ${JSON.stringify({ op: st.operation, branch: st.branch, a: st.ahead, b: st.behind })}`);
  }

  // --- upstream 없음, 원격 없음, 잘못된 원격 ---
  {
    const { b } = world();
    run(b, "switch", "-q", "-c", "topic");
    commit(b, "t.txt", "t\n", "topic work");
    const push = await scm.pushOp(b);
    expect(!push.ok && push.problem.kind === "noUpstream" && push.problem.hint.includes("git push -u origin topic"), `push no upstream: ${JSON.stringify(push)}`);
    const pull = await scm.pullOp(b, "ff");
    expect(!pull.ok && pull.problem.kind === "noUpstream", `pull no upstream: ${JSON.stringify(pull)}`);
  }
  {
    const dir = join(base, "lonely");
    mkdirSync(dir);
    run(dir, "init", "-q");
    commit(dir, "a.txt", "a\n", "only");
    const push = await scm.pushOp(dir);
    expect(!push.ok && push.problem.kind === "noRemote", `no remote: ${JSON.stringify(push)}`);
  }
  {
    const { b } = world();
    run(b, "remote", "set-url", "origin", join(base, "does-not-exist.git"));
    const fetched = await scm.fetchOp(b);
    expect(!fetched.ok && fetched.problem.kind === "remoteMissing", `bad remote: ${JSON.stringify(fetched)}`);
  }

  // --- 이미 최신이면 성공 ---
  {
    const { b } = world();
    const pull = await scm.pullOp(b, "ff");
    expect(pull.ok && /up to date/i.test(pull.output), `up to date: ${JSON.stringify(pull)}`);
  }

  // --- 병합 커밋 메시지: 병합 중에는 메시지가 비어도 커밋된다 ---
  {
    const { a, b } = world();
    commit(a, "g.txt", "g\n", "remote file");
    run(a, "push", "-q");
    commit(b, "h.txt", "h\n", "local file");
    await scm.fetchOp(b);
    run(b, "merge", "--no-commit", "--no-ff", "origin/main");
    const st = await scm.status(b);
    expect(st.operation === "merge" && st.conflicts.length === 0, "merge waiting for a commit");
    const result = await scm.commit(b, { message: "" });
    expect(result.status === "committed" && parents(b) === 2, `commit without message while merging: ${JSON.stringify(result)}`);
  }

  console.log("scmsync.test.ts 통과");
} finally {
  rmSync(base, { recursive: true, force: true });
}
