import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "agent-nav-mentiongate-"));
process.env.AGENT_NAV_HOME = home;
const { Store } = await import("../server/store");
const { InboxStore, InboxFetcher } = await import("../server/inbox");
const { BoardStore } = await import("../server/board");
const { MentionPipeline } = await import("../server/mentions");
const { mentionCollectionBlocked } = await import("../server/mentionGate");
type Settings = import("../shared/protocol").Settings;

const cases: { name: string; run: () => string | Promise<string> }[] = [];
const test = (name: string, run: () => string | Promise<string>) => cases.push({ name, run });
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
  return detail;
};

test("a new home starts with mention fetching and auto board adding off", () => {
  const s = new Store().settings;
  return expect(s.inboxIntervalMinutes === 0 && s.autoAddRequests === false, `interval ${s.inboxIntervalMinutes}, auto ${s.autoAddRequests}`);
});

test("values already written in settings.json are kept", () => {
  writeFileSync(join(home, "settings.json"), JSON.stringify({ settingsVersion: 2, inboxIntervalMinutes: 10, autoAddRequests: true }));
  const s = new Store().settings;
  rmSync(join(home, "settings.json"));
  return expect(s.inboxIntervalMinutes === 10 && s.autoAddRequests === true, `interval ${s.inboxIntervalMinutes}, auto ${s.autoAddRequests}`);
});

test("test instances are blocked whatever the settings say", () => {
  expect(mentionCollectionBlocked({ AGENT_NAV_INACTIVE: "1" }), "AGENT_NAV_INACTIVE");
  expect(mentionCollectionBlocked({ AGENT_NAV_E2E_PORT: "7951" }), "AGENT_NAV_E2E_PORT");
  expect(mentionCollectionBlocked({ AGENT_NAV_NO_MENTIONS: "1" }), "AGENT_NAV_NO_MENTIONS");
  expect(!mentionCollectionBlocked({}), "plain environment");
  return expect(!mentionCollectionBlocked({ AGENT_NAV_INACTIVE: "0" }), "INACTIVE=0");
});

test("a blocked fetcher does not start a Slack session", async () => {
  const fetcher = new InboxFetcher(new InboxStore(), () => {}, undefined, () => true);
  const rejected = await fetcher.refresh().then(() => false, () => true);
  return expect(rejected && !fetcher.fetching, `rejected ${rejected}, fetching ${fetcher.fetching}`);
});

test("a blocked fetcher does not read a thread from Slack either", async () => {
  const store = new InboxStore();
  store.merge([{ id: "C1:1.000000", kind: "mention", channelId: "C1", channelName: "#x", ts: "1.000000", threadTs: null, from: { id: "U1", name: "A" }, text: "t", permalink: "https://example.slack.com/archives/C1/p1000000", time: new Date(1000).toISOString(), read: false, archived: false, fetchedAt: "t" }], { at: "t", counts: { mention: 1, dm: 0, thread: 0 }, added: 1, partial: false, error: null, tools: [], costUsd: null, turns: null }, null);
  const fetcher = new InboxFetcher(store, () => {}, undefined, () => true);
  const message = await fetcher.thread("C1:1.000000").then(() => "read", (error: Error) => error.message);
  return expect(/disabled in test instances/.test(message) && store.item("C1:1.000000").thread === undefined, message);
});

test("a blocked pipeline neither judges nor analyzes", async () => {
  const inbox = new InboxStore();
  const calls: string[] = [];
  const pipeline = new MentionPipeline({
    inbox,
    board: new BoardStore(),
    settings: () => ({ autoAddRequests: true, mentionAnalysisModel: "sonnet", slackTeamId: "" }) as Settings,
    workspaces: () => [],
    judge: async () => {
      calls.push("judge");
      return { results: [], costUsd: 0, turns: 0 };
    },
    analyze: async () => {
      calls.push("analyze");
      throw new Error("not expected");
    },
    emitInbox: () => {},
    emitBoard: () => {},
    blocked: () => true,
  });
  const info = await pipeline.judgeNew();
  pipeline.kick();
  await pipeline.idle();
  return expect(calls.length === 0 && info.judged === 0, `calls ${calls.join(",") || "none"}`);
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
