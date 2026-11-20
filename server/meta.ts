import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { query, type Query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { versionedDisplayName } from "../shared/modelName";
import type { EffortLevel, McpActionResult, McpSessionResult, Meta } from "../shared/protocol";
import { claudeBin, claudeEnv, claudeErrorText } from "./claude";
import { errorText, reconnectInSessions, settleMcp, type McpControl } from "./mcp";
import { HOME } from "./store";
import { T } from "./strings";
import { spawnInGroup } from "./processGroups";

const MCP_SETTLE_MS = 12_000;
const MCP_ACTION_SETTLE_MS = 8_000;

const EMPTY_META: Meta = { claudeVersion: null, account: null, models: [], mcp: [], commandCount: 0, commands: [], fetchedAt: null, error: null };

// B3: 모델 목록과 명령 목록은 디스크에 남겨 둔다. 데몬을 다시 띄운 직후나 로그인 확인이 늦을 때(버그 1)도 입력창의 모델 메뉴와 `/` 메뉴가 비지 않는다. 계정과 MCP 상태는 로그인과 서버에 묶여 있어 남기지 않는다.
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
    // 캐시를 못 쓰면 다음 시작에 목록이 늦게 보일 뿐이다
  }
}
const NO_SESSIONS: McpSessionResult = { reconnected: 0, failed: 0, skipped: 0 };

// 턴을 보내지 않는 CLI 프로세스를 하나 띄워 초기화 응답(모델 목록, 명령, 계정)과 MCP 상태를 받는다.
// 프롬프트가 영원히 오지 않는 스트리밍 입력이라 비용이 들지 않는다. 이 프로세스는 닫지 않고 MetaService 가 들고 있다가,
// 설정 패널의 재연결과 켜기/끄기를 같은 프로세스에 건다 (그래서 켜기/끄기는 이 프로세스 안에서만 효과가 있다).
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
        supportedEffortLevels: (m.supportedEffortLevels ?? []) as EffortLevel[],
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

// 모델 목록, MCP 상태, 계정을 들고 있는 데몬 쪽 상태. 새로 고침은 프로세스를 새로 띄우고, MCP 재연결과 켜기/끄기는 떠 있는 프로세스에 건다.
export class MetaService {
  meta: Meta = (() => {
    const cached = readCache();
    return cached ? { ...EMPTY_META, ...cached } : EMPTY_META;
  })();
  private q: Query | null = null;
  private loading: Promise<Meta> | null = null;
  private busy = new Set<string>();

  constructor(
    private cwd: string,
    private emit: (meta: Meta) => void,
    // 지금 턴이 도는 세션들의 Query (대기 중인 세션은 프로세스가 없다)
    private liveSessions: () => McpControl[],
  ) {}

  refresh(): Promise<Meta> {
    this.loading ??= this.load()
      .then((next) => {
        this.meta = next.meta;
        this.q = next.query;
        writeCache(next.meta);
        console.log(`[meta] models=${next.meta.models.length} mcp=${next.meta.mcp.map((m) => `${m.name}:${m.status}`).join(",")}`);
      })
      .catch((error: Error) => {
        this.meta = { ...this.meta, error: claudeErrorText(error.message) };
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
    // 이전 프로세스를 먼저 닫아야 MCP 서버(로컬 stdio 포함)가 둘씩 떠 있지 않다.
    this.close();
    return startMeta(this.cwd);
  }

  close() {
    this.q?.close();
    this.q = null;
  }

  // 이름은 이 프로세스가 아는 서버여야 한다 (모르는 이름은 SDK 에 보내지 않는다).
  private known(name: unknown): string {
    if (typeof name !== "string" || !name) throw new Error(T.errMcpName);
    if (!this.meta.mcp.some((m) => m.name === name)) throw new Error(T.errMcpUnknown(name));
    return name;
  }

  async reconnect(name: unknown): Promise<McpActionResult> {
    const server = this.known(name);
    return this.act(server, async (q) => {
      // 세션 쪽은 메타 쪽과 따로 시도한다. 한쪽이 실패해도 다른 쪽은 진행한다.
      const [own, sessions] = await Promise.allSettled([q.reconnectMcpServer(server), reconnectInSessions(this.liveSessions(), server)]);
      return { error: own.status === "rejected" ? errorText(own.reason) : null, sessions: sessions.status === "fulfilled" ? sessions.value : NO_SESSIONS };
    });
  }

  // 켜기와 끄기는 이 프로세스에만 건다. 도구를 쓰는 도중인 세션의 도구 목록을 바꾸지 않는다.
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

  // 같은 서버에 동작이 겹치지 않게 하고, 끝나면 상태를 다시 읽어 알린다.
  // 실패한 동작에도 상태를 다시 읽는다 (needs-auth 로 돌아오거나 failed 사유가 달라질 수 있다).
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
        // 상태를 못 읽으면 프로세스가 죽은 것이다. 새로 띄운다.
        const meta = await this.refresh();
        return { ok: false, error: done.error ?? T.errMcpRestarted, sessions: done.sessions, meta };
      }
    } finally {
      this.busy.delete(name);
    }
  }
}
