// 본문 검색의 일치 구간 찾기. 검색 조건을 JS 정규식으로 바꿔 줄에서 일치를 찾는다(서버의 git grep 대체 경로와 웹의 표시가 같이 쓴다).
// DOM 과 Node 에 의존하지 않아 단위 시험이 그대로 부른다.

export type SearchFlags = { matchCase: boolean; wholeWord: boolean; regex: boolean };

// 줄 안에서 일치한 구간. start 와 end 는 UTF-16 코드 유닛 오프셋이고 end 는 포함하지 않는다.
export type MatchRange = { start: number; end: number };

// 정규식 문법이 JS 와 달라 만들 수 없으면 null.
// 낱말 단위는 rg 의 --word-regexp 와 같게 "앞뒤가 낱말 문자가 아니다" 로 건다(\b 는 검색어가 기호로 시작하면 어긋난다).
export function searchRegExp(query: string, flags: SearchFlags): RegExp | null {
  if (!query) return null;
  const body = flags.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const source = flags.wholeWord ? `(?<![\\p{L}\\p{N}_])(?:${body})(?![\\p{L}\\p{N}_])` : body;
  const base = flags.matchCase ? "g" : "gi";
  try {
    return new RegExp(source, `${base}u`);
  } catch {
    try {
      return new RegExp(flags.wholeWord ? `(?<!\\w)(?:${body})(?!\\w)` : body, base);
    } catch {
      return null;
    }
  }
}

export function findRanges(text: string, pattern: RegExp, limit = 10_000): MatchRange[] {
  const out: MatchRange[] = [];
  const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  for (let m = re.exec(text); m && out.length < limit; m = re.exec(text)) {
    if (m[0] === "") {
      re.lastIndex++;
      continue;
    }
    out.push({ start: m.index, end: m.index + m[0].length });
  }
  return out;
}
