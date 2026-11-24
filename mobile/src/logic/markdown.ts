import { Marked, type Token, type TokenizerExtension } from "marked";

const CACHE_LIMIT = 200;
const cache = new Map<string, Token[]>();

const closeStrong: TokenizerExtension = {
  name: "strong",
  level: "inline",
  start: (src) => src.indexOf("**"),
  tokenizer(src) {
    const match = /^\*\*(?![\s*])([^\n]*?[^\s*])\*\*(?!\*)/.exec(src);
    if (!match) return undefined;
    return { type: "strong", raw: match[0], text: match[1], tokens: this.lexer.inlineTokens(match[1]) };
  },
};

const parser = new Marked({ gfm: true, breaks: false }).use({
  extensions: [closeStrong],
  tokenizer: {
    del(src) {
      if (src.startsWith("~~")) return false;
      if (src.startsWith("~")) return { type: "text", raw: "~", text: "~" } as never;
      return false;
    },
  },
});

export function parseMarkdown(text: string): Token[] {
  const hit = cache.get(text);
  if (hit) {
    cache.delete(text);
    cache.set(text, hit);
    return hit;
  }
  const tokens = parser.lexer(text);
  cache.set(text, tokens);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
  return tokens;
}

export type { Token };

export function isOpenableLink(href: unknown): href is string {
  return typeof href === "string" && /^(https?:\/\/|mailto:)/i.test(href);
}

export function shortLinkLabel(href: string): string {
  if (!/^https?:\/\//i.test(href)) return href.replace(/^mailto:/i, "");
  try {
    const url = new URL(href);
    const host = url.host.replace(/^www\./, "");
    const segments = url.pathname.split("/").filter(Boolean);
    const last = segments.at(-1);
    if (!last) return host;
    return segments.length > 1 ? `${host}/\u2026/${decodeURIComponent(last)}` : `${host}/${decodeURIComponent(last)}`;
  } catch {
    return href;
  }
}

export function plainText(tokens: readonly Token[] | undefined): string {
  if (!tokens) return "";
  return tokens.map((t) => ("tokens" in t && t.tokens ? plainText(t.tokens as Token[]) : "text" in t ? String((t as { text: string }).text) : "")).join("");
}
