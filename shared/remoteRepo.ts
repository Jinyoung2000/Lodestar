// 도구 입력 글에서 GitHub 저장소 파일 참조를 뽑는다. `gh api repos/OWNER/REPO/contents/PATH` 와 github.com/OWNER/REPO/(blob|tree)/REF/PATH 를 읽는다.
// 서버(server/repoMirror.ts, 자주 읽는 저장소를 클론)와 화면(web/fileRefOutside.ts, 링크를 그 저장소로 푼다)이 같은 규칙을 쓴다. path 는 끝 / 를 뗀 저장소 안 경로이고 없으면 "".
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
