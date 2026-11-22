export const EXTENSIONS = "tsx?|jsx?|mjs|cjs|mts|cts|json|css|scss|md|mdx|graphql|gql|ya?ml|html|py|go|rs|kt|swift|java|sh|toml";
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

export function parseCodeSpanRef(text: string): FileRef | null {
  const trimmed = text.trim();
  const home = trimmed.startsWith("~/");
  const hit = parseFileRefs(home ? trimmed.slice(1) : trimmed)[0];
  if (!hit || hit.index !== 0 || hit.length !== (home ? trimmed.length - 1 : trimmed.length)) return null;
  return { ...hit.ref, raw: home ? `~${hit.ref.raw}` : hit.ref.raw };
}

