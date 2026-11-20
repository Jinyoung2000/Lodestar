// 대화 속 이미지와 영상 경로 찾기. 화면(미리보기를 붙일 경로 고르기)과 데몬(이 대화에 실제로 나온 경로인지 확인)이 같은 함수를 쓴다.
// DOM 과 store 없이 도는 순수 함수라 test/mediapaths.test.ts 가 바로 부른다.

export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "svg"] as const;
export const VIDEO_EXTENSIONS = ["mp4", "mov", "webm"] as const;
export type MediaKind = "image" | "video";

const EXT = "(?:png|jpe?g|gif|webp|svg|mp4|mov|webm)";
// 글 하나에서 확장자 모양이 한 번도 안 나오면 아래 정규식을 돌리지 않는다. 스트리밍 중 프레임마다 도는 검사라 가장 싼 문턱으로 둔다.
const HINT = new RegExp(`\\.${EXT}(?![\\p{L}\\p{N}_])`, "iu");
const ENDS_WITH_EXT = new RegExp(`\\.${EXT}$`, "i");

// 메시지 하나에 붙이는 미리보기 수. 넘는 경로는 글자로만 남는다. 없는 파일이 자리를 차지하지 않도록 데몬에는 후보를 더 많이 묻고(MAX_MEDIA_CANDIDATES), 읽을 수 있는 것 중 앞에서부터 붙인다.
export const MAX_MEDIA_PER_MESSAGE = 8;
export const MAX_MEDIA_CANDIDATES = 16;
export const MAX_MEDIA_PATH_LENGTH = 1024;

export const mayContainMedia = (text: string) => HINT.test(text);

export function mediaKindOf(path: string): MediaKind | null {
  const extension = /\.([a-z0-9]+)$/i.exec(path)?.[1].toLowerCase();
  if (!extension) return null;
  if ((IMAGE_EXTENSIONS as readonly string[]).includes(extension)) return "image";
  if ((VIDEO_EXTENSIONS as readonly string[]).includes(extension)) return "video";
  return null;
}

// 길이, NUL, `..` 조각을 거른 뒤 이미지나 영상 확장자로 끝나는 경로만 통과시킨다. 풀이(상대 경로, ~)는 데몬이 한다.
export function isPlausibleMediaPath(path: string): boolean {
  if (!path || path.length > MAX_MEDIA_PATH_LENGTH || path.includes("\0") || /\\|\n/.test(path)) return false;
  if (path.startsWith("//") || path.split("/").includes("..")) return false;
  return ENDS_WITH_EXT.test(path);
}

// 줄 끝에서 잘린 절대 경로 뒤에 이어지는 줄이 파일 이름뿐이면 한 경로로 잇는다. 모델이 80자 근처에서 줄을 꺾어 쓴 경우다.
// 잘못 이은 경로는 파일이 없어 미리보기가 안 붙을 뿐이다.
const HARD_WRAP = new RegExp(`(~?\\/[^\\s\`]*[\\p{L}\\p{N}_\\-/.])(?<!\\.${EXT})\\n[ \\t]*([^\\s\`/]+\\.${EXT})(?![\\p{L}\\p{N}_])`, "giu");
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const CODE_SPAN = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g;
const MD_IMAGE = /!\[[^\]]*\]\(\s*(?:<([^>\n]+)>|([^)\s]+))(?:\s+"[^"\n]*")?\s*\)/g;
const BARE = new RegExp(`(?<![\\p{L}\\p{N}_/.~\\-])(~?\\/(?!\\/)[^\\s\`"'<>()\\[\\]{}|*?,;]+?\\.${EXT})(?![\\p{L}\\p{N}_/\\-]|\\.[\\p{L}\\p{N}])`, "giu");

// 응답 글에서 이미지와 영상 경로를 나타난 순서대로 모은다(중복 없이).
//  - 인라인 코드 전체가 경로인 것, 글 속 맨 경로, `![](경로)`
//  - 펜스 코드 블록은 그 줄이 경로 하나뿐일 때만 본다(명령이나 코드 속 경로는 건드리지 않는다)
//  - 절대 경로(/...)와 ~/ 는 어디서든, 상대 경로는 `![](...)` 에 적힌 것만
// streaming 이면 아직 쓰는 중일 수 있는 경로를 뺀다: 글 끝에서 끝나는 맨 경로, 닫히지 않은 코드와 이미지 문법, 줄바꿈이 오지 않은 코드 블록 속 경로.
export function findMediaPaths(text: string, options: { streaming?: boolean } = {}): string[] {
  if (!mayContainMedia(text)) return [];
  const streaming = options.streaming === true;
  // 경로와 글 속 위치. 단계마다 찾은 것을 글에 적힌 순서로 다시 줄 세운다(미리보기가 글의 순서대로 나온다).
  const hits: { index: number; path: string }[] = [];
  const add = (index: number, path: string) => {
    if (isPlausibleMediaPath(path)) hits.push({ index, path });
  };
  // 찾은 부분을 같은 길이의 공백으로 지워 이후 단계가 다시 보지 않게 한다(위치는 그대로 유지).
  const blank = (whole: string) => whole.replace(/[^\n]/g, " ");

  // 0. 줄이 꺾인 경로를 잇는다. 이 뒤의 글을 기준으로 위치를 센다.
  const base = text.replace(HARD_WRAP, (_whole, head: string, tail: string) => `${head}${tail}`);

  // 1. 펜스 코드 블록: 경로 하나뿐인 줄만 뽑고 블록은 지운다.
  const lines = base.split("\n");
  let fence: string | null = null;
  let offset = 0;
  const kept = lines.map((line, number) => {
    const start = offset;
    offset += line.length + 1;
    const opening = FENCE.exec(line);
    if (fence === null && opening) {
      fence = opening[1];
      return blank(line);
    }
    if (fence === null) return line;
    if (opening && opening[1][0] === fence[0] && opening[1].length >= fence.length && line.trim() === opening[1]) fence = null;
    else if (!(streaming && number === lines.length - 1)) {
      const only = line.trim();
      if (/^~?\//.test(only) && !/[`"'<>|*?]/.test(only)) add(start, only);
    }
    return blank(line);
  });
  let rest = kept.join("\n");

  // 2. 인라인 코드: 전체가 경로 하나(공백이 낀 경로와 줄바꿈이 낀 경로 포함)이면 뽑고 지운다. 나머지는 맨 경로 검사에 맡긴다.
  rest = rest.replace(CODE_SPAN, (whole: string, _ticks: string, inner: string, index: number) => {
    const joined = inner.replace(/\s*\n\s*/g, "").trim();
    if (/^~?\//.test(joined) && !joined.includes("`")) {
      add(index, joined);
      return blank(whole);
    }
    return whole;
  });

  // 3. 마크다운 이미지: 상대 경로도 받는다. http, data 같은 주소는 건너뛴다.
  rest = rest.replace(MD_IMAGE, (whole: string, angle: string | undefined, plain: string | undefined, index: number) => {
    const target = localImageTarget(angle ?? plain ?? "");
    if (target) add(index, target);
    return blank(whole);
  });

  // 4. 맨 경로
  for (const match of rest.matchAll(BARE)) {
    if (streaming && match.index + match[0].length >= rest.length) continue;
    add(match.index, match[1]);
  }

  const found: string[] = [];
  for (const { path } of hits.sort((a, b) => a.index - b.index)) if (!found.includes(path)) found.push(path);
  return found;
}

// `![](대상)` 의 대상이 로컬 파일을 가리키면 그 경로를, 아니면 null. %20 같은 인코딩과 file:// 접두사, ?query 와 #hash 를 정리한다.
export function localImageTarget(target: string): string | null {
  let value = target.trim();
  if (!value || /^(?:https?|data|blob|mailto|ftp):/i.test(value) || value.startsWith("//")) return null;
  value = value.replace(/^file:\/\//i, "").replace(/[?#].*$/, "");
  try {
    value = decodeURIComponent(value);
  } catch {
    // 인코딩이 깨진 대상은 적힌 그대로 본다
  }
  return isPlausibleMediaPath(value) ? value : null;
}
