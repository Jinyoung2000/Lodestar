import { marked, type Token } from "marked";

// 마크다운 토큰 파싱. 같은 글은 다시 파싱하지 않게 최근 것을 기억한다(목록이 스크롤로 행을 다시 만들 때와 스트리밍 중 이전 문단 재계산을 줄인다).
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

// 모델 글의 링크 중 누르면 여는 것: 웹 주소와 메일만. file:, javascript:, 전화, 다른 앱의 주소(이 앱의 lodestar://pair 포함)는 열지 않는다.
export function isOpenableLink(href: unknown): href is string {
  return typeof href === "string" && /^(https?:\/\/|mailto:)/i.test(href);
}

// 인라인 토큰 안의 글자만 이어 붙인다(제목이나 링크 라벨 같은 곳의 평문)
export function plainText(tokens: readonly Token[] | undefined): string {
  if (!tokens) return "";
  return tokens.map((t) => ("tokens" in t && t.tokens ? plainText(t.tokens as Token[]) : "text" in t ? String((t as { text: string }).text) : "")).join("");
}
