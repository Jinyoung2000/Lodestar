// FBREBASE: 개선 세션이 옛 기준 위에서 계속 고쳐 같은 충돌로 "Not applied" 가 반복되던 문제 단독 시험(임시 git 저장소와 임시 홈, 모델 호출 없음).
// 1) 사용자가 이어서 말하기 전에 작업 폴더와 기준을 본 작업 폴더에 맞춘다(beforeTurn). 2) 같은 줄 충돌이면 충돌 파일을 본 폴더 내용으로 바꾸고 개선 세션에 다시 적용하게 한다(최대 2회). 3) 같은 사유의 실패 알림은 갱신만 한다.
// 가짜 개선 세션: send 가 불리면 정해 둔 동작을 worktree 와 본 작업 폴더에 하고, 잠시 뒤 턴이 끝난 것처럼 afterTurn 을 부른다.
// 실행: npm test
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const root = realpathSync(mkdtempSync(join(tmpdir(), "fbrebase-")));
process.env.AGENT_NAV_HOME = join(root, "home");

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed++;
};

const { FeedbackRunner } = await import("../server/feedback");
const { feedbackBadge } = await import("../web/feedbackBadge");
type Runner = InstanceType<typeof FeedbackRunner>;

const VERIFY = `import { mkdirSync, writeFileSync } from "node:fs";
mkdirSync("dist", { recursive: true });
writeFileSync("dist/index.html", "built");
`;

// l1..l20 한 줄씩. over 로 몇 줄만 바꾼다.
const styles = (over: Record<number, string> = {}) => Array.from({ length: 20 }, (_, i) => over[i + 1] ?? `l${i + 1}`).join("\n") + "\n";

// o1..o20 한 줄씩(web/other.txt)
const other = (over: Record<number, string> = {}) => Array.from({ length: 20 }, (_, i) => over[i + 1] ?? `o${i + 1}`).join("\n") + "\n";

function sourceRepo(name: string) {
  const dir = join(root, name);
  const put = (rel: string, text: string) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  };
  mkdirSync(dir, { recursive: true });
  put("verify.mjs", VERIFY);
  put("web/styles.css", styles());
  put("web/other.txt", other());
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return { dir, put, read: (rel: string) => readFileSync(join(dir, rel), "utf8") };
}

type Sent = { prompt: string; display: string | undefined };
type Item = { id: string; text: string; detail?: string };

// onSend 가 있으면 send 마다 불리고(몇 번째인지 n), 끝나면 잠시 뒤 턴이 끝난 것처럼 afterTurn 을 부른다.
function harness(src: string, opts: { reapplies?: number; onSend?: (n: number, prompt: string, worktree: string) => void } = {}) {
  const items: Item[] = [];
  const sent: Sent[] = [];
  const statuses: string[] = [];
  const holder: { runner: Runner | null; worktree: string; agentId: string } = { runner: null, worktree: "", agentId: "" };
  let counter = 0;
  const agents = {
    adopt: () => undefined,
    send: async (_id: string, prompt: string, options: { display?: string } = {}) => {
      // create 가 보내는 첫 요청은 worktree 가 정해지기 전이다.
      if (!holder.worktree) return { queued: false };
      sent.push({ prompt, display: options.display });
      opts.onSend?.(sent.length, prompt, holder.worktree);
      setTimeout(() => holder.runner?.afterTurn(holder.agentId), 100);
      return { queued: false };
    },
    // id 를 주면 그 항목을 같은 자리에서 갱신한다(실제 AgentRunner.notice 와 같다).
    notice: (_agentId: string, text: string, detail?: string, _fold?: unknown, id?: string) => {
      const itemId = id ?? `n${++counter}`;
      const item: Item = { id: itemId, text, ...(detail ? { detail } : {}) };
      const at = items.findIndex((i) => i.id === itemId);
      if (at === -1) items.push(item);
      else items[at] = item;
      return itemId;
    },
  };
  const store = { settings: { feedbackModel: "haiku" }, addWorkspace: () => ({ id: "w" }), workspaces: [], agent: () => ({ status: "idle" }), timeline: () => [] };
  const runner = new FeedbackRunner({
    store: store as never,
    agents: agents as never,
    emit: (event) => {
      const feedback = (event as { feedback?: { status: string; reapplying?: boolean } }).feedback;
      const label = feedback ? `${feedback.status}${feedback.reapplying ? "*" : ""}` : null;
      if (label && statuses[statuses.length - 1] !== label) statuses.push(label);
    },
    srcRoot: src,
    port: 0,
    restart: () => undefined,
    busyCount: () => 0,
    checks: [{ name: "verify", command: "node", args: ["verify.mjs"], timeoutMs: 30_000 }],
    autoFixes: 0,
    applyRetryWaitMs: 20,
    ...(opts.reapplies !== undefined ? { reapplies: opts.reapplies } : {}),
  });
  holder.runner = runner;
  const create = async () => {
    const feedback = await runner.create({ text: "change the styles", element: null, screenshot: null, screenshotNote: null });
    holder.worktree = feedback.worktree;
    holder.agentId = feedback.agentId;
    return feedback;
  };
  return { runner, items, sent, statuses, create, holder };
}

async function settled(runner: Runner, id: string) {
  for (let i = 0; i < 800; i++) {
    const status = runner.get(id).status;
    if (status !== "running" && status !== "checking" && status !== "fixing") return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out at ${runner.get(id).status}`);
}

const setLines = (worktree: string, over: Record<number, string>) => writeFileSync(join(worktree, "web/styles.css"), styles(over));
const readWorktree = (worktree: string) => readFileSync(join(worktree, "web/styles.css"), "utf8");

// 사용자가 이어서 말한다: agents.startTurn 이 하는 순서(beforeTurn 을 기다리고, turnStarted, 모델이 파일을 고치고, 턴이 끝나면 afterTurn).
async function userTurn(runner: Runner, agentId: string, text: string, work: () => void) {
  const modelPrompt = await runner.beforeTurn(agentId, text);
  runner.turnStarted(agentId);
  work();
  runner.afterTurn(agentId);
  return modelPrompt;
}

// 1. 원래 일어난 일(대조군): 같은 줄 충돌로 실패한 피드백을 손으로 반영하고 해결 처리한 뒤 대화를 이어 가면, 기준 보정 없이는 턴마다 같은 충돌이다.
{
  const src = sourceRepo("src1");
  const h = harness(src.dir, { reapplies: 0 });
  const fb = await h.create();
  src.put("web/styles.css", styles({ 3: "main-l3", 15: "main-l15" }));
  setLines(fb.worktree, { 3: "fb1-l3" });
  h.runner.afterTurn(fb.agentId);
  await settled(h.runner, fb.id);
  check("control: the first turn fails on the same lines", h.runner.get(fb.id).status === "failed" && (h.runner.get(fb.id).failure ?? "").includes("both changed the same lines"));

  // 코디네이터가 손으로 본 폴더에 옮겨 넣고 해결 처리한다(worktree 와 글자가 다르다).
  src.put("web/styles.css", styles({ 3: "main-l3+fb1", 15: "main-l15" }));
  h.runner.resolve(fb.id);
  check("resolved by hand", h.runner.get(fb.id).status === "resolved");

  // 보정 없이 이어 가기: 개선 세션은 옛 worktree 위에서 5번째 줄을 고친다
  setLines(fb.worktree, { 3: "fb1-l3", 5: "fb2-l5" });
  h.runner.afterTurn(fb.agentId);
  await settled(h.runner, fb.id);
  check("control: continuing without the rebase fails again with the same conflict", h.runner.get(fb.id).status === "failed" && (h.runner.get(fb.id).failure ?? "").includes("web/styles.css (both changed the same lines)"), h.runner.get(fb.id).failure ?? "");
}

// 2. 같은 일을 beforeTurn 으로: 손으로 반영한 변경은 본 폴더 내용이 이기고, 새 턴의 변경만 깨끗이 반영된다.
{
  const src = sourceRepo("src2");
  const h = harness(src.dir, { reapplies: 0 });
  const fb = await h.create();
  src.put("web/styles.css", styles({ 3: "main-l3", 15: "main-l15" }));
  setLines(fb.worktree, { 3: "fb1-l3" });
  h.runner.afterTurn(fb.agentId);
  await settled(h.runner, fb.id);
  const handLanded = styles({ 3: "main-l3+fb1", 15: "main-l15" });
  src.put("web/styles.css", handLanded);
  h.runner.resolve(fb.id);

  const modelPrompt = await userTurn(h.runner, fb.agentId, "1. 누르고 shift엔터누르니깐 문제가 생기네", () => {
    check("the working copy took the main folder's file before the model read anything", readWorktree(fb.worktree) === handLanded);
    setLines(fb.worktree, { 3: "main-l3+fb1", 5: "fb2-l5", 15: "main-l15" });
  });
  check("a resolved feedback runs again while the new turn works", h.runner.get(fb.id).status === "checking" || h.runner.get(fb.id).status === "running");
  check("the model prompt names the file and says it was handled by hand", modelPrompt.includes("web/styles.css") && modelPrompt.includes("already handled by hand") && modelPrompt.endsWith("1. 누르고 shift엔터누르니깐 문제가 생기네"), modelPrompt);
  check("the old version of the file is kept for reference", existsSync(join(root, "home", "feedback", fb.id, "dropped/web/styles.css")) && readFileSync(join(root, "home", "feedback", fb.id, "dropped/web/styles.css"), "utf8") === styles({ 3: "fb1-l3" }));
  check("the conversation gets one notice about the sync", h.items.some((i) => i.text.startsWith("Brought the working copy up to date")));
  await settled(h.runner, fb.id);
  const f = h.runner.get(fb.id);
  check("only the new turn's change is listed", f.status === "applied" && f.changedFiles.join() === "web/styles.css", `${f.status} ${f.failure ?? ""}`);
  check("main keeps the hand landing and gets the new line", src.read("web/styles.css") === styles({ 3: "main-l3+fb1", 5: "fb2-l5", 15: "main-l15" }));
  check("the baseline moved to the main folder's content", (await h.runner.original(fb.id, "web/styles.css")) === handLanded);
}

// 2b. 해결 처리된 피드백은 본 폴더가 손으로 옮긴 변경을 다른 줄에 얹었어도 합치지 않는다(병합하면 같은 변경이 두 번 들어간다).
{
  const src = sourceRepo("src2b");
  const h = harness(src.dir, { reapplies: 0 });
  const fb = await h.create();
  setLines(fb.worktree, { 3: "fb-change" });
  h.runner.afterTurn(fb.agentId);
  await settled(h.runner, fb.id);
  // 이 피드백은 본 폴더에 직접 들어갔고(다른 줄에, 글자도 약간 다르게) 해결 처리됐다. 반영 단추를 거치지 않았으니 이 피드백은 반영 상태가 아니다.
  const landed = styles({ 8: "fb-change (by hand)" });
  src.put("web/styles.css", landed);
  (h.runner as unknown as { fail: (f: unknown, m: string) => void }).fail(h.runner.get(fb.id), "Not applied: something");
  h.runner.resolve(fb.id);
  const modelPrompt = await h.runner.beforeTurn(fb.agentId, "again");
  check("resolved: the main folder wins, the change is not merged in twice", readWorktree(fb.worktree) === landed && modelPrompt.includes("web/styles.css"), readWorktree(fb.worktree));
}

// 3. 반영 안 된 채(failed, 해결 처리 아님) 이어 말하면: 합쳐지는 파일은 합치고, 충돌 파일은 본 폴더 내용이 이기고 옛 버전이 남는다. 안내에는 해결 처리 문구가 없다.
{
  const src = sourceRepo("src3");
  const h = harness(src.dir, { reapplies: 0 });
  const fb = await h.create();
  src.put("web/styles.css", styles({ 3: "main-l3", 15: "main-l15" }));
  src.put("web/other.txt", other({ 15: "main-o15" }));
  setLines(fb.worktree, { 3: "fb1-l3" });
  writeFileSync(join(fb.worktree, "web/other.txt"), other({ 3: "fb-o3" }));
  h.runner.afterTurn(fb.agentId);
  await settled(h.runner, fb.id);
  check("setup: failed on the conflict", h.runner.get(fb.id).status === "failed");

  const modelPrompt = await h.runner.beforeTurn(fb.agentId, "continue please");
  check("the conflicting file took the main folder's content", readWorktree(fb.worktree) === styles({ 3: "main-l3", 15: "main-l15" }));
  check("the prompt says the main folder changed the same places and does not claim a hand landing", modelPrompt.includes("changed in the same places") && !modelPrompt.includes("handled by hand"));
  check("the file that merges cleanly keeps both sides", readFileSync(join(fb.worktree, "web/other.txt"), "utf8") === other({ 3: "fb-o3", 15: "main-o15" }));
  check("the clean file is not listed as replaced", !modelPrompt.includes("web/other.txt"));
  h.runner.turnStarted(fb.agentId);
  setLines(fb.worktree, { 3: "main-l3+fb", 15: "main-l15" });
  h.runner.afterTurn(fb.agentId);
  await settled(h.runner, fb.id);
  check("after the model re-applies on top, it applies", h.runner.get(fb.id).status === "applied" && src.read("web/styles.css") === styles({ 3: "main-l3+fb", 15: "main-l15" }), h.runner.get(fb.id).failure ?? "");
}

// 3b. 첫 요청(running)이나 검사 중에는 건드리지 않는다. 반영된 피드백도 건드리지 않는다.
{
  const src = sourceRepo("src3b");
  const h = harness(src.dir, { reapplies: 0 });
  const fb = await h.create();
  src.put("web/styles.css", styles({ 3: "main-l3" }));
  setLines(fb.worktree, { 3: "fb1-l3" });
  check("a running feedback is left alone", (await h.runner.beforeTurn(fb.agentId, "hi")) === "hi" && readWorktree(fb.worktree) === styles({ 3: "fb1-l3" }));
  h.runner.afterTurn(fb.agentId);
  await settled(h.runner, fb.id);
  const manual = styles({ 3: "fb1-l3" });
  src.put("web/styles.css", manual);
  (h.runner as unknown as { set: (f: unknown, p: unknown) => void }).set(h.runner.get(fb.id), { status: "applied" });
  src.put("web/styles.css", styles({ 3: "fb1-l3", 15: "main-l15" }));
  check("an applied feedback is left alone", (await h.runner.beforeTurn(fb.agentId, "hi")) === "hi" && readWorktree(fb.worktree) === styles({ 3: "fb1-l3" }));
}

// 4. 같은 줄 충돌 자동 해소: 충돌 파일을 본 폴더 내용으로 바꾸고 개선 세션이 그 위에 다시 적용한 뒤 검사와 반영이 이어진다.
{
  const src = sourceRepo("src4");
  const h = harness(src.dir, {
    onSend: (_n, prompt, worktree) => {
      // 개선 세션: 파일을 다시 읽고(본 폴더 내용이어야 한다) 그 위에 의도한 변경을 얹는다.
      check("the re-apply turn finds the main folder's file in the working copy", readFileSync(join(worktree, "web/styles.css"), "utf8") === styles({ 3: "main-l3", 15: "main-l15" }));
      check("the prompt names the file, the reason and the diff of its own change", prompt.includes("web/styles.css (both changed the same lines)") && prompt.includes("-l3") && prompt.includes("+fb-l3") && prompt.includes("dropped"), prompt);
      writeFileSync(join(worktree, "web/styles.css"), styles({ 3: "main-l3+fb", 15: "main-l15" }));
    },
  });
  const fb = await h.create();
  src.put("web/styles.css", styles({ 3: "main-l3", 15: "main-l15" }));
  setLines(fb.worktree, { 3: "fb-l3" });
  h.runner.afterTurn(fb.agentId);
  // 재적용 턴이 시작되는 동안의 상태
  for (let i = 0; i < 100 && h.sent.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
  const during = h.runner.get(fb.id);
  check("while it re-applies the feedback is fixing, marked reapplying, and the badge says Re-applying", during.status === "fixing" && during.reapplying === true && feedbackBadge(during)?.label === "Re-applying", `${during.status} ${during.reapplying}`);
  await settled(h.runner, fb.id);
  const f = h.runner.get(fb.id);
  check("one re-apply turn, then applied", f.status === "applied" && h.sent.length === 1 && f.reapplyTries === 1, `${f.status} sent=${h.sent.length} tries=${f.reapplyTries} ${f.failure ?? ""}`);
  check("the turn's screen text says it is a re-apply", /^The main folder changed and your edits collided with it\. Apply them again on top of it \(1 of 2\)$/.test(h.sent[0]?.display ?? ""), h.sent[0]?.display ?? "");
  check("main has the main folder's edit and the re-applied change", src.read("web/styles.css") === styles({ 3: "main-l3+fb", 15: "main-l15" }));
  check("the conversation says it is re-applying, and no Not applied was posted", h.items.some((i) => i.text.startsWith("The main folder changed under this feedback's edits")) && !h.items.some((i) => i.text.startsWith("Not applied")));
  check("the flag is gone once checks start again", f.reapplying === false && h.statuses.includes("fixing*") && !h.statuses.slice(h.statuses.indexOf("fixing*") + 1).includes("fixing*"));
}

// 5. 두 번 다시 적용해도 본 폴더가 같은 줄을 또 바꾸면 실패(Merge Again)로 확정한다.
{
  const src = sourceRepo("src5");
  const h = harness(src.dir, {
    onSend: (n, _prompt, worktree) => {
      // 다른 에이전트가 본 폴더의 같은 줄을 또 고치고, 개선 세션은 그 사이 옛 본 폴더 위에서 다시 적용한 상태다.
      src.put("web/styles.css", styles({ 3: `main-v${n + 1}` }));
      setLines(worktree, { 3: `fb-v${n}` });
    },
  });
  const fb = await h.create();
  src.put("web/styles.css", styles({ 3: "main-v1" }));
  setLines(fb.worktree, { 3: "fb-v0" });
  h.runner.afterTurn(fb.agentId);
  await settled(h.runner, fb.id);
  const f = h.runner.get(fb.id);
  check("two re-apply turns were sent, then it failed", f.status === "failed" && h.sent.length === 2 && f.reapplyTries === 2, `${f.status} sent=${h.sent.length} tries=${f.reapplyTries}`);
  check("it fails as a conflict, so the button reads Merge Again", f.conflict === true && f.checks.length === 1 && !f.checks[0].ok && (f.failure ?? "").includes("web/styles.css (both changed the same lines)"), f.failure ?? "");
  check("the main folder is untouched by the failure", src.read("web/styles.css") === styles({ 3: "main-v3" }));
  check("the second turn said 2 of 2", (h.sent[1]?.display ?? "").endsWith("(2 of 2)"));
  const failures = h.items.filter((i) => i.text.startsWith("Not applied"));
  check("one failure notice", failures.length === 1, String(failures.length));
}

// 5b. 충돌이 같은 줄이 아니면(바이너리 등) 다시 적용하라고 보내지 않고 바로 실패한다.
{
  const src = sourceRepo("src5b");
  src.put("web/bin.dat", "x");
  writeFileSync(join(src.dir, "web/bin.dat"), Buffer.from([1, 0, 2, 3]));
  const h = harness(src.dir);
  const fb = await h.create();
  writeFileSync(join(src.dir, "web/bin.dat"), Buffer.from([1, 0, 9, 9]));
  writeFileSync(join(fb.worktree, "web/bin.dat"), Buffer.from([1, 0, 7, 7]));
  h.runner.afterTurn(fb.agentId);
  await settled(h.runner, fb.id);
  check("a binary conflict is not sent back to the session", h.runner.get(fb.id).status === "failed" && h.sent.length === 0 && [...readFileSync(join(h.runner.get(fb.id).worktree, "web/bin.dat"))].join() === "1,0,7,7");
}

// 6. 사용자가 이어서 말한 턴이 끝나면 재적용 횟수를 다시 센다.
{
  const src = sourceRepo("src6");
  const h = harness(src.dir, {
    onSend: (n, _prompt, worktree) => {
      src.put("web/styles.css", styles({ 3: `main-again${n}` }));
      setLines(worktree, { 3: `fb-again${n}` });
    },
  });
  const fb = await h.create();
  src.put("web/styles.css", styles({ 3: "main-l3" }));
  setLines(fb.worktree, { 3: "fb-l3" });
  h.runner.afterTurn(fb.agentId);
  await settled(h.runner, fb.id);
  check("setup: it used its two re-applies", h.runner.get(fb.id).reapplyTries === 2 && h.runner.get(fb.id).status === "failed");
  await userTurn(h.runner, fb.agentId, "try again", () => undefined);
  check("a turn the user sent starts the count over", h.runner.get(fb.id).reapplyTries === 0, `tries=${h.runner.get(fb.id).reapplyTries}`);
  await settled(h.runner, fb.id);
}

// 7. 같은 사유의 실패 알림은 갱신만 한다: 연속 턴에서 대화에 알림이 쌓이지 않고, 이미 본 실패는 다시 띄우지 않는다.
{
  const src = sourceRepo("src7");
  const h = harness(src.dir, { reapplies: 0 });
  const fb = await h.create();
  src.put("web/styles.css", styles({ 3: "main-l3" }));
  setLines(fb.worktree, { 3: "fb-l3" });
  h.runner.afterTurn(fb.agentId);
  await settled(h.runner, fb.id);
  const notApplied = () => h.items.filter((i) => i.text.startsWith("Not applied"));
  check("first failure: one notice", notApplied().length === 1);
  h.runner.markSeen(fb.id);

  // 보정 없이 두 턴 더(옛 흐름): 같은 사유
  for (const line of ["fb-2", "fb-3"]) {
    h.runner.turnStarted(fb.agentId);
    setLines(fb.worktree, { 3: line });
    h.runner.afterTurn(fb.agentId);
    await settled(h.runner, fb.id);
  }
  check("two more turns with the same reason: still one notice", notApplied().length === 1, String(notApplied().length));
  check("a failure the user already saw does not pop up again", h.runner.get(fb.id).seen === true);
  check("the card still shows the failure", h.runner.get(fb.id).status === "failed" && (h.runner.get(fb.id).failure ?? "").includes("both changed the same lines"));

  // 다른 사유는 새 알림
  src.put("web/other.txt", other({ 5: "main-o5" }));
  writeFileSync(join(fb.worktree, "web/other.txt"), other({ 5: "fb-o5" }));
  h.runner.afterTurn(fb.agentId);
  await settled(h.runner, fb.id);
  check("a different reason adds a new notice", notApplied().length === 2, String(notApplied().length));

  // 해결 처리 뒤 같은 사유로 다시 실패하면 새 알림이다
  const before = notApplied().length;
  h.runner.resolve(fb.id);
  h.runner.turnStarted(fb.agentId);
  h.runner.afterTurn(fb.agentId);
  await settled(h.runner, fb.id);
  check("after it was resolved, the same reason is a new failure again", notApplied().length === before + 1, `${before} -> ${notApplied().length}`);
}

rmSync(root, { recursive: true, force: true });
if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("all passed");
