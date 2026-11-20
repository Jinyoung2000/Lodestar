// RELEASE: 이 앱의 GitHub 저장소와 그 위에서 하는 두 가지(피드백을 issue 로 보고, 새 릴리스 확인)에 쓰는 순수 함수.
// 저장소 주소는 이 상수 하나만 쓴다. package.json 의 repository 와 같아야 한다.
export const LODESTAR_REPOSITORY = "Jinyoung2000/Lodestar";
export const LODESTAR_REPOSITORY_URL = `https://github.com/${LODESTAR_REPOSITORY}`;
export const NEW_ISSUE_URL = `${LODESTAR_REPOSITORY_URL}/issues/new`;
export const LATEST_RELEASE_API = `https://api.github.com/repos/${LODESTAR_REPOSITORY}/releases/latest`;

// 브라우저와 GitHub 가 받는 주소 길이에 여유를 둔 한도. 넘치면 본문 끝을 자르고 잘랐다고 적는다.
export const ISSUE_URL_LIMIT = 7000;
const TITLE_LIMIT = 200;
export const ISSUE_BODY_CUT_NOTE = "(Shortened to fit the link.)";

// 데몬이 알고 있는 버전 정보. latest 는 마지막으로 확인한 정식 릴리스(새 버전이 아니어도 적는다), dismissed 는 사이드바 줄을 닫은 버전.
export type ReleaseState = {
  installed: string;
  macos: string | null;
  latest: { version: string; url: string } | null;
  dismissed: string | null;
};

// "v0.10.0", "0.9.2" 를 숫자 배열로. 앞의 v 하나만 허락하고, 시험판(-beta 등)이나 숫자가 아닌 조각이 있으면 null.
export function parseVersion(text: string): number[] | null {
  const match = /^v?(\d+(?:\.\d+)*)$/.exec(text.trim());
  if (!match) return null;
  const parts = match[1].split(".").map(Number);
  return parts.every((n) => Number.isSafeInteger(n)) ? parts : null;
}

// tag 가 지금 버전보다 새 버전인지. 둘 중 하나라도 읽을 수 없으면 새 버전이 아니다. 빠진 자리는 0 으로 본다(1.2 와 1.2.0 은 같다).
export function isNewerVersion(tag: string, current: string): boolean {
  const next = parseVersion(tag);
  const now = parseVersion(current);
  if (!next || !now) return false;
  for (let i = 0; i < Math.max(next.length, now.length); i++) {
    const a = next[i] ?? 0;
    const b = now[i] ?? 0;
    if (a !== b) return a > b;
  }
  return false;
}

// GitHub releases/latest 답에서 버전과 릴리스 노트 주소를 꺼낸다. 시험판, 초안, 읽을 수 없는 태그는 null.
// 릴리스 노트 주소는 답의 html_url 을 믿지 않고 이 저장소 주소와 태그로 만든다.
export function releaseFromApi(value: unknown): { version: string; url: string } | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as { tag_name?: unknown; draft?: unknown; prerelease?: unknown };
  if (typeof raw.tag_name !== "string" || raw.draft === true || raw.prerelease === true) return null;
  const tag = raw.tag_name.trim();
  if (!parseVersion(tag)) return null;
  return { version: tag.replace(/^v/, ""), url: `${LODESTAR_REPOSITORY_URL}/releases/tag/${encodeURIComponent(tag)}` };
}

// 새 issue 화면 주소. 제목과 본문(사용자 글 + 덧붙임)은 쿼리로 넘긴다. 주소가 한도를 넘으면 사용자 글 끝을 잘라 맞추고 잘랐다고 적는다.
// 덧붙임(버전, 요소와 파일 경로)은 자르지 않는다.
export function newIssueUrl(title: string, text: string, footer = "", limit = ISSUE_URL_LIMIT): string {
  const head = `${NEW_ISSUE_URL}?title=${encodeURIComponent([...title.trim()].slice(0, TITLE_LIMIT).join(""))}&body=`;
  const full = encodeURIComponent(text + footer);
  if (head.length + full.length <= limit) return head + full;
  const chars = [...text];
  const bodyOf = (n: number) => `${chars.slice(0, n).join("").trimEnd()}\n\n${ISSUE_BODY_CUT_NOTE}${footer}`;
  const fits = (n: number) => head.length + encodeURIComponent(bodyOf(n)).length <= limit;
  // 들어가는 가장 긴 앞부분을 찾는다(글자마다 인코딩 길이가 달라 이분 탐색)
  let low = 0;
  let high = chars.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits(mid)) low = mid;
    else high = mid - 1;
  }
  return head + encodeURIComponent(bodyOf(low));
}

// 사이드바에 알릴 새 버전. 최신 릴리스가 설치된 것보다 새것이고 그 버전을 닫지 않았을 때만.
export function releaseToNotify(state: ReleaseState | null): { version: string; url: string } | null {
  const latest = state?.latest;
  if (!state || !latest || !isNewerVersion(latest.version, state.installed) || state.dismissed === latest.version) return null;
  return latest;
}

// 피드백 첫 줄로 issue 제목 초안을 만든다. 길면 단어 경계에서 자른다.
export function issueTitleFrom(text: string): string {
  const line = text.trim().split("\n")[0].replace(/\s+/g, " ").trim();
  if (line.length <= 80) return line;
  const cut = line.slice(0, 80);
  const space = cut.lastIndexOf(" ");
  return `${(space > 40 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
