import { execFile, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { homedir, platform, release } from "node:os";
import { basename } from "node:path";
import type { WebSocket } from "ws";
import { claudeEnv } from "./claude";
import { T } from "./strings";

const require = createRequire(import.meta.url);

type PtyModule = typeof import("@lydell/node-pty");

let ptyModule: PtyModule | null = null;
let loadError: string | null = null;
try {
  ptyModule = require("@lydell/node-pty") as PtyModule;
} catch (error) {
  loadError = String((error as Error).message).split("\n")[0];
}

export function bridgePty(socket: WebSocket, cwd: string, cols: number, rows: number, ptyId: string | null = null) {
  if (!ptyModule) {
    socket.send(`\r\n${T.terminalUnavailable(String(loadError))}\r\n`);
    socket.close(1011, "pty unavailable");
    return;
  }
  const shell = process.env.SHELL ?? "/bin/zsh";
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(claudeEnv())) if (value !== undefined) env[key] = value;
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  const term = ptyModule.spawn(shell, ["-l"], { name: "xterm-256color", cols, rows, cwd, env });
  console.log(`[pty] start pid=${term.pid} cwd=${cwd}`);
  if (ptyId) live.set(ptyId, { pid: term.pid, startCwd: cwd });
  term.onData((data) => {
    if (socket.readyState === socket.OPEN) socket.send(data);
  });
  term.onExit(({ exitCode }) => {
    console.log(`[pty] exit pid=${term.pid} code=${exitCode}`);
    if (socket.readyState === socket.OPEN) socket.close(1000, "shell exited");
  });
  socket.on("message", (raw) => {
    let message: { t: string; d?: string; cols?: number; rows?: number };
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (message.t === "d" && typeof message.d === "string") term.write(message.d);
    else if (message.t === "r" && message.cols && message.rows) term.resize(Math.max(2, message.cols), Math.max(1, message.rows));
  });
  socket.on("close", () => {
    if (ptyId && live.get(ptyId)?.pid === term.pid) live.delete(ptyId);
    term.kill();
  });
}

const live = new Map<string, { pid: number; startCwd: string }>();

export async function ptyInfo(ptyId: string): Promise<{ cwd: string; shell: string; os: string }> {
  const entry = live.get(ptyId);
  const cwd = (entry ? await processCwd(entry.pid) : null) ?? entry?.startCwd ?? homedir();
  return { cwd, shell: basename(process.env.SHELL ?? "/bin/zsh"), os: osName() };
}

function processCwd(pid: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { timeout: 2000 }, (error, stdout) => {
      const line = error ? undefined : stdout.split("\n").find((l) => l.startsWith("n"));
      resolve(line ? line.slice(1) : null);
    });
  });
}

let osLabel: string | null = null;
function osName() {
  if (osLabel) return osLabel;
  if (platform() === "darwin") {
    try {
      osLabel = `macOS ${execFileSync("sw_vers", ["-productVersion"], { encoding: "utf8", timeout: 2000 }).trim()}`;
    } catch {
      osLabel = "macOS";
    }
  } else osLabel = `${platform()} ${release()}`;
  return osLabel;
}
