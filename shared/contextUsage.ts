import type { ContextUsage } from "./protocol";

export const CONTEXT_WARNING = 0.8;
export const CONTEXT_ERROR = 0.95;
const WINDOW_DEFAULT = 200_000;
const WINDOW_LARGE = 1_000_000;

export type ContextLevel = "ok" | "warning" | "error";

export function contextRatio(usage: Pick<ContextUsage, "used" | "limit">) {
  return usage.limit > 0 ? usage.used / usage.limit : 0;
}

export function contextPercent(usage: Pick<ContextUsage, "used" | "limit">) {
  return Math.round(contextRatio(usage) * 100);
}

export function contextLevel(usage: Pick<ContextUsage, "used" | "limit">): ContextLevel {
  const ratio = contextRatio(usage);
  return ratio >= CONTEXT_ERROR ? "error" : ratio >= CONTEXT_WARNING ? "warning" : "ok";
}

export function formatTokens(count: number) {
  if (count >= 1_000_000) return `${trim(count / 1_000_000)}M`;
  if (count >= 1000) return `${trim(count / 1000)}k`;
  return String(Math.round(count));
}

function trim(value: number) {
  return value >= 100 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, "");
}

export type FrameUsage = {
  input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  output_tokens?: number | null;
};

export function usedFromUsage(usage: FrameUsage | undefined | null) {
  if (!usage) return null;
  const used = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
  return used > 0 ? used : null;
}

export function fallbackLimit(model: string | null | undefined) {
  return model && /\[1m\]|-1m\b/i.test(model) ? WINDOW_LARGE : WINDOW_DEFAULT;
}

export function estimateContext(prev: ContextUsage | null | undefined, usage: FrameUsage | undefined | null, model: string | null | undefined, now: string, known?: number | null): ContextUsage | null {
  const used = usedFromUsage(usage);
  if (used === null) return null;
  const limit = prev?.limit ?? known ?? fallbackLimit(model);
  return { used, limit: used > limit && used <= WINDOW_LARGE ? WINDOW_LARGE : limit, source: "estimate", at: now };
}

export function contextFromApi(res: { totalTokens: number; rawMaxTokens: number; maxTokens?: number }, now: string): ContextUsage | null {
  const limit = res.rawMaxTokens > 0 ? res.rawMaxTokens : (res.maxTokens ?? 0);
  if (!(limit > 0) || !(res.totalTokens >= 0)) return null;
  return { used: res.totalTokens, limit, source: "api", at: now };
}

export function contextAfterCompact(prev: ContextUsage | null | undefined, postTokens: number | undefined, model: string | null | undefined, now: string): ContextUsage | null {
  if (!(typeof postTokens === "number" && postTokens >= 0)) return null;
  return { used: postTokens, limit: prev?.limit ?? fallbackLimit(model), source: "estimate", at: now };
}

export function sameContext(a: ContextUsage | null | undefined, b: ContextUsage | null | undefined) {
  return a?.used === b?.used && a?.limit === b?.limit && a?.source === b?.source;
}
