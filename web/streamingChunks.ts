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

export function endsInsideFence(text: string): boolean {
  let fence: string | null = null;
  for (const line of text.split("\n")) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (!marker) continue;
    if (fence === null) fence = marker;
    else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
  }
  return fence !== null;
}
