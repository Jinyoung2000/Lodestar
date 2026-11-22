import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import type { BlameCommit, FileBlame } from "../shared/protocol";
import { resolveReadable } from "./files";
import * as gitOps from "./git";
import { realDir, realPathLoose } from "./paths";

const MAX_BYTES = 2_000_000;
const MAX_MESSAGES = 300;
const MAX_MESSAGE_CHARS = 4000;

export async function blameOf(dir: string, path: string, text?: string): Promise<FileBlame | null> {
  const root = await gitOps.repoRoot(dir);
  if (!root) return null;
  if (text !== undefined && text.length > MAX_BYTES) return null;
  const absolute = await resolveReadable(dir, path);
  const rel = relative(realDir(root), realPathLoose(absolute));
  if (!rel || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) return null;
  const head = await gitOps.headCommit(root);
  if (!head) return null;
  const identity = text !== undefined ? `text:${createHash("sha1").update(text).digest("hex")}` : await diskIdentity(absolute);
  if (identity === null) return null;
  const key = `${root}\0${rel}\0${head}\0${identity}`;
  const hit = cache.get(key);
  if (hit !== undefined) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const blame = await runBlame(root, rel, text);
  if (blame) {
    cache.set(key, blame);
    if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value as string);
  }
  return blame;
}

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
    output = await gitOps.git(root, ["blame", "--porcelain", ...(text !== undefined ? ["--contents", "-"] : []), "--", rel], text !== undefined ? { input: text } : {});
  } catch {
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

export function parseBlame(output: string): { commits: ParsedCommit[]; lines: number[] } {
  const commits: ParsedCommit[] = [];
  const indexOf = new Map<string, number>();
  const lines: number[] = [];
  let current: ParsedCommit | null = null;
  for (const row of output.split("\n")) {
    if (row.startsWith("\t")) {
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
  }
  return messages;
}
