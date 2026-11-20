// 본문 검색 결과 표시에 쓰는 순수 함수. DOM 을 건드리지 않아 단위 시험이 그대로 부른다.

// 검색어를 일치 표시용 RegExp 로. 정규식이 아니면 글자 그대로, 낱말 단위면 \b 로 감싼다. 정규식이 잘못됐으면 null(표시만 생략한다).
export function highlightPattern(query: string, options: { matchCase: boolean; wholeWord: boolean; regex: boolean }): RegExp | null {
  if (!query) return null;
  const body = options.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  try {
    return new RegExp(options.wholeWord ? `\\b(?:${body})\\b` : body, options.matchCase ? "g" : "gi");
  } catch {
    return null;
  }
}

// 줄에서 첫 일치의 열(1부터). 모르면 1.
export function matchColumn(text: string, pattern: RegExp | null): number {
  if (!pattern) return 1;
  pattern.lastIndex = 0;
  const m = pattern.exec(text);
  pattern.lastIndex = 0;
  return m && m[0] !== "" ? m.index + 1 : 1;
}

export function searchSummary(matches: number, files: number, truncated: boolean): string {
  const text = `${matches === 1 ? "1 result" : `${matches} results`} - ${files === 1 ? "1 file" : `${files} files`}`;
  return truncated ? `${text} (showing the first matches)` : text;
}
