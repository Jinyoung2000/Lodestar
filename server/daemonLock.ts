import { spawnSync } from "node:child_process";
import { closeSync, openSync } from "node:fs";

export function lockDaemonFile(path: string): number | null {
  const file = openSync(path, "a", 0o600);
  const lock = spawnSync("/usr/bin/lockf", ["-ks", "-t", "0", "3"], { stdio: ["ignore", "ignore", "pipe", file] });
  if (lock.status === 0) return file;
  closeSync(file);
  if (lock.status === 75) return null;
  throw new Error(`Could not lock ${path}: ${lock.error?.message ?? lock.stderr?.toString().trim() ?? lock.status}`);
}
