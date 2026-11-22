import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Feedback } from "../shared/protocol";
import { DEFAULT_RETENTION, planRetention, protectedReason, withPolicy, type RetentionFacts } from "../shared/feedbackRetention";

const root = realpathSync(mkdtempSync(join(tmpdir(), "fbretention-")));
process.env.AGENT_NAV_HOME = join(root, "home");

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed++;
};

const { FeedbackRunner } = await import("../server/feedback");
const { isFeedbackWorktree, worktrees } = await import("../server/scm");

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-22T12:00:00.000Z");
const facts = (id: string, status: Feedback["status"], daysAgo: number, patch: Partial<Omit<RetentionFacts, "feedback">> & { feedback?: Partial<Feedback> } = {}): RetentionFacts => {
  const { feedback, ...rest } = patch;
  return {
    id,
    feedback: { status, restartRequested: false, restartPending: false, retrying: false, ...feedback },
    updatedAt: NOW - daysAgo * DAY,
    appliedAt: status === "applied" ? NOW - daysAgo * DAY : null,
    busy: false,
    hasWorktree: true,
    hasBackup: true,
    ...rest,
  };
};
const actions = (list: RetentionFacts[], policy = DEFAULT_RETENTION) => Object.fromEntries(planRetention(list, NOW, policy).map((e) => [e.id, `${e.action}${e.reason ? `:${e.reason}` : ""}`]));

{
  check("running, checking, fixing, needsInput, blocked, awaitingRestart 는 정리하지 않는다", (["running", "checking", "fixing", "needsInput", "blocked", "awaitingRestart"] as const).every((s) => protectedReason(facts("x", s, 30)) !== null));
  check("재시작을 기다리는 되돌림(reverted + restartPending)은 정리하지 않는다", protectedReason(facts("x", "reverted", 30, { feedback: { restartPending: true } })) === "restart");
  check("재시작을 요청한 반영은 정리하지 않는다", protectedReason(facts("x", "applied", 30, { feedback: { restartRequested: true } })) === "restart");
  check("검사를 다시 돌리는 중(retrying)은 정리하지 않는다", protectedReason(facts("x", "applied", 30, { feedback: { retrying: true } })) === "restart");
  check("끊겨서 Run Again 이 보이는 실패는 retryable", protectedReason(facts("x", "failed", 30, { feedback: { interrupted: true } })) === "retryable");
  check("그냥 실패(failed)도 사람이 정리하기 전까지는 둔다", protectedReason(facts("x", "failed", 30)) === "active");
  check("세션이나 파이프라인이 도는 중이면 끝난 상태여도 둔다", protectedReason(facts("x", "applied", 30, { busy: true })) === "busy");
  check("applied, resolved, dismissed, noChanges 는 정리 대상", (["applied", "resolved", "dismissed", "noChanges"] as const).every((s) => protectedReason(facts("x", s, 30)) === null));
}

{
  const list = [facts("old1", "applied", 20), facts("old2", "applied", 10), facts("mid", "applied", 5), facts("new1", "applied", 1), facts("new2", "applied", 0.5), facts("dis", "dismissed", 15), facts("res", "resolved", 8)];
  const result = actions(list, { worktreeKeepRecent: 2, worktreeKeepDays: 3, backupKeepApplied: 1, backupKeepDays: 3 });
  check("최근 N개와 최근 N일은 worktree 를 둔다", result.new1.startsWith("keep") && result.new2.startsWith("keep"), JSON.stringify(result));
  check("오래된 반영은 worktree 와 백업을 같이 정리한다", result.old1 === "both" && result.old2 === "both" && result.mid === "both", JSON.stringify(result));
  check("dismissed, resolved 도 오래되면 정리된다", result.dis === "both" && result.res === "both");
  const noBackup = actions([facts("a", "applied", 20, { hasBackup: false }), facts("b", "applied", 0)], { ...DEFAULT_RETENTION, worktreeKeepRecent: 1 });
  check("백업이 없으면 worktree 만 정리한다", noBackup.a === "worktree", JSON.stringify(noBackup));
  const none = actions([facts("a", "applied", 20, { hasBackup: false, hasWorktree: false })]);
  check("정리할 것이 없으면 아무것도 안 한다", none.a === "keep", JSON.stringify(none));
  const keepBackup = actions([facts("a", "applied", 30), facts("b", "applied", 20), facts("c", "applied", 10)], { worktreeKeepRecent: 0, worktreeKeepDays: 0, backupKeepApplied: 2, backupKeepDays: 0 });
  check("백업은 가장 최근에 반영된 N개만 둔다(Revert 는 가장 최근 반영만 되므로)", keepBackup.c === "worktree" && keepBackup.b === "worktree" && keepBackup.a === "both", JSON.stringify(keepBackup));
  check("정책 값은 0 이상의 유한한 수만 받는다", withPolicy({ worktreeKeepRecent: -1, worktreeKeepDays: Number.NaN, backupKeepApplied: 7 }).worktreeKeepRecent === DEFAULT_RETENTION.worktreeKeepRecent && withPolicy({ backupKeepApplied: 7 }).backupKeepApplied === 7);
}

{
  check("feedback/<id> 브랜치와 feedback-<id> 폴더가 맞아야 피드백 사본", isFeedbackWorktree("/r/agent-nav.worktrees/feedback-03a850e0", "feedback/03a850e0"));
  check("사용자가 만든 비슷한 이름은 사본이 아니다", !isFeedbackWorktree("/r/repo.worktrees/feedback-login", "feedback/login") && !isFeedbackWorktree("/r/repo.worktrees/other", "feedback/03a850e0") && !isFeedbackWorktree("/r/repo.worktrees/x", null));
}

const src = join(root, "src");
mkdirSync(join(src, "web"), { recursive: true });
writeFileSync(join(src, "web/ui.txt"), "x\n");
execFileSync("git", ["init", "-q"], { cwd: src });

const archived: string[] = [];
const agents = new Map<string, { status: string; workspaceId: string }>();
function daemon() {
  return new FeedbackRunner({
    store: {
      settings: { feedbackModel: "haiku" },
      addWorkspace: () => ({ id: "w" }),
      workspaces: [],
      agent: (id: string) => agents.get(id) ?? { status: "idle", workspaceId: "w" },
      timeline: () => [],
      archiveWorkspace: (id: string) => {
        archived.push(id);
        return true;
      },
    } as never,
    agents: { adopt: () => undefined, send: async () => undefined, notice: () => undefined } as never,
    emit: () => undefined,
    srcRoot: src,
    port: 0,
    restart: () => undefined,
    busyCount: () => 0,
    checks: [],
  });
}

async function seeded(label: string, patch: Partial<Feedback>, backup = true) {
  const first = daemon();
  const created = await first.create({ text: label, element: null, screenshot: null, screenshotNote: null });
  const dir = join(root, "home", "feedback", created.id);
  const file = join(dir, "state.json");
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), ...patch }, null, 2));
  if (backup) {
    mkdirSync(join(dir, "backup", "web"), { recursive: true });
    writeFileSync(join(dir, "backup", "web", "ui.txt"), "old\n");
    mkdirSync(join(dir, "backup-dist"), { recursive: true });
    writeFileSync(join(dir, "backup-dist", "index.html"), "<html></html>");
  }
  return { id: created.id, dir, worktree: created.worktree };
}

const old = (days: number) => new Date(Date.now() - days * DAY).toISOString();
const a = await seeded("old applied", { status: "applied", updatedAt: old(20), seen: true });
const b = await seeded("older dismissed", { status: "dismissed", updatedAt: old(25), seen: true });
const c = await seeded("fresh applied", { status: "applied", updatedAt: old(0), seen: true });
const d = await seeded("old awaitingRestart", { status: "awaitingRestart", updatedAt: old(30), needsRestart: true }, false);
const e = await seeded("old interrupted failure", { status: "failed", interrupted: true, updatedAt: old(30), failure: "cut" }, false);
const f = await seeded("old running", { status: "running", updatedAt: old(30) }, false);
const runner = daemon();
const policy = { worktreeKeepRecent: 1, worktreeKeepDays: 1, backupKeepApplied: 1, backupKeepDays: 1 };

{
  const plan = await runner.tidyPlan(policy);
  const by = (id: string) => plan.entries.find((entry) => entry.id === id)!;
  check("dry-run: 오래된 반영과 dismissed 만 정리 대상", by(a.id).action === "both" && by(b.id).action === "both", `${by(a.id).action}, ${by(b.id).action}`);
  check("dry-run: 최근 것, 재시작 대기, 끊긴 실패, 도는 중은 둔다", [c, d, e, f].every((x) => by(x.id).action === "keep"), [c, d, e, f].map((x) => by(x.id).action).join());
  check("dry-run: 이유가 보인다", by(d.id).reason === "active" && by(e.id).reason === "retryable" && by(c.id).reason === "recent");
  check("dry-run: 크기를 센다", by(a.id).worktreeBytes > 0 && by(a.id).backupBytes > 0 && plan.totals.workspaces === 2, JSON.stringify(plan.totals));
  check("dry-run 은 아무것도 지우지 않는다", [a, b, c, d, e, f].every((x) => existsSync(x.worktree)) && existsSync(join(a.dir, "backup-dist")));
}

{
  const result = await runner.tidyRun(policy);
  check("실행: worktree 2개, 백업 2개, 워크스페이스 2개", result.worktrees === 2 && result.backups === 2 && result.workspaces === 2 && result.failed.length === 0, JSON.stringify(result));
  check("정리된 피드백의 worktree 와 백업이 사라졌다", !existsSync(a.worktree) && !existsSync(b.worktree) && !existsSync(join(a.dir, "backup")) && !existsSync(join(a.dir, "backup-dist")));
  check("기록(state.json)은 남는다", existsSync(join(a.dir, "state.json")) && existsSync(join(a.dir, "baseline.json")));
  check("보호된 피드백의 worktree 는 그대로", [c, d, e, f].every((x) => existsSync(x.worktree)));
  check("최근 반영의 백업은 그대로", existsSync(join(c.dir, "backup-dist", "index.html")));
  check("git worktree 목록에서도 빠졌다", !execFileSync("git", ["worktree", "list"], { cwd: src }).toString().includes(`feedback-${a.id}`) && execFileSync("git", ["worktree", "list"], { cwd: src }).toString().includes(`feedback-${c.id}`));
  check("워크스페이스를 치운다고 알렸다", archived.length === 2);
  check("정리된 피드백의 변경 목록은 비어 있다(사본이 없다)", (await runner.changes(a.id)).length === 0);
  let revertError = "";
  try {
    await runner.revert(a.id);
  } catch (error) {
    revertError = (error as Error).message;
  }
  check("백업을 정리한 반영을 Revert 하면 이유를 말한다", revertError.includes("cleaned up"), revertError);
  const again = await runner.tidyRun(policy);
  check("두 번째 실행은 할 일이 없다", again.worktrees === 0 && again.backups === 0, JSON.stringify(again));
}

{
  const g = await seeded("becomes busy", { status: "applied", updatedAt: old(40), seen: true });
  const later = daemon();
  agents.set(later.get(g.id).agentId, { status: "running", workspaceId: "w" });
  const result = await later.tidyRun(policy);
  check("세션이 도는 중이면 오래된 반영도 건너뛴다", existsSync(g.worktree) && existsSync(join(g.dir, "backup-dist")), JSON.stringify(result));
}

{
  const repo = join(root, "scm-repo");
  mkdirSync(repo, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" }).toString();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  writeFileSync(join(repo, "a.txt"), "a\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  git("worktree", "add", "-q", "-b", "mine", join(root, "scm-repo.worktrees", "mine"));
  git("worktree", "add", "-q", "--orphan", "-b", "feedback/0123abcd", join(root, "scm-repo.worktrees", "feedback-0123abcd"));
  const repos = await worktrees([repo]);
  const names = repos[0].worktrees.map((w) => w.branch);
  check("SCM 목록에는 사용자 worktree 만 있고 피드백 사본은 없다", names.includes("main") && names.includes("mine") && !names.some((n) => n?.startsWith("feedback/")), names.join());
}

console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
