// 대화 속 상대 경로가 작업 폴더에 없을 때, 같은 대화의 도구 호출이 만진 다른 폴더 기준으로 찾을 후보를 만든다. 순수 함수(test/filerefresolve.test.ts).
// 예: app 레포 세션이 `cd /Users/me/Repository/app-client/app-webview/src && cat ...` 를 돌린 뒤 글에 app-webview/src/a.ts 라고 쓰면,
// 그 폴더의 app-webview 앞부분(/Users/me/Repository/app-client)을 기준으로 /Users/me/Repository/app-client/app-webview/src/a.ts 를 후보로 낸다.
import { remoteRepoRefs } from "../shared/remoteRepo";
import { elidedParts, matchesElided } from "./fileRefResolve";

// 도구 입력 글에서 홈과 /tmp 아래 절대 경로를 뽑는다. 따옴표, 공백, 셸 기호에서 끊는다.
const ABSOLUTE = /(?:^|[\s'"`=(:,[{])((?:\/Users|\/home|\/private\/tmp|\/tmp)\/[^\s'"`;|&<>()[\]{},*?$]+)/g;

const MAX_CANDIDATES = 12;

// rel 은 normalizeRelative 를 거친 상대 경로, inputs 는 최근 호출이 앞에 오는 도구 입력 글들, workspaceDir 는 세션 작업 폴더.
// 순서: 도구가 직접 만진 파일 중 rel 로 끝나는 것, 만진 경로 안에서 rel 의 첫 폴더 이름이 나오는 자리, 만진 폴더 바로 아래.
export function outsideCandidates(rel: string, inputs: readonly string[], workspaceDir: string): string[] {
  if (!rel || rel.startsWith("../")) return [];
  const parts = rel.split("/");
  const first = parts[0];
  // 가운데를 줄인 경로(a/.../b.kt)는 도구가 직접 만진 파일 중 앞뒤가 맞는 것만 후보로 낸다.
  const elided = elidedParts(rel);
  const direct: string[] = [];
  const anchored: string[] = [];
  const under: string[] = [];
  for (const input of inputs) {
    for (const match of input.matchAll(ABSOLUTE)) {
      const absolute = match[1].replace(/[.:]+$/, "").replace(/\/+$/, "");
      if (!absolute || (workspaceDir && (absolute === workspaceDir || absolute.startsWith(`${workspaceDir}/`)))) continue;
      if (elided) {
        if (matchesElided(absolute, elided)) push(direct, absolute);
        continue;
      }
      if (absolute.endsWith(`/${rel}`)) push(direct, absolute);
      const segments = absolute.split("/");
      if (parts.length > 1) {
        // 마지막에서 가까운 자리부터. 파일 경로의 마지막 조각(파일 이름)은 폴더 이름과 맞춰 보지 않는다.
        for (let i = segments.length - 2; i > 1; i -= 1) {
          if (segments[i] === first) push(anchored, `${segments.slice(0, i).join("/")}/${rel}`);
        }
      }
      // 파일 이름처럼 보이면(마지막 조각에 점) 그 폴더를, 아니면 그 경로 자체를 폴더로 본다.
      const last = segments.at(-1) ?? "";
      const dir = /\.[A-Za-z0-9]+$/.test(last) ? segments.slice(0, -1).join("/") : absolute;
      if (dir.split("/").length > 3) push(under, `${dir}/${rel}`);
    }
  }
  const out: string[] = [];
  for (const candidate of [...direct, ...anchored, ...under]) {
    push(out, candidate);
    if (out.length >= MAX_CANDIDATES) break;
  }
  return out;
}

function push(list: string[], value: string) {
  if (!list.includes(value)) list.push(value);
}

// 디스크 어디에도 없는 상대 경로가 대화가 gh api 나 GitHub 주소로 읽은 원격 저장소의 파일이면 그 저장소와 GitHub 주소를 돌려준다.
// 예: `gh api repos/example-org/app/contents/internal/helper/url` 로 읽은 뒤 글에 internal/helper/url/url.go 라고 쓰면
// repo 는 example-org/app, url 은 https://github.com/example-org/app/blob/HEAD/internal/helper/url/url.go 다.
// 그 저장소의 로컬 클론(server/repoMirror.ts)이 있으면 화면은 클론의 파일을 먼저 연다(web/fileRefMark.ts).
// 순서: 읽은 경로가 rel 과 같거나 rel 의 상위 폴더인 것, 다음은 첫 폴더 이름이 같은 것. 둘 다 없으면 null(엉뚱한 저장소로 보내지 않게).
export function remoteFile(rel: string, inputs: readonly string[], line?: number): { repo: string; url: string } | null {
  if (!rel || rel.startsWith("../") || rel.startsWith("/")) return null;
  const first = rel.split("/")[0];
  let exact: string | null = null;
  let loose: string | null = null;
  for (const input of inputs) {
    for (const { repo, path } of remoteRepoRefs(input)) {
      if (!exact && (path === rel || (path && rel.startsWith(`${path}/`)))) exact = repo;
      if (!loose && path.split("/")[0] === first) loose = repo;
    }
    if (exact) break;
  }
  const repo = exact ?? loose;
  return repo ? { repo, url: `https://github.com/${repo}/blob/HEAD/${rel}${line ? `#L${line}` : ""}` } : null;
}

