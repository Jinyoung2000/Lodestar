import { marked, type Token } from "marked";

const CACHE_LIMIT = 200;
const cache = new Map<string, Token[]>();

export function parseMarkdown(text: string): Token[] {
  const hit = cache.get(text);
  if (hit) {
    cache.delete(text);
    cache.set(text, hit);
    return hit;
  }
  const tokens = marked.lexer(text, { gfm: true, breaks: false });
  cache.set(text, tokens);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
  return tokens;
}

export type { Token };

export function isOpenableLink(href: unknown): href is string {
  return typeof href === "string" && /^(https?:\/\/|mailto:)/i.test(href);
}

export function plainText(tokens: readonly Token[] | undefined): string {
  if (!tokens) return "";
  return tokens.map((t) => ("tokens" in t && t.tokens ? plainText(t.tokens as Token[]) : "text" in t ? String((t as { text: string }).text) : "")).join("");
}
