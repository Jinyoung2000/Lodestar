import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = realpathSync(mkdtempSync(join(tmpdir(), "agent-nav-hunks-")));
writeFileSync(join(base, "gitconfig"), "[user]\n\tname = t\n\temail = t@t\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n");
process.env.GIT_CONFIG_GLOBAL = join(base, "gitconfig");
process.env.GIT_CONFIG_NOSYSTEM = "1";

const scm = await import("../server/scm");
const hunkPatch = await import("../shared/hunkPatch");

const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
};
const run = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
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
let counter = 0;
const repo = (files: Record<string, string>) => {
  const dir = join(base, `r${counter++}`);
  mkdirSync(dir);
  run(dir, "init", "-q");
  for (const [rel, text] of Object.entries(files)) write(dir, rel, text);
  run(dir, "add", "-A");
  run(dir, "commit", "-q", "-m", "init");
  return dir;
};
const lines = (n: number, tag = "") => Array.from({ length: n }, (_, i) => `line ${i + 1}${tag}`).join("\n") + "\n";
const indexText = (dir: string, rel: string) => run(dir, "show", `:${rel}`);
const cached = (dir: string) => run(dir, "diff", "--cached", "--no-color", "-U0");

try {
  {
    const diff = ["diff --git a/f b/f", "index 1..2 100644", "--- a/f", "+++ b/f", "@@ -2 +2 @@", "-b", "+B", "@@ -9,0 +10,2 @@ ctx", "+x", "+y", "@@ -20,2 +0,0 @@", "-p", "-q", ""].join("\n");
    const parsed = hunkPatch.parseGitDiff(diff);
    expect(parsed.hunks.length === 3 && parsed.kind === "modify", `hunks ${parsed.hunks.length}`);
    expect(parsed.hunks[0].oldLines === 1 && parsed.hunks[0].newLines === 1, "count omitted means 1");
    expect(parsed.hunks[1].oldStart === 9 && parsed.hunks[1].oldLines === 0 && parsed.hunks[1].newStart === 10 && parsed.hunks[1].newLines === 2, "insertion header");
    expect(parsed.hunks[2].newLines === 0 && parsed.hunks[2].text.endsWith("-q\n"), "deletion body");
    expect(new Set(parsed.hunks.map((h) => h.hash)).size === 3, "hashes differ");
    const created = hunkPatch.parseGitDiff("diff --git a/n b/n\nnew file mode 100755\nindex 0..1\n--- /dev/null\n+++ b/n\n@@ -0,0 +1 @@\n+hi\n\\ No newline at end of file\n");
    expect(created.kind === "new" && created.mode === "100755" && created.hunks[0].text.includes("No newline"), "new file diff");
    const synth = hunkPatch.newFileDiff("a\nb");
    expect(synth.hunks[0].text === "@@ -0,0 +1,2 @@\n+a\n+b\n\\ No newline at end of file\n", `synth ${JSON.stringify(synth.hunks[0].text)}`);
    expect(hunkPatch.newFileDiff("").hunks.length === 0, "empty new file has no hunk");
    expect(!hunkPatch.patchSafePath('a"b') && !hunkPatch.patchSafePath("a\tb") && hunkPatch.patchSafePath("한글 폴더/a b.txt"), "patch safe path");
    const patch = hunkPatch.buildHunkPatch("a b.txt", parsed, parsed.hunks[0]);
    expect(patch.startsWith("diff --git a/a b.txt b/a b.txt\n--- a/a b.txt\n+++ b/a b.txt\n@@ -2 +2 @@\n"), "patch header");
  }

  {
    const dir = repo({ "f.txt": lines(30) });
    const edited = lines(30)
      .replace("line 3\n", "line 3 changed\n")
      .replace("line 15\n", "line 15\nadded after 15\n")
      .replace("line 25\n", "");
    write(dir, "f.txt", edited);
    const before = await scm.fileDiff(dir, "f.txt", "changes");
    expect(before.hunks.length === 3, `three hunks ${before.hunks.length}`);
    expect(before.original === lines(30) && before.modified === edited, "both sides");
    await scm.stageHunk(dir, "f.txt", "changes", 1, before.hunks[1].hash);
    expect(cached(dir).includes("+added after 15") && !cached(dir).includes("line 3 changed") && !cached(dir).includes("-line 25"), `only middle staged: ${cached(dir)}`);
    const after = await scm.fileDiff(dir, "f.txt", "changes");
    expect(after.hunks.length === 2, `two left ${after.hunks.length}`);
    expect(indexText(dir, "f.txt") === lines(30).replace("line 15\n", "line 15\nadded after 15\n"), "index content has only the middle hunk");
    await scm.stageHunk(dir, "f.txt", "changes", 0, after.hunks[0].hash);
    const staged = await scm.fileDiff(dir, "f.txt", "staged");
    expect(staged.hunks.length === 2 && staged.original === lines(30), `staged hunks ${staged.hunks.length}`);
    await scm.stageHunk(dir, "f.txt", "staged", 0, staged.hunks[0].hash);
    const staged2 = await scm.fileDiff(dir, "f.txt", "staged");
    expect(staged2.hunks.length === 1 && cached(dir).includes("+added after 15") && !cached(dir).includes("line 3 changed"), "one unstaged");
    const changes2 = await scm.fileDiff(dir, "f.txt", "changes");
    expect(changes2.hunks.length === 2, `back in changes ${changes2.hunks.length}`);
    for (let i = 0; i < 2; i++) {
      const d = await scm.fileDiff(dir, "f.txt", "changes");
      await scm.stageHunk(dir, "f.txt", "changes", 0, d.hunks[0].hash);
    }
    expect(indexText(dir, "f.txt") === edited && run(dir, "diff", "--stat") === "", "all staged equals worktree");
  }

  {
    const dir = repo({ "f.txt": lines(10) });
    write(dir, "f.txt", lines(10).replace("line 2\n", "two\n"));
    const first = await scm.fileDiff(dir, "f.txt", "changes");
    write(dir, "f.txt", lines(10).replace("line 2\n", "second edit\n"));
    const message = await failure(() => scm.stageHunk(dir, "f.txt", "changes", 0, first.hunks[0].hash));
    expect(!!message && /changed since/.test(message), `stale hunk refused: ${message}`);
    expect(cached(dir) === "", "nothing staged");
    expect((await failure(() => scm.stageHunk(dir, "f.txt", "changes", 5, "x"))) !== null, "unknown index refused");
    expect((await failure(() => scm.stageHunk(dir, "../outside", "changes", 0, "x"))) !== null, "outside path refused");
  }

  {
    const dir = repo({ "f.txt": lines(30) });
    const edited = lines(30).replace("line 3\n", "line 3 changed\n").replace("line 15\n", "line 15\nadded after 15\n").replace("line 25\n", "");
    write(dir, "f.txt", edited);
    const before = await scm.fileDiff(dir, "f.txt", "changes");
    await scm.discardHunk(dir, "f.txt", 1, before.hunks[1].hash);
    const worktree = (await scm.fileDiff(dir, "f.txt", "changes")).modified;
    expect(worktree === lines(30).replace("line 3\n", "line 3 changed\n").replace("line 25\n", ""), `middle block discarded: ${JSON.stringify(worktree)}`);
    expect(cached(dir) === "", "index untouched by discard");
    const after = await scm.fileDiff(dir, "f.txt", "changes");
    await scm.discardHunk(dir, "f.txt", 1, after.hunks[1].hash);
    expect((await scm.fileDiff(dir, "f.txt", "changes")).modified === lines(30).replace("line 3\n", "line 3 changed\n"), "deletion block restored");
    const message = await failure(() => scm.discardHunk(dir, "f.txt", 0, before.hunks[0].hash + "x"));
    expect(!!message && /changed since/.test(message), `stale discard refused: ${message}`);
  }

  {
    const dir = repo({ "a.txt": "one\ntwo", "b.txt": "one\ntwo", "c.txt": "one\ntwo\n" });
    write(dir, "a.txt", "one\nTWO");
    const a = await scm.fileDiff(dir, "a.txt", "changes");
    expect(a.hunks.length === 1, "a has a hunk");
    await scm.stageHunk(dir, "a.txt", "changes", 0, a.hunks[0].hash);
    expect(indexText(dir, "a.txt") === "one\nTWO", `no-eol content kept: ${JSON.stringify(indexText(dir, "a.txt"))}`);
    write(dir, "b.txt", "one\ntwo\n");
    const b = await scm.fileDiff(dir, "b.txt", "changes");
    await scm.stageHunk(dir, "b.txt", "changes", 0, b.hunks[0].hash);
    expect(indexText(dir, "b.txt") === "one\ntwo\n", "newline added");
    write(dir, "c.txt", "one\ntwo");
    const c = await scm.fileDiff(dir, "c.txt", "changes");
    await scm.stageHunk(dir, "c.txt", "changes", 0, c.hunks[0].hash);
    expect(indexText(dir, "c.txt") === "one\ntwo", "newline removed");
    const cs = await scm.fileDiff(dir, "c.txt", "staged");
    await scm.stageHunk(dir, "c.txt", "staged", 0, cs.hunks[0].hash);
    expect(indexText(dir, "c.txt") === "one\ntwo\n" && cached(dir).includes("a.txt"), "unstaged no-eol change");
  }

  {
    const dir = repo({ "keep.txt": "k\n" });
    write(dir, "new file.txt", "x\ny\n");
    write(dir, "no eol.txt", "tail");
    write(dir, "한글/새 파일.txt", "안녕\n");
    write(dir, "empty.txt", "");
    chmodSync(join(dir, "new file.txt"), 0o755);
    const n = await scm.fileDiff(dir, "new file.txt", "changes");
    expect(n.hunks.length === 1 && n.original === null && n.modified === "x\ny\n", "untracked has one synthesized hunk");
    await scm.stageHunk(dir, "new file.txt", "changes", 0, n.hunks[0].hash);
    expect(indexText(dir, "new file.txt") === "x\ny\n", "new file staged");
    expect(run(dir, "ls-files", "-s", "new file.txt").startsWith("100755"), "executable mode kept");
    const e = await scm.fileDiff(dir, "no eol.txt", "changes");
    await scm.stageHunk(dir, "no eol.txt", "changes", 0, e.hunks[0].hash);
    expect(indexText(dir, "no eol.txt") === "tail", "new file without trailing newline");
    const k = await scm.fileDiff(dir, "한글/새 파일.txt", "changes");
    await scm.stageHunk(dir, "한글/새 파일.txt", "changes", 0, k.hunks[0].hash);
    expect(indexText(dir, "한글/새 파일.txt") === "안녕\n", "korean path with space");
    expect((await scm.fileDiff(dir, "empty.txt", "changes")).hunks.length === 0, "empty new file has no hunk");
    const staged = await scm.fileDiff(dir, "new file.txt", "staged");
    expect(staged.hunks.length === 1 && staged.original === null, "staged new file");
    await scm.stageHunk(dir, "new file.txt", "staged", 0, staged.hunks[0].hash);
    expect(!run(dir, "ls-files").includes("new file.txt"), "unstaged new file leaves the index");
    expect(/\?\? .*new file\.txt/.test(run(dir, "status", "--porcelain")), "file still on disk, untracked again");
  }

  {
    const dir = repo({ "keep.txt": "k\n" });
    write(dir, "intent.txt", "p\nq\n");
    run(dir, "add", "-N", "intent.txt");
    const d = await scm.fileDiff(dir, "intent.txt", "changes");
    expect(d.hunks.length === 1, "intent-to-add has a hunk");
    await scm.stageHunk(dir, "intent.txt", "changes", 0, d.hunks[0].hash);
    expect(indexText(dir, "intent.txt") === "p\nq\n", "intent-to-add file staged by hunk");
  }

  {
    const dir = repo({ "gone.txt": lines(4), "edit.txt": lines(4) });
    rmSync(join(dir, "gone.txt"));
    const d = await scm.fileDiff(dir, "gone.txt", "changes");
    expect(d.hunks.length === 1 && d.modified === null && d.original === lines(4), "deleted file diff");
    await scm.stageHunk(dir, "gone.txt", "changes", 0, d.hunks[0].hash);
    expect(!run(dir, "ls-files").includes("gone.txt") && run(dir, "status", "--porcelain").includes("D  gone.txt"), "deletion staged");
    const s = await scm.fileDiff(dir, "gone.txt", "staged");
    expect(s.hunks.length === 1 && s.modified === null, "staged deletion diff");
    await scm.stageHunk(dir, "gone.txt", "staged", 0, s.hunks[0].hash);
    expect(run(dir, "ls-files").includes("gone.txt") && run(dir, "status", "--porcelain").trim() === "D gone.txt", `deletion unstaged: ${run(dir, "status", "--porcelain")}`);
  }

  {
    const dir = repo({ "old.txt": lines(30) });
    run(dir, "mv", "old.txt", "renamed.txt");
    write(dir, "renamed.txt", lines(30).replace("line 3\n", "line 3 edit\n").replace("line 27\n", "line 27 edit\n"));
    run(dir, "add", "-A");
    const staged = await scm.fileDiff(dir, "renamed.txt", "staged");
    expect(staged.original === lines(30), "original comes from the old name");
    expect(staged.hunks.length === 2, `rename carries two hunks ${staged.hunks.length}`);
    await scm.stageHunk(dir, "renamed.txt", "staged", 0, staged.hunks[0].hash);
    expect(run(dir, "ls-files").trim() === "renamed.txt", "still renamed in the index");
    expect(indexText(dir, "renamed.txt") === lines(30).replace("line 27\n", "line 27 edit\n"), "only the second hunk stays staged");
    expect(run(dir, "diff", "--cached", "-M", "--name-status").startsWith("R"), `rename kept: ${run(dir, "diff", "--cached", "-M", "--name-status")}`);
    const rest = await scm.fileDiff(dir, "renamed.txt", "changes");
    expect(rest.hunks.length === 1, "first hunk is now unstaged");
    await scm.stageHunk(dir, "renamed.txt", "changes", 0, rest.hunks[0].hash);
    expect(indexText(dir, "renamed.txt") === lines(30).replace("line 3\n", "line 3 edit\n").replace("line 27\n", "line 27 edit\n"), "re-staged");
  }

  {
    const crlf = ["a", "b", "c", "d", "e", "f", "g", "h"].map((l) => `${l}\r\n`).join("");
    const dir = repo({ "w.txt": crlf });
    run(dir, "config", "core.autocrlf", "false");
    write(dir, "w.txt", crlf.replace("b\r\n", "B\r\n").replace("g\r\n", "G\r\n"));
    const d = await scm.fileDiff(dir, "w.txt", "changes");
    expect(d.hunks.length === 2, "crlf hunks");
    await scm.stageHunk(dir, "w.txt", "changes", 1, d.hunks[1].hash);
    expect(indexText(dir, "w.txt") === crlf.replace("g\r\n", "G\r\n"), "crlf staged exactly");
  }

  {
    const dir = repo({ "img.bin": "a\u0000b" });
    write(dir, "img.bin", "a\u0000c");
    const d = await scm.fileDiff(dir, "img.bin", "changes");
    expect(d.binary && d.hunks.length === 0 && d.original === null, "binary has no hunks");
    write(dir, 'quo"te.txt', "x\n");
    const message = await failure(() => scm.stageHunk(dir, 'quo"te.txt', "changes", 0, "x"));
    expect(!!message && /whole file/.test(message), `quoted path refused: ${message}`);
  }

  {
    const dir = repo({ "a.txt": "a\n" });
    const none = await scm.fileDiff(dir, "a.txt", "staged");
    expect(none.hunks.length === 0 && none.original === null && none.modified === null, "unchanged file has no diff");
    const fresh = join(base, "fresh");
    mkdirSync(fresh);
    run(fresh, "init", "-q");
    write(fresh, "first.txt", "1\n2\n");
    run(fresh, "add", "first.txt");
    const staged = await scm.fileDiff(fresh, "first.txt", "staged");
    expect(staged.hunks.length === 1 && staged.original === null && staged.modified === "1\n2\n", "staged in an unborn repo");
    await scm.stageHunk(fresh, "first.txt", "staged", 0, staged.hunks[0].hash);
    expect(run(fresh, "ls-files").trim() === "", "unstaged in an unborn repo");
  }

  console.log("scmhunks.test.ts 통과");
} finally {
  rmSync(base, { recursive: true, force: true });
}
