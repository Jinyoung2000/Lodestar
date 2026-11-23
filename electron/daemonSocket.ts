import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";

export type DaemonState = {
  state: "running" | "restarting" | "stopped";
  attempt: number;
  maxAttempts: number;
  port: number;
  pid: number | null;
  reload?: true;
};

export type DaemonEvent = DaemonState | { restart: boolean | "deferred" };

export function daemonSocket(home: string) {
  const uid = process.getuid?.();
  const dir = `/tmp/lodestar-${uid}`;
  mkdirSync(dir, { mode: 0o700, recursive: true });
  const info = lstatSync(dir);
  if (!info.isDirectory() || info.uid !== uid || (info.mode & 0o077)) throw new Error("Invalid Lodestar socket directory");
  const id = createHash("sha256").update(realpathSync(home)).digest("hex").slice(0, 32);
  return join(dir, `${id}.sock`);
}
