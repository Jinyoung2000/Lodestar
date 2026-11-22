import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "agent-nav-chat-unit-"));
process.env.AGENT_NAV_HOME = join(home, "nav");
mkdirSync(process.env.AGENT_NAV_HOME, { recursive: true });
const { AgentRunner } = await import("../server/agents");
const { Store } = await import("../server/store");
const { usesSnapshots } = await import("../server/snapshots");
type ServerEvent = import("../shared/protocol").ServerEvent;

const store = new Store();
const events: ServerEvent[] = [];
const runner = new AgentRunner(store, (e) => events.push(e));
(runner as unknown as { send: () => Promise<void> }).send = async () => {};
const params = { prompt: "hello", permissionMode: "default" as const, model: null, effort: null, worktree: null };

const cases: { name: string; run: () => Promise<string> }[] = [];
const test = (name: string, run: () => Promise<string>) => cases.push({ name, run });
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
  return detail;
};

test("workspaceId null 로 만들면 폴더 없는 세션: HOME/chats/<id> 가 생기고 git 기준과 worktree 가 없다", async () => {
  const agent = await runner.create({ ...params, workspaceId: null });
  expect(agent.workspaceId === null, "workspaceId");
  expect(agent.cwd === join(process.env.AGENT_NAV_HOME!, "chats", agent.id), agent.cwd);
  expect(existsSync(agent.cwd) && readdirSync(agent.cwd).length === 0, "빈 폴더가 만들어짐");
  expect(agent.worktree === null && agent.startCommit === null, "worktree 와 startCommit 이 없다");
  expect(!usesSnapshots(agent), "스냅샷 방식이 아니다");
  expect(store.agents.some((a) => a.id === agent.id), "저장됨");
  return agent.cwd;
});

test("폴더 없는 세션에 worktree 를 요청하면 거절한다", async () => {
  let message = "";
  await runner.create({ ...params, workspaceId: null, worktree: { branch: "x", base: "main" } }).catch((e: Error) => (message = e.message));
  expect(/without a folder/.test(message), message);
  expect(store.agents.length === 1, "세션이 늘지 않음");
  return message;
});

test("삭제하면 빈 임시 폴더는 치우고 파일이 있으면 남긴다", async () => {
  const empty = await runner.create({ ...params, workspaceId: null });
  const kept = await runner.create({ ...params, workspaceId: null });
  writeFileSync(join(kept.cwd, "note.txt"), "agent output");
  await runner.remove(empty.id, false);
  await runner.remove(kept.id, false);
  expect(!existsSync(empty.cwd), "빈 폴더는 사라짐");
  expect(existsSync(join(kept.cwd, "note.txt")), "파일이 있는 폴더는 남음");
  expect(!store.agents.some((a) => a.id === empty.id || a.id === kept.id), "세션은 지워짐");
  return "ok";
});

test("폴더 있는 세션은 그대로: workspaceId 와 cwd 가 폴더를 따른다", async () => {
  const dir = join(home, "proj");
  mkdirSync(dir, { recursive: true });
  const workspace = store.addWorkspace(dir);
  const agent = await runner.create({ ...params, workspaceId: workspace.id });
  expect(agent.workspaceId === workspace.id && agent.cwd === realpathSync(dir), `${agent.workspaceId} ${agent.cwd}`);
  return "ok";
});

let failed = 0;
for (const c of cases) {
  try {
    console.log(`PASS ${c.name}: ${await c.run()}`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${c.name}: ${(error as Error).message}`);
  }
}
if (failed) process.exit(1);
console.log(`${cases.length}개 통과`);
process.exit(0);
