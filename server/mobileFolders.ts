// MOBILE: 폰이 맥의 폴더를 둘러보고 워크스페이스로 추가할 때의 경계(server/mobileAccess.ts 의 guardMobileCall 과 데몬의 mobile.browse 가 쓴다).
// 폰이 볼 수 있는 것은 "홈 아래 디렉터리의 이름과 git 여부" 뿐이고 파일 이름과 내용은 주지 않는다.
// 1. 홈은 기본이 homedir() 이고, 시험에서는 AGENT_NAV_MOBILE_BROWSE_ROOT 로 바꾼다(AGENT_NAV_HOME 은 데몬 데이터 폴더라 다른 값이다).
// 2. 경로는 realpath 로 풀어 홈 안인지 본다(심볼릭 링크로 밖을 가리켜도 걸러지고, macOS 의 /tmp 가 /private/tmp 인 것도 맞는다).
// 3. 숨김 폴더(.ssh 같은 것), 홈 바로 아래의 Library 와 Applications 같은 시스템 폴더, node_modules 는 목록에서도 빠지고 직접 적어도 거절한다.
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import type { MobileBrowseEntry, MobileBrowseResult } from "../shared/mobile";
import { T } from "./strings";

export const BROWSE_LIMIT = 500;

// 홈 바로 아래에서만 빼는 이름(앱 데이터와 시스템 폴더). 어디서든 빼는 이름은 숨김 폴더와 node_modules.
const ROOT_EXCLUDED: ReadonlySet<string> = new Set(["Library", "Applications", "Movies", "Music", "Pictures", "Public"]);

export function browseRoot(): string {
  const root = process.env.AGENT_NAV_MOBILE_BROWSE_ROOT;
  return realpathSync(root && root.trim() ? root : homedir());
}

// 홈에서의 위치(세그먼트 목록)가 폰에 보일 수 있는 곳인지
function visible(segments: readonly string[]): boolean {
  return segments.every((name, index) => !name.startsWith(".") && name !== "node_modules" && !(index === 0 && ROOT_EXCLUDED.has(name)));
}

export type ResolvedFolder = { dir: string; display: string };

// 폰이 보낸 경로를 홈 아래의 실제 폴더로 푼다. 받는 모양: 비었거나 "~"(홈), "~/a/b", 홈을 앞에 둔 절대 경로, 홈 기준 상대 경로 "a/b".
// 홈 밖, 숨김, 제외 폴더, 폴더가 아닌 것은 같은 문구로 거절해서 홈 밖의 존재 여부를 알려 주지 않는다.
export function resolveFolder(input: unknown, root = browseRoot()): ResolvedFolder {
  const raw = input === undefined || input === null ? "" : typeof input === "string" ? input.trim() : null;
  if (raw === null || raw.length > 1024 || raw.includes("\0")) throw new Error(T.errMobileParam("path"));
  let absolute: string;
  if (raw === "" || raw === "~") absolute = root;
  else if (raw.startsWith("~/")) absolute = resolve(root, raw.slice(2));
  else if (raw.startsWith("/")) absolute = resolve(raw);
  else absolute = resolve(root, raw);
  // resolve 가 ".." 를 접은 뒤의 글자 비교. 같은 홈을 realpath 로 쓴 경로와 안 쓴 경로가 섞일 수 있어 realpath 한 뒤 한 번 더 본다.
  let real: string;
  try {
    real = realpathSync(absolute);
  } catch {
    // 홈 안으로 적은 경로만 "없다" 고 말한다. 홈 밖은 있든 없든 같은 거절이다.
    const lexical = relative(root, absolute);
    throw new Error(lexical === ".." || lexical.startsWith(`..${sep}`) ? T.errMobileFolderDenied : T.errMobileFolderMissing);
  }
  const rel = relative(root, real);
  if (rel === ".." || rel.startsWith(`..${sep}`) || resolve(root, rel) !== real) throw new Error(T.errMobileFolderDenied);
  const segments = rel === "" ? [] : rel.split(sep);
  if (!visible(segments)) throw new Error(T.errMobileFolderDenied);
  if (!statSync(real).isDirectory()) throw new Error(T.errMobileFolderDenied);
  return { dir: real, display: segments.length ? `~/${segments.join("/")}` : "~" };
}

// 워크스페이스로 추가할 수 있는 폴더: 홈 아래의 실제 폴더이고 홈 자체는 안 된다(홈 전체를 일터로 열면 세션이 숨김 폴더의 열쇠와 설정까지 읽을 수 있다).
export function resolveAddable(input: unknown, root = browseRoot()): ResolvedFolder {
  const folder = resolveFolder(input, root);
  if (folder.dir === root) throw new Error(T.errMobileFolderRoot);
  return folder;
}

// 폴더 하나의 하위 디렉터리 목록. 심볼릭 링크는 따라가지 않고(밖을 가리킬 수 있다), 숨김과 제외 폴더는 뺀다.
export function listFolder(folder: ResolvedFolder, workspaceByDir: ReadonlyMap<string, string>, root = browseRoot()): MobileBrowseResult {
  const atRoot = folder.dir === root;
  const entries: MobileBrowseEntry[] = [];
  let truncated = false;
  let names: { name: string; isDirectory: boolean }[] = [];
  try {
    names = readdirSync(folder.dir, { withFileTypes: true }).map((d) => ({ name: d.name, isDirectory: d.isDirectory() && !d.isSymbolicLink() }));
  } catch {
    names = [];
  }
  for (const { name, isDirectory } of names.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))) {
    if (!isDirectory || name.startsWith(".") || name === "node_modules" || (atRoot && ROOT_EXCLUDED.has(name))) continue;
    if (entries.length >= BROWSE_LIMIT) {
      truncated = true;
      break;
    }
    const dir = join(folder.dir, name);
    entries.push({ name, git: existsSync(join(dir, ".git")), workspaceId: workspaceByDir.get(dir) ?? null });
  }
  const parent = atRoot ? null : folder.display.includes("/") ? folder.display.slice(0, folder.display.lastIndexOf("/")) || "~" : "~";
  return { path: folder.display, parent, git: existsSync(join(folder.dir, ".git")), workspaceId: workspaceByDir.get(folder.dir) ?? null, entries, truncated };
}
