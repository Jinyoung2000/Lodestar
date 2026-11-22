import { remoteRepoRefs } from "../shared/remoteRepo";
import { elidedParts, matchesElided } from "./fileRefResolve";

const ABSOLUTE = /(?:^|[\s'"`=(:,[{])((?:\/Users|\/home|\/private\/tmp|\/tmp)\/[^\s'"`;|&<>()[\]{},*?$]+)/g;

const MAX_CANDIDATES = 12;

export function outsideCandidates(rel: string, inputs: readonly string[], workspaceDir: string): string[] {
  if (!rel || rel.startsWith("../")) return [];
  const parts = rel.split("/");
  const first = parts[0];
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
        for (let i = segments.length - 2; i > 1; i -= 1) {
          if (segments[i] === first) push(anchored, `${segments.slice(0, i).join("/")}/${rel}`);
        }
      }
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

