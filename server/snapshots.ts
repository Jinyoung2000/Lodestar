import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { Agent, ChangedFile } from "../shared/protocol";
import { countLineChanges } from "../shared/lineDiff";
import type { Store } from "./store";

// 기준 커밋이 없는 폴더(커밋 0개 레포, git 레포가 아님)의 변경 기준: 에이전트가 파일을 고치기 직전에 남긴 스냅샷.
// 스냅샷은 store.changes(~/.agent-nav/changes/<agentId>.json)에 들어가고, "유지"가 기준을 앞으로 옮기는 기록과 같은 자리를 쓴다.
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;

// worktree, 피드백 세션, 시작 커밋이 있는 세션은 git(또는 해시) 기준을 쓰므로 스냅샷 방식이 아니다.
export function usesSnapshots(agent: Agent) {
  // 폴더 없는 세션(퀵 챗)은 변경 대상이 없어 스냅샷도 만들지 않는다
  return !agent.startCommit && !agent.worktree && !agent.feedbackId && agent.workspaceId !== null;
}

// PreToolUse 훅에서 부른다. 이 파일의 기록이 이미 있으면(첫 수정 전 내용이거나 "유지" 로 옮긴 기준) 그대로 둔다.
// 기록하면 true.
export async function snapshotBeforeEdit(agent: Agent, store: Store, toolName: string, input: Record<string, unknown>) {
  if (!usesSnapshots(agent) || !EDIT_TOOLS.has(toolName)) return false;
  const raw = typeof input.file_path === "string" ? input.file_path : typeof input.notebook_path === "string" ? input.notebook_path : null;
  if (!raw) return false;
  const absolute = isAbsolute(raw) ? raw : resolve(agent.cwd, raw);
  const rel = relative(agent.cwd, absolute);
  if (rel.startsWith("..") || isAbsolute(rel)) return false;
  if (store.change(agent.id, absolute)) return false;
  const original = await readText(absolute);
  if (original === undefined) return false;
  store.setChange(agent.id, absolute, original);
  return true;
}

// 스냅샷과 지금 디스크를 비교해 바뀐 파일 목록을 만든다. 같아졌으면(되돌렸거나 "유지" 했으면) 목록에서 뺀다.
export async function snapshotChanges(agent: Agent, store: Store): Promise<ChangedFile[]> {
  const files: ChangedFile[] = [];
  for (const entry of store.changes(agent.id)) {
    const current = await readText(entry.path);
    if (current === undefined) continue;
    if (current === entry.original) continue;
    const status = entry.original === null ? "A" : current === null ? "D" : "M";
    const { additions, deletions } = countLineChanges(entry.original ?? "", current ?? "");
    const rel = relative(agent.cwd, entry.path);
    files.push({ path: entry.path, rel: rel.startsWith("..") ? entry.path : rel, status, additions, deletions });
  }
  return files.sort((a, b) => a.rel.localeCompare(b.rel));
}

// "유지"한 기준이 있는 파일의 +/- 는 그 기준과 지금 디스크의 차이다(diff 가 보이는 것과 같은 숫자). 파일은 목록에 남고, 전부 유지했으면 +0 -0 이 된다.
export async function applyKeptCounts(agent: Agent, store: Store, files: ChangedFile[]): Promise<ChangedFile[]> {
  const kept = store.changes(agent.id);
  if (kept.length === 0) return files;
  return Promise.all(
    files.map(async (file) => {
      const entry = kept.find((c) => c.path === file.path);
      if (!entry) return file;
      const current = await readText(file.path);
      if (current === undefined) return file;
      const { additions, deletions } = countLineChanges(entry.original ?? "", current ?? "");
      return { ...file, additions, deletions };
    }),
  );
}

// 파일이 없으면 null, 너무 크면 undefined(비교하지 않는다).
async function readText(path: string): Promise<string | null | undefined> {
  try {
    const buffer = await readFile(path);
    if (buffer.length > MAX_SNAPSHOT_BYTES) return undefined;
    return buffer.toString("utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : undefined;
  }
}

// 줄 단위 추가/삭제 수 계산은 웹(도구 행의 +a -b)도 쓰므로 shared 에 있다.
export { countLineChanges } from "../shared/lineDiff";
