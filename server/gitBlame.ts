import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import type { BlameCommit, FileBlame } from "../shared/protocol";
import { resolveReadable } from "./files";
import * as gitOps from "./git";
import { realDir, realPathLoose } from "./paths";

// 에디터 current line blame(GitLens 의 줄 끝 주석)의 데이터. git blame --porcelain 을 파일 전체에 한 번 돌려 줄별 커밋으로 푼다.
// 저장 안 한 편집이 있으면 버퍼를 --contents - 로 넘겨 줄 번호를 맞춘다(바뀐 줄은 커밋 안 된 줄로 나온다).
const MAX_BYTES = 2_000_000;
// 이만큼 서로 다른 커밋의 전체 메시지까지만 읽고, 나머지는 제목만 쓴다(hover 카드에서 제목이 전문 자리에 나온다).
const MAX_MESSAGES = 300;
const MAX_MESSAGE_CHARS = 4000;

export async function blameOf(dir: string, path: string, text?: string): Promise<FileBlame | null> {
  const root = await gitOps.repoRoot(dir);
  if (!root) return null;
  if (text !== undefined && text.length > MAX_BYTES) return null;
  const absolute = await resolveReadable(dir, path);
  // 저장소 루트는 git 이 푼 실제 경로로 나오니 파일 경로도 푼 뒤에 상대 경로를 만든다(/tmp/x 와 /private/tmp/x)
  const rel = relative(realDir(root), realPathLoose(absolute));
  if (!rel || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) return null;
  const head = await gitOps.headCommit(root);
  if (!head) return null;
  const identity = text !== undefined ? `text:${createHash("sha1").update(text).digest("hex")}` : await diskIdentity(absolute);
  if (identity === null) return null;
  const key = `${root}\0${rel}\0${head}\0${identity}`;
  const hit = cache.get(key);
  if (hit !== undefined) {
    // 가장 최근에 쓴 항목을 뒤로 옮긴다
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const blame = await runBlame(root, rel, text);
  // 실패(null)는 담지 않는다: 일시적인 git 실패가 다음 요청까지 남지 않게
  if (blame) {
    cache.set(key, blame);
    if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value as string);
  }
  return blame;
}

// 저장소 안 파일 몇 개의 결과만 둔다. 키에 HEAD 와 파일 내용(저장 안 한 글은 해시, 디스크는 수정 시각과 크기)이 들어 있어, 커밋하거나 파일이 바뀌면 키가 달라진다.
const CACHE_SIZE = 24;
const cache = new Map<string, FileBlame>();

async function diskIdentity(absolute: string) {
  const info = await stat(absolute).catch(() => null);
  if (!info?.isFile() || info.size > MAX_BYTES) return null;
  return `disk:${info.mtimeMs}:${info.size}`;
}

async function runBlame(root: string, rel: string, text: string | undefined): Promise<FileBlame | null> {
  let output: string;
  try {
    // 경로는 인자 배열의 마지막 항목이다. -- 뒤라 -로 시작하는 이름도 옵션으로 읽히지 않는다.
    output = await gitOps.git(root, ["blame", "--porcelain", ...(text !== undefined ? ["--contents", "-"] : []), "--", rel], text !== undefined ? { input: text } : {});
  } catch {
    // 추적 안 하는 파일, HEAD 에 없는 파일, 바이너리 같은 실패는 오류로 올리지 않고 표시 없음으로 둔다
    return null;
  }
  const parsed = parseBlame(output);
  const email = (await gitOps.git(root, ["config", "user.email"]).catch(() => "")).trim().toLowerCase();
  const messages = await commitMessages(root, parsed.commits.filter((commit) => !commit.uncommitted).slice(0, MAX_MESSAGES).map((commit) => commit.hash));
  return {
    lines: parsed.lines,
    commits: parsed.commits.map((commit) => ({
      ...commit,
      message: messages.get(commit.hash) ?? commit.summary,
      you: commit.uncommitted || (email !== "" && commit.email.toLowerCase() === email),
    })),
  };
}

export type ParsedCommit = Omit<BlameCommit, "message" | "you">;

// git blame --porcelain 출력을 줄별 커밋으로 푼다. 줄마다 `<해시> <원래 줄> <최종 줄> [묶음 크기]` 머리글과 `\t내용` 이 오고,
// 작성자 같은 메타데이터는 그 커밋이 출력에 처음 나올 때 한 번만 붙는다. 그래서 커밋 정보는 해시로 모으고 줄은 최종 줄 번호로 놓는다.
export function parseBlame(output: string): { commits: ParsedCommit[]; lines: number[] } {
  const commits: ParsedCommit[] = [];
  const indexOf = new Map<string, number>();
  const lines: number[] = [];
  let current: ParsedCommit | null = null;
  for (const row of output.split("\n")) {
    if (row.startsWith("\t")) {
      // 내용 줄: 머리글에서 정한 최종 줄 번호 칸을 채운 것으로 본다(내용 자체는 쓰지 않는다)
      continue;
    }
    const header = HEADER.exec(row);
    if (header) {
      const hash = header[1]!;
      let index = indexOf.get(hash);
      if (index === undefined) {
        const uncommitted = /^0+$/.test(hash);
        index = commits.length;
        indexOf.set(hash, index);
        commits.push({ hash, author: "", email: "", time: 0, summary: "", uncommitted });
      }
      current = commits[index]!;
      lines[Number(header[3]) - 1] = index;
      continue;
    }
    if (!current) continue;
    const space = row.indexOf(" ");
    if (space < 0) continue;
    const value = row.slice(space + 1);
    switch (row.slice(0, space)) {
      case "author":
        current.author = value;
        break;
      case "author-mail":
        current.email = value.replace(/^<|>$/g, "");
        break;
      case "author-time":
        current.time = Number(value) || 0;
        break;
      case "summary":
        current.summary = value;
        break;
    }
  }
  return { commits, lines };
}

const HEADER = /^([0-9a-f]{40,64}) (\d+) (\d+)(?: (\d+))?$/;

// 서로 다른 커밋들의 전체 메시지를 git log 한 번으로 읽는다. 해시는 blame 이 낸 16진수라 그대로 인자가 된다.
async function commitMessages(root: string, hashes: string[]) {
  const messages = new Map<string, string>();
  if (!hashes.length) return messages;
  try {
    const output = await gitOps.git(root, ["log", "--no-walk=unsorted", "--format=%H%x1f%B%x1e", ...hashes]);
    for (const record of output.split("\x1e")) {
      const split = record.indexOf("\x1f");
      if (split < 0) continue;
      messages.set(record.slice(0, split).trim(), record.slice(split + 1).trim().slice(0, MAX_MESSAGE_CHARS));
    }
  } catch {
    // 메시지를 못 읽어도 제목은 있다
  }
  return messages;
}
