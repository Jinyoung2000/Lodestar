import { buildPicks } from "./quickOpenModel";

export function rankFiles(files: string[], query: string, limit = 50) {
  const q = query.trim();
  if (!q) return files.slice(0, limit);
  return buildPicks({ files, recent: [], filter: q, workspaceDir: null, includeExcluded: false, limit }).results.map((pick) => pick.path);
}
