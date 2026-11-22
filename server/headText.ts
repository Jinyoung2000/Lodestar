import * as gitOps from "./git";
import { resolveReadable } from "./files";

const MAX_BYTES = 2_000_000;

export async function headTextOf(dir: string, path: string): Promise<{ repo: boolean; text: string | null }> {
  if (!(await gitOps.repoRoot(dir))) return { repo: false, text: null };
  const absolute = await resolveReadable(dir, path);
  const text = await gitOps.original(dir, "HEAD", absolute);
  return { repo: true, text: text !== null && text.length <= MAX_BYTES ? text : null };
}
