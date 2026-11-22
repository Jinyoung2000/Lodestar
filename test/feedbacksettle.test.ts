import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { TimelineItem } from "../shared/protocol";

const root = realpathSync(mkdtempSync(join(tmpdir(), "fbsettle-")));
process.env.AGENT_NAV_HOME = join(root, "home");

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed++;
};

const { FeedbackRunner } = await import("../server/feedback");
const { T } = await import("../server/strings");
type Runner = InstanceType<typeof FeedbackRunner>;
type Deps = ConstructorParameters<typeof FeedbackRunner>[0];

function sourceRepo(name: string, files: Record<string, string>) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const put = (rel: string, text: string) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  };
  for (const [rel, text] of Object.entries(files)) put(rel, text);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return { dir, put, read: (rel: string) => readFileSync(join(dir, rel), "utf8") };
}

function harness(src: string, extra: Partial<Deps> = {}, timeline: () => TimelineItem[] = () => []) {
  const notices: string[] = [];
  const agents = { adopt: () => undefined, send: async () => undefined, notice: (_id: string, text: string) => void notices.push(text) };
  const store = { settings: { feedbackModel: "haiku" }, addWorkspace: () => ({ id: "w" }), workspaces: [], agent: () => ({ status: "idle" }), timeline };
  const runner = new FeedbackRunner({ store: store as never, agents: agents as never, emit: () => undefined, srcRoot: src, port: 0, restart: () => undefined, busyCount: () => 0, autoFixes: 0, ...extra });
  return { runner, notices };
}

const save = (runner: Runner, id: string, patch: Record<string, unknown>) => {
  const feedback = runner.get(id);
  Object.assign(feedback, patch);
  (runner as unknown as { save: (f: unknown) => void }).save(feedback);
};
const secs = (ms: number) => new Date(ms);
const touch = (file: string, atMs: number) => utimesSync(file, secs(atMs), secs(atMs));

async function awaitingFeedback(name: string) {
  const src = sourceRepo(name, { "server/x.ts": "v1\n", "web/ui.txt": "before\n" });
  const { runner } = harness(src.dir);
  const feedback = await runner.create({ text: `change ${name}`, element: null, screenshot: null, screenshotNote: null });
  writeFileSync(join(feedback.worktree, "server/x.ts"), "v2\n");
  save(runner, feedback.id, { status: "awaitingRestart", changedFiles: ["server/x.ts"], needsRestart: true, summary: `summary ${name}` });
  return { src, id: feedback.id, worktree: feedback.worktree };
}

async function restartedWith(src: string, id: string, daemon: Deps["daemon"], extra: Partial<Deps> = {}) {
  const { runner, notices } = harness(src, { daemon, ...extra });
  await runner.settleOnStart();
  return { runner, feedback: runner.get(id), notices };
}

const START = 1_800_000_000_000;

const home = process.env.AGENT_NAV_HOME!;
const retire = (src: string, id: string) => save(harness(src).runner, id, { status: "dismissed" });

{
  const { src, id } = await awaitingFeedback("landed");
  src.put("server/x.ts", "v2\n");
  touch(join(src.dir, "server/x.ts"), START - 60_000);
  const { feedback, notices } = await restartedWith(src.dir, id, { startedAt: START, builtAt: START - 30_000, bundled: true });
  check("landed change in this daemon's bundle: applied", feedback.status === "applied" && feedback.restartRequested === false && !feedback.restartPending, feedback.status);
  check("a notice says it was applied by the start", notices.some((n) => n === T.fbSettledOnStart("summary landed")), JSON.stringify(notices));
  const manifestFile = join(home, "feedback", id, "manifest.json");
  const manifest = existsSync(manifestFile) ? (JSON.parse(readFileSync(manifestFile, "utf8")) as { files: { rel: string; existed: boolean }[]; hadDist: boolean }) : null;
  check("a manifest is written so Revert works", manifest?.files.length === 1 && manifest.files[0].rel === "server/x.ts" && manifest.files[0].existed && manifest.hadDist === false, JSON.stringify(manifest));
  check("the backup holds the file as it was before the feedback", readFileSync(join(home, "feedback", id, "backup", "server/x.ts"), "utf8") === "v1\n");
  check("the state was saved: the next daemon sees it as applied", harness(src.dir).runner.get(id).status === "applied");
  retire(src.dir, id);
}

{
  const { src, id } = await awaitingFeedback("oldbundle");
  src.put("server/x.ts", "v2\n");
  touch(join(src.dir, "server/x.ts"), START - 10_000);
  const { feedback } = await restartedWith(src.dir, id, { startedAt: START, builtAt: START - 20_000, bundled: true });
  check("bundle built before the change landed: still awaiting restart", feedback.status === "awaitingRestart", feedback.status);
  check("no manifest was invented", !existsSync(join(home, "feedback", id, "manifest.json")));
  retire(src.dir, id);
}

{
  const { src, id } = await awaitingFeedback("rebuilt");
  src.put("server/x.ts", "v2\n");
  touch(join(src.dir, "server/x.ts"), START - 60_000);
  const { feedback } = await restartedWith(src.dir, id, { startedAt: START, builtAt: START + 5_000, bundled: true });
  check("bundle replaced after this daemon started: still awaiting restart", feedback.status === "awaitingRestart", feedback.status);
  retire(src.dir, id);
}

{
  const { src, id } = await awaitingFeedback("different");
  src.put("server/x.ts", "v3 someone else\n");
  touch(join(src.dir, "server/x.ts"), START - 60_000);
  const { feedback } = await restartedWith(src.dir, id, { startedAt: START, builtAt: START - 30_000, bundled: true });
  check("main folder file differs from the feedback's: still awaiting restart", feedback.status === "awaitingRestart", feedback.status);
  retire(src.dir, id);
  const { src: src2, id: id2 } = await awaitingFeedback("notlanded");
  const again = await restartedWith(src2.dir, id2, { startedAt: START, builtAt: START - 30_000, bundled: true });
  check("change never reached the main folder: still awaiting restart", again.feedback.status === "awaitingRestart", again.feedback.status);
  retire(src2.dir, id2);
}

{
  const early = await awaitingFeedback("tsx-early");
  early.src.put("server/x.ts", "v2\n");
  touch(join(early.src.dir, "server/x.ts"), START - 5_000);
  check("source daemon started after the change: applied", (await restartedWith(early.src.dir, early.id, { startedAt: START, builtAt: START - 90_000, bundled: false })).feedback.status === "applied");
  retire(early.src.dir, early.id);
  const late = await awaitingFeedback("tsx-late");
  late.src.put("server/x.ts", "v2\n");
  touch(join(late.src.dir, "server/x.ts"), START + 5_000);
  check("source daemon started before the change: still awaiting restart", (await restartedWith(late.src.dir, late.id, { startedAt: START, builtAt: START - 90_000, bundled: false })).feedback.status === "awaitingRestart");
  retire(late.src.dir, late.id);
}

{
  const { src, id } = await awaitingFeedback("manifest");
  const manifestFile = join(home, "feedback", id, "manifest.json");
  writeFileSync(manifestFile, JSON.stringify({ appliedAt: new Date(START - 1_000).toISOString(), files: [], hadDist: false, hadDistElectron: false }));
  check("applied before the daemon started: applied", (await restartedWith(src.dir, id, { startedAt: START, builtAt: 0, bundled: true })).feedback.status === "applied");
  save(harness(src.dir).runner, id, { status: "awaitingRestart" });
  writeFileSync(manifestFile, JSON.stringify({ appliedAt: new Date(START + 1_000).toISOString(), files: [], hadDist: false, hadDistElectron: false }));
  check("applied after the daemon started: still awaiting restart", (await restartedWith(src.dir, id, { startedAt: START, builtAt: 0, bundled: true })).feedback.status === "awaitingRestart");
  retire(src.dir, id);
}

{
  const { src, id } = await awaitingFeedback("reverted");
  save(harness(src.dir).runner, id, { status: "reverted", restartPending: true, needsRestart: true, updatedAt: new Date(START - 5_000).toISOString() });
  const done = await restartedWith(src.dir, id, { startedAt: START, builtAt: 0, bundled: true });
  check("reverted before the daemon started: restartPending cleared, still Reverted", done.feedback.status === "reverted" && done.feedback.restartPending === false);
  save(harness(src.dir).runner, id, { status: "reverted", restartPending: true, updatedAt: new Date(START + 5_000).toISOString() });
  const waiting = await restartedWith(src.dir, id, { startedAt: START, builtAt: 0, bundled: true });
  check("reverted after the daemon started: restartPending stays", waiting.feedback.restartPending === true);
  retire(src.dir, id);
}

{
  const { src, id } = await awaitingFeedback("nobuild");
  src.put("server/x.ts", "v2\n");
  const { runner } = harness(src.dir);
  await runner.settleOnStart();
  check("without daemon build info nothing changes", runner.get(id).status === "awaitingRestart");
  retire(src.dir, id);
}

{
  const { src, id } = await awaitingFeedback("restart-deferred");
  let calls = 0;
  const { runner } = harness(src.dir, { restart: () => (calls++, { deferred: true, inMs: 12_000 }) });
  save(runner, id, { status: "reverted", restartPending: true });
  runner.requestRestart(id);
  await new Promise((resolve) => setTimeout(resolve, 200));
  check("deferred restart: asked once, the waiting mark stays", calls === 1 && runner.get(id).restartRequested === true && runner.get(id).restartPending === true, `${calls} ${runner.get(id).restartRequested}`);
  retire(src.dir, id);
  const now = await awaitingFeedback("restart-now");
  let nowCalls = 0;
  const immediate = harness(now.src.dir, { restart: () => void nowCalls++ });
  save(immediate.runner, now.id, { status: "reverted", restartPending: true });
  immediate.runner.requestRestart(now.id);
  await new Promise((resolve) => setTimeout(resolve, 200));
  check("restart done at once: the waiting mark is cleared", nowCalls === 1 && immediate.runner.get(now.id).restartRequested === false && immediate.runner.get(now.id).restartPending === false);
  retire(now.src.dir, now.id);
}

{
  const verify = `import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
if (readFileSync("web/ui.txt", "utf8") === "after\\n" && readFileSync("test/data.txt", "utf8").trim() !== "ok") {
  console.error("data is broken");
  process.exit(1);
}
mkdirSync("dist", { recursive: true });
writeFileSync("dist/index.html", "built");
`;
  const src = sourceRepo("summary", { "verify.mjs": verify, "test/data.txt": "broken", "web/ui.txt": "before\n" });
  let seq = 0;
  const timeline = (): TimelineItem[] => [
    { id: `u${seq++}`, kind: "user", text: "Feedback: overlap", shown: "overlap", source: "user" },
    { id: `a${seq++}`, kind: "assistant", text: "제목 오른쪽 여백을 버튼 개수에 맞춰 늘렸습니다." } as TimelineItem,
    { id: `u${seq++}`, kind: "user", text: "The check failed ...", shown: T.fbFixShown("verify", 1, 2), source: "user" },
    { id: `a${seq++}`, kind: "assistant", text: "npm이 실행 환경에 없어서 코드로는 고칠 수 없습니다." } as TimelineItem,
  ];
  const { runner } = harness(src.dir, { checks: [{ name: "verify", command: "node", args: ["verify.mjs"], timeoutMs: 30_000 }] }, timeline);
  const feedback = await runner.create({ text: "overlap", element: null, screenshot: null, screenshotNote: null });
  writeFileSync(join(feedback.worktree, "web/ui.txt"), "after\n");
  runner.afterTurn(feedback.agentId);
  const until = async (done: (status: string) => boolean) => {
    for (let i = 0; i < 600 && !done(runner.get(feedback.id).status); i++) await new Promise((r) => setTimeout(r, 50));
  };
  await until((status) => status === "failed");
  check("failed at the check first", runner.get(feedback.id).status === "failed");
  src.put("test/data.txt", "ok");
  runner.retryChecks(feedback.id);
  await until((status) => status === "applied");
  const done = runner.get(feedback.id);
  check("retry applied it", done.status === "applied", done.status);
  check("the summary is the first turn's reply, not the auto-fix reply", done.summary === "제목 오른쪽 여백을 버튼 개수에 맞춰 늘렸습니다.", String(done.summary));
}

rmSync(root, { recursive: true, force: true });
if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("all passed");
