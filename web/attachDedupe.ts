import type { Attachment } from "./store";


type DirOf = (workspaceId: string) => string | undefined;
type Chip = Pick<Attachment, "workspaceId" | "path" | "startLine" | "endLine" | "session" | "note" | "browser" | "handoff" | "image" | "file" | "quote">;

export function chipIdentity(a: Chip, dirOf: DirOf): string | null {
  if (a.quote) return null;
  if (a.handoff) return `handoff:${a.handoff.sourceId}`;
  if (a.session) return `session:${a.path}`;
  if (a.note) return `note:${a.path}`;
  if (a.image) return a.image.hash ? `image:${a.image.hash}` : null;
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

export function nameTails(attachments: readonly (Chip & { id: string })[], dirOf: DirOf): Map<string, string> {
  const groups = new Map<string, { id: string; where: Located }[]>();
  for (const a of attachments) {
    if (a.handoff || a.session || a.note || a.image || a.browser || a.file || a.quote) continue;
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

export function chipTitle(a: Pick<Attachment, "path" | "startLine" | "endLine">) {
  if (a.startLine == null) return a.path;
  return a.startLine === a.endLine ? `${a.path}:${a.startLine}` : `${a.path}:${a.startLine}-${a.endLine}`;
}

export async function hashBytes(bytes: ArrayBuffer): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    try {
      return Array.from(new Uint8Array(await subtle.digest("SHA-256", bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
    } catch {
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

function uniqueDepth(all: string[][]) {
  const longest = Math.max(...all.map((s) => s.length), 1);
  for (let depth = 1; depth <= longest; depth++) {
    if (new Set(all.map((s) => s.slice(-depth).join("/"))).size === all.length) return depth;
  }
  return longest;
}
