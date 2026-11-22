export function displayPath(path: string) {
  return path.replace(/^\/private(?=\/(?:tmp|var)(?:\/|$))/, "").replace(/^\/Users\/[^/]+(?=\/|$)/, "~");
}
