// Aside MCP(브라우저 조작 REPL)의 도구 이름과, 도구 결과 글에서 이미지 파일 경로를 뽑는 순수 함수. 서버(이미지 읽기, 결과 저장)와 화면(행)이 같이 쓴다.
export const ASIDE_TOOL = "mcp__aside__repl";
export const isAsideTool = (name: string) => name === ASIDE_TOOL;

// 결과 글에는 이미지가 파일 경로로만 남는다(이미지 바이트는 모델과 CLI 쪽에만 있다).
//   Displayed image saved to: <Aside 세션 tmp 의 파일> [image/png]
//   [Image: source: <Claude Code 가 남긴 tool-results 의 파일>]
// 한 이미지가 두 줄로 나오는 경우가 많아서, 이어서 나오는 두 경로는 한 이미지의 후보로 묶는다(앞의 것이 먼저 읽힌다).
const SAVED = /^Displayed image saved to: (\/\S+?\.(?:png|jpe?g|webp|gif))(?: \[[^\]]*\])?\s*$/gim;
const SOURCE = /^\[Image: source: (\/\S+?\.(?:png|jpe?g|webp|gif))\]\s*$/gim;

export function asideImageRefs(output: string | null): string[][] {
  if (!output) return [];
  const found: { index: number; path: string; source: boolean }[] = [];
  for (const m of output.matchAll(SAVED)) found.push({ index: m.index ?? 0, path: m[1], source: false });
  for (const m of output.matchAll(SOURCE)) found.push({ index: m.index ?? 0, path: m[1], source: true });
  found.sort((a, b) => a.index - b.index);
  const refs: string[][] = [];
  for (const hit of found) {
    const last = refs[refs.length - 1];
    // 이미지 한 장은 "saved" 한 줄과 "source" 한 줄이다. source 가 바로 앞의 saved 와 짝이면 후보로 묶는다.
    if (hit.source && last && last.length === 1) last.push(hit.path);
    else refs.push([hit.path]);
  }
  return refs;
}

// 이미지 안내 줄(위의 두 줄과 "[Image: original ...]" 크기 줄)을 뺀 나머지 글
export function withoutImageNotes(output: string): string {
  return output
    .split("\n")
    .filter((line) => !/^Displayed image saved to: /i.test(line) && !/^\[Image: (?:source|original)\b/i.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
