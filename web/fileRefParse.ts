// 파일 경로 인식은 DOM 과 store 없이 도는 순수 함수라 따로 둔다(test/codespan.test.ts).
export const EXTENSIONS = "tsx?|jsx?|mjs|cjs|mts|cts|json|css|scss|md|mdx|graphql|gql|ya?ml|html|py|go|rs|kt|swift|java|sh|toml";
// src/a/b.tsx, ./x.ts, /abs/path.ts 뒤에 :line, :line:col 이 붙을 수 있다.
// 한글 같은 글자도 경로에 들어가므로 \w 대신 유니코드 글자와 숫자를 쓴다(u 플래그).
const W = "\\p{L}\\p{N}_";
const FILE_REF = new RegExp(
  `(?<![${W}/@.-])(\\/?(?:[${W}@.\\-\\[\\]()]+\\/)*[${W}@\\-\\[\\]][${W}@.\\-\\[\\]]*\\.(?:${EXTENSIONS}))(?::(\\d+)(?::(\\d+))?)?(?![${W}/])`,
  "gu",
);

export type FileRef = { raw: string; line?: number; column?: number };

export function parseFileRefs(text: string): { index: number; length: number; ref: FileRef }[] {
  const results = [];
  for (const match of text.matchAll(FILE_REF)) {
    results.push({
      index: match.index,
      length: match[0].length,
      ref: { raw: match[1], line: match[2] ? Number(match[2]) : undefined, column: match[3] ? Number(match[3]) : undefined },
    });
  }
  return results;
}

// 코드 스팬 전체가 파일 경로 하나(`src/a.ts:12`, `~/.agents/rules.md`)일 때만 그 경로를 돌려준다. `cat a.ts` 처럼 다른 글자가 섞이면 null.
export function parseCodeSpanRef(text: string): FileRef | null {
  const trimmed = text.trim();
  const home = trimmed.startsWith("~/");
  const hit = parseFileRefs(home ? trimmed.slice(1) : trimmed)[0];
  if (!hit || hit.index !== 0 || hit.length !== (home ? trimmed.length - 1 : trimmed.length)) return null;
  return { ...hit.ref, raw: home ? `~${hit.ref.raw}` : hit.ref.raw };
}

