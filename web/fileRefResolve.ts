// 대화 속 상대 경로를 작업 폴더 파일로 푸는 순수 함수. DOM, store, rpc 를 모른다(test/filerefresolve.test.ts).
// 링크를 그릴 때(web/fileRefMark.ts)와 눌렀을 때(web/fileRefs.ts openFileRef)가 같은 함수를 써서, 실선으로 그린 링크가 눌렀을 때 실패하는 어긋남이 없게 한다.

export type FileIndex = { list: readonly string[]; set: ReadonlySet<string> };

const indexes = new WeakMap<readonly string[], FileIndex>();

// 같은 배열이면 같은 색인을 돌려준다(스트리밍 중 다시 그릴 때마다 5만 개를 다시 훑지 않게).
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
  // 디스크에 없다. path 는 파일을 만든다면 놓일 자리.
  | { kind: "missing"; path: string }
  // git 목록에 없는 후보. 디스크에 있는지(무시된 파일이거나 방금 만든 파일) 알아야 정해진다.
  | { kind: "pending"; check: string[] };

// ./ 를 걷고 a/../b 를 접는다. 작업 폴더 밖으로 나가면 앞에 ../ 가 남는다.
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

// 모델은 긴 경로 가운데를 a/b/.../c/d.kt 처럼 줄여 쓴다. "..." 또는 "…" 조각 하나를 앞(head)과 뒤(tail)로 나눈다. 없거나 뒤가 비면 null.
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

// path 가 줄인 경로와 맞는지: tail 로 끝나고, 그 앞부분에 head 가 폴더 경계에서 나온다(가운데 폴더는 몇 개든).
export function matchesElided(path: string, elided: Elided): boolean {
  if (!path.endsWith(`/${elided.tail}`)) return false;
  if (!elided.head) return true;
  const rest = `/${path.slice(0, path.length - elided.tail.length - 1)}/`;
  return rest.includes(`/${elided.head}/`);
}

const escapesRoot = (path: string) => path === ".." || path.startsWith("../");
const dirOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));

// 힌트 파일(같은 글에서 이미 찾은 파일)의 폴더와 그 위쪽 폴더들. 깊은 쪽부터, 작업 폴더 루트는 뺀다.
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

// 순서: 작업 폴더 기준 정확히 일치, 힌트 폴더 기준 일치, 접미사가 하나뿐인 파일, 디스크 확인, 없음.
// hints 는 같은 글에서 이미 찾은 파일들이다. 모델은 하위 패키지 폴더(app-cli/) 기준으로 src/cli.ts 처럼 쓰는 일이 잦아서, 그 파일들의 폴더를 기준으로도 찾는다.
// known 은 디스크 확인 결과(경로 -> 있음). 모르는 후보가 남으면 pending 으로 무엇을 확인해야 하는지 알려 준다.
export function resolveFileRef(index: FileIndex, raw: string, hints: readonly string[], known: ReadonlyMap<string, boolean>): Resolution {
  const rel = normalizeRelative(raw);
  if (!rel || escapesRoot(rel)) return { kind: "found", path: rel || raw };
  const bases = hintBases(hints);
  const candidates = candidatesOf(rel, raw, bases);

  for (const candidate of candidates) if (index.set.has(candidate)) return { kind: "found", path: candidate };

  // 가운데를 줄인 경로는 앞뒤가 맞는 파일로 찾는다. 디스크에 "..." 이름을 물어볼 것은 없다.
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

// 없는 파일을 만든다면 놓일 자리. 힌트 파일의 폴더를 위로 올라가며, 그 아래에 rel 의 첫 폴더가 이미 있는 곳을 고른다.
// 없으면 루트에 그 폴더가 있는지, 그것도 아니면 가장 가까운 package.json 폴더, 그것도 없으면 작업 폴더 루트.
export function createPathFor(rel: string, hints: readonly string[], index: FileIndex): string {
  const bases = hintBases(hints);
  const first = rel.includes("/") ? rel.slice(0, rel.indexOf("/")) : null;
  for (const base of bases) {
    if (first === null) return `${base}/${rel}`;
    const prefix = `${base}/${first}/`;
    if (index.list.some((file) => file.startsWith(prefix))) return `${base}/${rel}`;
  }
  // 힌트 폴더에는 없고 작업 폴더 루트에 그 폴더가 이미 있으면 루트 기준으로 쓴 것이다
  if (first !== null && index.list.some((file) => file.startsWith(`${first}/`))) return rel;
  const hintDir = dirOf(hints[0] ?? "");
  let dir = hintDir;
  while (dir) {
    if (index.set.has(`${dir}/package.json`)) return `${dir}/${rel}`;
    dir = dirOf(dir);
  }
  return rel;
}
