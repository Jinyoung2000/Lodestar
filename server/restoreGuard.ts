import { mkdir, readFile, stat, unlink, writeFile, chmod } from "node:fs/promises";
import { basename, dirname } from "node:path";
import type { Agent, RestoreFile, RestorePlan, RestoreSkip } from "../shared/protocol";
import { insideCwd } from "./checkpoints";
import { canonPath, hashOf } from "./sessionTouch";
import { moveToTrash, saveToTrash } from "./trash";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";

// FIX5-0: 체크포인트 복원을 파일마다 보호하는 부분. SDK 의 rewindFiles 는 체크포인트가 가진 파일을 전부 한 번에 되돌리고 파일을 골라 줄 방법이 없어서,
// 되돌리기 전에 건너뛸 파일과 지워질 파일의 지금 내용을 읽어 두고, 되돌린 뒤에 건너뛸 파일을 그 내용으로 되쓰고 지워진 파일은 그 내용을 휴지통에 넣는다.
// 휴지통 이동을 되돌리기 앞에 두지 않는 이유: 되돌릴 파일이 그 하나뿐일 때 rewindFiles 가 실패하면 파일만 휴지통으로 가고 복원은 안 된 상태가 남는다.

type Saved = { content: Buffer | null; mode: number | null };

export async function applyRestore(plan: RestorePlan, rewind: () => Promise<unknown>): Promise<{ trashed: RestoreFile[] }> {
  const protectedFiles = new Map<string, Saved>();
  for (const file of plan.skip) protectedFiles.set(file.path, await readSaved(file.path));
  const removing = new Map<string, Saved>();
  for (const file of plan.remove) removing.set(file.path, await readSaved(file.path));
  const trashed: RestoreFile[] = [];
  try {
    await rewind();
    for (const file of plan.remove) {
      const saved = removing.get(file.path);
      // SDK 가 실제로 지운 파일만 휴지통에 넣는다(그대로 남았으면 지워진 것이 아니다)
      if (!saved?.content || (await readSaved(file.path)).content !== null) continue;
      await saveToTrash(basename(file.path), saved.content);
      trashed.push(file);
    }
  } finally {
    for (const [path, saved] of protectedFiles) await putBack(path, saved);
  }
  return { trashed };
}

async function readSaved(path: string): Promise<Saved> {
  try {
    const [content, info] = await Promise.all([readFile(path), stat(path)]);
    return { content, mode: info.mode & 0o777 };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { content: null, mode: null };
    throw error;
  }
}

// 복원 전의 모습으로: 내용이 같으면 그대로 두고, SDK 가 지웠으면 다시 만들고, 원래 없던 파일을 SDK 가 만들었으면 지운다.
async function putBack(path: string, saved: Saved) {
  const now = await readSaved(path);
  if (saved.content === null) {
    if (now.content !== null) await unlink(path);
    return;
  }
  if (now.content?.equals(saved.content)) return;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, saved.content);
  if (saved.mode !== null) await chmod(path, saved.mode);
}

// 복원 직후 파일들의 해시(없으면 absent). Redo 가 "복원 뒤 아무도 안 고친 파일" 만 다시 쓰는 근거다.
export async function hashesOf(paths: string[]): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  for (const path of paths) hashes[path] = hashOf((await readSaved(path)).content);
  return hashes;
}

// Redo: 복원 전 내용(files, null 은 그때 없던 파일)을 다시 쓴다. 복원 직후 해시(restoredHash)와 다른 파일은 그 사이 누가 고친 것이라 건너뛴다.
// 복원 전에 없던 파일은 지우지 않고 휴지통으로 옮긴다. restoredHash 가 없는 옛 Redo 기록은 검사 없이 쓴다.
export async function redoFiles(agent: Agent, files: Record<string, string | null>, restoredHash: Record<string, string> | undefined) {
  const written: string[] = [];
  const skipped: RestoreSkip[] = [];
  const cwd = await realpath(agent.cwd).catch(() => agent.cwd);
  for (const [path, data] of Object.entries(files)) {
    if (!(await insideCwd(agent, path))) continue;
    const now = await readSaved(path);
    if (restoredHash && path in restoredHash && hashOf(now.content) !== restoredHash[path]) {
      const rel = relative(cwd, await canonPath(path));
      skipped.push({ path, rel: rel.startsWith("..") || isAbsolute(rel) ? path : rel, reason: "modified" });
      continue;
    }
    if (data === null) {
      if (now.content !== null) await moveToTrash(path);
    } else {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, Buffer.from(data, "base64"));
    }
    written.push(path);
  }
  return { written, skipped };
}
