import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { query, type Query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { versionedDisplayName } from "../shared/modelName";
import { CLAUDE_EFFORT_LEVELS, type EffortLevel, type McpActionResult, type McpSessionResult, type Meta } from "../shared/protocol";
import { claudeBin, claudeEnv, claudeErrorText, claudeInstalled } from "./claude";
import { errorText, reconnectInSessions, settleMcp, type McpControl } from "./mcp";
import { HOME } from "./store";
import { T } from "./strings";
import { spawnInGroup } from "./processGroups";

const MCP_SETTLE_MS = 12_000;
const MCP_ACTION_SETTLE_MS = 8_000;

const EMPTY_META: Meta = { claudeVersion: null, account: null, models: [], mcp: [], commandCount: 0, commands: [], fetchedAt: null, error: null };

const CACHE_FILE = join(HOME, "meta-cache.json");
type MetaCache = Pick<Meta, "claudeVersion" | "models" | "commands">;

function readCache(): MetaCache | null {
  try {
    const cache = JSON.parse(readFileSync(CACHE_FILE, "utf8")) as Partial<MetaCache>;
    return Array.isArray(cache.models) ? { claudeVersion: cache.claudeVersion ?? null, models: cache.models.map((m) => ({ ...m, displayName: versionedDisplayName(m.displayName, m.resolvedModel) })), commands: Array.isArray(cache.commands) ? cache.commands : [] } : null;
  } catch {
    return null;
  }
}

function writeCache(meta: Meta) {
  if (!meta.models.length) return;
  try {
    mkdirSync(HOME, { recursive: true });
    const cache: MetaCache = { claudeVersion: meta.claudeVersion, models: meta.models, commands: meta.commands ?? [] };
    writeFileSync(CACHE_FILE, JSON.stringify(cache));
  } catch {
  }
}
const NO_SESSIONS: McpSessionResult = { reconnected: 0, failed: 0, skipped: 0 };

async function startMeta(cwd: string): Promise<{ meta: Meta; query: Query }> {
  async function* never(): AsyncGenerator<SDKUserMessage> {
    await new Promise(() => {});
  }
  const q = query({
    prompt: never(),
    options: {
      cwd,
      env: claudeEnv(),
      pathToClaudeCodeExecutable: claudeBin(),
      spawnClaudeCodeProcess: spawnInGroup,
      persistSession: false,
      settingSources: ["user", "project", "local"],
      systemPrompt: { type: "preset", preset: "claude_code" },
    },
  });
  try {
    const init = await q.initializationResult();
    const mcp = await settleMcp(q, MCP_SETTLE_MS).catch((error: Error) => {
      console.error("[meta] mcp status failed", error);
      return [];
    });
    const meta: Meta = {
      claudeVersion: init.claude_code_version ?? null,
      account: { email: init.account.email ?? "", subscriptionType: init.account.subscriptionType ?? "" },
      models: init.models.map((m) => ({
        value: m.value,
        resolvedModel: m.resolvedModel ?? null,
        displayName: versionedDisplayName(m.displayName, m.resolvedModel ?? null),
        supportedEffortLevels: ((m.supportedEffortLevels ?? []) as EffortLevel[]).filter((level) => (CLAUDE_EFFORT_LEVELS as EffortLevel[]).includes(level)),
      })),
      mcp,
      commandCount: init.commands.length,
      commands: init.commands.map((c) => ({ name: c.name, description: c.description ?? "" })),
      fetchedAt: new Date().toISOString(),
      error: null,
    };
    return { meta, query: q };
  } catch (error) {
    q.close();
    throw error;
  }
}

export class MetaService {
  meta: Meta = (() => {
    const cached = readCache();
    const base = cached ? { ...EMPTY_META, ...cached } : EMPTY_META;
    return { ...base, claudeMissing: !claudeInstalled() };
  })();
  private q: Query | null = null;
  private loading: Promise<Meta> | null = null;
  private busy = new Set<string>();

  constructor(
    private cwd: string,
    private emit: (meta: Meta) => void,
    private liveSessions: () => McpControl[],
  ) {}

  refresh(): Promise<Meta> {
    this.loading ??= this.load()
      .then((next) => {
        this.meta = { ...next.meta, claudeMissing: false };
        this.q = next.query;
        writeCache(next.meta);
        console.log(`[meta] models=${next.meta.models.length} mcp=${next.meta.mcp.map((m) => `${m.name}:${m.status}`).join(",")}`);
      })
      .catch((error: Error) => {
        this.meta = { ...this.meta, error: claudeErrorText(error.message), claudeMissing: !claudeInstalled() };
        console.error("[meta] failed", error);
      })
      .finally(() => {
        this.loading = null;
        this.emit(this.meta);
      })
      .then(() => this.meta);
    return this.loading;
  }

  private async load() {
    this.close();
    return startMeta(this.cwd);
  }

  close() {
    this.q?.close();
    this.q = null;
  }

  private known(name: unknown): string {
    if (typeof name !== "string" || !name) throw new Error(T.errMcpName);
    if (!this.meta.mcp.some((m) => m.name === name)) throw new Error(T.errMcpUnknown(name));
    return name;
  }

  async reconnect(name: unknown): Promise<McpActionResult> {
    const server = this.known(name);
    return this.act(server, async (q) => {
      const [own, sessions] = await Promise.allSettled([q.reconnectMcpServer(server), reconnectInSessions(this.liveSessions(), server)]);
      return { error: own.status === "rejected" ? errorText(own.reason) : null, sessions: sessions.status === "fulfilled" ? sessions.value : NO_SESSIONS };
    });
  }

  async toggle(name: unknown, enabled: unknown): Promise<McpActionResult> {
    const server = this.known(name);
    if (typeof enabled !== "boolean") throw new Error(T.errMcpEnabled);
    return this.act(server, async (q) => {
      try {
        await q.toggleMcpServer(server, enabled);
        return { error: null, sessions: NO_SESSIONS };
      } catch (error) {
        return { error: errorText(error), sessions: NO_SESSIONS };
      }
    });
  }

  private async act(name: string, run: (q: Query) => Promise<{ error: string | null; sessions: McpSessionResult }>): Promise<McpActionResult> {
    if (this.busy.has(name)) throw new Error(T.errMcpBusy(name));
    const q = this.q;
    if (!q) return { ok: false, error: T.errMcpRestarted, sessions: NO_SESSIONS, meta: this.meta };
    this.busy.add(name);
    try {
      const done = await run(q);
      if (this.q !== q) return { ok: false, error: done.error ?? T.errMcpRestarted, sessions: done.sessions, meta: this.meta };
      try {
        const mcp = await settleMcp(q, MCP_ACTION_SETTLE_MS);
        this.meta = { ...this.meta, mcp, fetchedAt: new Date().toISOString() };
        this.emit(this.meta);
        return { ok: done.error === null, error: done.error, sessions: done.sessions, meta: this.meta };
      } catch {
        const meta = await this.refresh();
        return { ok: false, error: done.error ?? T.errMcpRestarted, sessions: done.sessions, meta };
      }
    } finally {
      this.busy.delete(name);
    }
  }
}
