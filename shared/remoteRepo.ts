const REMOTE = /(?:repos\/([\w.-]+)\/([\w.-]+)\/contents\/?|github\.com\/([\w.-]+)\/([\w.-]+)\/(?:blob|tree)\/[^/\s'"`]+\/)([^\s'"`?#;|&<>()\\]*)/g;

export type RemoteRepoRef = { repo: string; path: string };

export function remoteRepoRefs(text: string): RemoteRepoRef[] {
  const out: RemoteRepoRef[] = [];
  for (const match of text.matchAll(REMOTE)) {
    const repo = `${match[1] ?? match[3]}/${(match[2] ?? match[4]).replace(/\.git$/, "")}`;
    out.push({ repo, path: match[5].replace(/\/+$/, "") });
  }
  return out;
}
