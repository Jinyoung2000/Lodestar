import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { InboxFetchInfo, InboxItem, InboxKind, InboxState, InboxThreadMessage, JudgeInfo } from "../shared/protocol";
import { claudeBin, claudeEnv, isAuthError, mcpServerConfig } from "./claude";
import { SLACK_DISALLOWED_TOOLS, SLACK_READ_TOOLS, SLACK_WRITE_PATTERN, nextCursor, parseProfile, parseSearch, parseThread, toMentionItems, toThreadItems, toolResultJson, type SearchHit } from "./inboxParse";
import { HOME } from "./store";
import { T } from "./strings";
import { spawnInGroup } from "./processGroups";

const INBOX_FILE = join(HOME, "inbox.json");
export const INBOX_MAX_ITEMS = 500;
const FIRST_WINDOW_MS = 24 * 60 * 60 * 1000;
const OVERLAP_MS = 5 * 60 * 1000;
const SEARCH_LIMIT = 20;
const FETCH_MODEL = "haiku";

type Saved = { version: 3; selfUserId: string | null; lastFetchedAt: string | null; items: InboxItem[]; lastFetch: InboxFetchInfo | null };

export class InboxStore {
  private saved: Saved;

  constructor() {
    mkdirSync(HOME, { recursive: true });
    this.saved = this.load();
  }

  private load(): Saved {
    const empty: Saved = { version: 3, selfUserId: null, lastFetchedAt: null, items: [], lastFetch: null };
    if (!existsSync(INBOX_FILE)) return empty;
    try {
      const raw = JSON.parse(readFileSync(INBOX_FILE, "utf8")) as Partial<Saved> & { version?: number };
      if (!raw || typeof raw !== "object" || !Array.isArray(raw.items)) throw new Error("shape");
      const saved: Saved = {
        version: 3,
        selfUserId: typeof raw.selfUserId === "string" ? raw.selfUserId : null,
        lastFetchedAt: typeof raw.lastFetchedAt === "string" ? raw.lastFetchedAt : null,
        items: raw.items.filter(isItem),
        lastFetch: raw.lastFetch && typeof raw.lastFetch === "object" ? raw.lastFetch : null,
      };
      const from = typeof raw.version === "number" ? raw.version : 1;
      if (from < 3) this.migrate(saved, from);
      return saved;
    } catch {
      const aside = `${INBOX_FILE}.corrupt-${Date.now()}`;
      renameSync(INBOX_FILE, aside);
      console.error(`[inbox] ${T.errInboxCorrupt(aside)}`);
      return empty;
    }
  }

  private migrate(saved: Saved, from: number) {
    const backup = join(HOME, `inbox.v${from}.json`);
    if (!existsSync(backup)) copyFileSync(INBOX_FILE, backup);
    const at = new Date().toISOString();
    if (from < 2) saved.items = saved.items.map((i) => (i.kind === "mention" && !i.judgment ? { ...i, judgment: { at, skipped: "legacy" as const, isRequest: false, confidence: 0, title: "", summary: "" } } : i));
    saved.items = saved.items.map((i) => (i.kind === "thread" && !i.legacy ? { ...i, legacy: true as const } : i));
    const tmp = `${INBOX_FILE}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(saved, null, 2), { mode: 0o600 });
    renameSync(tmp, INBOX_FILE);
  }

  private save() {
    const tmp = `${INBOX_FILE}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.saved, null, 2), { mode: 0o600 });
    renameSync(tmp, INBOX_FILE);
  }

  get selfUserId() {
    return this.saved.selfUserId;
  }

  get lastFetchedAt() {
    return this.saved.lastFetchedAt;
  }

  state(fetching: boolean): InboxState {
    const { selfUserId, lastFetchedAt, lastFetch } = this.saved;
    const items = this.saved.items.filter(isVisible);
    return { selfUserId, lastFetchedAt, items, lastFetch, fetching, unread: items.filter((i) => !i.read && !i.archived).length };
  }

  mentions(): InboxItem[] {
    return this.saved.items.filter((i) => i.kind === "mention");
  }

  item(id: string): InboxItem {
    const item = this.saved.items.find((i) => i.id === id);
    if (!item) throw new Error(T.errUnknownInboxItem(String(id)));
    return item;
  }

  setSelf(id: string) {
    this.saved.selfUserId = id;
    this.save();
  }

  merge(incoming: InboxItem[], info: InboxFetchInfo, startedAt: string | null) {
    incoming = incoming.filter((i) => i.kind === "mention" || i.kind === "thread");
    const byId = new Map(this.saved.items.map((i) => [i.id, i]));
    let added = 0;
    for (const item of incoming) {
      const existing = byId.get(item.id);
      if (existing) {
        const { legacy: _legacy, ...rest } = existing;
        byId.set(item.id, { ...rest, kind: item.kind === "mention" ? "mention" : existing.kind, text: item.text, permalink: item.permalink || existing.permalink });
      } else {
        byId.set(item.id, item);
        added++;
      }
    }
    this.saved.items = trim([...byId.values()]);
    if (startedAt) this.saved.lastFetchedAt = startedAt;
    this.saved.lastFetch = { ...info, added };
    this.save();
    return added;
  }

  recordFailure(info: InboxFetchInfo) {
    this.saved.lastFetch = info;
    this.save();
  }

  setRead(ids: string[], read: boolean) {
    const set = new Set(ids);
    for (const id of set) this.item(id);
    this.saved.items = this.saved.items.map((i) => (set.has(i.id) ? { ...i, read } : i));
    this.save();
  }

  setArchived(ids: string[], archived: boolean) {
    const set = new Set(ids);
    for (const id of set) this.item(id);
    this.saved.items = this.saved.items.map((i) => (set.has(i.id) ? { ...i, archived, read: archived ? true : i.read } : i));
    this.save();
  }

  update(id: string, change: (item: InboxItem) => InboxItem): InboxItem {
    this.item(id);
    this.saved.items = this.saved.items.map((i) => (i.id === id ? change(i) : i));
    this.save();
    return this.item(id);
  }

  setLastJudge(judge: JudgeInfo) {
    if (!this.saved.lastFetch) return;
    this.saved.lastFetch = { ...this.saved.lastFetch, judge };
    this.save();
  }

  setThread(id: string, messages: InboxThreadMessage[]) {
    this.item(id);
    this.saved.items = this.saved.items.map((i) => (i.id === id ? { ...i, thread: { fetchedAt: new Date().toISOString(), messages } } : i));
    this.save();
    return this.item(id);
  }
}

function isVisible(item: InboxItem): boolean {
  return item.kind === "mention" || (item.kind === "thread" && !item.legacy);
}

function isItem(value: unknown): value is InboxItem {
  const v = value as Partial<InboxItem> | null;
  return !!v && typeof v.id === "string" && typeof v.channelId === "string" && typeof v.ts === "string" && typeof v.text === "string" && !!v.from && typeof v.from.id === "string";
}

export function trim(items: InboxItem[], max = INBOX_MAX_ITEMS): InboxItem[] {
  if (items.length <= max) return items;
  const rank = (i: InboxItem) => (!isVisible(i) ? -1 : i.archived ? 0 : (i.read ? 2 : 4) - (i.kind === "thread" ? 1 : 0));
  const doomed = new Set(
    [...items]
      .sort((a, b) => rank(a) - rank(b) || a.time.localeCompare(b.time))
      .slice(0, items.length - max)
      .map((i) => i.id),
  );
  return items.filter((i) => !doomed.has(i.id));
}

function slackServerConfig(): Record<string, unknown> {
  const slack = mcpServerConfig("slack");
  if (!slack) throw new Error(T.errSlackNotConfigured);
  return slack;
}

export type ToolCall = { name: string; input: Record<string, unknown>; result: Record<string, unknown> | null; error: boolean };
export type SessionOutcome = { calls: ToolCall[]; tools: string[]; costUsd: number | null; turns: number | null };

export async function runSlackSession(prompt: string, server: Record<string, unknown> = slackServerConfig()): Promise<SessionOutcome> {
  const allowed: string[] = Object.values(SLACK_READ_TOOLS);
  const q = query({
    prompt,
    options: {
      cwd: HOME,
      env: claudeEnv(),
      model: FETCH_MODEL,
      maxTurns: 4,
      tools: [],
      allowedTools: allowed,
      disallowedTools: SLACK_DISALLOWED_TOOLS,
      permissionMode: "dontAsk",
      settingSources: [],
      strictMcpConfig: true,
      mcpServers: { slack: server as never },
      systemPrompt: "You fetch Slack data for a local inbox. Make exactly the tool calls the user lists, with exactly the arguments given, in parallel when possible. Do not call any other tool. After the results arrive, reply with the single word DONE.",
      persistSession: false,
      includePartialMessages: false,
      pathToClaudeCodeExecutable: claudeBin(),
      spawnClaudeCodeProcess: spawnInGroup,
      hooks: {
        PreToolUse: [
          {
            hooks: [
              async (input) => {
                const name = input.hook_event_name === "PreToolUse" ? input.tool_name : "";
                if (allowed.includes(name) && !SLACK_WRITE_PATTERN.test(name)) return {};
                return { hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "deny" as const, permissionDecisionReason: "Not allowed in the inbox fetch" } };
              },
            ],
          },
        ],
      },
    },
  });
  const uses = new Map<string, { name: string; input: Record<string, unknown> }>();
  const calls: ToolCall[] = [];
  let tools: string[] = [];
  let costUsd: number | null = null;
  let turns: number | null = null;
  try {
    for await (const message of q) {
      if (message.type === "system" && message.subtype === "init") {
        const slack = (message.mcp_servers ?? []).find((s) => s.name === "slack");
        if (!slack || slack.status !== "connected") throw new Error(T.errSlackNotConnected(slack?.status ?? "missing"));
        tools = message.tools.filter((t) => t.startsWith("mcp__slack__"));
        const writable = tools.find((t) => SLACK_WRITE_PATTERN.test(t));
        if (writable) throw new Error(T.errSlackWriteToolVisible(writable));
      } else if (message.type === "assistant") {
        for (const block of message.message.content) if (block.type === "tool_use") uses.set(block.id, { name: block.name, input: (block.input ?? {}) as Record<string, unknown> });
      } else if (message.type === "user") {
        const content = (message.message as { content?: unknown }).content;
        if (!Array.isArray(content)) continue;
        for (const block of content as { type: string; tool_use_id?: string; content?: unknown; is_error?: boolean }[]) {
          if (block.type !== "tool_result" || !block.tool_use_id) continue;
          const use = uses.get(block.tool_use_id);
          if (use) calls.push({ ...use, result: toolResultJson(block.content), error: !!block.is_error });
        }
      } else if (message.type === "result") {
        costUsd = message.total_cost_usd ?? null;
        turns = message.num_turns ?? null;
      }
    }
  } finally {
    q.close();
  }
  return { calls, tools, costUsd, turns };
}

const toolList = (calls: ToolCall[]) => [...new Set(calls.map((c) => c.name))];

export class InboxFetcher {
  private running: Promise<InboxState> | null = null;

  constructor(
    private store: InboxStore,
    private emit: (state: InboxState) => void,
    private judgeNew: () => Promise<JudgeInfo> = async () => ({ judged: 0, requests: 0, notRequests: 0, queued: 0, error: null, costUsd: null, turns: null }),
    private blocked: () => boolean = () => false,
  ) {}

  get fetching() {
    return this.running !== null;
  }

  state() {
    return this.store.state(this.fetching);
  }

  refresh(): Promise<InboxState> {
    if (this.blocked()) return Promise.reject(new Error(T.errMentionsBlocked));
    if (!this.running) {
      this.running = this.run().finally(() => {
        this.running = null;
        this.emit(this.state());
      });
      this.emit(this.state());
    }
    return this.running;
  }

  private async run(): Promise<InboxState> {
    const startedAt = new Date();
    const emptyInfo = (error: string | null, extra: Partial<InboxFetchInfo> = {}): InboxFetchInfo => ({ at: startedAt.toISOString(), counts: { mention: 0, dm: 0, thread: 0 }, added: 0, partial: false, error, tools: [], costUsd: null, turns: null, ...extra });
    try {
      let self = this.store.selfUserId;
      let spent = 0;
      let turns = 0;
      const tools = new Set<string>();
      if (!self) {
        const outcome = await runSlackSession("Call slack_read_user_profile with response_format \"detailed\" and no other arguments.");
        const call = outcome.calls.find((c) => c.name === SLACK_READ_TOOLS.profile && !c.error);
        self = parseProfile(call?.result ?? null);
        if (!self) throw new Error(T.errSlackCall("profile", "no user id in the result"));
        this.store.setSelf(self);
        spent += outcome.costUsd ?? 0;
        turns += outcome.turns ?? 0;
        outcome.tools.forEach((t) => tools.add(t));
      }

      const since = this.store.lastFetchedAt ? Math.max(Date.parse(this.store.lastFetchedAt) - OVERLAP_MS, startedAt.getTime() - FIRST_WINDOW_MS) : startedAt.getTime() - FIRST_WINDOW_MS;
      const after = String(Math.floor(since / 1000));
      const outcome = await runSlackSession(searchPrompt(self, after));
      outcome.tools.forEach((t) => tools.add(t));
      spent += outcome.costUsd ?? 0;
      turns += outcome.turns ?? 0;

      const { items, counts, partial, missing } = collectSearchResults(outcome.calls, self, startedAt.toISOString());
      const info = emptyInfo(missing.length ? T.errSlackMissing(missing.join(", ")) : null, { counts, partial, tools: [...tools].sort(), costUsd: spent, turns });
      const added = this.store.merge(items, info, missing.length ? null : startedAt.toISOString());
      console.log(`[inbox] fetched mention=${counts.mention} thread=${counts.thread} added=${added}${partial ? " partial" : ""}${missing.length ? ` missing=${missing.join(",")}` : ""} turns=${turns} cost=$${spent.toFixed(4)}`);
      try {
        const judge = await this.judgeNew();
        this.store.setLastJudge(judge);
        if (judge.judged || judge.error) console.log(`[mentions] judged=${judge.judged} requests=${judge.requests} not=${judge.notRequests} queued=${judge.queued} turns=${judge.turns ?? 0} cost=$${(judge.costUsd ?? 0).toFixed(4)}${judge.error ? ` error=${judge.error}` : ""}`);
      } catch (error) {
        const reason = String(error instanceof Error ? error.message : error).slice(0, 200);
        console.error(`[inbox] judge failed: ${reason}`);
        this.store.setLastJudge({ judged: 0, requests: 0, notRequests: 0, queued: 0, error: reason, costUsd: null, turns: null });
      }
    } catch (error) {
      const text = String(error instanceof Error ? error.message : error).slice(0, 300);
      this.store.recordFailure(emptyInfo(isAuthError(text) ? T.reloginHint(text) : text));
      console.error(`[inbox] fetch failed: ${text}`);
    }
    return this.store.state(false);
  }

  async thread(id: string): Promise<InboxItem> {
    if (this.blocked()) throw new Error(T.errMentionsBlocked);
    const item = this.store.item(id);
    const parentTs = item.threadTs ?? item.ts;
    const outcome = await runSlackSession(`Call slack_read_thread once with channel_id "${item.channelId}", message_ts "${parentTs}", limit 100, response_format "detailed".`);
    const call = outcome.calls.find((c) => c.name === SLACK_READ_TOOLS.thread && c.input.channel_id === item.channelId && c.input.message_ts === parentTs);
    if (!call || call.error || !call.result) throw new Error(T.errSlackCall("thread read", call?.error ? "the tool returned an error" : "no result"));
    const messages = parseThread(call.result);
    if (!messages.length) throw new Error(T.errSlackThreadParse);
    const saved = this.store.setThread(id, messages);
    console.log(`[inbox] thread read messages=${messages.length} tools=${toolList(outcome.calls).length}`);
    this.emit(this.state());
    return saved;
  }
}

export function searchPrompt(self: string, after: string) {
  const common = `limit ${SEARCH_LIMIT}, include_context false, sort "timestamp", sort_dir "desc", response_format "detailed", after "${after}", content_types "messages"`;
  return [
    `Make these two slack_search_public_and_private calls in parallel with exactly these arguments, then reply DONE.`,
    `Call A (mentions): keywords ["<@${self}>"], filters "", ${common}.`,
    `Call B (threads): keywords [], filters "is:thread with:<@${self}>", ${common}.`,
  ].join("\n");
}

export function collectSearchResults(calls: ToolCall[], self: string, fetchedAt: string) {
  const seen = new Set<InboxKind>();
  const hits: Record<"mention" | "thread", SearchHit[]> = { mention: [], thread: [] };
  let partial = false;
  for (const call of calls) {
    if (call.name !== SLACK_READ_TOOLS.search) continue;
    const kind = searchKind(call.input, self);
    if ((kind !== "mention" && kind !== "thread") || call.error || !call.result) continue;
    seen.add(kind);
    if (nextCursor(call.result)) partial = true;
    hits[kind].push(...parseSearch(call.result));
  }
  const missing = (["mention", "thread"] as const).filter((kind) => !seen.has(kind));
  const fromMentionSearch = toMentionItems(hits.mention, self, fetchedAt);
  const mentionIds = new Set(fromMentionSearch.map((i) => i.id));
  const fromThreadSearch = toThreadItems(hits.thread, self, fetchedAt).filter((i) => !mentionIds.has(i.id));
  const items = [...fromMentionSearch, ...fromThreadSearch];
  const counts: Record<InboxKind, number> = { mention: items.filter((i) => i.kind === "mention").length, dm: 0, thread: items.filter((i) => i.kind === "thread").length };
  return { items, counts, partial, missing };
}

export function searchKind(input: Record<string, unknown>, self: string): InboxKind | null {
  const keywords = Array.isArray(input.keywords) ? input.keywords.map(String) : [];
  const filters = typeof input.filters === "string" ? input.filters : "";
  if (keywords.includes(`<@${self}>`)) return "mention";
  if (/\bis:dm\b/.test(filters)) return "dm";
  if (/\bis:thread\b/.test(filters) && filters.includes(`<@${self}>`)) return "thread";
  return null;
}
