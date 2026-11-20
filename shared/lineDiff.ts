// 줄 단위 추가/삭제 수. 앞뒤 공통 줄을 걷어 낸 가운데를 Myers 로 센다. git diff --numstat 과 같은 값이다.
export function countLineChanges(before: string, after: string) {
  const a = splitLines(before);
  const b = splitLines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const m = endA - start;
  const n = endB - start;
  if (m === 0 || n === 0) return { additions: n, deletions: m };
  const distance = editDistance(a, b, start, endA, endB);
  if (distance === null) return { additions: n, deletions: m };
  return { additions: (distance + n - m) / 2, deletions: (distance - n + m) / 2 };
}

// Myers O(ND): 추가 + 삭제 줄 수의 최솟값(D). 경로는 필요 없어 V 배열 하나만 쓴다. git diff 의 줄 수도 같은 최솟값이다.
// 거의 전부 다른 파일(D 가 한계를 넘음)은 null 을 돌려 호출자가 전부 바뀐 것으로 세게 한다.
const MAX_EDIT_DISTANCE = 20_000;

function editDistance(a: string[], b: string[], start: number, endA: number, endB: number) {
  const m = endA - start;
  const n = endB - start;
  const max = Math.min(m + n, MAX_EDIT_DISTANCE);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  for (let d = 0; d <= max; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < m && y < n && a[start + x] === b[start + y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= m && y >= n) return d;
    }
  }
  return null;
}

// 줄 끝 개행이 없는 마지막 줄은 개행이 있는 같은 줄과 다른 줄로 센다(git 이 "\ No newline at end of file" 로 구분하는 것과 같다).
function splitLines(text: string) {
  if (!text) return [];
  const lines = text.split("\n");
  const last = lines.pop() as string;
  if (last !== "") lines.push(`${last}\0noeol`);
  return lines;
}
