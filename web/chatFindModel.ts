import { MATCH_LIMIT, regexError } from "./findModel";

// Q2: 대화 안 찾기의 순수 계산. DOM 이 없어서 단위 시험(test/chatfind.test.ts)이 그대로 쓴다.
// 글을 블록(문단, 목록 항목, 코드 블록 단위) 하나씩 이어 붙인 문자열에서 일치를 찾는다.

export type ChatFindOptions = { caseSensitive: boolean; wholeWord: boolean; regexp: boolean };
export type TextMatch = { from: number; to: number };

const WORD_BEFORE = "(?<![\\p{L}\\p{N}_])";
const WORD_AFTER = "(?![\\p{L}\\p{N}_])";

// 틀린 정규식이면 regex 가 null 이고 error 에 브라우저 문구가 담긴다. 빈 질의는 둘 다 null.
export function buildPattern(query: string, options: ChatFindOptions): { regex: RegExp | null; error: string | null } {
  if (!query) return { regex: null, error: null };
  const error = options.regexp ? regexError(query) : null;
  if (error) return { regex: null, error };
  const body = options.regexp ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // \b 는 한글을 낱말 글자로 보지 않으므로 유니코드 글자와 숫자를 직접 가린다.
  const source = options.wholeWord ? `${WORD_BEFORE}(?:${body})${WORD_AFTER}` : body;
  return { regex: new RegExp(source, `gmu${options.caseSensitive ? "" : "i"}`), error: null };
}

// 일치가 limit 개를 넘으면 capped. 빈 일치(^ 만 있는 식 등)는 건너뛴다.
export function textMatches(text: string, regex: RegExp, limit = MATCH_LIMIT): { list: TextMatch[]; capped: boolean } {
  const list: TextMatch[] = [];
  regex.lastIndex = 0;
  for (let hit = regex.exec(text); hit; hit = regex.exec(text)) {
    if (hit[0].length === 0) {
      regex.lastIndex++;
      continue;
    }
    if (list.length >= limit) return { list, capped: true };
    list.push({ from: hit.index, to: hit.index + hit[0].length });
  }
  return { list, capped: false };
}

// 글자 시작 위치 목록(starts, 오름차순)에서 offset 이 속한 조각 번호. offset 이 조각 끝과 같으면 다음 조각이다.
export function partIndexAt(starts: number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (starts[mid] <= offset) low = mid;
    else high = mid - 1;
  }
  return low;
}

// 이동: 끝에서 다음은 처음으로, 처음에서 이전은 끝으로 돈다.
export function stepIndex(index: number, total: number, backwards: boolean): number {
  if (total === 0) return -1;
  if (index < 0) return backwards ? total - 1 : 0;
  return backwards ? (index - 1 + total) % total : (index + 1) % total;
}
