import type { ContextUsage } from "./protocol";

// CTX: 컨텍스트 창 사용량 계산. 서버(어림 값과 SDK 값 합치기)와 화면(비율, 색, 토큰 표기)이 같이 쓴다.

export const CONTEXT_WARNING = 0.8;
export const CONTEXT_ERROR = 0.95;
const WINDOW_DEFAULT = 200_000;
const WINDOW_LARGE = 1_000_000;

export type ContextLevel = "ok" | "warning" | "error";

export function contextRatio(usage: Pick<ContextUsage, "used" | "limit">) {
  return usage.limit > 0 ? usage.used / usage.limit : 0;
}

// 화면에 보이는 퍼센트. 0 이 아닌데 0 으로 보이지 않게 올림하지는 않고, 반올림한 정수다.
export function contextPercent(usage: Pick<ContextUsage, "used" | "limit">) {
  return Math.round(contextRatio(usage) * 100);
}

export function contextLevel(usage: Pick<ContextUsage, "used" | "limit">): ContextLevel {
  const ratio = contextRatio(usage);
  return ratio >= CONTEXT_ERROR ? "error" : ratio >= CONTEXT_WARNING ? "warning" : "ok";
}

// 12345 -> "12.3k", 1_000_000 -> "1M". 툴팁의 `used / limit tokens`.
export function formatTokens(count: number) {
  if (count >= 1_000_000) return `${trim(count / 1_000_000)}M`;
  if (count >= 1000) return `${trim(count / 1000)}k`;
  return String(Math.round(count));
}

function trim(value: number) {
  return value >= 100 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, "");
}

// 응답 프레임(assistant 메시지)의 usage. 필드는 없을 수도 있다.
export type FrameUsage = {
  input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  output_tokens?: number | null;
};

// 이 응답을 만들 때 모델이 읽은 컨텍스트: 입력 + 캐시 읽기 + 캐시 쓰기. 전부 0 이면(오류로 만든 가짜 응답) null.
export function usedFromUsage(usage: FrameUsage | undefined | null) {
  if (!usage) return null;
  const used = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
  return used > 0 ? used : null;
}

// SDK 가 창 크기를 알려 주기 전(첫 응답 도중)에만 쓰는 어림. [1m] 변형 id 면 1M, 아니면 200k.
export function fallbackLimit(model: string | null | undefined) {
  return model && /\[1m\]|-1m\b/i.test(model) ? WINDOW_LARGE : WINDOW_DEFAULT;
}

// 응답 프레임으로 어림한 사용량. 창 크기는 이 세션에 SDK 가 준 값, 같은 모델의 다른 세션에서 SDK 가 준 값(known), 모델 id 어림 순으로 쓴다.
// 실제로 읽은 양이 어림 창보다 크면 그 창은 틀린 것이라(200k 로 어림한 Sonnet 이 248k 를 읽음) 큰 창으로 올린다.
export function estimateContext(prev: ContextUsage | null | undefined, usage: FrameUsage | undefined | null, model: string | null | undefined, now: string, known?: number | null): ContextUsage | null {
  const used = usedFromUsage(usage);
  if (used === null) return null;
  const limit = prev?.limit ?? known ?? fallbackLimit(model);
  return { used, limit: used > limit && used <= WINDOW_LARGE ? WINDOW_LARGE : limit, source: "estimate", at: now };
}

// SDK getContextUsage 의 응답. totalTokens 는 지금 컨텍스트에 든 양, rawMaxTokens 는 자동 압축이 기준으로 삼는 창이다.
export function contextFromApi(res: { totalTokens: number; rawMaxTokens: number; maxTokens?: number }, now: string): ContextUsage | null {
  const limit = res.rawMaxTokens > 0 ? res.rawMaxTokens : (res.maxTokens ?? 0);
  if (!(limit > 0) || !(res.totalTokens >= 0)) return null;
  return { used: res.totalTokens, limit, source: "api", at: now };
}

// 압축이 끝난 직후: 압축 뒤 토큰 수로 바로 내린다(다음 SDK 값이 오면 바뀐다).
export function contextAfterCompact(prev: ContextUsage | null | undefined, postTokens: number | undefined, model: string | null | undefined, now: string): ContextUsage | null {
  if (!(typeof postTokens === "number" && postTokens >= 0)) return null;
  return { used: postTokens, limit: prev?.limit ?? fallbackLimit(model), source: "estimate", at: now };
}

export function sameContext(a: ContextUsage | null | undefined, b: ContextUsage | null | undefined) {
  return a?.used === b?.used && a?.limit === b?.limit && a?.source === b?.source;
}
