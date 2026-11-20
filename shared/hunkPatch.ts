// FIX6B: hunk 단위 stage 와 unstage. git 이 `git diff -U0` 로 낸 글을 hunk 로 나누고, 고른 hunk 하나만 가진 패치를 만든다.
// 패치는 서버(server/scm.ts)가 `git apply --cached --unidiff-zero` 로 인덱스에 적용한다(unstage 는 -R). hunk 경계를 git 이 정하므로 줄바꿈 없는 파일 끝 표시(`\ No newline at end of file`)와 빈 범위 표기가 그대로 따라온다.

export type DiffKind = "modify" | "new" | "delete";

export type DiffHunk = {
  index: number;
  // 옛 쪽과 새 쪽의 시작 줄(1부터)과 줄 수. 줄 수가 0 이면 시작은 그 앞 줄이다(git 표기).
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  // `@@ ... @@` 줄부터 본문 끝까지, 줄바꿈으로 끝난다
  text: string;
  // 본문이 바뀌었는지 가리는 지문. 화면이 읽은 뒤 파일이 바뀌었으면 stage 를 거절하는 데 쓴다.
  hash: string;
};

export type ParsedDiff = { kind: DiffKind; mode: string | null; binary: boolean; hunks: DiffHunk[] };

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

// 암호용이 아닌 짧은 지문(cyrb53). 브라우저와 Node 가 같은 값을 낸다.
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
      // 본문 줄은 항상 + - 공백 \ 로 시작한다. 그 밖(빈 마지막 줄, 다음 파일의 diff --git)에서 hunk 가 끝난다.
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

// 이름 바뀜을 거쳐 온 파일이어도 인덱스에 있는 새 이름의 평범한 수정 패치로 만든다(hunk 의 줄 번호는 옛 이름 쪽 내용 기준이다).
export function buildHunkPatch(rel: string, parsed: Pick<ParsedDiff, "kind" | "mode">, hunk: DiffHunk): string {
  const head = `diff --git a/${rel} b/${rel}\n`;
  const mode = parsed.mode ?? "100644";
  if (parsed.kind === "new") return `${head}new file mode ${mode}\n--- /dev/null\n+++ b/${rel}\n${hunk.text}`;
  if (parsed.kind === "delete") return `${head}deleted file mode ${mode}\n--- a/${rel}\n+++ /dev/null\n${hunk.text}`;
  return `${head}--- a/${rel}\n+++ b/${rel}\n${hunk.text}`;
}

// 추적하지 않는 새 파일은 git diff 에 나오지 않는다. 같은 모양의 hunk 하나를 글에서 직접 만든다. 빈 파일은 hunk 가 없다.
export function newFileDiff(text: string, mode = "100644"): ParsedDiff {
  if (text === "") return { kind: "new", mode, binary: false, hunks: [] };
  const endsWithNewline = text.endsWith("\n");
  const lines = (endsWithNewline ? text.slice(0, -1) : text).split("\n");
  const body = [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => `+${line}`)];
  if (!endsWithNewline) body.push("\\ No newline at end of file");
  const hunkText = `${body.join("\n")}\n`;
  return { kind: "new", mode, binary: false, hunks: [{ index: 0, oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, text: hunkText, hash: textHash(hunkText) }] };
}

// 패치 첫 줄 `diff --git a/<경로> b/<경로>` 에 안전하게 쓸 수 있는 경로인지. 따옴표, 역슬래시, 제어 문자가 있으면 git 이 경로를 따옴표로 감싸 쓰므로 파일 단위 stage 를 쓰게 한다.
export const patchSafePath = (rel: string) => !/["\\\x00-\x1f\x7f]/.test(rel);
