export type WhitespaceMode = "none" | "boundary" | "selection" | "trailing" | "all";

// 한 줄 안의 선택 구간(줄 안 오프셋, 끝은 포함하지 않음)
export type LineSelection = { from: number; to: number };

// 점이나 화살표를 그릴 공백과 탭의 줄 안 오프셋.
// none 은 아무것도, all 은 모든 공백과 탭, boundary 는 줄 앞뒤 공백과 탭 그리고 공백이 이어진 곳(단어 사이 한 칸은 제외),
// trailing 은 줄 끝 공백과 탭(줄 전체가 공백이면 전부), selection 은 선택 구간 안의 공백과 탭만이다.
export function whitespaceOffsets(text: string, mode: WhitespaceMode, selections: readonly LineSelection[] | null): number[] {
  if (mode === "none") return [];
  if (mode === "selection" && (!selections || selections.length === 0)) return [];
  const length = text.length;
  let firstNonSpace = indexOfFirstNonSpace(text);
  let lastNonSpace: number;
  let allSpace = false;
  if (firstNonSpace === -1) {
    allSpace = true;
    firstNonSpace = length;
    lastNonSpace = length;
  } else {
    lastNonSpace = indexOfLastNonSpace(text);
  }
  const offsets: number[] = [];
  let selectionIndex = 0;
  let current = selections?.[0];
  for (let i = 0; i < length; i++) {
    const code = text.charCodeAt(i);
    while (current && current.to <= i) current = selections?.[++selectionIndex];
    if (code !== 9 && code !== 32) continue;
    if (mode === "trailing" && !allSpace && i <= lastNonSpace) continue;
    if (mode === "boundary" && i >= firstNonSpace && i <= lastNonSpace && code === 32) {
      const before = i - 1 >= 0 ? text.charCodeAt(i - 1) : 0;
      const after = i + 1 < length ? text.charCodeAt(i + 1) : 0;
      if (before !== 32 && after !== 32) continue;
    }
    if (mode === "selection" && !(current && current.from <= i && i < current.to)) continue;
    offsets.push(i);
  }
  return offsets;
}

// 공백과 탭이 아닌 첫 글자와 마지막 글자의 오프셋. 공백뿐이면 -1.
function indexOfFirstNonSpace(text: string): number {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code !== 32 && code !== 9) return i;
  }
  return -1;
}

function indexOfLastNonSpace(text: string): number {
  for (let i = text.length - 1; i >= 0; i--) {
    const code = text.charCodeAt(i);
    if (code !== 32 && code !== 9) return i;
  }
  return -1;
}

// 연속한 오프셋을 같은 종류끼리 한 구간으로 묶는다(공백 구간과 탭 구간). 장식 수를 줄이려는 용도.
export type WhitespaceRun = { from: number; to: number; tab: boolean };

export function whitespaceRuns(text: string, offsets: readonly number[]): WhitespaceRun[] {
  const runs: WhitespaceRun[] = [];
  for (const offset of offsets) {
    const tab = text.charCodeAt(offset) === 9;
    const last = runs[runs.length - 1];
    if (last && last.to === offset && last.tab === tab && !tab) last.to = offset + 1;
    else runs.push({ from: offset, to: offset + 1, tab });
  }
  return runs;
}
