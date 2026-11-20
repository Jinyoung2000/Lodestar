export type Range = { start: number; end: number };
export type FuzzyScore = { score: number; labelMatch?: Range[]; descriptionMatch?: Range[] };
export type ScoreItem = { label: string; description?: string; path?: string };

const NO_SCORE: FuzzyScore = { score: 0 };
// 점수 구간: 경로 전체가 질의와 같음 > 이름 맨 앞 일치 > 이름 일치 > 경로에만 일치
const PATH_IDENTITY_SCORE = 1 << 18;
const LABEL_PREFIX_SCORE = 1 << 17;
const LABEL_SCORE = 1 << 16;

type QueryPiece = { original: string; pathNormalized: string; normalized: string; normalizedLowercase: string; expectContiguousMatch: boolean };
export type PreparedQuery = QueryPiece & { values?: QueryPiece[]; containsPathSeparator: boolean };

const isQuoted = (text: string) => text.startsWith('"') && text.endsWith('"');

function normalizePiece(text: string) {
  const pathNormalized = text.replace(/\\/g, "/");
  const normalized = pathNormalized.replace(/[*…\s"]/g, "").replace(/(?<=.)#$/, "");
  return { pathNormalized, normalized, normalizedLowercase: normalized.toLowerCase() };
}

// 공백으로 나눈 낱말은 모두 맞아야 하고, "따옴표" 안의 낱말은 이어서 맞아야 한다.
export function prepareQuery(original: string): PreparedQuery {
  const { pathNormalized, normalized, normalizedLowercase } = normalizePiece(original);
  const words = original.split(" ");
  let values: QueryPiece[] | undefined;
  if (words.length > 1) {
    for (const word of words) {
      const piece = normalizePiece(word);
      if (!piece.normalized) continue;
      (values ??= []).push({ original: word, ...piece, expectContiguousMatch: isQuoted(word) });
    }
  }
  return { original, pathNormalized, normalized, normalizedLowercase, values, containsPathSeparator: pathNormalized.includes("/"), expectContiguousMatch: isQuoted(original) };
}

// 글자 하나가 맞을 때의 점수: 기본 1, 앞 글자와 이어 맞으면 가산(3글자까지 6점씩, 그 뒤 3점씩), 대소문자까지 같으면 1, 이름 맨 앞이면 8, 구분자 바로 뒤면 4~5, 대문자 시작이면 2
function charScore(queryChar: string, queryLowerChar: string, target: string, targetLower: string, index: number, sequence: number) {
  const lower = targetLower[index];
  if (queryLowerChar !== lower && !((queryLowerChar === "/" || queryLowerChar === "\\") && (lower === "/" || lower === "\\"))) return 0;
  let score = 1;
  if (sequence > 0) score += Math.min(sequence, 3) * 6 + Math.max(0, sequence - 3) * 3;
  if (queryChar === target[index]) score += 1;
  if (index === 0) return score + 8;
  const separator = separatorScore(target.charCodeAt(index - 1));
  if (separator) return score + separator;
  const code = target.charCodeAt(index);
  if (sequence === 0 && code >= 65 && code <= 90) score += 2;
  return score;
}

function separatorScore(code: number) {
  switch (code) {
    case 47:
    case 92:
      return 5;
    case 95:
    case 45:
    case 46:
    case 32:
    case 39:
    case 34:
    case 58:
      return 4;
    default:
      return 0;
  }
}

// 행렬이 질의 길이 x 대상 길이라 한 번에 크게 만들어 두고 다시 쓴다(입력마다 수천 번 부른다).
let scoreBuffer = new Int32Array(4096);
let runBuffer = new Int32Array(4096);

function scoreFuzzy(target: string, query: string, queryLower: string, allowNonContiguous: boolean): [number, number[]] {
  const targetLength = target.length;
  const queryLength = query.length;
  if (!target || !query || targetLength < queryLength) return [0, []];
  const size = queryLength * targetLength;
  if (size > scoreBuffer.length) {
    scoreBuffer = new Int32Array(size * 2);
    runBuffer = new Int32Array(size * 2);
  }
  const targetLower = target.toLowerCase();
  for (let q = 0; q < queryLength; q++) {
    const rowStart = q * targetLength;
    const previousRow = rowStart - targetLength;
    const queryChar = query[q];
    const queryLowerChar = queryLower[q];
    for (let t = 0; t < targetLength; t++) {
      const current = rowStart + t;
      const leftScore = t > 0 ? scoreBuffer[current - 1] : 0;
      const diagonalScore = q > 0 && t > 0 ? scoreBuffer[previousRow + t - 1] : 0;
      const sequence = q > 0 && t > 0 ? runBuffer[previousRow + t - 1] : 0;
      const score = !diagonalScore && q > 0 ? 0 : charScore(queryChar, queryLowerChar, target, targetLower, t, sequence);
      if (score && diagonalScore + score >= leftScore && (allowNonContiguous || q > 0 || targetLower.startsWith(queryLower, t))) {
        runBuffer[current] = sequence + 1;
        scoreBuffer[current] = diagonalScore + score;
      } else {
        runBuffer[current] = 0;
        scoreBuffer[current] = leftScore;
      }
    }
  }
  const positions: number[] = [];
  let q = queryLength - 1;
  let t = targetLength - 1;
  while (q >= 0 && t >= 0) {
    if (runBuffer[q * targetLength + t] !== 0) {
      positions.push(t);
      q--;
    }
    t--;
  }
  return [scoreBuffer[size - 1], positions.reverse()];
}

function toRanges(positions: number[]): Range[] {
  const ranges: Range[] = [];
  let last: Range | undefined;
  for (const position of positions) {
    if (last && last.end === position) last.end += 1;
    else ranges.push((last = { start: position, end: position + 1 }));
  }
  return ranges;
}

function mergeRanges(ranges: Range[]): Range[] {
  const merged: Range[] = [];
  let last: Range | undefined;
  for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
    if (last && !(last.end < range.start || range.end < last.start)) {
      last.start = Math.min(last.start, range.start);
      last.end = Math.max(last.end, range.end);
    } else {
      last = { ...range };
      merged.push(last);
    }
  }
  return merged;
}

function scoreSingle(item: ScoreItem, piece: QueryPiece, preferLabel: boolean, allowNonContiguous: boolean): FuzzyScore {
  const { label, description, path } = item;
  const fuzzy = allowNonContiguous && !piece.expectContiguousMatch;
  if (preferLabel || !description) {
    const [raw, positions] = scoreFuzzy(label, piece.normalized, piece.normalizedLowercase, fuzzy);
    if (raw) {
      const isPrefix = label.length >= piece.normalized.length && label.toLowerCase().startsWith(piece.normalizedLowercase);
      const base = isPrefix ? LABEL_PREFIX_SCORE + Math.round((piece.normalized.length / label.length) * 100) : LABEL_SCORE;
      return { score: base + raw, labelMatch: isPrefix ? (piece.normalized ? [{ start: 0, end: piece.normalized.length }] : []) : toRanges(positions) };
    }
  }
  if (description) {
    const prefix = path ? `${description}/` : description;
    const [raw, positions] = scoreFuzzy(`${prefix}${label}`, piece.normalized, piece.normalizedLowercase, fuzzy);
    if (raw) {
      const labelMatch: Range[] = [];
      const descriptionMatch: Range[] = [];
      for (const range of toRanges(positions)) {
        if (range.start < prefix.length && range.end > prefix.length) {
          labelMatch.push({ start: 0, end: range.end - prefix.length });
          descriptionMatch.push({ start: range.start, end: prefix.length });
        } else if (range.start >= prefix.length) {
          labelMatch.push({ start: range.start - prefix.length, end: range.end - prefix.length });
        } else {
          descriptionMatch.push(range);
        }
      }
      return { score: raw, labelMatch, descriptionMatch };
    }
  }
  return NO_SCORE;
}

// 파일 하나의 점수. 0 이면 맞지 않는다. 경로에 "/" 가 있는 질의는 이름 우선을 끄고 경로 전체에서 찾는다.
export function scoreFileItem(item: ScoreItem, query: PreparedQuery, allowNonContiguous: boolean): FuzzyScore {
  if (!query.normalized) return NO_SCORE;
  const preferLabel = !item.path || !query.containsPathSeparator;
  if (item.path && item.path.toLowerCase() === query.pathNormalized.toLowerCase()) {
    return { score: PATH_IDENTITY_SCORE, labelMatch: [{ start: 0, end: item.label.length }], descriptionMatch: item.description ? [{ start: 0, end: item.description.length }] : undefined };
  }
  if (query.values && query.values.length > 1) {
    let score = 0;
    const labelMatch: Range[] = [];
    const descriptionMatch: Range[] = [];
    for (const piece of query.values) {
      const result = scoreSingle(item, piece, preferLabel, allowNonContiguous);
      if (!result.score) return NO_SCORE;
      score += result.score;
      if (result.labelMatch) labelMatch.push(...result.labelMatch);
      if (result.descriptionMatch) descriptionMatch.push(...result.descriptionMatch);
    }
    return { score, labelMatch: mergeRanges(labelMatch), descriptionMatch: mergeRanges(descriptionMatch) };
  }
  return scoreSingle(item, query, preferLabel, allowNonContiguous);
}

export type Scored<T extends ScoreItem> = { item: T; match: FuzzyScore };

// 정렬 규칙(compareItemsByFuzzyScore): 경로 전체 일치 > 점수 > 이름에 맞은 것 > 맞은 구간이 짧은 것 > 짧은 이름과 경로 > 가나다순
export function compareScored<T extends ScoreItem>(a: Scored<T>, b: Scored<T>, query: PreparedQuery): number {
  const scoreA = a.match.score;
  const scoreB = b.match.score;
  if ((scoreA === PATH_IDENTITY_SCORE || scoreB === PATH_IDENTITY_SCORE) && scoreA !== scoreB) return scoreA === PATH_IDENTITY_SCORE ? -1 : 1;
  if (scoreA > LABEL_SCORE || scoreB > LABEL_SCORE) {
    if (scoreA !== scoreB) return scoreA > scoreB ? -1 : 1;
    if (scoreA < LABEL_PREFIX_SCORE && scoreB < LABEL_PREFIX_SCORE) {
      const bySpan = compareSpan(a.match.labelMatch, b.match.labelMatch);
      if (bySpan !== 0) return bySpan;
    }
    if (a.item.label.length !== b.item.label.length) return a.item.label.length - b.item.label.length;
  }
  if (scoreA !== scoreB) return scoreA > scoreB ? -1 : 1;
  const hasLabelA = !!a.match.labelMatch?.length;
  const hasLabelB = !!b.match.labelMatch?.length;
  if (hasLabelA && !hasLabelB) return -1;
  if (hasLabelB && !hasLabelA) return 1;
  const distanceA = matchDistance(a);
  const distanceB = matchDistance(b);
  if (distanceA && distanceB && distanceA !== distanceB) return distanceB > distanceA ? -1 : 1;
  return compareByLength(a.item, b.item, query);
}

function compareSpan(a: Range[] | undefined, b: Range[] | undefined) {
  if (!a?.length && !b?.length) return 0;
  if (!b?.length) return -1;
  if (!a?.length) return 1;
  const spanA = a[a.length - 1].end - a[0].start;
  const spanB = b[b.length - 1].end - b[0].start;
  return spanA === spanB ? 0 : spanB < spanA ? 1 : -1;
}

function matchDistance({ item, match }: Scored<ScoreItem>) {
  let start = -1;
  let end = -1;
  if (match.descriptionMatch?.length) start = match.descriptionMatch[0].start;
  else if (match.labelMatch?.length) start = match.labelMatch[0].start;
  if (match.labelMatch?.length) {
    end = match.labelMatch[match.labelMatch.length - 1].end;
    if (match.descriptionMatch?.length && item.description) end += item.description.length;
  } else if (match.descriptionMatch?.length) {
    end = match.descriptionMatch[match.descriptionMatch.length - 1].end;
  }
  return end - start;
}

function compareByLength(a: ScoreItem, b: ScoreItem, query: PreparedQuery) {
  const lengthA = a.label.length + (a.description?.length ?? 0);
  const lengthB = b.label.length + (b.description?.length ?? 0);
  if (lengthA !== lengthB) return lengthA - lengthB;
  if (a.path && b.path && a.path.length !== b.path.length) return a.path.length - b.path.length;
  if (a.label !== b.label) return compareText(a.label, b.label, query.normalized);
  if (a.description && b.description && a.description !== b.description) return compareText(a.description, b.description, query.normalized);
  if (a.path && b.path && a.path !== b.path) return compareText(a.path, b.path, query.normalized);
  return 0;
}

// 질의로 시작하는 쪽, 질의로 끝나는 쪽을 먼저 두고 나머지는 글자 순서
function compareText(a: string, b: string, lookFor: string) {
  const lowerA = a.toLowerCase();
  const lowerB = b.toLowerCase();
  const needle = lookFor.toLowerCase();
  const startsA = lowerA.startsWith(needle);
  const startsB = lowerB.startsWith(needle);
  if (startsA !== startsB) return startsA ? -1 : 1;
  if (startsA && startsB && lowerA.length !== lowerB.length) return lowerA.length - lowerB.length;
  const endsA = lowerA.endsWith(needle);
  const endsB = lowerB.endsWith(needle);
  if (endsA !== endsB) return endsA ? -1 : 1;
  // localeCompare 는 동점이 많은 큰 목록에서 느려 글자 코드 순서로 비교한다
  if (lowerA !== lowerB) return lowerA < lowerB ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

// 점수를 매기기 전에 거르는 빠른 검사: 낱말마다 글자가 순서대로(따옴표 낱말은 이어서) 들어 있어야 후보다.
export function mightMatch(lowerPath: string, query: PreparedQuery) {
  const pieces = query.values && query.values.length > 1 ? query.values : [query];
  for (const piece of pieces) {
    const needle = piece.normalizedLowercase;
    if (!needle) continue;
    if (piece.expectContiguousMatch) {
      if (!lowerPath.includes(needle)) return false;
      continue;
    }
    let at = 0;
    for (let i = 0; i < lowerPath.length && at < needle.length; i++) if (lowerPath.charCodeAt(i) === needle.charCodeAt(at)) at++;
    if (at < needle.length) return false;
  }
  return true;
}
