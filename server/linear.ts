import type { LinearIssue, LinearIssueFilter, LinearIssuePage, LinearIssueRef, LinearMeta, LinearPriority, LinearResult, LinearRpcMethods, LinearStatus } from "../shared/linear";
import { LINEAR_PRIORITIES } from "../shared/linear";
import { BadFilter, buildIssueFilter, normalizeFilter } from "./linearFilter";
import { fail, LinearApi, redact } from "./linearApi";
import { KeychainError, keyStoreFor, validKeyShape, type KeyStore } from "./linearKey";
import { ISSUE_QUERY, ISSUES_QUERY, MAX_PAGE_SIZE, META_QUERIES, PAGE_SIZE, parseIssue, parseMeta, parseViewer, UPDATE_ISSUE_MUTATION, VIEWER_QUERY, type MetaRaw } from "./linearQueries";
import { requireConfirmed } from "./pr";

// LINEAR: Linear 연동의 RPC 핸들러. 읽기는 캐시하고(meta 10분, 이슈 목록 30초, 연결 상태 1분), 쓰기는 상태와 우선순위 두 가지뿐이다.
// 쓰기와 키 변경은 화면이 사용자의 클릭으로 보낸 confirmed: true 가 있어야 하고(server/pr.ts 와 같은 규칙), 세션의 모델에게 주는 도구나 모바일 허용 목록(shared/mobile.ts)에는 없다.

export const META_TTL_MS = 10 * 60_000;
export const ISSUES_TTL_MS = 30_000;
export const STATUS_TTL_MS = 60_000;
const MAX_META_PAGES = 10;

type Connection = { nodes?: unknown[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } };
type Handlers = { [M in keyof LinearRpcMethods]: (params: LinearRpcMethods[M]["params"]) => Promise<LinearRpcMethods[M]["result"]> };

export type LinearDeps = {
  api?: LinearApi;
  keys?: KeyStore;
  now?: () => number;
  // 세션의 Linear 표지를 바꾸고 화면에 알린다(index.ts 가 store.patchAgent 와 broadcast 로 채운다).
  setAgentIssue: (agentId: string, issue: LinearIssueRef | null) => void;
  log?: (line: string) => void;
};

// 값이 TTL 안이면 그대로, 아니면 loader 를 한 번만 불러 같이 기다린다. 실패는 저장하지 않는다.
class TtlCache<T> {
  private readonly values = new Map<string, { at: number; value: T }>();
  private readonly pending = new Map<string, Promise<LinearResult<T>>>();
  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number,
  ) {}

  async get(key: string, force: boolean, load: () => Promise<LinearResult<T>>): Promise<LinearResult<T>> {
    const hit = this.values.get(key);
    if (!force && hit && this.now() - hit.at < this.ttlMs) return { ok: true, data: hit.value };
    const running = this.pending.get(key);
    if (running) return running;
    const promise = load()
      .then((result) => {
        if (result.ok) this.values.set(key, { at: this.now(), value: result.data });
        return result;
      })
      .finally(() => this.pending.delete(key));
    this.pending.set(key, promise);
    return promise;
  }

  clear() {
    this.values.clear();
  }
}

export function linearHandlers(deps: LinearDeps): Handlers {
  const now = deps.now ?? Date.now;
  const keys = deps.keys ?? deps.api?.keys ?? keyStoreFor();
  const api = deps.api ?? new LinearApi({ keys, now });
  const log = deps.log ?? ((line: string) => console.log(line));
  const iso = () => new Date(now()).toISOString();

  const statusCache = new TtlCache<LinearStatus & { connected: true }>(STATUS_TTL_MS, now);
  const metaCache = new TtlCache<LinearMeta>(META_TTL_MS, now);
  const pageCache = new TtlCache<LinearIssuePage>(ISSUES_TTL_MS, now);
  const issueCache = new TtlCache<LinearIssue>(ISSUES_TTL_MS, now);
  const dropAll = () => {
    statusCache.clear();
    metaCache.clear();
    pageCache.clear();
    issueCache.clear();
  };

  const note = (op: string, result: LinearResult<unknown>) => {
    if (!result.ok) log(`[linear] ${op} failed: ${result.error.kind}`);
  };

  const readStatus = async (force: boolean, keyOverride?: string): Promise<LinearStatus> => {
    const load = async (): Promise<LinearResult<LinearStatus & { connected: true }>> => {
      const result = await api.request<{ viewer?: unknown; organization?: { name?: unknown; urlKey?: unknown } | null }>(VIEWER_QUERY, {}, keyOverride);
      if (!result.ok) return result;
      const viewer = parseViewer(result.data.viewer);
      if (!viewer) return fail("server", "Linear did not say who this key belongs to.");
      const org = result.data.organization;
      return { ok: true, data: { connected: true, viewer, organization: org && typeof org.name === "string" && typeof org.urlKey === "string" ? { name: org.name, urlKey: org.urlKey } : null } };
    };
    // 저장 전 확인(keyOverride)은 캐시를 거치지 않는다.
    const result = keyOverride ? await load() : await statusCache.get("status", force, load);
    note("status", result);
    return result.ok ? result.data : { connected: false, error: result.error };
  };

  // 여러 쪽짜리 메타 목록 하나를 끝까지(최대 MAX_META_PAGES 쪽) 읽는다.
  const readAll = async (query: string, field: string): Promise<LinearResult<unknown[]>> => {
    const nodes: unknown[] = [];
    let after: string | null = null;
    for (let page = 0; page < MAX_META_PAGES; page++) {
      const result: LinearResult<Record<string, Connection | undefined>> = await api.request(query, { after });
      if (!result.ok) return result;
      const connection: Connection | undefined = result.data[field];
      nodes.push(...(connection?.nodes ?? []));
      if (!connection?.pageInfo?.hasNextPage || !connection.pageInfo.endCursor) break;
      after = connection.pageInfo.endCursor;
    }
    return { ok: true, data: nodes };
  };

  const readMeta = (force: boolean) =>
    metaCache.get("meta", force, async () => {
      const [teams, states, labels, cycles] = await Promise.all([readAll(META_QUERIES.teams, "teams"), readAll(META_QUERIES.states, "workflowStates"), readAll(META_QUERIES.labels, "issueLabels"), readAll(META_QUERIES.cycles, "cycles")]);
      for (const part of [teams, states, labels, cycles]) if (!part.ok) return part;
      const raw: MetaRaw = { teams: teams.ok ? teams.data : [], states: states.ok ? states.data : [], labels: labels.ok ? labels.data : [], cycles: cycles.ok ? cycles.data : [] };
      return { ok: true, data: parseMeta(raw, iso()) } as LinearResult<LinearMeta>;
    });

  const guard = async <T>(run: () => Promise<LinearResult<T>>): Promise<LinearResult<T>> => {
    try {
      return await run();
    } catch (error) {
      if (error instanceof BadFilter) return fail("badRequest", error.message);
      if (error instanceof KeychainError) return fail("keychain", error.message);
      return fail("server", redact(error instanceof Error ? error.message : "Unexpected Linear error.", null));
    }
  };

  return {
    "linear.status": async ({ force }) => readStatus(force === true),

    "linear.setKey": async (params) => {
      requireConfirmed(params);
      const key = typeof params.key === "string" ? params.key.trim() : "";
      if (!validKeyShape(key)) return { connected: false, error: { kind: "invalidKey", message: "That does not look like a Linear API key. Create one under Settings, Account, Security & access in Linear." } };
      // 먼저 이 키로 viewer 를 읽어 보고, 통과한 키만 저장한다.
      const status = await readStatus(true, key);
      if (!status.connected) return status;
      try {
        await keys.write(key);
      } catch (error) {
        return { connected: false, error: { kind: "keychain", message: error instanceof KeychainError ? error.message : "Could not save the Linear key." } };
      }
      dropAll();
      api.resetBlock();
      return readStatus(true);
    },

    "linear.clearKey": async (params) => {
      requireConfirmed(params);
      try {
        await keys.clear();
      } catch (error) {
        return { connected: false, error: { kind: "keychain", message: error instanceof KeychainError ? error.message : "Could not remove the Linear key." } };
      }
      dropAll();
      api.resetBlock();
      return readStatus(true);
    },

    "linear.meta": async ({ force }) => {
      const result = await guard(() => readMeta(force === true));
      note("meta", result);
      return result;
    },

    "linear.issues": async ({ filter, first, after, force }) => {
      const result = await guard(async () => {
        const normalized: LinearIssueFilter = normalizeFilter(filter);
        const size = Number.isInteger(first) && (first as number) > 0 ? Math.min(first as number, MAX_PAGE_SIZE) : PAGE_SIZE;
        if (after !== undefined && after !== null && (typeof after !== "string" || after.length > 300)) throw new BadFilter("after must be a cursor");
        const cursor = typeof after === "string" && after ? after : null;
        return pageCache.get(JSON.stringify([normalized, size, cursor]), force === true, async () => {
          const reply = await api.request<{ issues?: { nodes?: unknown[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } } }>(ISSUES_QUERY, { filter: buildIssueFilter(normalized), first: size, after: cursor });
          if (!reply.ok) return reply;
          const connection = reply.data.issues;
          const issues = (connection?.nodes ?? []).flatMap((node) => {
            const issue = parseIssue(node);
            return issue ? [issue] : [];
          });
          return { ok: true, data: { issues, hasNextPage: connection?.pageInfo?.hasNextPage === true, endCursor: connection?.pageInfo?.endCursor ?? null, fetchedAt: iso() } };
        });
      });
      note("issues", result);
      return result;
    },

    "linear.issue": async ({ id, force }) => {
      const result = await guard(async () => {
        if (typeof id !== "string" || !id || id.length > 100) throw new BadFilter("id must be an issue id or identifier");
        return issueCache.get(id, force === true, async () => {
          const reply = await api.request<{ issue?: unknown }>(ISSUE_QUERY, { id });
          if (!reply.ok) return reply;
          const issue = parseIssue(reply.data.issue, true);
          return issue ? { ok: true, data: issue } : fail("server", "Linear did not return that issue.");
        });
      });
      note("issue", result);
      return result;
    },

    "linear.updateIssue": async (params) => {
      requireConfirmed(params);
      const result = await guard(async () => {
        const { id, stateId, priority } = params;
        if (typeof id !== "string" || !id || id.length > 100) throw new BadFilter("id must be an issue id");
        const input: { stateId?: string; priority?: LinearPriority } = {};
        if (stateId !== undefined) {
          if (typeof stateId !== "string" || !stateId || stateId.length > 100) throw new BadFilter("stateId must be a workflow state id");
          input.stateId = stateId;
        }
        if (priority !== undefined) {
          if (!(LINEAR_PRIORITIES as readonly unknown[]).includes(priority)) throw new BadFilter("priority must be a whole number from 0 to 4");
          input.priority = priority;
        }
        if (input.stateId === undefined && input.priority === undefined) throw new BadFilter("Nothing to change: send stateId or priority.");
        const reply = await api.request<{ issueUpdate?: { success?: boolean; issue?: unknown } }>(UPDATE_ISSUE_MUTATION, { id, input });
        if (!reply.ok) return reply;
        const issue = parseIssue(reply.data.issueUpdate?.issue);
        if (!reply.data.issueUpdate?.success || !issue) return fail("server", "Linear did not apply the change.");
        // 바꾼 뒤 30초 동안 옛 상태가 보이지 않게 이슈 캐시를 비운다.
        pageCache.clear();
        issueCache.clear();
        return { ok: true, data: issue } as LinearResult<LinearIssue>;
      });
      note("updateIssue", result);
      return result;
    },

    "agents.setLinearIssue": async ({ agentId, issue }) => {
      if (typeof agentId !== "string" || !agentId) throw new Error("agentId is required.");
      deps.setAgentIssue(agentId, issue === null ? null : cleanRef(issue));
      return null;
    },
  };
}

function cleanRef(raw: LinearIssueRef): LinearIssueRef {
  const identifier = typeof raw?.identifier === "string" ? raw.identifier.trim() : "";
  const title = typeof raw?.title === "string" ? raw.title.replace(/\s+/g, " ").trim().slice(0, 300) : "";
  const url = typeof raw?.url === "string" ? raw.url.trim() : "";
  if (!/^[A-Za-z][A-Za-z0-9]{0,15}-\d{1,9}$/.test(identifier)) throw new Error("Not a Linear issue identifier.");
  if (!/^https?:\/\/[^\s]{1,500}$/.test(url)) throw new Error("The issue link must be an http or https address.");
  return { identifier, title, url };
}
