// HANDOFF: 핸드오프 인계 문서 파일, 세션 만들기, 사이드바 트리. 모델은 부르지 않는다(문서 생성은 .verify 의 실제 시험에서 haiku 로 확인). 실행: npm test
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "agent-nav-handoff-unit-"));
process.env.AGENT_NAV_HOME = join(home, "nav");
mkdirSync(process.env.AGENT_NAV_HOME, { recursive: true });
const handoff = await import("../server/handoff");
const { AgentRunner } = await import("../server/agents");
const { Store } = await import("../server/store");
const { buildGroups, DEFAULT_VIEW } = await import("../web/sessionList");
type Agent = import("../shared/protocol").Agent;

const cases: { name: string; run: () => string | Promise<string> }[] = [];
const test = (name: string, run: () => string | Promise<string>) => cases.push({ name, run });
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
  return detail;
};
const NOW = "2026-10-15T12:00:00.000Z";
const record = (id: string, patch: Partial<Agent> = {}): Agent => ({ id, workspaceId: null, cwd: home, worktree: null, forkedFrom: null, resumeFrom: null, startCommit: null, feedbackId: null, title: `title ${id}`, sessionId: `sess-${id}`, status: "idle", permissionMode: "default", model: null, effort: null, activeModel: null, activeEffort: null, backgroundTasks: 0, createdAt: NOW, updatedAt: NOW, ...patch });

test("프롬프트: 사용자의 언어로, 정해진 여섯 섹션", () => {
  const p = handoff.HANDOFF_PROMPT;
  expect(/language the user mainly used/.test(p) && /section titles/.test(p), "language instruction");
  for (const section of ["Goal", "Decisions", "Changed files", "Remaining work", "Cautions", "Related paths"]) expect(p.includes(section), section);
  expect(/no tool|without using any tool/.test(handoff.HANDOFF_SYSTEM_PROMPT) && /Never invent/.test(handoff.HANDOFF_SYSTEM_PROMPT), "system prompt");
  return "6 sections";
});

test("문서 파일: 저장, 읽기, 고쳐 쓰기, 잘못된 id 거절", () => {
  expect(handoff.validHandoffId("mq1abc-0a1b2c") && !handoff.validHandoffId("../etc/passwd") && !handoff.validHandoffId("a/b-0a1b2c") && !handoff.validHandoffId(""), "id check");
  mkdirSync(handoff.HANDOFF_DIR, { recursive: true });
  const id = "mq1abc-0a1b2c";
  expect(!existsSync(handoff.handoffPath(id)), "no file yet");
  let threw = false;
  try {
    handoff.saveHandoff(id, "x");
  } catch {
    threw = true;
  }
  expect(threw, "save without a created document is refused (no new ids from the client)");
  for (const bad of ["../x", "a b", "mq1abc-zzzzzz"]) {
    try {
      handoff.readHandoff(bad);
      throw new Error(`accepted ${bad}`);
    } catch (error) {
      expect((error as Error).message === "Unknown handoff document", (error as Error).message);
    }
  }
  return "refused";
});

test("generateHandoff: 대화가 없는 세션은 거절", async () => {
  try {
    await handoff.generateHandoff(record("empty", { sessionId: null }));
  } catch (error) {
    return expect(/nothing to hand off/.test((error as Error).message), (error as Error).message);
  }
  throw new Error("did not throw");
});

test("create: 핸드오프 세션은 원 세션의 자식이고, 원 세션 끝에 Handed off 줄이 남는다", async () => {
  const store = new Store();
  const events: unknown[] = [];
  const runner = new AgentRunner(store, (e) => events.push(e));
  store.addAgent(record("src", { title: "Fix the login" }));
  const sent: { prompt: string; options: { display?: string; attachments?: unknown[] } }[] = [];
  (runner as unknown as { send: unknown }).send = async (_id: string, prompt: string, options: never) => {
    sent.push({ prompt, options });
    return { queued: false };
  };
  // 문서를 만든 것으로 하고 파일을 둔다
  const id = "mq1abc-0a1b2c";
  mkdirSync(handoff.HANDOFF_DIR, { recursive: true });
  (await import("node:fs")).writeFileSync(handoff.handoffPath(id), "# doc\n");
  expect(handoff.readHandoff(id).text === "# doc\n", "read back");
  handoff.saveHandoff(id, "# doc v2\n");
  expect(handoff.readHandoff(id).text === "# doc v2\n", "edited text is kept");

  const child = await runner.create({ workspaceId: null, prompt: "<handoff>...</handoff>\n\nkeep going", permissionMode: "acceptEdits", model: "haiku", effort: "low", worktree: null, handoffFrom: "src", handoffId: id, shown: "keep going" });
  expect(child.handoffFrom === "src" && child.title === "keep going" && child.permissionMode === "acceptEdits" && child.model === "haiku", JSON.stringify(child));
  const first = sent[0];
  expect(first.options.display === "keep going" && JSON.stringify(first.options.attachments) === JSON.stringify([{ kind: "handoff", label: "Handoff from Fix the login", id }]), JSON.stringify(first.options));
  const notice = store.timeline("src").find((i) => i.kind === "notice");
  expect(notice?.kind === "notice" && notice.text === `Handed off to keep going` && notice.openAgentId === child.id, JSON.stringify(notice));
  // 글 없이 보내면 제목은 원 세션 제목에서
  const bare = await runner.create({ workspaceId: null, prompt: "doc", permissionMode: "default", model: null, effort: null, worktree: null, handoffFrom: "src", handoffId: id, shown: "" });
  expect(bare.title === "Handoff: Fix the login", bare.title);
  // 잘못된 id 와 없는 원 세션은 만들기 전에 거절
  let refused = 0;
  for (const params of [{ handoffFrom: "src", handoffId: "../x" }, { handoffFrom: "nope", handoffId: id }]) {
    try {
      await runner.create({ workspaceId: null, prompt: "x", permissionMode: "default", model: null, effort: null, worktree: null, ...params });
    } catch {
      refused++;
    }
  }
  expect(refused === 2, `refused ${refused}`);
  return "child, notice, title";
});

test("사이드바: 핸드오프 세션은 원 세션 아래 자식, 갈래가 있으면 갈래가 먼저", () => {
  const workspaces = [{ id: "w1", name: "alpha", dir: "/alpha", parentId: null }];
  const src = record("p", { workspaceId: "w1", createdAt: "2026-10-15T10:00:00.000Z", updatedAt: "2026-10-15T10:00:00.000Z" });
  const kid = record("k", { workspaceId: "w1", handoffFrom: "p", createdAt: "2026-10-15T11:00:00.000Z", updatedAt: "2026-10-15T11:00:00.000Z" });
  const both = record("b", { workspaceId: "w1", forkedFrom: "p", handoffFrom: "k", createdAt: "2026-10-15T11:30:00.000Z", updatedAt: "2026-10-15T11:30:00.000Z" });
  const groups = buildGroups({ agents: [src, kid, both], workspaces, topWorkspaceId: (id) => id || null, view: { ...DEFAULT_VIEW }, defaultOrdering: "created", now: Date.parse("2026-10-15T13:00:00.000Z"), collapsedParents: new Set(), expandedGroups: new Set() });
  const rows = groups.find((g) => g.id === "ws:w1")!.rows.map((r) => `${r.agent.id}:${r.depth}`).join(",");
  return expect(rows === "p:0,k:1,b:1", rows);
});

test("gitStateBlock: 원 세션 폴더의 최근 커밋과 커밋 안 된 변경이 문서 질문에 들어간다 (dogfood 2회차 10번)", async () => {
  const { execFileSync } = await import("node:child_process");
  const { writeFileSync, realpathSync } = await import("node:fs");
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "agent-nav-handoff-repo-")));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" }).toString();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  writeFileSync(join(repo, "a.txt"), "1\n");
  git("add", ".");
  git("commit", "-q", "-m", "Add a.txt from the Source Control panel");
  writeFileSync(join(repo, "b.txt"), "new\n");
  const block = await handoff.gitStateBlock(repo);
  expect(!!block && block.includes("branch main") && block.includes("Add a.txt from the Source Control panel"), `commit subject: ${block}`);
  expect(!!block && /Uncommitted changes \(1 files/.test(block) && block.includes("?? b.txt"), `uncommitted: ${block}`);
  git("add", ".");
  git("commit", "-q", "-m", "second");
  expect((await handoff.gitStateBlock(repo))!.includes("Uncommitted changes: none"), "clean tree");
  const plain = mkdtempSync(join(tmpdir(), "agent-nav-handoff-plain-"));
  expect((await handoff.gitStateBlock(plain)) === null, "git 이 아닌 폴더는 붙이지 않는다");
  rmSync(repo, { recursive: true, force: true });
  rmSync(plain, { recursive: true, force: true });
  return "commits, uncommitted, clean, non-git";
});

let failed = 0;
for (const c of cases) {
  try {
    console.log(`ok   ${c.name} (${await c.run()})`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${c.name}: ${(error as Error).message}`);
  }
}
rmSync(home, { recursive: true, force: true });
console.log(failed ? `${failed} failed` : `${cases.length} passed`);
process.exit(failed ? 1 : 0);
