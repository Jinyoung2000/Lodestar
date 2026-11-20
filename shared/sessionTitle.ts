// 세션 제목을 만드는 순수 함수. 첫 요청 전체가 아니라 첫 줄을 마크다운 없이 짧게 줄인다. 시험: test/sessiontitle.test.ts

export const TITLE_MAX = 80;

// 첫 요청에서 제목으로 쓸 첫 줄. 코드 울타리와 가로줄은 건너뛰고, 줄 머리의 마크다운(제목, 인용, 목록)과 강조 표시를 걷어낸다.
export function shortTitle(text: string, max = TITLE_MAX): string {
  for (const raw of text.split(/\r?\n/)) {
    const line = stripMarkdown(raw);
    if (line) return clampTitle(line, max);
  }
  return "";
}

// 이미 한 줄인 제목(옛 세션, 이름 바꾼 제목)을 max 글자 안으로 줄인다. 단어 중간에서 자르지 않고 줄였으면 끝에 …
export function clampTitle(title: string, max: number): string {
  const text = title.replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  const room = text.slice(0, max - 1);
  const space = room.lastIndexOf(" ");
  const cut = space >= (max - 1) * 0.6 ? room.slice(0, space) : room;
  return `${cut.trimEnd()}…`;
}

function stripMarkdown(raw: string): string {
  const line = raw.trim();
  if (!line || /^(```|~~~)/.test(line) || /^([-*_])(\s*\1){2,}$/.test(line)) return "";
  return line
    .replace(/^(?:#{1,6}\s+|>\s*|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)+/, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`+([^`]*)`+/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[\s(])\*([^*\s][^*]*?)\*(?=[\s).,:;!?]|$)/g, "$1$2")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}
