// Slack Inbox 의 파서와 저장 단독 시험 (데몬과 Slack 없이). 형식은 실제 Slack MCP 결과를 보고 만든 가짜 데이터다.
// 실행: npm test
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "agent-nav-inbox-unit-"));
process.env.AGENT_NAV_HOME = home;
const { InboxStore, INBOX_MAX_ITEMS, collectSearchResults, searchKind, searchPrompt, trim } = await import("../server/inbox");
const { appLink, classify, nextCursor, parseProfile, parseSearch, parseThread, toItems, toThreadItems, toolResultJson, SLACK_DISALLOWED_TOOLS, SLACK_WRITE_PATTERN, SLACK_READ_TOOLS } = await import("../server/inboxParse");
const clean = await import("../shared/inbox");
const { slackAppUrl } = await import("../shared/slackLink");
type Item = import("../shared/protocol").InboxItem;

const SELF = "UME000001";
const cases: { name: string; run: () => string }[] = [];
const test = (name: string, run: () => string) => cases.push({ name, run });
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
  return detail;
};

type Block = { channel: string; from: string; ts: string; thread?: string; text: string; participants?: string; bot?: boolean };
const searchResult = (blocks: Block[], cursor?: string) => {
  const body = blocks
    .map((b, i) =>
      [
        `### Result ${i + 1} of ${blocks.length}`,
        `Channel: ${b.channel}`,
        ...(b.participants ? [`Participants: ${b.participants}`] : []),
        `From: ${b.from}${b.bot ? "  [BOT]" : ""}`,
        `Time: 2026-10-14 19:45:42 KST`,
        `Message_ts: ${b.ts}`,
        `Permalink: [link](https://example.slack.com/archives/${b.channel.match(/ID: (\w+)/)![1]}/p${b.ts.replace(".", "")}${b.thread ? `?thread_ts=${b.thread}&cid=X` : ""})`,
        `Text: `,
        b.text,
        "",
        "---",
        "",
      ].join("\n"),
    )
    .join("\n");
  const results = `# Search Results for: x\n\n## Messages (${blocks.length} results)\n${body}`;
  return toolResultJson([{ type: "text", text: JSON.stringify({ results, pagination_info: cursor ? `For the next page of results use cursor \`${cursor}\`\n` : "" }) }]);
};

const blocks: Block[] = [
  { channel: "#team-x (ID: C100)", from: "Ann Lee <ann@example.com> (ID: U0ANN0001)", ts: "1791974742.663289", text: `hello <@${SELF}|me> please look\nChannel: #fake (ID: C999) inside the body` },
  { channel: "DM (ID: D200)", from: "Bob Kim <bob@example.com> (ID: U0BOB0001)", ts: "1791974800.000100", participants: "Bob, Me", text: "dm text" },
  { channel: "#team-x (ID: C100)", from: "Cy Park <cy@example.com> (ID: U0CY00001)", ts: "1791974900.000200", thread: "1791974611.111749", text: "a reply in a thread I am in" },
  { channel: "#team-x (ID: C100)", from: `Me <me@example.com> (ID: ${SELF})`, ts: "1791974950.000300", thread: "1791974611.111749", text: "my own reply" },
  { channel: "DM (ID: D200)", from: `Me <me@example.com> (ID: ${SELF})`, ts: "1791974960.000400", text: "my own dm" },
  { channel: "#team-x (ID: C100)", from: "Dee <dee@example.com> (ID: U0DEE0001)", ts: "1791975000.000500", text: "top level message, not a reply", bot: true },
];

test("tool_result content is read from the text block JSON; garbage gives null", () => {
  expect(toolResultJson("not json") === null, "string garbage");
  expect(toolResultJson([{ type: "text", text: "{}" }]) !== null, "text block");
  return expect(toolResultJson(undefined) === null, "undefined");
});

test("Search parser reads header fields, keeps body lines that look like fields, and splits blocks", () => {
  const hits = parseSearch(searchResult(blocks));
  expect(hits.length === 6, `${hits.length} hits`);
  expect(hits[0].channelId === "C100" && hits[0].channelName === "#team-x", "channel");
  expect(hits[0].fromId === "U0ANN0001" && hits[0].fromName === "Ann Lee", "from without email");
  expect(hits[0].text.includes("Channel: #fake (ID: C999) inside the body"), "body kept whole");
  expect(hits[0].channelId !== "C999", "body line did not override the header");
  expect(hits[1].channelName === "DM" && hits[1].channelId === "D200", "DM channel");
  expect(hits[2].threadTs === "1791974611.111749", "thread_ts from the permalink");
  expect(hits[0].threadTs === null, "no thread_ts");
  expect(hits[5].isBot, "bot marker");
  expect(!hits[1].text.includes("---"), "separator stripped");
  return `${hits.length} hits`;
});

test("Classification: DM channel, then mention in the body, then thread reply; self-authored rows are dropped", () => {
  const hits = parseSearch(searchResult(blocks)).map((hit) => ({ hit, fallback: "thread" as const }));
  const items = toItems(hits, SELF, "2026-10-14T00:00:00.000Z");
  const kinds = items.map((i) => `${i.channelId}:${i.kind}`).join(",");
  expect(!items.some((i) => i.from.id === SELF), "self rows dropped");
  expect(items.length === 3, `${items.length} items: ${kinds}`);
  expect(items[0].kind === "mention", "mention");
  expect(items[1].kind === "dm", "dm");
  expect(items[2].kind === "thread" && items[2].threadTs === "1791974611.111749", "thread reply");
  expect(!items.some((i) => i.text.startsWith("top level")), "non-reply from the thread query dropped");
  expect(items[0].time === new Date(1791974742.663289 * 1000).toISOString(), "time from ts");
  return kinds;
});

test("The same message found by two searches is one item", () => {
  const hit = parseSearch(searchResult([blocks[0]]))[0];
  const items = toItems([{ hit, fallback: "mention" }, { hit, fallback: "thread" }], SELF, "t");
  return expect(items.length === 1 && items[0].id === "C100:1791974742.663289", items[0]?.id);
});

test("classify falls back to the search kind when nothing else matches", () => {
  const hit = parseSearch(searchResult([blocks[5]]))[0];
  return expect(classify(hit, SELF, "mention") === "mention", "fallback");
});

test("Cursor and profile parsers", () => {
  expect(nextCursor(searchResult([])) === null, "no pagination text in an empty page");
  const withCursor = toolResultJson([{ type: "text", text: JSON.stringify({ results: "", pagination_info: "For the next page of results use cursor `abc123=`\n" }) }]);
  expect(nextCursor(withCursor) === "abc123=", "cursor");
  const profile = toolResultJson([{ type: "text", text: JSON.stringify({ result: `User ID: ${SELF}\nUsername: me\nEmail: me@example.com\n` }) }]);
  return expect(parseProfile(profile) === SELF, "profile id");
});

test("Thread parser: parent first, replies after, different labels from search", () => {
  const messages = [
    "=== THREAD PARENT MESSAGE ===",
    "From: Ann Lee (ann) <ann@example.com> (U0ANN0001)",
    "Time: 2026-10-14 19:35:02 KST",
    "Message TS: 1791974102.714499",
    "parent text",
    "Reactions: +1 (2)",
    "",
    "=== THREAD REPLIES (2 messages) ===",
    "",
    "--- Reply 1 of 2 ---",
    "From: Bob Kim <bob@example.com> (U0BOB0001)",
    "Time: 2026-10-14 19:40:05 KST",
    "Message TS: 1791974405.504750",
    "first reply",
    "second line",
    "",
    "--- Reply 2 of 2 ---",
    "From: Cy Park <cy@example.com> (U0CY00001)",
    "Time: 2026-10-14 19:41:05 KST",
    "Message TS: 1791974465.000000",
    "second reply",
  ].join("\n");
  const parsed = parseThread(toolResultJson([{ type: "text", text: JSON.stringify({ messages, pagination_info: "" }) }]));
  expect(parsed.length === 3, `${parsed.length} messages`);
  expect(parsed[0].text === "parent text" && parsed[0].from.id === "U0ANN0001" && parsed[0].from.name === "Ann Lee (ann)", "parent");
  expect(parsed[1].text === "first reply\nsecond line" && parsed[1].ts === "1791974405.504750", "reply 1");
  return expect(parsed[2].text === "second reply", "reply 2");
});

test("searchKind reads the kind from the arguments the model actually sent", () => {
  expect(searchKind({ keywords: [`<@${SELF}>`], filters: "" }, SELF) === "mention", "mention");
  expect(searchKind({ keywords: [], filters: "is:dm" }, SELF) === "dm", "dm");
  expect(searchKind({ keywords: [], filters: `is:thread with:<@${SELF}>` }, SELF) === "thread", "thread");
  return expect(searchKind({ keywords: ["deploy"], filters: "in:#x" }, SELF) === null, "unexpected search is ignored");
});

test("Write tools: the explicit block list and the name pattern cover every Slack write tool, and no read tool", () => {
  const writes = ["send_message", "send_message_draft", "schedule_message", "add_reaction", "create_canvas", "update_canvas", "create_conversation", "create_list", "add_list_record", "update_list", "update_list_record", "get_file_upload_url", "complete_file_upload"];
  for (const name of writes) {
    expect(SLACK_DISALLOWED_TOOLS.includes(`mcp__slack__slack_${name}`), `${name} is in disallowedTools`);
    expect(SLACK_WRITE_PATTERN.test(`mcp__slack__slack_${name}`), `${name} matches the pattern`);
  }
  for (const name of Object.values(SLACK_READ_TOOLS)) expect(!SLACK_WRITE_PATTERN.test(name) && !SLACK_DISALLOWED_TOOLS.includes(name), `${name} is a read tool`);
  for (const name of ["read_channel", "read_thread", "search_users", "list_user_channels", "get_reactions", "read_canvas"]) expect(!SLACK_WRITE_PATTERN.test(`mcp__slack__slack_${name}`), `${name} is not treated as a write tool`);
  return `${writes.length} write tools blocked`;
});

test("slack:// link needs a workspace id; without one there is none", () => {
  const item = { channelId: "C100", ts: "1.2", threadTs: null };
  expect(appLink(item, "") === null, "no team");
  expect(appLink(item, "not-a-team") === null, "bad team");
  return expect(appLink(item, "T0TEAM001") === "slack://channel?team=T0TEAM001&id=C100&message=1.2", "link");
});

test("cleanSlackText turns mrkdwn tokens into plain text", () => {
  const { cleanSlackText } = clean;
  const out = cleanSlackText("hi <@U0A1B2C3|Ann (앤)> see <https://example.com/x|the doc> in <#C100|team-x> <!here> &lt;ok&gt; &amp; <https://example.com/y>");
  return expect(out === "hi @Ann (앤) see the doc (https://example.com/x) in #team-x @here <ok> & https://example.com/y", out);
});

const fresh = () => {
  rmSync(join(home, "inbox.json"), { force: true });
  return new InboxStore();
};
const info = (added = 0) => ({ at: "t", counts: { mention: 0, dm: 0, thread: 0 }, added, partial: false, error: null, tools: [], costUsd: null, turns: null });
const make = (n: number, extra: Partial<Item> = {}): Item => ({
  id: `C1:${n}.000000`,
  kind: "mention",
  channelId: "C1",
  channelName: "#x",
  ts: `${n}.000000`,
  threadTs: null,
  from: { id: "U1", name: "A" },
  text: `t${n}`,
  permalink: "https://example.slack.com/archives/C1/p1",
  time: new Date(n * 1000).toISOString(),
  read: false,
  archived: false,
  fetchedAt: "t",
  ...extra,
});

test("A second fetch of the same messages adds nothing and keeps read and archived state", () => {
  const store = fresh();
  expect(store.merge([make(1), make(2), make(3)], info(), "a") === 3, "first adds 3");
  store.setRead(["C1:1.000000"], true);
  store.setArchived(["C1:2.000000"], true);
  const added = store.merge([make(1), make(2), make(3), make(4)], info(), "b");
  const state = store.state(false);
  expect(added === 1, `second adds ${added}`);
  expect(state.items.length === 4, "4 items");
  expect(state.items.find((i) => i.id === "C1:1.000000")!.read, "read kept");
  expect(state.items.find((i) => i.id === "C1:2.000000")!.archived, "archived kept");
  return expect(state.unread === 2, `unread ${state.unread}`);
});

test("Archiving counts as read and leaves the unread badge; unarchiving keeps it read", () => {
  const store = fresh();
  store.merge([make(1)], info(), null);
  store.setArchived(["C1:1.000000"], true);
  expect(store.state(false).unread === 0, "badge");
  store.setArchived(["C1:1.000000"], false);
  return expect(store.state(false).items[0].read && store.state(false).unread === 0, "still read");
});

test("lastFetchedAt only moves when the fetch was complete", () => {
  const store = fresh();
  store.merge([make(1)], info(), "2026-10-14T00:00:00.000Z");
  store.merge([make(2)], info(), null);
  return expect(store.lastFetchedAt === "2026-10-14T00:00:00.000Z", String(store.lastFetchedAt));
});

test("Unknown ids are rejected", () => {
  const store = fresh();
  try {
    store.setRead(["nope"], true);
  } catch (error) {
    return expect(/Unknown inbox item/.test((error as Error).message), (error as Error).message);
  }
  throw new Error("did not throw");
});

test("Over the cap, archived go first, then read, then unread; the oldest of each", () => {
  const items: Item[] = [];
  for (let n = 1; n <= INBOX_MAX_ITEMS + 3; n++) items.push(make(n, n <= 2 ? { archived: true, read: true } : n === 3 ? { read: true } : {}));
  const kept = trim(items);
  expect(kept.length === INBOX_MAX_ITEMS, `${kept.length} kept`);
  const ids = new Set(kept.map((i) => i.id));
  expect(!ids.has("C1:1.000000") && !ids.has("C1:2.000000") && !ids.has("C1:3.000000"), "two archived and one read removed first");
  expect(ids.has("C1:4.000000"), "oldest unread kept");
  const unreadOnly = trim(Array.from({ length: INBOX_MAX_ITEMS + 1 }, (_, i) => make(i + 1)));
  return expect(!unreadOnly.some((i) => i.id === "C1:1.000000") && unreadOnly.length === INBOX_MAX_ITEMS, "oldest unread goes last");
});

test("Writes leave no .tmp and a new store reads the same inbox", () => {
  const store = fresh();
  store.setSelf(SELF);
  store.merge([make(1), make(2)], info(2), "x");
  store.setThread("C1:1.000000", [{ ts: "1.000000", from: { id: "U1", name: "A" }, text: "p" }]);
  const again = new InboxStore();
  expect(JSON.stringify(again.state(false)) === JSON.stringify(store.state(false)), "same after reload");
  expect(again.selfUserId === SELF, "self id kept");
  expect(again.state(false).items[0].thread?.messages.length === 1, "thread kept");
  expect(!existsSync(join(home, `inbox.json.${process.pid}.tmp`)), "no temp file");
  return expect((readFileSync(join(home, "inbox.json")).length ?? 0) > 0, "file written");
});

test("A corrupt inbox.json is moved aside and an empty inbox starts", () => {
  rmSync(join(home, "inbox.json"), { force: true });
  writeFileSync(join(home, "inbox.json"), "{broken");
  const store = new InboxStore();
  return expect(store.state(false).items.length === 0 && !existsSync(join(home, "inbox.json")), "empty and moved");
});

// --- 스레드 수집 (가짜 Slack 응답. 실제 Slack 은 읽지 않는다) ---

const mentionArgs = { keywords: [`<@${SELF}>`], filters: "" };
const threadArgs = { keywords: [], filters: `is:thread with:<@${SELF}>` };
const call = (input: Record<string, unknown>, result: ReturnType<typeof searchResult> | null, error = false) => ({ name: SLACK_READ_TOOLS.search as string, input, result, error });
const threadReplyBlocks: Block[] = [
  blocks[2],
  blocks[3],
  { channel: "#team-x (ID: C100)", from: "Eve <eve@example.com> (ID: U0EVE0001)", ts: "1791975100.000600", thread: "1791974611.111749", text: `second reply, <@${SELF}> take a look` },
  { channel: "#team-y (ID: C300)", from: "Fay <fay@example.com> (ID: U0FAY0001)", ts: "1791975200.000700", thread: "1791975000.000001", text: "reply in another thread" },
  blocks[5],
  blocks[1],
];

test("Search prompt asks for exactly two read-only searches, mentions and participated threads, in one session", () => {
  const prompt = searchPrompt(SELF, "1791900000");
  expect((prompt.match(/^Call [AB] /gm) ?? []).length === 2, "two calls");
  expect(prompt.includes(`keywords ["<@${SELF}>"], filters ""`), "call A is the mention search");
  expect(prompt.includes(`keywords [], filters "is:thread with:<@${SELF}>"`), "call B is the thread search");
  expect((prompt.match(/after "1791900000"/g) ?? []).length === 2, "both use the same after");
  expect(!/send|write|react|post/i.test(prompt.replace(/slack_search_public_and_private/, "")), "no write words");
  return "A mentions, B threads";
});

test("Collection: mentions from A, new thread replies from B; own posts, DMs, thread parents and duplicates are dropped", () => {
  const out = collectSearchResults([call(mentionArgs, searchResult([blocks[0], blocks[1]])), call(threadArgs, searchResult(threadReplyBlocks))], SELF, "2026-10-15T00:00:00.000Z");
  const byId = new Map(out.items.map((i) => [i.id, i]));
  expect(out.missing.length === 0 && !out.partial, "complete");
  expect(byId.get("C100:1791974742.663289")?.kind === "mention", "A mention");
  expect(byId.get("C100:1791974900.000200")?.kind === "thread" && byId.get("C100:1791974900.000200")!.threadTs === "1791974611.111749", "B reply is a thread item with its parent");
  expect(byId.get("C300:1791975200.000700")?.kind === "thread", "reply in another thread");
  expect(byId.get("C100:1791975100.000600")?.kind === "mention", "a reply that mentions me is a mention even when only B found it");
  expect(![...byId.values()].some((i) => i.from.id === SELF), "own reply dropped");
  expect(![...byId.values()].some((i) => i.channelId.startsWith("D")), "DM dropped");
  expect(!byId.has("C100:1791975000.000500"), "top-level message from the thread search dropped");
  expect(out.items.length === 4 && out.counts.mention === 2 && out.counts.thread === 2 && out.counts.dm === 0, JSON.stringify(out.counts));
  return JSON.stringify(out.counts);
});

test("Collection: a message found by both searches is one mention", () => {
  const out = collectSearchResults([call(mentionArgs, searchResult([threadReplyBlocks[2]])), call(threadArgs, searchResult([threadReplyBlocks[2], threadReplyBlocks[0]]))], SELF, "t");
  expect(out.items.length === 2, `${out.items.length} items`);
  return expect(out.items.filter((i) => i.id === "C100:1791975100.000600").length === 1 && out.items.find((i) => i.id === "C100:1791975100.000600")!.kind === "mention", "mention wins");
});

test("Collection: a failed or missing search is reported and the other search still counts; a cursor means partial", () => {
  const onlyMention = collectSearchResults([call(mentionArgs, searchResult([blocks[0]]))], SELF, "t");
  expect(onlyMention.missing.join() === "thread" && onlyMention.items.length === 1, "thread search missing");
  const errored = collectSearchResults([call(mentionArgs, searchResult([blocks[0]])), call(threadArgs, null, true)], SELF, "t");
  expect(errored.missing.join() === "thread", "errored thread search");
  const neither = collectSearchResults([], SELF, "t");
  expect(neither.missing.join() === "mention,thread" && neither.items.length === 0, "nothing came back");
  const paged = collectSearchResults([call(mentionArgs, searchResult([blocks[0]], "abc=")), call(threadArgs, searchResult([threadReplyBlocks[0]]))], SELF, "t");
  return expect(paged.partial && paged.missing.length === 0, "partial");
});

test("Collection: a call whose arguments are not the ones we asked for is not used", () => {
  const tampered = call({ keywords: ["deploy"], filters: "in:#x" }, searchResult([blocks[0]]));
  const out = collectSearchResults([tampered, call(threadArgs, searchResult([threadReplyBlocks[0]]))], SELF, "t");
  return expect(out.missing.join() === "mention" && out.items.length === 1 && out.items[0].kind === "thread", "ignored");
});

test("toThreadItems keeps replies only", () => {
  const items = toThreadItems(parseSearch(searchResult(threadReplyBlocks)), SELF, "t");
  return expect(items.length === 3 && items.every((i) => i.threadTs !== null), items.map((i) => i.kind).join());
});

test("The screen shows mentions and new thread replies; DMs and legacy thread replies stay in the file; judging still sees mentions only", () => {
  const store = fresh();
  store.merge([make(1), make(2, { kind: "thread", threadTs: "0.5" })], info(), "a");
  store.merge([], info(), "a");
  const hidden = [make(3, { kind: "dm" }), make(4, { kind: "thread", threadTs: "0.5", legacy: true })];
  writeFileSync(join(home, "inbox.json"), JSON.stringify({ ...JSON.parse(readFileSync(join(home, "inbox.json"), "utf8")), items: [...store.state(false).items, ...hidden] }));
  const again = new InboxStore();
  const state = again.state(false);
  expect(state.items.map((i) => i.id).sort().join() === "C1:1.000000,C1:2.000000" && state.unread === 2, "thread reply is on the screen and in the unread count");
  expect(again.mentions().length === 1 && again.mentions()[0].id === "C1:1.000000", "only mentions go to judging");
  return expect(again.item("C1:4.000000").legacy === true, "legacy item still addressable");
});

test("merge: a thread reply that is read again as a mention becomes a mention; a legacy item read again by the new fetch surfaces", () => {
  const store = fresh();
  store.merge([make(1, { kind: "thread", threadTs: "0.5" })], info(), "a");
  store.setRead(["C1:1.000000"], true);
  store.merge([make(1, { text: "edited <@ME>" })], info(), "b");
  const after = store.item("C1:1.000000");
  expect(after.kind === "mention" && after.read && after.text === "edited <@ME>", "kind upgraded, read kept");
  store.merge([make(1, { kind: "thread", threadTs: "0.5" })], info(), "c");
  expect(store.item("C1:1.000000").kind === "mention", "a mention does not turn back into a thread reply");
  writeFileSync(join(home, "inbox.json"), JSON.stringify({ version: 3, selfUserId: null, lastFetchedAt: null, items: [make(7, { kind: "thread", threadTs: "0.5", legacy: true })], lastFetch: null }));
  const legacy = new InboxStore();
  expect(legacy.state(false).items.length === 0, "hidden before");
  legacy.merge([make(7, { kind: "thread", threadTs: "0.5" })], info(), "d");
  return expect(legacy.state(false).items.length === 1 && legacy.item("C1:7.000000").legacy === undefined, "surfaced after");
});

test("Over the cap hidden items go first, then archived, read thread replies, read mentions, unread thread replies, unread mentions", () => {
  const mk = (n: number, extra: Partial<Item> = {}) => make(n, extra);
  const items = [
    mk(1, { kind: "dm" }),
    mk(2, { kind: "thread", legacy: true, threadTs: "0.5" }),
    mk(3, { archived: true, read: true }),
    mk(4, { kind: "thread", read: true, threadTs: "0.5" }),
    mk(5, { read: true }),
    mk(6, { kind: "thread", threadTs: "0.5" }),
    mk(7),
  ];
  for (const keep of [6, 5, 4, 3, 2, 1]) {
    const kept = trim(items, keep).map((i) => i.id);
    const dropped = items.filter((i) => !kept.includes(i.id)).map((i) => Number(i.id.slice(3, 4)));
    expect(dropped.join() === [1, 2, 3, 4, 5, 6].slice(0, 7 - keep).join(), `keep ${keep}: dropped ${dropped.join()}`);
  }
  return "rank order holds";
});

test("Thread message links are built from the item's permalink: parent without thread_ts, replies with it; slackAppUrl accepts them", () => {
  const item = { channelId: "C06ABCDEF", ts: "1791974900.000200", threadTs: "1791974611.111749", permalink: "https://example.slack.com/archives/C06ABCDEF/p1791974900000200?thread_ts=1791974611.111749&cid=C06ABCDEF" };
  const parent = clean.threadMessageLink(item, "1791974611.111749");
  const reply = clean.threadMessageLink(item, "1791974900.000200");
  expect(parent === "https://example.slack.com/archives/C06ABCDEF/p1791974611111749", String(parent));
  expect(reply === "https://example.slack.com/archives/C06ABCDEF/p1791974900000200?thread_ts=1791974611.111749&cid=C06ABCDEF", String(reply));
  expect(slackAppUrl(reply!, "T0TEAM001") === "slack://channel?team=T0TEAM001&id=C06ABCDEF&message=1791974900.000200&thread_ts=1791974611.111749", String(slackAppUrl(reply!, "T0TEAM001")));
  expect(slackAppUrl(parent!, "T0TEAM001") === "slack://channel?team=T0TEAM001&id=C06ABCDEF&message=1791974611.111749", String(slackAppUrl(parent!, "T0TEAM001")));
  const top = { channelId: "C06ABCDEF", ts: "1791974742.663289", threadTs: null, permalink: "https://example.slack.com/archives/C06ABCDEF/p1791974742663289" };
  expect(clean.threadMessageLink(top, "1791974742.663289") === top.permalink, "a top-level message is its own parent");
  expect(!!clean.threadMessageLink(top, "1791974800.000100")?.endsWith("?thread_ts=1791974742.663289&cid=C06ABCDEF"), "replies to a top-level message point at it");
  return expect(clean.threadMessageLink({ ...top, permalink: "" }, "1.2") === null && clean.threadMessageLink(top, "bad") === null, "unusable input gives null");
});

let failed = 0;
for (const c of cases) {
  try {
    console.log(`ok   ${c.name} (${c.run()})`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${c.name}: ${(error as Error).message}`);
  }
}
rmSync(home, { recursive: true, force: true });
console.log(failed ? `${failed} failed` : `${cases.length} passed`);
process.exit(failed ? 1 : 0);
