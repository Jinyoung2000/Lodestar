import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CommandInfo } from "../shared/protocol";

// `/` 메뉴의 스킬과 명령은 데몬을 띄울 때 한 번 읽은 목록이라, 그 뒤에 만든 스킬과 워크스페이스 폴더의 스킬이 빠진다.
// 사용자 폴더와 워크스페이스 폴더의 .claude 를 그때그때 읽어 보충한다(디스크만 읽으니 싸다).

function frontmatterDescription(text: string): string {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return "";
  const lines = m[1].split(/\r?\n/);
  const at = lines.findIndex((l) => l.startsWith("description:"));
  if (at < 0) return "";
  const first = lines[at].slice("description:".length).trim();
  // `>` 와 `|` 는 다음 들여쓴 줄들이 값이다
  if (/^[>|][+-]?$/.test(first)) {
    const body: string[] = [];
    for (const l of lines.slice(at + 1)) {
      if (l.trim() && !/^\s/.test(l)) break;
      if (l.trim()) body.push(l.trim());
    }
    return body.join(" ");
  }
  return first.replace(/^(["'])([\s\S]*)\1$/, "$2");
}

function read(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function names(dir: string) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function scan(root: string): CommandInfo[] {
  const found: CommandInfo[] = [];
  for (const entry of names(join(root, "skills"))) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const text = read(join(root, "skills", entry.name, "SKILL.md"));
    if (text) found.push({ name: entry.name, description: frontmatterDescription(text) });
  }
  for (const entry of names(join(root, "commands"))) {
    if (!entry.name.endsWith(".md")) continue;
    found.push({ name: entry.name.slice(0, -3), description: frontmatterDescription(read(join(root, "commands", entry.name))) });
  }
  return found;
}

export function localCommands(workspaceDir: string): CommandInfo[] {
  const seen = new Set<string>();
  return [...scan(join(workspaceDir, ".claude")), ...scan(join(homedir(), ".claude"))].filter((c) => !seen.has(c.name) && !!seen.add(c.name));
}
