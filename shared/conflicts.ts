// FIX6B: 병합 충돌 마커(<<<<<<<, =======, >>>>>>>)를 읽고 한쪽으로 풀어 주는 순수 함수. 에디터 확장(web/conflictMarkers.ts)과 시험이 같이 쓴다.
// diff3 스타일(|||||||)도 읽는다. 베이스 구간은 어느 선택에도 들어가지 않는다.

export type ConflictBlock = {
  // 0부터 세는 줄 번호. start 는 <<<<<<<, base 는 |||||||(없으면 -1), mid 는 =======, end 는 >>>>>>> 줄
  start: number;
  base: number;
  mid: number;
  end: number;
  currentLabel: string;
  incomingLabel: string;
  current: string[];
  incoming: string[];
};

export type ConflictChoice = "current" | "incoming" | "both";

const START = /^<{7}(?: (.*?))?\r?$/;
const BASE = /^\|{7}(?: .*?)?\r?$/;
const MID = /^={7}\r?$/;
const END = /^>{7}(?: (.*?))?\r?$/;

export function parseConflicts(lines: readonly string[]): ConflictBlock[] {
  const blocks: ConflictBlock[] = [];
  let start = -1;
  let base = -1;
  let mid = -1;
  let currentLabel = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const opened = START.exec(line);
    if (opened) {
      // 닫히지 않은 앞 블록은 버리고 여기서 다시 시작한다
      start = i;
      base = -1;
      mid = -1;
      currentLabel = opened[1] ?? "";
      continue;
    }
    if (start < 0) continue;
    if (mid < 0 && base < 0 && BASE.test(line)) base = i;
    else if (mid < 0 && MID.test(line)) mid = i;
    else if (mid >= 0) {
      const closed = END.exec(line);
      if (!closed) continue;
      blocks.push({
        start,
        base,
        mid,
        end: i,
        currentLabel,
        incomingLabel: closed[1] ?? "",
        current: lines.slice(start + 1, base >= 0 ? base : mid),
        incoming: lines.slice(mid + 1, i),
      });
      start = -1;
      base = -1;
      mid = -1;
    }
  }
  return blocks;
}

export function replacementFor(block: ConflictBlock, choice: ConflictChoice): string[] {
  if (choice === "current") return block.current;
  if (choice === "incoming") return block.incoming;
  return [...block.current, ...block.incoming];
}

// text 의 index 번째 충돌을 choice 로 푼 글. 줄바꿈은 \n 으로 나누고 \r 는 줄 안에 남긴다(CRLF 파일도 그대로 이어진다).
export function resolveConflict(text: string, index: number, choice: ConflictChoice): string {
  const lines = text.split("\n");
  const block = parseConflicts(lines)[index];
  if (!block) return text;
  lines.splice(block.start, block.end - block.start + 1, ...replacementFor(block, choice));
  return lines.join("\n");
}

export function resolveAllConflicts(text: string, choice: ConflictChoice): string {
  const lines = text.split("\n");
  const blocks = parseConflicts(lines);
  for (const block of [...blocks].reverse()) lines.splice(block.start, block.end - block.start + 1, ...replacementFor(block, choice));
  return lines.join("\n");
}

export const hasConflictMarkers = (text: string) => text.includes("<<<<<<<") && parseConflicts(text.split("\n")).length > 0;
