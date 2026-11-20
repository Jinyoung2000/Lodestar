import { Marked, type Tokens, type TokenizerAndRendererExtension } from "marked";

// CommonMark 는 닫는 `**` 앞이 문장부호이고 뒤가 글자이면(`**일직선(linear)**으로`), 여는 `**` 뒤가 문장부호이고 앞이 글자이면(`한글**(괄호)말**`) 굵게로 보지 않는다.
// 영어는 공백이 단어를 끊어 문제가 없지만 한국어는 조사가 바로 붙어서 별표가 그대로 보인다. 그 경우만 이 확장이 대신 굵게와 기울임으로 만든다.
// 코드 span 과 코드 블록은 marked 가 먼저 한 덩어리로 가져가므로 이 확장은 그 안에 닿지 않는다.
const CJK = /[ᄀ-ᇿ぀-ヿ㄰-㆏㐀-䶿一-鿿가-힯＀-￯]/;
const PUNCT = /[\p{P}\p{S}]/u;

function match(src: string, delim: "**" | "*") {
  const double = delim === "**";
  const m = double ? /^\*\*(?!\s|\*)((?:[^*\n]|\*(?!\*))+?)(?<!\s)\*\*(?!\*)/.exec(src) : /^\*(?!\s|\*)([^*\n]+?)(?<!\s)\*(?!\*)/.exec(src);
  if (!m) return null;
  const inner = m[1];
  const after = src.slice(m[0].length, m[0].length + 1);
  // 표준 규칙으로 안 되는 경우만 맡는다: 닫는 쪽에서 문장부호 뒤에 한글이 오거나, 여는 쪽에서 문장부호가 바로 오는 경우.
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

// 옵시디언 노트 링크 `[[제목]]` 은 마크다운 문법이 아니라 marked 가 글자 그대로 둔다. 대괄호를 떼고 제목만 칩으로 그린다.
// `[[제목|표시 이름]]` 이면 표시 이름을 쓴다. 노트를 여는 동작은 없다(vault 가 작업 폴더 밖이라 경로 해석이 따로 필요하다).
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

// GFM 은 `~한쪽~` 도 취소선으로 본다. "4.2% ~ 7.0%" 처럼 범위를 뜻하는 물결표가 두 번 나오면 그 사이가 줄 그어져 버리므로 `~~두 겹~~` 일 때만 취소선으로 인정한다.
const markdown = new Marked({
  extensions: [wikilink, emphasis("cjkStrong", "**", "strong"), emphasis("cjkEm", "*", "em")],
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
