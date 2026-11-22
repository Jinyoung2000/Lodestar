import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitInfo } from "../shared/protocol";
import { info as gitInfo } from "../server/git";
import { titleBranchOf, type TitleBranchInput } from "../web/titleBranchRule";

const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
};
const same = (actual: unknown, wanted: unknown, name: string) => expect(JSON.stringify(actual) === JSON.stringify(wanted), `${name}: ${JSON.stringify(actual)} != ${JSON.stringify(wanted)}`);

const gitState = (patch: Partial<GitInfo>): GitInfo => ({ repoRoot: "/r", hasHead: true, branch: "main", upstream: null, ahead: 0, behind: 0, base: null, baseLabel: null, ...patch });
const plain = { cwd: "/r/app", worktreeBranch: null, inWorktree: false };
const worktree = { cwd: "/r.worktrees/feat", worktreeBranch: "feat", inWorktree: true };
const input = (patch: Partial<TitleBranchInput>): TitleBranchInput => ({ sessionsView: true, session: plain, info: gitState({}), ...patch });

same(titleBranchOf(input({})), { kind: "branch", label: "main", tooltip: "main\n/r/app", switchable: true }, "일반");

same(titleBranchOf(input({ session: worktree, info: gitState({ branch: "feat" }) })), { kind: "branch", label: "feat", tooltip: "feat\n/r.worktrees/feat", switchable: false }, "worktree");
same(titleBranchOf(input({ session: worktree, info: gitState({ branch: "renamed-in-terminal" }) })), { kind: "branch", label: "renamed-in-terminal", tooltip: "renamed-in-terminal\n/r.worktrees/feat", switchable: false }, "worktree checkout");
same(titleBranchOf(input({ session: worktree, info: undefined })).kind, "branch", "worktree 읽기 전");
same(titleBranchOf(input({ info: undefined })), { kind: "none" }, "일반 읽기 전");

same(titleBranchOf(input({ info: gitState({ branch: "HEAD", headShort: "a1b2c3d" }) })), { kind: "detached", label: "a1b2c3d", tooltip: "Detached HEAD at a1b2c3d\n/r/app", switchable: true }, "detached");
same(titleBranchOf(input({ info: gitState({ branch: "HEAD" }) })).kind === "detached", true, "detached 해시 없음");

same(titleBranchOf(input({ info: gitState({ repoRoot: null, branch: null }) })), { kind: "none" }, "git 아님");
same(titleBranchOf(input({ session: null })), { kind: "none" }, "세션 없음");
same(titleBranchOf(input({ sessionsView: false })), { kind: "none" }, "세션 격자 아님");
same(titleBranchOf(input({ info: gitState({ branch: null }) })), { kind: "none" }, "이름 없음");

const root = realpathSync(mkdtempSync(join(tmpdir(), "agent-nav-titlebranch-")));
const run = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], { cwd: root, encoding: "utf8" }).trim();
try {
  run("init", "-q");
  const unborn = await gitInfo(root, null);
  same([unborn.branch, unborn.headShort, unborn.hasHead], ["main", null, false], "커밋 없는 저장소");
  writeFileSync(join(root, "a.txt"), "a\n");
  run("add", "-A");
  run("commit", "-q", "-m", "a");
  const full = run("rev-parse", "HEAD");
  const onBranch = await gitInfo(root, null);
  same([onBranch.branch, onBranch.headShort], ["main", full.slice(0, 7)], "브랜치 위");
  run("switch", "-q", "--detach");
  const detached = await gitInfo(root, null);
  same([detached.branch, detached.headShort], ["HEAD", full.slice(0, 7)], "detached");
  same(titleBranchOf(input({ info: detached })).kind, "detached", "서버 값 -> 규칙");
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log("titlebranch ok");
