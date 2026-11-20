import { lstat, cp, mkdir, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative } from "node:path";

// 파일을 지우는 대신 휴지통으로 옮기는 곳. 데몬이 Node 프로세스라 shell.trashItem 을 못 써서 ~/.Trash 로 이름을 바꿔 옮긴다(Finder 의 Put Back 정보는 없다).
// Source Control 의 새 파일 버리기, 세션 변경 되돌리기(Discard Changes), Files 트리 Delete 가 같이 쓴다. 영구 삭제 경로는 만들지 않는다.

export function trashDir() {
  return process.env.AGENT_NAV_TRASH_DIR ?? join(homedir(), ".Trash");
}

// 파일 이름을 바꿔 휴지통 폴더로 옮긴다. 같은 이름이 있으면 "이름 2.확장자" 로 비킨다. 다른 볼륨이면 복사한 뒤 원본을 지운다(복사본이 남는다).
export async function moveToTrash(abs: string) {
  const dir = trashDir();
  await mkdir(dir, { recursive: true });
  const ext = extname(abs);
  const stem = basename(abs, ext);
  let target = join(dir, basename(abs));
  for (let n = 2; await exists(target); n++) target = join(dir, `${stem} ${n}${ext}`);
  try {
    await rename(abs, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    await cp(abs, target, { recursive: true, errorOnExist: true, verbatimSymlinks: true });
    await rm(abs, { recursive: true });
  }
  return target;
}

// 이미 지워진 파일의 내용을 휴지통에 넣는다(체크포인트 복원이 SDK 가 지운 파일을 살려 두는 데 쓴다). 이름 규칙은 moveToTrash 와 같다.
export async function saveToTrash(name: string, content: Buffer) {
  const dir = trashDir();
  await mkdir(dir, { recursive: true });
  const ext = extname(name);
  const stem = basename(name, ext);
  let target = join(dir, basename(name));
  for (let n = 2; await exists(target); n++) target = join(dir, `${stem} ${n}${ext}`);
  await writeFile(target, content, { flag: "wx" });
  return target;
}

// 파일을 치운 뒤 비어 버린 폴더를 root 아래에서만 거둔다. rmdir 은 비어 있지 않으면 실패하므로 다른 파일은 건드리지 않는다.
export async function pruneEmptyDirs(root: string, from: string) {
  for (let dir = from; dir !== root && !relative(root, dir).startsWith(".."); dir = dirname(dir)) {
    try {
      await rmdir(dir);
    } catch {
      return;
    }
  }
}

async function exists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}
