
export type FileIndex = { list: readonly string[]; set: ReadonlySet<string> };

const indexes = new WeakMap<readonly string[], FileIndex>();

export function fileIndex(list: readonly string[]): FileIndex {
  let index = indexes.get(list);
  if (!index) {
    index = { list, set: new Set(list) };
    indexes.set(list, index);
  }
  return index;
}

export type Resolution =
  | { kind: "found"; path: string }
  | { kind: "ambiguous"; matches: string[] }
  | { kind: "missing"; path: string }
  | { kind: "pending"; check: string[] };

export function normalizeRelative(raw: string): string {
  const out: string[] = [];
  for (const part of raw.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length && out.at(-1) !== "..") out.pop();
      else out.push("..");
    } else out.push(part);
  }
  return out.join("/");
}

export type Elided = { head: string; tail: string };
const isEllipsis = (part: string) => part === "..." || part === "…";
export function elidedParts(rel: string): Elided | null {
  const parts = rel.split("/");
  const i = parts.findIndex(isEllipsis);
  if (i < 0) return null;
  const tail = parts.slice(i + 1);
  if (!tail.length || tail.some(isEllipsis)) return null;
  return { head: parts.slice(0, i).join("/"), tail: tail.join("/") };
}

export function matchesElided(path: string, elided: Elided): boolean {
  if (!path.endsWith(`/${elided.tail}`)) return false;
  if (!elided.head) return true;
  const rest = `/${path.slice(0, path.length - elided.tail.length - 1)}/`;
  return rest.includes(`/${elided.head}/`);
}

const escapesRoot = (path: string) => path === ".." || path.startsWith("../");
const dirOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));

function hintBases(hints: readonly string[]): string[] {
  const bases: string[] = [];
  for (const hint of hints) {
    let dir = dirOf(hint);
    while (dir) {
      if (!bases.includes(dir)) bases.push(dir);
      dir = dirOf(dir);
    }
  }
  return bases;
}

function candidatesOf(rel: string, raw: string, bases: readonly string[]): string[] {
  const out = [rel];
  for (const base of bases) {
    const candidate = normalizeRelative(`${base}/${raw}`);
    if (!escapesRoot(candidate) && !out.includes(candidate)) out.push(candidate);
  }
  return out;
}

export function resolveFileRef(index: FileIndex, raw: string, hints: readonly string[], known: ReadonlyMap<string, boolean>): Resolution {
  const rel = normalizeRelative(raw);
  if (!rel || escapesRoot(rel)) return { kind: "found", path: rel || raw };
  const bases = hintBases(hints);
  const candidates = candidatesOf(rel, raw, bases);

  for (const candidate of candidates) if (index.set.has(candidate)) return { kind: "found", path: candidate };

  const elided = elidedParts(rel);
  if (elided) {
    const hits = index.list.filter((file) => matchesElided(`/${file}`, elided));
    if (hits.length === 1) return { kind: "found", path: hits[0] };
    if (hits.length > 1) {
      const near = hits.filter((file) => bases.some((base) => file.startsWith(`${base}/`)));
      return near.length === 1 ? { kind: "found", path: near[0] } : { kind: "ambiguous", matches: hits };
    }
    return { kind: "missing", path: createPathFor(rel, hints, index) };
  }

  const matches = index.list.filter((file) => file.endsWith(`/${rel}`));
  if (matches.length === 1) return { kind: "found", path: matches[0] };
  if (matches.length > 1) {
    const near = matches.filter((file) => bases.some((base) => file.startsWith(`${base}/`)));
    return near.length === 1 ? { kind: "found", path: near[0] } : { kind: "ambiguous", matches };
  }

  for (let i = 0; i < candidates.length; i += 1) {
    const state = known.get(candidates[i]);
    if (state === true) return { kind: "found", path: candidates[i] };
    if (state === undefined) return { kind: "pending", check: candidates.slice(i).filter((c) => !known.has(c)) };
  }
  return { kind: "missing", path: createPathFor(rel, hints, index) };
}

export function createPathFor(rel: string, hints: readonly string[], index: FileIndex): string {
  const bases = hintBases(hints);
  const first = rel.includes("/") ? rel.slice(0, rel.indexOf("/")) : null;
  for (const base of bases) {
    if (first === null) return `${base}/${rel}`;
    const prefix = `${base}/${first}/`;
    if (index.list.some((file) => file.startsWith(prefix))) return `${base}/${rel}`;
  }
  if (first !== null && index.list.some((file) => file.startsWith(`${first}/`))) return rel;
  const hintDir = dirOf(hints[0] ?? "");
  let dir = hintDir;
  while (dir) {
    if (index.set.has(`${dir}/package.json`)) return `${dir}/${rel}`;
    dir = dirOf(dir);
  }
  return rel;
}
