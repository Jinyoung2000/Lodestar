import type { LinearError, LinearErrorKind, LinearResult } from "../shared/linear";
import { apiBaseOf, KeychainError, type KeyStore } from "./linearKey";

// LINEAR: Linear GraphQL 호출의 유일한 곳. 인증 헤더는 개인 API 키라 `Authorization: <키>` (Bearer 를 붙이지 않는다, 공식 문서).
// 키는 이 파일의 요청 헤더에만 실린다. 오류 문구, 로그, 응답에는 redact 를 거친 글만 나간다.
// 요청 수 제한: 응답 헤더 X-RateLimit-*-Remaining 이 0 이 되면 Reset(UTC epoch ms)까지 새 요청을 보내지 않고 바로 rateLimited 를 돌려준다.
// 제한에 걸린 응답은 HTTP 400 + errors[].extensions.code RATELIMITED (문서) 이고, SDK 는 extensions.type "ratelimited" 와 HTTP 429 도 같은 뜻으로 읽는다.

export type LinearApiDeps = {
  env?: NodeJS.ProcessEnv;
  keys: KeyStore;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
};

type GraphqlError = { message?: string; extensions?: { type?: string; code?: string } };
type GraphqlReply = { data?: Record<string, unknown> | null; errors?: GraphqlError[] };

const FALLBACK_WAIT_MS = 60_000;

export function fail(kind: LinearErrorKind, message: string, retryAfterSec?: number): { ok: false; error: LinearError } {
  return { ok: false, error: { kind, message, ...(retryAfterSec === undefined ? {} : { retryAfterSec }) } };
}

// 오류 문구에서 키를 지운다. 현재 키 전체와 lin_api_ 로 시작하는 낱말을 모두 가린다.
export function redact(text: string, key: string | null): string {
  let out = text.replace(/lin_(?:api|oauth)_[A-Za-z0-9]+/g, "[redacted]");
  if (key && key.length >= 8) out = out.split(key).join("[redacted]");
  return out;
}

export class LinearApi {
  private blockedUntil = 0;
  private readonly now: () => number;
  private readonly doFetch: typeof fetch;

  constructor(private readonly deps: LinearApiDeps) {
    this.now = deps.now ?? Date.now;
    this.doFetch = deps.fetch ?? fetch;
  }

  get keys() {
    return this.deps.keys;
  }

  // keyOverride 는 저장 전에 입력한 키를 확인할 때만 쓴다.
  async request<T extends Record<string, unknown>>(query: string, variables: Record<string, unknown> = {}, keyOverride?: string): Promise<LinearResult<T>> {
    const waitMs = this.blockedUntil - this.now();
    if (waitMs > 0) return fail("rateLimited", `Linear asked us to slow down. Try again in ${Math.ceil(waitMs / 1000)} seconds.`, Math.ceil(waitMs / 1000));

    let key: string | null;
    try {
      key = keyOverride ?? (await this.deps.keys.read());
    } catch (error) {
      return fail("keychain", error instanceof KeychainError ? error.message : "Could not read the Linear key.");
    }
    if (!key) return fail("noKey", "No Linear API key is saved.");

    const { base } = apiBaseOf(this.deps.env ?? process.env);
    let response: Response;
    try {
      response = await this.doFetch(`${base}/graphql`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: key },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(this.deps.timeoutMs ?? 20_000),
      });
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      return fail("network", timedOut ? "Linear did not answer in time." : redact("Could not reach Linear.", key));
    }

    this.noteRateLimit(response.headers);

    let reply: GraphqlReply | null = null;
    try {
      reply = (await response.json()) as GraphqlReply;
    } catch {
      reply = null;
    }

    const first = reply?.errors?.[0];
    const type = first?.extensions?.type?.toLowerCase() ?? "";
    const code = first?.extensions?.code?.toUpperCase() ?? "";
    const message = redact(first?.message ?? `Linear answered HTTP ${response.status}.`, key);

    if (type === "ratelimited" || code === "RATELIMITED" || response.status === 429) {
      const until = this.resetOf(response.headers) ?? this.now() + FALLBACK_WAIT_MS;
      this.blockedUntil = Math.max(this.blockedUntil, until);
      const seconds = Math.max(1, Math.ceil((until - this.now()) / 1000));
      return fail("rateLimited", `Linear asked us to slow down. Try again in ${seconds} seconds.`, seconds);
    }
    if (type === "authentication error" || code === "AUTHENTICATION_ERROR" || response.status === 401 || /not authenticated|authentication required/i.test(message)) return fail("invalidKey", "Linear rejected the API key.");
    if (type === "forbidden" || code === "FORBIDDEN" || response.status === 403) return fail("forbidden", "This key is not allowed to do that in Linear.");
    if (response.status >= 500) return fail("server", `Linear is having trouble (HTTP ${response.status}).`);
    if (first || !response.ok) return fail(response.status === 400 || first ? "badRequest" : "server", message);
    if (!reply?.data) return fail("server", "Linear sent an empty answer.");
    return { ok: true, data: reply.data as T };
  }

  // 남은 요청 수나 복잡도 한도가 0 이면 그 한도의 Reset 까지 막는다. 키 단위 한도라 모든 요청이 같이 막힌다.
  private noteRateLimit(headers: Headers) {
    for (const name of ["requests", "complexity"]) {
      const remaining = headers.get(`x-ratelimit-${name}-remaining`);
      const reset = Number(headers.get(`x-ratelimit-${name}-reset`));
      if (remaining !== null && Number(remaining) <= 0 && Number.isFinite(reset) && reset > this.now()) this.blockedUntil = Math.max(this.blockedUntil, reset);
    }
  }

  private resetOf(headers: Headers): number | null {
    const values = [headers.get("x-ratelimit-requests-reset"), headers.get("x-ratelimit-complexity-reset")].map((v) => (v === null ? NaN : Number(v))).filter((n) => Number.isFinite(n) && n > 0);
    return values.length ? Math.max(...values) : null;
  }

  // 키를 바꾸거나 지우면 이전 키로 받은 제한은 의미가 없다.
  resetBlock() {
    this.blockedUntil = 0;
  }
}
