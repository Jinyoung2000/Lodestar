import type { Attachment } from "./store";


type DirOf = (workspaceId: string) => string | undefined;
type Chip = Pick<Attachment, "workspaceId" | "path" | "startLine" | "endLine" | "session" | "note" | "browser" | "handoff" | "image" | "file">;

// 같은 칩인지 가르는 키. 중복을 걸러 내지 않는 종류(브라우저 캡처는 찍을 때마다 내용이 다른 스냅샷이다)와 해시가 없는 이미지는 null.
export function chipIdentity(a: Chip, dirOf: DirOf): string | null {
  if (a.handoff) return `handoff:${a.handoff.sourceId}`;
  if (a.session) return `session:${a.path}`;
  if (a.note) return `note:${a.path}`;
  if (a.image) return a.image.hash ? `image:${a.image.hash}` : null;
  // FILEATTACH: 경로를 아는 파일은 같은 경로면 같은 칩이다. 업로드 중인 파일은 경로가 아직 없어 중복을 거르지 않는다.
  if (a.file) return a.file.path ? `localfile:${a.file.path}` : null;
  if (a.browser?.kind === "notion") return `notion:${a.browser.pageKey}`;
  if (a.browser) return null;
  const range = a.startLine == null ? "" : `#${a.startLine}-${a.endLine ?? a.startLine}`;
  return `file:${locate(a, dirOf).identity}${range}`;
}

export function findDuplicate<T extends Chip>(existing: readonly T[], incoming: Chip, dirOf: DirOf): T | undefined {
  const key = chipIdentity(incoming, dirOf);
  return key === null ? undefined : existing.find((e) => chipIdentity(e, dirOf) === key);
}

// 같은 이름의 서로 다른 파일이 함께 있을 때 칩 이름 뒤에 붙일 흐린 꼬리(칩 id -> 상위 폴더). 이름이 겹치지 않는 칩은 맵에 없다.
// 꼬리는 겹치는 파일들이 서로 구분될 때까지 상위 폴더를 한 칸씩 늘린 경로 끝부분이다(`api`, 같으면 `src/api`).
export function nameTails(attachments: readonly (Chip & { id: string })[], dirOf: DirOf): Map<string, string> {
  const groups = new Map<string, { id: string; where: Located }[]>();
  for (const a of attachments) {
    if (a.handoff || a.session || a.note || a.image || a.browser || a.file) continue;
    const where = locate(a, dirOf);
    const name = where.name;
    groups.set(name, [...(groups.get(name) ?? []), { id: a.id, where }]);
  }
  const tails = new Map<string, string>();
  for (const members of groups.values()) {
    const files = [...new Map(members.map((m) => [m.where.identity, m.where])).values()];
    if (files.length < 2) continue;
    const depth = uniqueDepth(files.map((f) => f.segments));
    for (const m of members) tails.set(m.id, m.where.segments.slice(-depth).join("/") || ".");
  }
  return tails;
}

// 칩에 마우스를 올렸을 때 보이는 전체 상대 경로(줄 범위가 있으면 함께).
export function chipTitle(a: Pick<Attachment, "path" | "startLine" | "endLine">) {
  if (a.startLine == null) return a.path;
  return a.startLine === a.endLine ? `${a.path}:${a.startLine}` : `${a.path}:${a.startLine}-${a.endLine}`;
}

// 이미지 내용 해시(SHA-256 16진수). 보안 컨텍스트가 아니라 crypto.subtle 이 없는 접속(LAN 의 http 주소)에서는 FNV-1a 두 가닥으로 대신한다.
export async function hashBytes(bytes: ArrayBuffer): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    try {
      return Array.from(new Uint8Array(await subtle.digest("SHA-256", bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
    } catch {
      // 아래 대체 해시로 간다.
    }
  }
  const view = new Uint8Array(bytes);
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (const byte of view) {
    a = Math.imul(a ^ byte, 0x01000193) >>> 0;
    b = Math.imul(b + byte + 0x9e3779b9, 0x85ebca6b) >>> 0;
  }
  return `fnv-${view.length}-${a.toString(16)}-${b.toString(16)}`;
}

type Located = { identity: string; name: string; segments: string[] };

// 칩이 가리키는 파일의 정체. 워크스페이스 폴더를 알면 절대 경로(`..` 정리, macOS 의 /private/tmp 는 /tmp 로)이고, 모르면 워크스페이스 id 와 정리한 상대 경로다.
function locate(a: Pick<Attachment, "workspaceId" | "path">, dirOf: DirOf): Located {
  const dir = a.workspaceId ? dirOf(a.workspaceId) : undefined;
  const full = a.path.startsWith("/") ? a.path : dir ? `${dir}/${a.path}` : null;
  if (full) {
    const parts = normalize(full);
    return { identity: `/${parts.join("/")}`, name: parts[parts.length - 1] ?? "", segments: parts.slice(0, -1) };
  }
  const parts = normalize(a.path);
  return { identity: `${a.workspaceId ?? ""}:${parts.join("/")}`, name: parts[parts.length - 1] ?? "", segments: parts.slice(0, -1) };
}

function normalize(path: string): string[] {
  const out: string[] = [];
  for (const part of path.replace(/^\/private(?=\/(?:tmp|var)(?:\/|$))/, "").split("/")) {
    if (!part || part === ".") continue;
    if (part === ".." && out.length && out[out.length - 1] !== "..") out.pop();
    else out.push(part);
  }
  return out;
}

// 폴더 경로들의 끝 몇 칸을 보이면 서로 달라지는지. 끝까지 늘려도 같으면(워크스페이스를 모를 때 상대 경로가 같은 경우) 가장 긴 폴더 경로를 쓴다.
function uniqueDepth(all: string[][]) {
  const longest = Math.max(...all.map((s) => s.length), 1);
  for (let depth = 1; depth <= longest; depth++) {
    if (new Set(all.map((s) => s.slice(-depth).join("/"))).size === all.length) return depth;
  }
  return longest;
}
