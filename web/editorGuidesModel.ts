// 줄마다 들여쓰기 칸 수를 돌려주는 원본. 공백뿐인 줄은 -1 이다. 줄 번호는 0부터.
export type IndentSource = { lineCount: number; indentOf: (lineIndex: number) => number };

// 앞쪽 공백과 탭으로 잰 들여쓰기 칸 수. 탭은 다음 탭 칸까지 올린다. 공백뿐이거나 빈 줄은 -1.
export function indentColumns(text: string, tabSize: number): number {
  let columns = 0;
  let i = 0;
  for (; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 32) columns++;
    else if (code === 9) columns = columns - (columns % tabSize) + tabSize;
    else break;
  }
  return i === text.length ? -1 : columns;
}

// 빈 줄의 단 수: 위아래 가장 가까운 비어 있지 않은 줄의 들여쓰기에서 정한다.
// offSide 언어(python, yaml 등)는 아래 줄을 따른다.
export function whitespaceLineLevel(offSide: boolean, above: number, below: number, indentSize: number): number {
  if (above === -1 || below === -1) return 0;
  if (above < below) return 1 + Math.floor(above / indentSize);
  if (above === below || offSide) return Math.ceil(below / indentSize);
  return 1 + Math.floor(below / indentSize);
}

// firstLine..lastLine(1부터, 양 끝 포함) 줄마다 그릴 안내선 수
export function guideCounts(source: IndentSource, firstLine: number, lastLine: number, indentSize: number, offSide: boolean): number[] {
  const counts: number[] = [];
  let prevIndent = -1;
  let prevLine = -2;
  let nextIndent = -1;
  let nextLine = -2;
  for (let line = firstLine; line <= lastLine; line++) {
    const indent = source.indentOf(line - 1);
    if (indent >= 0) {
      prevLine = line - 1;
      prevIndent = indent;
      counts.push(Math.ceil(indent / indentSize));
      continue;
    }
    if (prevLine === -2) {
      prevLine = -1;
      prevIndent = -1;
      for (let i = line - 2; i >= 0; i--) {
        const found = source.indentOf(i);
        if (found >= 0) {
          prevLine = i;
          prevIndent = found;
          break;
        }
      }
    }
    if (nextLine !== -1 && (nextLine === -2 || nextLine < line - 1)) {
      nextLine = -1;
      nextIndent = -1;
      for (let i = line; i < source.lineCount; i++) {
        const found = source.indentOf(i);
        if (found >= 0) {
          nextLine = i;
          nextIndent = found;
          break;
        }
      }
    }
    counts.push(whitespaceLineLevel(offSide, prevIndent, nextIndent, indentSize));
  }
  return counts;
}

// 커서가 있는 줄이 속한 들여쓰기 블록: 줄 범위와 그 블록의 단 번호(1부터). indent 가 0 이면 활성 안내선이 없다.
export type ActiveGuide = { startLine: number; endLine: number; indent: number };

export function activeGuide(source: IndentSource, line: number, minLine: number, maxLine: number, indentSize: number, offSide: boolean): ActiveGuide {
  const lineCount = source.lineCount;
  // 위쪽 줄 기준으로 가까운 비어 있지 않은 줄을 찾는 캐시: 위로, 아래로
  let aboveOfUp = -2;
  let aboveIndentOfUp = -1;
  let belowOfUp = -2;
  let belowIndentOfUp = -1;
  const scanUp = (at: number) => {
    if (aboveOfUp !== -1 && (aboveOfUp === -2 || aboveOfUp > at - 1)) {
      aboveOfUp = -1;
      aboveIndentOfUp = -1;
      for (let i = at - 2; i >= 0; i--) {
        const found = source.indentOf(i);
        if (found >= 0) {
          aboveOfUp = i;
          aboveIndentOfUp = found;
          break;
        }
      }
    }
    if (belowOfUp === -2) {
      belowOfUp = -1;
      belowIndentOfUp = -1;
      for (let i = at; i < lineCount; i++) {
        const found = source.indentOf(i);
        if (found >= 0) {
          belowOfUp = i;
          belowIndentOfUp = found;
          break;
        }
      }
    }
  };
  let aboveOfDown = -2;
  let aboveIndentOfDown = -1;
  let belowOfDown = -2;
  let belowIndentOfDown = -1;
  const scanDown = (at: number) => {
    if (aboveOfDown === -2) {
      aboveOfDown = -1;
      aboveIndentOfDown = -1;
      for (let i = at - 2; i >= 0; i--) {
        const found = source.indentOf(i);
        if (found >= 0) {
          aboveOfDown = i;
          aboveIndentOfDown = found;
          break;
        }
      }
    }
    if (belowOfDown !== -1 && (belowOfDown === -2 || belowOfDown < at - 1)) {
      belowOfDown = -1;
      belowIndentOfDown = -1;
      for (let i = at; i < lineCount; i++) {
        const found = source.indentOf(i);
        if (found >= 0) {
          belowOfDown = i;
          belowIndentOfDown = found;
          break;
        }
      }
    }
  };

  let startLine = 0;
  let upActive = true;
  let endLine = 0;
  let downActive = true;
  let indent = 0;
  let own = 0;
  for (let step = 0; upActive || downActive; step++) {
    const up = line - step;
    const down = line + step;
    if (step > 1 && (up < 1 || up < minLine)) upActive = false;
    if (step > 1 && (down > lineCount || down > maxLine)) downActive = false;
    if (step > 5e4) {
      upActive = false;
      downActive = false;
    }
    let upLevel = -1;
    if (upActive && up >= 1) {
      const found = source.indentOf(up - 1);
      if (found >= 0) {
        belowOfUp = up - 1;
        belowIndentOfUp = found;
        upLevel = Math.ceil(found / indentSize);
      } else {
        scanUp(up);
        upLevel = whitespaceLineLevel(offSide, aboveIndentOfUp, belowIndentOfUp, indentSize);
      }
    }
    let downLevel = -1;
    if (downActive && down <= lineCount) {
      const found = source.indentOf(down - 1);
      if (found >= 0) {
        aboveOfDown = down - 1;
        aboveIndentOfDown = found;
        downLevel = Math.ceil(found / indentSize);
      } else {
        scanDown(down);
        downLevel = whitespaceLineLevel(offSide, aboveIndentOfDown, belowIndentOfDown, indentSize);
      }
    }
    if (step === 0) {
      own = upLevel;
      continue;
    }
    if (step === 1) {
      if (down <= lineCount && downLevel >= 0 && own + 1 === downLevel) {
        upActive = false;
        startLine = down;
        endLine = down;
        indent = downLevel;
        continue;
      }
      if (up >= 1 && upLevel >= 0 && upLevel - 1 === own) {
        downActive = false;
        startLine = up;
        endLine = up;
        indent = upLevel;
        continue;
      }
      startLine = line;
      endLine = line;
      indent = own;
      if (indent === 0) return { startLine, endLine, indent };
    }
    if (upActive) {
      if (upLevel >= indent) startLine = up;
      else upActive = false;
    }
    if (downActive) {
      if (downLevel >= indent) endLine = down;
      else downActive = false;
    }
  }
  return { startLine, endLine, indent };
}

const OFF_SIDE = new Set(["python", "yaml", "markdown", "sql", "clojure", "coffeescript", "fsharp", "pug"]);
export const isOffSideLanguage = (languageName: string | null) => languageName !== null && OFF_SIDE.has(languageName);
