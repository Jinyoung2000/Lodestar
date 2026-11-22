import { Marked, type Tokens, type TokenizerAndRendererExtension } from "marked";

const CJK = /[ᄀ-ᇿ぀-ヿ㄰-㆏㐀-䶿一-鿿가-힯＀-￯]/;
const PUNCT = /[\p{P}\p{S}]/u;

function match(src: string, delim: "**" | "*") {
  const double = delim === "**";
  const m = double ? /^\*\*(?!\s|\*)((?:[^*\n]|\*(?!\*))+?)(?<!\s)\*\*(?!\*)/.exec(src) : /^\*(?!\s|\*)([^*\n]+?)(?<!\s)\*(?!\*)/.exec(src);
  if (!m) return null;
  const inner = m[1];
  const after = src.slice(m[0].length, m[0].length + 1);
  const closerFails = PUNCT.test(inner.slice(-1)) && CJK.test(after);
  const openerFails = PUNCT.test(inner.slice(0, 1));
  const hasCjkNearby = CJK.test(after) || CJK.test(inner);
  if (!(closerFails || (openerFails && hasCjkNearby))) return null;
  return { raw: m[0], inner };
}

function emphasis(name: "cjkStrong" | "cjkEm", delim: "**" | "*", tag: "strong" | "em"): TokenizerAndRendererExtension {
  return {
    name,
    level: "inline",
    start: (src: string) => src.indexOf("*"),
    tokenizer(src: string) {
      const found = match(src, delim);
      if (!found) return undefined;
      return { type: name, raw: found.raw, text: found.inner, tokens: this.lexer.inlineTokens(found.inner) };
    },
    renderer(token: Tokens.Generic) {
      return `<${tag}>${this.parser.parseInline(token.tokens ?? [])}</${tag}>`;
    },
  };
}

const wikilink: TokenizerAndRendererExtension = {
  name: "wikilink",
  level: "inline",
  start: (src: string) => src.indexOf("[["),
  tokenizer(src: string) {
    const m = /^\[\[([^[\]\n|]+?)(?:\|([^[\]\n]+?))?\]\]/.exec(src);
    if (!m) return undefined;
    return { type: "wikilink", raw: m[0], text: (m[2] ?? m[1]).trim() };
  },
  renderer(token: Tokens.Generic) {
    const text = String(token.text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return `<span class="wikilink">${text}</span>`;
  },
};

const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const fileCitation: TokenizerAndRendererExtension = {
  name: "fileCitation",
  level: "inline",
  start: (src: string) => src.search(/:{1,2}codex-file-citation\{/),
  tokenizer(src: string) {
    const m = /^:{1,2}codex-file-citation\{([^}\n]*)\}/.exec(src);
    if (!m) return undefined;
    const attrs = Object.fromEntries([...m[1].matchAll(/([\w-]+)=(?:"([^"]*)"|(\S+))/g)].map((a) => [a[1], a[2] ?? a[3]]));
    const path = attrs.path;
    if (!path) return undefined;
    const line = Number(attrs.line_range_start ?? attrs.line ?? "") || undefined;
    return { type: "fileCitation", raw: m[0], path, line };
  },
  renderer(token: Tokens.Generic) {
    const path = String(token.path);
    const name = path.replace(/\/+$/, "").split("/").at(-1) || path;
    const ref = JSON.stringify({ raw: path, line: token.line as number | undefined });
    return `<a class="file-link" role="link" tabindex="0" title="${escapeHtml(path)}" data-file="${escapeHtml(ref)}">${escapeHtml(name)}</a>`;
  },
};

const markdown = new Marked({
  extensions: [fileCitation, wikilink,emphasis("cjkStrong", "**", "strong"), emphasis("cjkEm", "*", "em")],
  tokenizer: {
    del(src: string) {
      if (!src.startsWith("~~")) return undefined;
      return false;
    },
  },
});

export function parseMarkdown(text: string, options: { breaks?: boolean } = {}): string {
  return markdown.parse(text, { async: false, breaks: options.breaks ?? false });
}
