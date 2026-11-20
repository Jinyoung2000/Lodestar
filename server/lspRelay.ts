import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseJsonc } from "./defaults";
import type { ChildLink, LinkCallbacks, Msg } from "./lspMux";
import { readMessages, writeMessage } from "./lspStdio";


export const RELAY_CONFIG_NAMES = ["relay.config.js", "relay.config.json", "relay.config.cjs", "relay.config.mjs", "relay.config.ts"];
const SKIPPED_DIRS = new Set(["node_modules", "dist", "build", "out", "coverage", "__generated__", "Pods", "target", "release"]);

// relay config 파일이나 package.json 의 relay 항목이 있는 폴더인가.
export function hasRelayConfig(dir: string): boolean {
  if (RELAY_CONFIG_NAMES.some((name) => existsSync(join(dir, name)))) return true;
  try {
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { relay?: unknown };
    return manifest.relay !== undefined && manifest.relay !== null;
  } catch {
    return false;
  }
}

// 워크스페이스에서 Relay 서버를 하나씩 띄울 폴더들.
// 1) 워크스페이스 폴더나 그 조상에 config 가 있으면 그 폴더 하나(relay 바이너리도 cwd 에서 위로 config 를 찾는다).
// 2) 없으면 하위 폴더를 깊이 3까지 훑는다(node_modules, 숨김 폴더, 빌드 산출물 제외). config 를 찾은 폴더 안으로는 더 들어가지 않는다.
export async function findRelayDirs(workspaceDir: string, maxDepth = 3, maxVisited = 2000): Promise<string[]> {
  let current = workspaceDir;
  for (let up = 0; up < 8; up++) {
    if (hasRelayConfig(current)) return [current];
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const found: string[] = [];
  let visited = 0;
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > maxDepth || visited++ > maxVisited) return;
    if (depth > 0 && hasRelayConfig(dir)) {
      found.push(dir);
      return;
    }
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || SKIPPED_DIRS.has(entry.name)) continue;
      await walk(join(dir, entry.name), depth + 1);
    }
  };
  await walk(workspaceDir, 0);
  return found;
}

export type RelaySettings = { pathToRelay?: string; pathToConfig?: string; pathToLocateCommand?: string; lspOutputLevel?: string };

export function readRelaySettings(scopeDir: string, workspaceDir: string): RelaySettings {
  const result: RelaySettings = {};
  for (const dir of [workspaceDir, scopeDir]) {
    let value: unknown;
    try {
      value = parseJsonc(readFileSync(join(dir, ".vscode/settings.json"), "utf8"));
    } catch {
      continue;
    }
    if (!value || typeof value !== "object") continue;
    const settings = value as Record<string, unknown>;
    const pick = (key: string) => (typeof settings[`relay.${key}`] === "string" && settings[`relay.${key}`] !== "" ? (settings[`relay.${key}`] as string) : undefined);
    for (const key of ["pathToRelay", "pathToConfig", "pathToLocateCommand", "lspOutputLevel"] as const) {
      const picked = pick(key);
      if (picked !== undefined) result[key] = picked;
    }
  }
  return result;
}

export function platformBinaryPath(platform = process.platform, arch = process.arch): string | null {
  if (platform === "darwin" && arch === "x64") return join("macos-x64", "relay");
  if (platform === "darwin" && arch === "arm64") return join("macos-arm64", "relay");
  if (platform === "linux" && arch === "x64") return join("linux-x64", "relay");
  if (platform === "linux" && arch === "arm64") return join("linux-arm64", "relay");
  if (platform === "win32" && arch === "x64") return join("win-x64", "relay.exe");
  return null;
}

export type RelayCommand = { exe: string; args: string[]; cwd: string; version: string | null };

// 실행할 명령. 못 만들면 이유(상태 줄에 보인다).
export function planRelay(scopeDir: string, workspaceDir: string, platform = process.platform, arch = process.arch): RelayCommand | { problem: string } {
  const settings = readRelaySettings(scopeDir, workspaceDir);
  const args = ["lsp", `--output=${settings.lspOutputLevel ?? "quiet-with-errors"}`];
  if (settings.pathToConfig) args.push(settings.pathToConfig);
  if (settings.pathToLocateCommand) args.push(`--locateCommand=${settings.pathToLocateCommand}`);
  if (settings.pathToRelay) return { exe: resolve(scopeDir, settings.pathToRelay), args, cwd: scopeDir, version: null };

  const packageDir = findRelayCompilerPackage(scopeDir);
  if (!packageDir) return { problem: `Could not find node_modules/relay-compiler from ${scopeDir}. Run the package install.` };
  const binary = platformBinaryPath(platform, arch);
  if (!binary) return { problem: `Relay has no binary for ${platform} ${arch}.` };
  const exe = join(packageDir, binary);
  if (!isExecutable(exe)) return { problem: `Relay binary not found or not executable: ${exe}` };
  let version: string | null = null;
  try {
    version = (JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as { version?: string }).version ?? null;
  } catch {
    // package.json 을 못 읽어도 바이너리가 있으면 시도한다.
  }
  const major = Number(/^(\d+)\./.exec(version ?? "")?.[1]);
  if (Number.isFinite(major) && major < 14 && !version?.includes("-")) return { problem: `Relay compiler ${version} is too old for the language server (needs 14 or newer).` };
  return { exe, args, cwd: scopeDir, version };
}

function findRelayCompilerPackage(start: string): string | null {
  for (let current = start, hops = 0; hops < 5000; hops++) {
    const candidate = join(current, "node_modules", "relay-compiler");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

function isExecutable(path: string) {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// Relay 는 initialize 뒤에도 소스와 스키마를 읽는 동안 `window/showStatus` 요청으로 단계를 알리고, 끝나면 "The Relay extension is ready" 를 보낸다.
// 그 전의 hover, definition, completion 은 "schema is missing (or not ready, yet)" 오류가 난다.
export function isRelayReady(message: Msg): boolean {
  if (message.method !== "window/showStatus") return false;
  return /\bready\b/i.test(String(message.params?.message ?? "")) || /\bready\b/i.test(String(message.params?.shortMessage ?? ""));
}

export function startRelay(command: RelayCommand, callbacks: LinkCallbacks): ChildLink {
  const child = spawn(command.exe, command.args, { cwd: command.cwd, stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.on("error", () => {});
  console.log(`[lsp] start relay ${command.version ?? ""} pid=${child.pid} dir=${command.cwd} args=${command.args.join(" ")}`);
  let stopped = false;
  let stderrTail = "";
  readMessages(child, (body) => callbacks.message(body));
  child.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    stderrTail = (stderrTail + text).slice(-1500);
    console.error(`[lsp relay stderr] ${text.trim()}`);
  });
  child.on("error", (error) => {
    if (!stopped) callbacks.exit(`spawn failed: ${error.message}`);
  });
  child.on("exit", (code, signal) => {
    console.log(`[lsp] exit relay pid=${child.pid} code=${code} signal=${signal}`);
    if (!stopped) callbacks.exit(exitReason(code ?? signal, stderrTail));
  });
  return {
    send: (text) => writeMessage(child, text),
    stop: () => {
      stopped = true;
      child.kill();
    },
  };
}

// watchman 이 없으면 Relay LSP 가 시작하지 못하고 죽는다(노트: Relay LSP watchman 필수).
function exitReason(code: number | string | null, stderrTail: string) {
  if (/watchman/i.test(stderrTail)) return "Relay needs watchman (brew install watchman).";
  const tail = stderrTail.trim().split("\n").slice(-3).join(" ").slice(0, 300);
  return `Relay exited with code ${code}${tail ? `: ${tail}` : ""}`;
}
