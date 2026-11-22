import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "agent-nav-notionservice-unit-"));
process.env.AGENT_NAV_HOME = join(home, "nav");
mkdirSync(process.env.AGENT_NAV_HOME, { recursive: true });

const { NotionService } = await import("../server/notion");
const { NotionChatStore } = await import("../server/notionChats");
const { notionOverridden, notionServerConfig } = await import("../server/notionSession");
const { createNotion, wirePage } = await import("../server/notionHost");
type ServerEvent = import("../shared/protocol").ServerEvent;
type Outcome = import("../server/notionSession").NotionSessionOutcome;

const cases: { name: string; run: () => Promise<void> | void }[] = [];
const test = (name: string, run: () => Promise<void> | void) => cases.push({ name, run });
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
};

const ID = "aaaaaaaabbbbccccddddeeeeeeeeeeee";
const URL_ = `https://www.notion.so/Plan-${ID}`;
const fetchText = (title = "Plan") => JSON.stringify({ metadata: { type: "page" }, title, url: `https://app.notion.com/p/${ID}`, text: `Here is the result:\n<page url="x">\n<properties>\n{"title":"${title}"}\n</properties>\n<content>\n## Hello\n</content>\n</page>`, page_last_edited_at: "2026-10-16T00:00:00.000Z" });
const outcome = (text: string, isError = false): Outcome => ({ call: { name: "x", input: {}, text, isError }, calls: 1, costUsd: 0.002, turns: 2 });

function service(run: (tool: string, input: Record<string, unknown>) => Promise<Outcome>, dir = mkdtempSync(join(tmpdir(), "notion-pages-"))) {
  const events: ServerEvent[] = [];
  const calls: { tool: string; input: Record<string, unknown> }[] = [];
  const s = new NotionService((e) => events.push(e), async (tool, input) => (calls.push({ tool, input }), run(tool, input)), dir);
  return { s, events, calls, dir };
}

test("read: notion-fetch 를 id 로 한 번 부르고 결과를 해석한다", async () => {
  const { s, calls } = service(async () => outcome(fetchText()));
  const read = await s.read(URL_);
  expect(calls.length === 1 && calls[0].tool === "notion-fetch" && calls[0].input.id === ID, JSON.stringify(calls));
  expect(read.page.title === "Plan" && read.page.markdown === "## Hello" && read.costUsd === 0.002 && read.turns === 2, JSON.stringify(read.page));
});

test("read: 같은 페이지를 동시에 읽으면 호출은 한 번 (주소 모양이 달라도 id 가 같으면)", async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => (release = r));
  const { s, calls } = service(async () => (await gate, outcome(fetchText())));
  const a = s.read(URL_);
  const b = s.read(`https://app.notion.com/p/${ID}?pvs=4`);
  release();
  await Promise.all([a, b]);
  expect(calls.length === 1, `호출 ${calls.length}번`);
});

test("cached: 읽은 뒤에는 네트워크 없이 돌려주고, 다른 인스턴스(재시작)도 파일에서 읽는다", async () => {
  const { s, calls, dir } = service(async () => outcome(fetchText()));
  expect(s.cached(URL_) === null, "처음엔 없음");
  await s.read(URL_);
  expect(s.cached(URL_)?.page.title === "Plan", "메모리");
  const second = service(async () => outcome("never"), dir);
  expect(second.s.cached(`https://app.notion.com/p/${ID}`)?.page.title === "Plan" && second.calls.length === 0, "파일");
  expect(readdirSync(dir).includes(`${ID}.json`) && calls.length === 1, "저장 파일");
});

test("cached: 깨진 파일은 없는 것으로 본다", () => {
  const dir = mkdtempSync(join(tmpdir(), "notion-pages-"));
  writeFileSync(join(dir, `${ID}.json`), "{not json");
  expect(service(async () => outcome(""), dir).s.cached(URL_) === null, "깨진 파일");
});

test("read: 오류 결과와 해석할 수 없는 결과는 이유가 담긴 예외, 호출이 없으면 다시 해 보라는 예외", async () => {
  const failing = service(async () => outcome("object not found", true));
  let message = "";
  await failing.s.read(URL_).catch((e: Error) => (message = e.message));
  expect(message.includes("object not found"), message);
  const junk = service(async () => outcome("plain text, not json"));
  await junk.s.read(URL_).catch((e: Error) => (message = e.message));
  expect(message.includes("plain text"), message);
  const none = service(async () => ({ call: null, calls: 0, costUsd: 0, turns: 1 }));
  await none.s.read(URL_).catch((e: Error) => (message = e.message));
  expect(message.includes("not called"), message);
  expect(none.s.cached(URL_) === null, "실패는 캐시하지 않는다");
});

test("write: 러너에 인자를 그대로 넘기고, 호출이 없으면 sent false", async () => {
  const { s, calls } = service(async () => outcome('{"ok":true}'));
  const result = await s.write("notion-update-page", { page_id: ID, command: "insert_content", content: "x" });
  expect(result.sent && !result.isError && calls[0].tool === "notion-update-page" && calls[0].input.content === "x", JSON.stringify(result));
  const none = service(async () => ({ call: null, calls: 0, costUsd: 0, turns: 1 }));
  const skipped = await none.s.write("notion-create-pages", { pages: [] });
  expect(!skipped.sent && skipped.isError, "호출 없음");
});

test("changed: 메모리와 파일 캐시를 버리고 notionChanged 를 보낸다", async () => {
  const { s, events } = service(async () => outcome(fetchText()));
  await s.read(URL_);
  s.changed(URL_);
  expect(events.some((e) => e.type === "notionChanged" && e.key === `id:${ID}`), JSON.stringify(events));
  expect(s.cached(URL_) === null, "바뀌기 전 내용이 남지 않는다");
});

test("chats: 저장과 재시작 보존, 세션 id 로 찾기, 지워진 세션 정리", () => {
  const file = join(home, "chats.json");
  const a = new NotionChatStore(file);
  a.set(`id:${ID}`, { agentId: "s1", url: URL_, title: "Plan" });
  a.set("id:other", { agentId: "s2", url: "https://www.notion.so/x", title: "X" });
  const b = new NotionChatStore(file);
  expect(b.get(`id:${ID}`)?.agentId === "s1" && b.ofAgent("s2")?.title === "X" && b.ofAgent("zzz") === null, "재시작 보존");
  expect(JSON.stringify(b.wire()) === JSON.stringify({ [`id:${ID}`]: "s1", "id:other": "s2" }), "화면용 모양");
  expect(b.prune(new Set(["s1"])) && b.get("id:other") === null && !b.prune(new Set(["s1"])), "정리");
  b.remove(`id:${ID}`);
  expect(new NotionChatStore(file).get(`id:${ID}`) === null, "remove");
  writeFileSync(file, "garbage");
  expect(Object.keys(new NotionChatStore(file).wire()).length === 0, "깨진 파일");
});

test("시험 인스턴스 설정: AGENT_NAV_NOTION_MCP 가 가짜 서버 설정을 가리키면 실제 Notion 설정 대신 쓴다", () => {
  const file = join(home, "fake.json");
  writeFileSync(file, JSON.stringify({ type: "stdio", command: "node", args: ["fake.mjs"] }));
  const env = { AGENT_NAV_NOTION_MCP: file } as NodeJS.ProcessEnv;
  expect(notionOverridden(env) && (notionServerConfig(env) as { command: string }).command === "node", "override");
  expect(!notionOverridden({} as NodeJS.ProcessEnv), "기본은 override 없음");
  expect(notionServerConfig({ AGENT_NAV_NOTION_MCP: join(home, "missing.json") } as NodeJS.ProcessEnv) === null, "파일이 없으면 null (실제 설정으로 물러나지 않는다)");
});

test("wirePage: 화면으로 가는 값에는 enhanced 원문이 없다", async () => {
  const { s } = service(async () => outcome(fetchText()));
  const view = wirePage(await s.read(URL_));
  expect(!("enhanced" in view.page) && view.page.markdown === "## Hello", "enhanced 제외");
});

test("createNotion: 보드 카드는 페이지 링크와 함께 만들어지고, 페이지 전용 대화가 아니면 보드와 새 세션 도구가 없다", async () => {
  const created: unknown[] = [];
  const store = { allAgentIds: new Set<string>(["a1"]) };
  const board = { createCard: (input: Record<string, unknown>) => (created.push(input), { id: `c${created.length}`, title: String(input.title) }) };
  const events: ServerEvent[] = [];
  const file = join(home, "host-chats.json");
  const chats = new NotionChatStore(file);
  const { hooks } = createNotion({ store: store as never, board: board as never, runner: {} as never, broadcast: (e) => events.push(e), publishBoard: () => events.push({ type: "reload", restarting: false }), service: service(async () => outcome(fetchText())).s, chats });
  const plain = hooks.host("other", async () => ({ allowed: false }));
  expect(plain.page === null && plain.addCards === null && plain.startSession === null, "일반 세션");
  hooks.attach("a1", { url: URL_, title: "Plan" });
  const host = hooks.host("a1", async () => ({ allowed: false }));
  expect(host.page?.title === "Plan" && host.addCards !== null, "대화 세션");
  const made = host.addCards!([{ title: "Do the thing", body: "details" }]);
  expect(made[0].title === "Do the thing", "카드");
  const card = created[0] as { links: { url: string }[]; title: string; agentIds?: string[] };
  expect(card.links[0].url === URL_ && card.agentIds === undefined, "페이지 링크, 세션에는 묶지 않는다");
  host.startSession!("work on it");
  expect(events.some((e) => e.type === "notionStartSession" && e.agentId === "a1" && e.prompt === "work on it") && events.some((e) => e.type === "notionChats"), "이벤트");
});

let failed = 0;
for (const c of cases) {
  try {
    await c.run();
    console.log(`ok   ${c.name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${c.name}: ${(error as Error).message}`);
  }
}
console.log(failed ? `${failed} failed` : `${cases.length} passed`);
process.exit(failed ? 1 : 0);
