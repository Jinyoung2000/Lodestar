// 응답 중인 글을 문단 조각으로 나눈다(web/Timeline.tsx StreamingMarkdown 이 굳은 조각은 다시 그리지 않으려고 쓴다, PERF2).
// 빈 줄에서 나누되, 펜스 코드 블록(``` 또는 ~~~) 안에서는 나누지 않는다. 조각을 다시 이으면 원래 글과 같다.
export function streamingChunks(text: string): string[] {
  const chunks: string[] = [];
  let fence: string | null = null;
  let start = 0;
  let at = 0;
  while (at < text.length) {
    const end = text.indexOf("\n", at);
    const lineEnd = end === -1 ? text.length : end;
    const line = text.slice(at, lineEnd);
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker && (fence === null || (marker[0] === fence[0] && marker.length >= fence.length))) fence = fence === null ? marker : null;
    else if (fence === null && line.trim() === "" && lineEnd > start && end !== -1 && at > start) {
      chunks.push(text.slice(start, lineEnd + 1));
      start = lineEnd + 1;
    }
    if (end === -1) break;
    at = end + 1;
  }
  if (start < text.length || !chunks.length) chunks.push(text.slice(start));
  return chunks;
}
