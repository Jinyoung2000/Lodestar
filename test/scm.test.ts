// SCM: Source Control 보기의 서버 동작(server/scm.ts)과 순수 함수(shared/scm.ts)를 /tmp 임시 저장소와 bare 원격으로 시험한다. 데몬도 모델도 필요 없다.
// 사용자의 전역 git 설정(서명, 훅)이 섞이지 않게 설정 파일을 임시로 바꾸고, 휴지통도 임시 폴더로 보낸다.
// 실행: npm test
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = realpathSync(mkdtempSync(join(tmpdir(), "agent-nav-scm-")));
writeFileSync(join(base, "gitconfig"), "[user]\n\tname = t\n\temail = t@t\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n");
process.env.GIT_CONFIG_GLOBAL = join(base, "gitconfig");
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.AGENT_NAV_TRASH_DIR = join(base, "trash");

const scm = await import("../server/scm");
const shared = await import("../shared/scm");

const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
};
const run = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const failure = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
  } catch (error) {
    return (error as Error).message;
  }
  return null;
};
const write = (dir: string, rel: string, text: string) => {
  mkdirSync(join(dir, rel, ".."), { recursive: true });
  writeFileSync(join(dir, rel), text);
};
const rels = (list: { rel: string }[]) => list.map((e) => e.rel).join(",");

try {
  // --- 순수 함수 ---
  {
    const raw = ["M  a.txt", " M b.txt", "MM c.txt", "?? d dir/e.txt", "R  new name.txt", "old name.txt", "UU f.txt", " D g.txt", "A  h.txt", "!! ignored.txt", ""].join("\0");
    const parsed = shared.parseStatus(raw, "/r");
    expect(rels(parsed.staged) === "a.txt,c.txt,h.txt,new name.txt", `staged ${rels(parsed.staged)}`);
    expect(rels(parsed.changes) === "b.txt,c.txt,d dir/e.txt,g.txt", `changes ${rels(parsed.changes)}`);
    expect(rels(parsed.conflicts) === "f.txt" && parsed.conflicts[0].conflict === "UU" && parsed.conflicts[0].code === "!", "conflicts");
    const renamed = parsed.staged.find((e) => e.code === "R");
    expect(renamed?.from === "old name.txt" && renamed.path === "/r/new name.txt", "rename entry");
    expect(parsed.changes.find((e) => e.rel === "d dir/e.txt")?.code === "U", "untracked code");
    expect(parsed.changes.find((e) => e.rel === "g.txt")?.code === "D", "deleted code");
    expect(shared.cleanCommitMessage('```\n"feat: add x."\n\nbody line\nCo-Authored-By: Claude <x>\n```') === "feat: add x.", `clean ${shared.cleanCommitMessage('"feat: add x."\nCo-Authored-By: x')}`);
    expect(shared.cleanCommitMessage("Co-Authored-By: x\nfix: y") === "fix: y", "clean trailer first");
    expect(shared.cleanCommitMessage("x".repeat(200)).length === 100, "clean length");
    const tree = shared.buildScmTree(parsed.changes.concat([{ rel: "src/a/b/c.ts", path: "/r/src/a/b/c.ts", code: "M" }, { rel: "src/a/b/d.ts", path: "/r/src/a/b/d.ts", code: "M" }]));
    const src = tree.find((n) => n.name === "src/a/b");
    expect(!!src && src.children.length === 2, `compact folders ${JSON.stringify(tree.map((n) => n.name))}`);
    expect(tree[tree.length - 1].entry !== null && tree[0].entry === null, "folders first");
    expect(shared.scmEntriesUnder(src!).length === 2, "entries under");
  }

  // --- 경로 정규화 ---
  {
    const root = join(base, "paths");
    mkdirSync(root);
    expect(scm.scmRelPath(root, "a/../b.txt") === "b.txt", "normalize inside");
    expect(scm.scmRelPath(root, join(root, "x/y.txt")) === "x/y.txt", "absolute inside");
    for (const bad of ["../x", "a/../../x", "/etc/passwd", ".git/config", ".git", "", ".", "..", "a\0b"]) {
      expect((await failure(async () => scm.scmRelPath(root, bad))) !== null, `rejects ${JSON.stringify(bad)}`);
    }
  }

  // --- 아직 커밋이 없는 저장소 (이 레포 자신처럼) ---
  const fresh = join(base, "fresh");
  mkdirSync(fresh);
  run(fresh, "init");
  write(fresh, "a.txt", "a\n");
  write(fresh, "dir/b.txt", "b\n");
  {
    let s = await scm.status(fresh);
    expect(s.repoRoot === fresh && !s.hasHead && s.branch === "main", `unborn ${s.repoRoot} ${s.hasHead} ${s.branch}`);
    expect(rels(s.changes) === "a.txt,dir/b.txt" && s.changes.every((e) => e.code === "U"), `unborn changes ${rels(s.changes)}`);
    await scm.stage(fresh, ["dir"]);
    s = await scm.status(fresh);
    expect(rels(s.staged) === "dir/b.txt" && s.staged[0].code === "A" && rels(s.changes) === "a.txt", `unborn stage folder ${rels(s.staged)} / ${rels(s.changes)}`);
    await scm.unstage(fresh, ["dir/b.txt"]);
    s = await scm.status(fresh);
    expect(s.staged.length === 0 && s.changes.length === 2, "unborn unstage uses rm --cached");
    expect((await scm.graph(fresh)).length === 0, "unborn graph empty");
    expect((await failure(() => scm.undoLastCommit(fresh))) !== null, "unborn undo refused");
    expect((await failure(() => scm.commit(fresh, { message: "x", amend: true }))) !== null, "unborn amend refused");
    const input = await scm.commitMessageInput(fresh);
    expect(!!input && input.source === "changes" && input.diff.includes("new file: a.txt") && input.recent.length === 0, "unborn message input");
    expect((await scm.commit(fresh, { message: "feat: first" })).status === "needsStageAll", "unborn needs stage all");
    const first = await scm.commit(fresh, { message: "feat: first", stageAll: true });
    expect(first.status === "committed", `first commit ${JSON.stringify(first)}`);
    expect(run(fresh, "log", "-1", "--format=%s") === "feat: first", "first commit subject");
    // 첫 커밋 되돌리기: HEAD 만 지우고 파일은 스테이지된 채 남는다
    const undone = await scm.undoLastCommit(fresh);
    s = await scm.status(fresh);
    expect(undone.message === "feat: first" && !s.hasHead && rels(s.staged) === "a.txt,dir/b.txt", `undo root ${undone.message} ${s.hasHead} ${rels(s.staged)}`);
    await scm.commit(fresh, { message: "feat: first again" });
  }

  // --- 작업 저장소와 bare 원격 ---
  const origin = join(base, "origin.git");
  const work = join(base, "work");
  mkdirSync(origin);
  run(origin, "init", "--bare");
  mkdirSync(work);
  run(work, "init");
  write(work, "keep.txt", "keep\n");
  write(work, "src/one.ts", "one\n");
  write(work, "src/two.ts", "two\n");
  write(work, "gone.txt", "gone\n");
  run(work, "add", "-A");
  run(work, "commit", "-m", "init");
  run(work, "remote", "add", "origin", origin);
  run(work, "push", "-u", "origin", "main");

  // 상태 글자
  write(work, "keep.txt", "keep changed\n");
  rmSync(join(work, "gone.txt"));
  write(work, "new/deep/n1.txt", "n1\n");
  write(work, "new/deep/n2.txt", "n2\n");
  run(work, "mv", "src/two.ts", "src/three.ts");
  {
    const s = await scm.status(work);
    expect(s.branch === "main" && s.upstream === "origin/main" && s.ahead === 0 && s.hasRemote, "branch info");
    expect(rels(s.staged) === "src/three.ts" && s.staged[0].code === "R" && s.staged[0].from === "src/two.ts", `staged rename ${JSON.stringify(s.staged)}`);
    expect(rels(s.changes) === "gone.txt,keep.txt,new/deep/n1.txt,new/deep/n2.txt", `changes ${rels(s.changes)}`);
    const code = (rel: string) => s.changes.find((e) => e.rel === rel)?.code;
    expect(code("gone.txt") === "D" && code("keep.txt") === "M" && code("new/deep/n1.txt") === "U", "change letters");
    expect(s.lastCommit?.subject === "init" && s.lastCommit.pushed && s.lastCommit.parents === 0, `last commit ${JSON.stringify(s.lastCommit)}`);
  }

  // 폴더 스테이지와 해제 (이름 바뀜은 옛 경로까지)
  await scm.stage(work, ["new"]);
  expect(rels((await scm.status(work)).staged) === "new/deep/n1.txt,new/deep/n2.txt,src/three.ts", "stage folder");
  await scm.unstage(work, ["new/deep"]);
  expect((await scm.status(work)).staged.map((e) => e.rel).join(",") === "src/three.ts", "unstage folder");
  await scm.unstage(work, ["src/three.ts"]);
  {
    const s = await scm.status(work);
    expect(s.staged.length === 0 && s.changes.some((e) => e.rel === "src/two.ts" && e.code === "D") && s.changes.some((e) => e.rel === "src/three.ts" && e.code === "U"), `unstage rename restores old path ${rels(s.changes)}`);
  }
  await scm.stage(work, ["src"]);
  expect((await scm.status(work)).staged.some((e) => e.code === "R"), "restage rename");
  await scm.unstage(work, ["src"]);
  await scm.stage(work, ["gone.txt"]);
  expect((await scm.status(work)).staged.find((e) => e.rel === "gone.txt")?.code === "D", "stage a deletion");
  await scm.unstage(work, ["gone.txt"]);

  // 경로 탈출 거절. 아무것도 바뀌지 않는다
  {
    const before = JSON.stringify(await scm.status(work));
    for (const bad of ["../outside.txt", "/etc/hosts", ".git/config"]) {
      for (const op of [scm.stage, scm.unstage, scm.discard] as const) {
        expect((await failure(() => op(work, [bad]))) !== null, `${op.name} rejects ${bad}`);
      }
    }
    // 저장소 안 파일과 섞여 있어도 하나라도 밖이면 전부 거절한다
    expect((await failure(() => scm.stage(work, ["keep.txt", "../x"]))) !== null, "mixed rejects");
    expect(JSON.stringify(await scm.status(work)) === before, "rejected calls changed nothing");
    // pathspec 문법으로 읽히지 않는다
    await scm.stage(work, [":(top)keep.txt"]);
    expect((await scm.status(work)).staged.length === 0, "literal pathspec");
  }

  // 변경 버리기: 추적 파일은 되돌리고, 새 파일은 휴지통으로 옮긴다
  const trash = process.env.AGENT_NAV_TRASH_DIR!;
  {
    const result = await scm.discard(work, ["keep.txt", "gone.txt", "new"]);
    expect(result.restored === 2 && result.trashed === 2, `discard counts ${JSON.stringify(result)}`);
    expect(readFileSync(join(work, "keep.txt"), "utf8") === "keep\n" && existsSync(join(work, "gone.txt")), "tracked restored");
    expect(!existsSync(join(work, "new/deep/n1.txt")) && !existsSync(join(work, "new")), "new files moved and empty folders pruned");
    expect(readdirSync(trash).sort().join(",") === "n1.txt,n2.txt", `trash ${readdirSync(trash)}`);
    expect(readFileSync(join(trash, "n1.txt"), "utf8") === "n1\n", "trash keeps content");
    // 같은 이름이 또 오면 덮어쓰지 않는다
    write(work, "again/n1.txt", "second\n");
    await scm.discard(work, ["again/n1.txt"]);
    expect(readFileSync(join(trash, "n1.txt"), "utf8") === "n1\n" && readFileSync(join(trash, "n1 2.txt"), "utf8") === "second\n", "trash collision");
    await scm.discard(work, ["src"]);
  }

  // 저장소 밖을 가리키는 심볼릭 링크: 링크만 휴지통으로 가고 가리키던 폴더는 그대로다
  {
    const outside = join(base, "outside");
    write(outside, "precious.txt", "keep me\n");
    symlinkSync(outside, join(work, "link"));
    expect(rels((await scm.status(work)).changes).includes("link"), "symlink listed");
    await scm.discard(work, ["link"]);
    expect(!existsSync(join(work, "link")) && readFileSync(join(outside, "precious.txt"), "utf8") === "keep me\n", "symlink target untouched");
    expect(existsSync(join(trash, "link")), "link moved to trash");
  }

  // 커밋
  {
    expect((await failure(() => scm.commit(work, { message: "  " }))) === "Please provide a commit message.", "empty message");
    expect((await scm.commit(work, { message: "feat: x" })).status === "nothingToCommit", "nothing to commit");
    write(work, "keep.txt", "v2\n");
    write(work, "added.txt", "added\n");
    const needs = await scm.commit(work, { message: "feat: second" });
    expect(needs.status === "needsStageAll", "needs stage all");
    expect(run(work, "log", "-1", "--format=%s") === "init", "nothing committed yet");
    await scm.stage(work, ["keep.txt"]);
    const partial = await scm.commit(work, { message: "fix: only keep" });
    expect(partial.status === "committed" && run(work, "show", "--stat", "--format=", "HEAD").includes("keep.txt") && !run(work, "show", "--stat", "--format=", "HEAD").includes("added.txt"), "commits only staged");
    expect(rels((await scm.status(work)).changes) === "added.txt", "unstaged stays");
    const all = await scm.commit(work, { message: "feat: add all", stageAll: true });
    expect(all.status === "committed" && (await scm.status(work)).changes.length === 0, "stage all and commit");
  }

  // amend: push 한 커밋이면 확인을 요구한다
  {
    run(work, "push");
    const s = await scm.status(work);
    expect(s.ahead === 0 && s.lastCommit?.pushed === true, "pushed flag");
    const warn = await scm.commit(work, { message: "feat: add all (amended)", amend: true });
    expect(warn.status === "amendPushed" && run(work, "log", "-1", "--format=%s") === "feat: add all", "amend warns when pushed");
    write(work, "second.txt", "s\n");
    await scm.commit(work, { message: "chore: local only", stageAll: true });
    const local = await scm.commit(work, { message: "chore: local only (amended)", amend: true });
    expect(local.status === "committed" && run(work, "log", "-1", "--format=%s") === "chore: local only (amended)", "amend unpushed");
    const noEdit = await scm.commit(work, { message: "", amend: true });
    expect(noEdit.status === "committed" && run(work, "log", "-1", "--format=%s") === "chore: local only (amended)", "amend keeps message when empty");
    expect((await scm.status(work)).lastCommit?.pushed === false, "unpushed after new commit");
    const forced = await scm.commit(work, { message: "chore: ok", amend: true });
    expect(forced.status === "committed", "amend unpushed again");
  }

  // 마지막 커밋 되돌리기: 변경은 스테이지된 채 남고 메시지가 돌아온다
  {
    const head = run(work, "rev-parse", "HEAD~1");
    const undone = await scm.undoLastCommit(work);
    const s = await scm.status(work);
    expect(undone.message === "chore: ok" && run(work, "rev-parse", "HEAD") === head && rels(s.staged) === "second.txt", `undo ${undone.message} ${rels(s.staged)}`);
    await scm.commit(work, { message: "chore: second" });
  }

  // 커밋하고 push, sync
  {
    write(work, "p1.txt", "p1\n");
    const pushed = await scm.commit(work, { message: "feat: p1", stageAll: true, then: "push" });
    expect(pushed.status === "committed" && pushed.pushError === null && run(origin, "log", "-1", "--format=%s", "main") === "feat: p1", `commit and push ${JSON.stringify(pushed)}`);
    // 다른 클론이 먼저 올려 갈라지면 sync 는 ff-only pull 에서 멈추고 오류를 돌려준다. 커밋은 남는다.
    const other = join(base, "other");
    run(base, "clone", origin, other);
    write(other, "remote.txt", "r\n");
    run(other, "add", "-A");
    run(other, "commit", "-m", "remote work");
    run(other, "push");
    write(work, "p2.txt", "p2\n");
    const diverged = await scm.commit(work, { message: "feat: p2", stageAll: true, then: "sync" });
    expect(diverged.status === "committed" && !!diverged.pushError && /diverged/i.test(diverged.pushError), `diverged sync ${JSON.stringify(diverged)}`);
    expect(run(work, "log", "-1", "--format=%s") === "feat: p2" && run(origin, "log", "-1", "--format=%s", "main") === "remote work", "diverged: commit kept, nothing pushed");
    run(work, "pull", "--rebase");
    write(work, "p2b.txt", "p2b\n");
    const synced = await scm.commit(work, { message: "feat: p2b", stageAll: true, then: "sync" });
    expect(synced.status === "committed" && synced.pushError === null && run(origin, "log", "-1", "--format=%s", "main") === "feat: p2b", `sync ${JSON.stringify(synced)}`);
    // upstream 이 없는 브랜치는 커밋은 되고 push 오류만 돌아온다
    run(work, "switch", "-c", "no-upstream");
    write(work, "p3.txt", "p3\n");
    const lost = await scm.commit(work, { message: "feat: p3", stageAll: true, then: "push" });
    expect(lost.status === "committed" && !!lost.pushError && /upstream/.test(lost.pushError), `no upstream ${JSON.stringify(lost)}`);
    expect(run(work, "log", "-1", "--format=%s") === "feat: p3", "commit survived the failed push");
    run(work, "switch", "main");
  }

  // 훅이 실패하면 출력 전문을 돌려주고, 사용자가 고르면 --no-verify 로 다시 커밋한다
  {
    const hook = join(work, ".git/hooks/pre-commit");
    writeFileSync(hook, "#!/bin/sh\necho 'lint-staged: 2 errors' \necho 'src/x.ts:1 bad thing' >&2\nexit 1\n");
    chmodSync(hook, 0o755);
    write(work, "hooked.txt", "h\n");
    const failed = await scm.commit(work, { message: "feat: hooked", stageAll: true });
    expect(failed.status === "failed" && failed.hook && failed.output.includes("lint-staged: 2 errors") && failed.output.includes("src/x.ts:1 bad thing"), `hook failure ${JSON.stringify(failed)}`);
    expect(run(work, "log", "-1", "--format=%s") !== "feat: hooked" && rels((await scm.status(work)).staged) === "hooked.txt", "nothing committed, files stay staged");
    const bypass = await scm.commit(work, { message: "feat: hooked", noVerify: true });
    expect(bypass.status === "committed" && run(work, "log", "-1", "--format=%s") === "feat: hooked", "no-verify only on request");
    rmSync(hook);
  }

  // Graph, 커밋 파일, 커밋 diff
  {
    const commits = await scm.graph(work, 5);
    expect(commits.length === 5 && commits[0].subject === "feat: hooked" && commits[0].refs.includes("main"), `graph ${commits.map((c) => c.subject)} ${commits[0].refs}`);
    expect(/^[0-9a-f]{40}$/.test(commits[0].hash) && commits[0].author === "t" && !Number.isNaN(Date.parse(commits[0].date)) && commits[0].parents === 1, "graph fields");
    const files = await scm.commitFiles(work, commits[0].hash);
    expect(files.length === 1 && files[0].rel === "hooked.txt" && files[0].code === "A" && files[0].additions === 1, `commit files ${JSON.stringify(files)}`);
    const diff = await scm.commitFileDiff(work, commits[0].hash, "hooked.txt");
    expect(diff.text.includes("+h") && !diff.truncated, "commit diff");
    const initHash = run(work, "rev-list", "--max-parents=0", "HEAD");
    expect((await scm.commitFiles(work, initHash)).some((f) => f.rel === "keep.txt" && f.code === "A"), "root commit lists its files");
    expect((await failure(() => scm.commitFiles(work, "--output=/tmp/x"))) !== null, "bad hash rejected");
    expect((await failure(() => scm.commitFileDiff(work, commits[0].hash, "../x"))) !== null, "diff path escape rejected");
  }

  // 충돌
  {
    run(work, "switch", "-c", "left");
    write(work, "conflict.txt", "left\n");
    run(work, "add", "-A");
    run(work, "commit", "-m", "left");
    run(work, "switch", "main");
    write(work, "conflict.txt", "main\n");
    run(work, "add", "-A");
    run(work, "commit", "-m", "main side");
    try {
      run(work, "merge", "left");
    } catch {
      // 충돌이 나는 것이 시험 대상이다
    }
    let s = await scm.status(work);
    expect(rels(s.conflicts) === "conflict.txt" && s.conflicts[0].code === "!" && s.conflicts[0].conflict === "AA" && s.merging, `conflict ${JSON.stringify(s.conflicts)} merging ${s.merging}`);
    expect((await scm.commit(work, { message: "merge" })).status === "conflicts", "commit blocked by conflicts");
    write(work, "conflict.txt", "resolved\n");
    await scm.stage(work, ["conflict.txt"]);
    s = await scm.status(work);
    expect(s.conflicts.length === 0 && rels(s.staged) === "conflict.txt", "resolve by staging");
    const merged = await scm.commit(work, { message: "merge left" });
    expect(merged.status === "committed" && (await scm.status(work)).lastCommit?.parents === 2, "merge commit");
  }

  // Worktrees
  {
    const wt = join(base, "work.worktrees/feature/a");
    run(work, "worktree", "add", "-b", "feature/a", wt);
    write(wt, "wt.txt", "wt\n");
    run(wt, "add", "-A");
    run(wt, "commit", "-m", "in worktree");
    run(wt, "push", "-u", "origin", "feature/a");
    write(wt, "wt2.txt", "wt2\n");
    run(wt, "add", "-A");
    run(wt, "commit", "-m", "second in worktree");
    // 같은 저장소의 두 폴더를 모두 주어도 저장소는 한 번만 센다
    const repos = await scm.worktrees([work, wt, fresh]);
    expect(repos.length === 2, `repos ${repos.map((r) => r.root)}`);
    const repo = repos.find((r) => r.root === work)!;
    expect(repo.name === "work" && repo.worktrees.length === 2 && repo.worktrees[0].main && repo.worktrees[0].branch === "main", `worktrees ${JSON.stringify(repo.worktrees)}`);
    const feature = repo.worktrees.find((w) => w.branch === "feature/a")!;
    expect(feature.path === wt && !feature.main && feature.upstream === "origin/feature/a" && feature.ahead === 1 && feature.behind === 0, `worktree tracking ${JSON.stringify(feature)}`);
    const status = await scm.status(wt);
    expect(status.repoRoot === wt && status.branch === "feature/a", "status inside a linked worktree");
    write(wt, "dirty.txt", "d\n");
    await scm.stage(wt, ["dirty.txt"]);
    expect(rels((await scm.status(wt)).staged) === "dirty.txt" && (await scm.status(work)).staged.length === 0, "worktrees keep separate indexes");
  }

  // 커밋 메시지 생성: 스테이지된 diff 와 최근 제목이 질의에 실리고, 답은 제목 한 줄로 다듬어진다
  {
    const messages = await import("../server/scmMessage");
    expect((await failure(() => messages.generateCommitMessage(work, "haiku", async () => "unused"))) === "There are no changes to describe.", "no changes");
    write(work, "m.txt", "line for message\n");
    await scm.stage(work, ["m.txt"]);
    write(work, "m2.txt", "unstaged only\n");
    let seen = "";
    let usedModel = "";
    const message = await messages.generateCommitMessage(work, "haiku", async (_cwd, model, prompt) => {
      seen = prompt;
      usedModel = model;
      return '"feat: add m"\n\nlonger body\nCo-Authored-By: Claude <x>';
    });
    expect(message === "feat: add m" && usedModel === "haiku", `generated ${message}`);
    expect(seen.includes("Diff of the staged changes") && seen.includes("+line for message") && !seen.includes("unstaged only") && seen.includes("- feat: p2b"), "prompt carries the staged diff and recent subjects");
    expect(messages.COMMIT_MESSAGE_SYSTEM_PROMPT.includes("Co-Authored-By") && messages.COMMIT_MESSAGE_SYSTEM_PROMPT.includes("No body"), "system prompt forbids body and trailers");
    expect((await failure(() => messages.generateCommitMessage(work, "haiku", async () => "   "))) === "The model did not return a commit message.", "empty answer");
    // 스테이지된 게 없으면 작업 트리 변경으로 대신한다
    await scm.unstage(work, ["m.txt"]);
    await messages.generateCommitMessage(work, "haiku", async (_cwd, _model, prompt) => {
      seen = prompt;
      return "chore: x";
    });
    expect(seen.includes("working tree changes") && seen.includes("new file: m.txt"), "falls back to the working tree");
  }

  // 저장소가 아닌 폴더
  {
    const plain = join(base, "plain");
    mkdirSync(plain);
    const s = await scm.status(plain);
    expect(s.repoRoot === null && s.staged.length === 0 && (await scm.graph(plain)).length === 0, "not a repo");
    expect((await failure(() => scm.stage(plain, ["a"]))) === "This folder is not a git repository.", "stage outside a repo");
  }

  console.log("scm.test.ts 통과");
} finally {
  rmSync(base, { recursive: true, force: true });
}
