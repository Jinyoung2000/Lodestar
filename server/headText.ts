import * as gitOps from "./git";
import { resolveReadable } from "./files";

// FIX6C: 에디터 변경 거터가 비교할 기준(HEAD)의 파일 내용. git 저장소가 아니면 거터를 안 그리도록 repo 를 같이 알린다.
const MAX_BYTES = 2_000_000;

export async function headTextOf(dir: string, path: string): Promise<{ repo: boolean; text: string | null }> {
  if (!(await gitOps.repoRoot(dir))) return { repo: false, text: null };
  const absolute = await resolveReadable(dir, path);
  const text = await gitOps.original(dir, "HEAD", absolute);
  return { repo: true, text: text !== null && text.length <= MAX_BYTES ? text : null };
}
