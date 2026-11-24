import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { realDir } from "./paths";

export function claudeProjectsDir(env: NodeJS.ProcessEnv = process.env) {
  return join(env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");
}

const projectDirName = (cwd: string) => cwd.replace(/[^A-Za-z0-9]/g, "-");

export function findTranscript(claudeSessionId: string, cwd: string | null, projects = claudeProjectsDir()): string | null {
  const name = `${claudeSessionId}.jsonl`;
  if (cwd) {
    for (const base of new Set([cwd, realDir(cwd)])) {
      const file = join(projects, projectDirName(base), name);
      if (existsSync(file)) return file;
    }
  }
  if (!existsSync(projects)) return null;
  for (const dir of readdirSync(projects)) {
    const file = join(projects, dir, name);
    if (existsSync(file)) return file;
  }
  return null;
}
