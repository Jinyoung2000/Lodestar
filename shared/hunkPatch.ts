
export type DiffKind = "modify" | "new" | "delete";

export type DiffHunk = {
  index: number;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  text: string;
  hash: string;
};

export type ParsedDiff = { kind: DiffKind; mode: string | null; binary: boolean; hunks: DiffHunk[] };

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function textHash(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

export function parseGitDiff(diff: string): ParsedDiff {
  const lines = diff.split("\n");
  let kind: DiffKind = "modify";
  let mode: string | null = null;
  let binary = false;
  const hunks: DiffHunk[] = [];
  let current: { header: RegExpExecArray; body: string[] } | null = null;
  const flush = () => {
    if (!current) return;
    const text = `${current.body.join("\n")}\n`;
    const [, os, ol, ns, nl] = current.header;
    hunks.push({ index: hunks.length, oldStart: Number(os), oldLines: ol === undefined ? 1 : Number(ol), newStart: Number(ns), newLines: nl === undefined ? 1 : Number(nl), text, hash: textHash(text) });
    current = null;
  };
  for (const line of lines) {
    const header = HUNK.exec(line);
    if (header) {
      flush();
      current = { header, body: [line] };
      continue;
    }
    if (current) {
      if (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ") || line.startsWith("\\")) current.body.push(line);
      else flush();
      continue;
    }
    const newFile = /^new file mode (\d+)/.exec(line);
    const deleted = /^deleted file mode (\d+)/.exec(line);
    if (newFile) {
      kind = "new";
      mode = newFile[1];
    } else if (deleted) {
      kind = "delete";
      mode = deleted[1];
    } else if (/^Binary files .* differ$|^GIT binary patch/.test(line)) binary = true;
  }
  flush();
  return { kind, mode, binary, hunks };
}

export function buildHunkPatch(rel: string, parsed: Pick<ParsedDiff, "kind" | "mode">, hunk: DiffHunk): string {
  const head = `diff --git a/${rel} b/${rel}\n`;
  const mode = parsed.mode ?? "100644";
  if (parsed.kind === "new") return `${head}new file mode ${mode}\n--- /dev/null\n+++ b/${rel}\n${hunk.text}`;
  if (parsed.kind === "delete") return `${head}deleted file mode ${mode}\n--- a/${rel}\n+++ /dev/null\n${hunk.text}`;
  return `${head}--- a/${rel}\n+++ b/${rel}\n${hunk.text}`;
}

export function newFileDiff(text: string, mode = "100644"): ParsedDiff {
  if (text === "") return { kind: "new", mode, binary: false, hunks: [] };
  const endsWithNewline = text.endsWith("\n");
  const lines = (endsWithNewline ? text.slice(0, -1) : text).split("\n");
  const body = [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => `+${line}`)];
  if (!endsWithNewline) body.push("\\ No newline at end of file");
  const hunkText = `${body.join("\n")}\n`;
  return { kind: "new", mode, binary: false, hunks: [{ index: 0, oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, text: hunkText, hash: textHash(hunkText) }] };
}

export const patchSafePath = (rel: string) => !/["\\\x00-\x1f\x7f]/.test(rel);
