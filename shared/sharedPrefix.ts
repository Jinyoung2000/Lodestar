// 두 배열이 앞에서부터 같은 항목(참조)으로 이어지는 개수. 타임라인 갱신은 항목 하나를 바꾸거나 붙이므로, 지난 배열과 비교해 바뀐 곳을 찾는 데 쓴다(PERF2).
export function sharedPrefix(a: readonly unknown[], b: readonly unknown[]): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}
