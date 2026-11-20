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

// 세션 cwd 에서 뜨는 진짜 셸. 브라우저의 xterm 과 WebSocket 으로 잇는다.
// 클라이언트 → 서버: JSON {t:"d", d} 입력, {t:"r", cols, rows} 크기. 서버 → 클라이언트: 출력 문자열 그대로.
// 사용자가 터미널 탭을 열 때만 만들어지고, 에이전트가 이 경로를 쓰는 일은 없다.
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

// TERMASK: 화면이 붙인 ptyId 로 셸을 찾아 지금 작업 폴더를 읽는다. 셸이 cd 한 뒤의 값은 시작 폴더와 다르므로 프로세스의 cwd 를 lsof 로 본다.
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
