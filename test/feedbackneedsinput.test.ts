import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const root = realpathSync(mkdtempSync(join(tmpdir(), "fbask-")));
process.env.AGENT_NAV_HOME = join(root, "home");

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed++;
};

const { FeedbackRunner } = await import("../server/feedback");
type Runner = InstanceType<typeof FeedbackRunner>;
type Item = { kind: "user" | "assistant"; text: string };

const VERIFY = `import { mkdirSync, writeFileSync } from "node:fs";
mkdirSync("dist", { recursive: true });
writeFileSync("dist/index.html", "built");
`;

function sourceRepo(name: string) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const put = (rel: string, text: string) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  };
  put("verify.mjs", VERIFY);
  put("web/ui.txt", "before\n");
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return { dir, read: (rel: string) => readFileSync(join(dir, rel), "utf8") };
}

function harness(src: string) {
  const notices: string[] = [];
  const statuses: string[] = [];
  const timeline: Item[] = [];
  const agents = { adopt: () => undefined, send: async () => undefined, notice: (_id: string, text: string) => void notices.push(text) };
  const store = { settings: { feedbackModel: "haiku" }, addWorkspace: () => ({ id: "w" }), workspaces: [], agent: () => ({ status: "idle" }), timeline: () => timeline };
  const runner = new FeedbackRunner({
    store: store as never,
    agents: agents as never,
    emit: (event) => {
      const e = event as unknown as { type: string; feedback?: { status: string } };
      if (e.type === "feedback" && e.feedback && statuses.at(-1) !== e.feedback.status) statuses.push(e.feedback.status);
    },
    srcRoot: src,
    port: 0,
    restart: () => undefined,
    busyCount: () => 0,
    checks: [{ name: "verify", command: "node", args: ["verify.mjs"], timeoutMs: 30_000 }],
    autoFixes: 0,
  });
  const turn = (user: string, reply: string) => timeline.push({ kind: "user", text: user }, { kind: "assistant", text: reply });
  return { runner, notices, statuses, turn };
}

async function until(runner: Runner, id: string, done: (status: string) => boolean) {
  for (let i = 0; i < 600; i++) {
    if (done(runner.get(id).status)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out at ${runner.get(id).status}`);
}

const create = (runner: Runner) => runner.create({ text: "파일 탭을 고정해 줘", element: null, screenshot: null, screenshotNote: null });
const NOTHING = "The session finished without changing any file. Nothing to apply";

{
  const src = sourceRepo("src1");
  const { runner, notices, statuses, turn } = harness(src.dir);
  const feedback = await create(runner);
  turn("파일 탭을 고정해 줘", "[QUESTION] 파일 탭을 별도 고정 패널로 만들까요, 아니면 다른 뜻인가요?");
  runner.afterTurn(feedback.agentId);
  await until(runner, feedback.id, (s) => s === "needsInput");
  const waiting = runner.get(feedback.id);
  check("a marked question with no file change becomes needsInput", waiting.status === "needsInput");
  check("the question is stored without the marker", waiting.question === "파일 탭을 별도 고정 패널로 만들까요, 아니면 다른 뜻인가요?", String(waiting.question));
  check("the summary does not carry the marker", !(waiting.summary ?? "").includes("QUESTION"), String(waiting.summary));
  check("no 'finished without changing' notice and no failure", !notices.includes(NOTHING) && waiting.failure === null && waiting.changedFiles.length === 0);
  check("a waiting feedback is unseen so the notice card and title dot show", waiting.seen === false);
  const saved = JSON.parse(readFileSync(join(root, "home", "feedback", feedback.id, "state.json"), "utf8")) as { status: string; question: string };
  check("state.json keeps the status and the question", saved.status === "needsInput" && saved.question === waiting.question);

  const reloaded = new FeedbackRunner({ store: { agent: () => ({ status: "idle" }) } as never, agents: {} as never, emit: () => undefined, srcRoot: src.dir, port: 0, restart: () => undefined, busyCount: () => 0 });
  check("a daemon restart leaves needsInput alone", reloaded.get(feedback.id).status === "needsInput");

  runner.turnStarted(feedback.agentId);
  const running = runner.get(feedback.id);
  check("the follow-up turn start puts it back to running and clears the question", running.status === "running" && running.question === null);

  writeFileSync(join(running.worktree, "web/ui.txt"), "after\n");
  turn("고정으로", "파일 탭을 고정 패널로 바꿨습니다.");
  runner.afterTurn(feedback.agentId);
  await until(runner, feedback.id, (s) => s === "applied");
  const done = runner.get(feedback.id);
  check("the follow-up turn goes through the checks and applies", done.status === "applied" && done.checks.length === 1 && done.checks[0].ok);
  check("the change reached the main folder", src.read("web/ui.txt") === "after\n");
  check("the status sequence is running, checking, needsInput, running, checking, applied", statuses.join(",") === "running,checking,needsInput,running,checking,applied", statuses.join(","));
  check("the summary after the answer is the new sentence", done.summary === "파일 탭을 고정 패널로 바꿨습니다.", String(done.summary));
  check("the question is gone once applied", !done.question);
  runner.turnStarted(feedback.agentId);
  check("turnStarted does not reopen an applied feedback", runner.get(feedback.id).status === "applied");
}

{
  const src = sourceRepo("src2");
  const { runner, notices, turn } = harness(src.dir);
  const feedback = await create(runner);
  turn("파일 탭을 고정해 줘", "변경 없이 확인이 필요합니다. 별도 고정 패널로 만들까요, 아니면 다른 뜻인가요?");
  runner.afterTurn(feedback.agentId);
  await until(runner, feedback.id, (s) => s === "needsInput");
  check("an old session whose last sentence ends with ? becomes needsInput", runner.get(feedback.id).question?.endsWith("다른 뜻인가요?") === true);

  runner.turnStarted(feedback.agentId);
  turn("고정으로", "알겠습니다. 지금 구조에서는 바꿀 곳이 없습니다.");
  runner.afterTurn(feedback.agentId);
  await until(runner, feedback.id, (s) => s === "noChanges");
  check("a follow-up turn with no change and no question ends as noChanges, the old question is ignored", runner.get(feedback.id).question === null && notices.includes(NOTHING));

  runner.turnStarted(feedback.agentId);
  check("a follow-up on noChanges also starts running", runner.get(feedback.id).status === "running");
  turn("그럼 위쪽에 둬 줘", "[QUESTION] 위쪽이면 헤더 안인가요, 헤더 아래인가요?");
  runner.afterTurn(feedback.agentId);
  await until(runner, feedback.id, (s) => s === "needsInput");
  check("a question in a follow-up turn is needsInput too", runner.get(feedback.id).question === "위쪽이면 헤더 안인가요, 헤더 아래인가요?");
}

{
  const src = sourceRepo("src3");
  const { runner, notices, turn } = harness(src.dir);
  const plain = await create(runner);
  turn("요청", "이미 그렇게 되어 있습니다.");
  runner.afterTurn(plain.agentId);
  await until(runner, plain.id, (s) => s === "noChanges");
  check("a statement with no file change is noChanges with the old notice", runner.get(plain.id).question == null && notices.includes(NOTHING));

  const marked = await create(runner);
  writeFileSync(join(marked.worktree, "web/ui.txt"), "after\n");
  turn("요청", "[QUESTION] 바꿔 봤는데 괜찮나요?");
  runner.afterTurn(marked.agentId);
  await until(runner, marked.id, (s) => s === "applied");
  check("a marker on a turn that changed files does not stop the apply, and the summary has no marker", runner.get(marked.id).status === "applied" && !(runner.get(marked.id).summary ?? "").includes("QUESTION"), String(runner.get(marked.id).summary));
}

console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
