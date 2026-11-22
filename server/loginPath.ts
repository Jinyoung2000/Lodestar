import { execFile } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { candidateDirs } from "./pathCandidates";

export type ShellRunner = (shell: string, args: string[], timeoutMs: number) => Promise<string>;
export type LoginPathDeps = { run: ShellRunner; now: () => number; home: string; shell: string; candidates: (home: string) => string[]; systemPath?: () => string };
export type LoginPathReport = { source: "login shell" | "fallback"; node: string | null; npm: string | null; error: string | null };

const SENTINEL = "__LODESTAR_PATH__";
const ATTEMPTS: { flag: string; timeoutMs: number }[] = [
  { flag: "-lic", timeoutMs: 20_000 },
  { flag: "-lc", timeoutMs: 20_000 },
];
const BACKOFF_MS = [5_000, 15_000, 60_000, 300_000];

const shellRunner: ShellRunner = (shell, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    const child = execFile(shell, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
    child.stdin?.end();
  });

export function createLoginPath(overrides: Partial<LoginPathDeps> = {}) {
  const deps: LoginPathDeps = { run: shellRunner, now: Date.now, home: homedir(), shell: process.env.SHELL || "/bin/zsh", candidates: candidateDirs, ...overrides };
  let cached = "";
  let pending: Promise<string> | null = null;
  let nextTryAt = 0;
  let failures = 0;
  let lastError: string | null = null;

  async function read(): Promise<string> {
    const errors: string[] = [];
    for (const { flag, timeoutMs } of ATTEMPTS) {
      try {
        const out = await deps.run(deps.shell, [flag, `printf '\\n${SENTINEL}%s\\n' "$PATH"`], timeoutMs);
        const path = parse(out);
        if (path) return path;
        errors.push(`${flag}: no PATH in the output`);
      } catch (error) {
        errors.push(`${flag}: ${(error as Error).message.split("\n")[0]}`);
      }
    }
    lastError = errors.join("; ");
    return "";
  }

  function load(force = false): Promise<string> {
    if (pending) return pending;
    if (!force && cached) return Promise.resolve(cached);
    if (!force && deps.now() < nextTryAt) return Promise.resolve(cached);
    pending = read()
      .then((path) => {
        if (path) {
          cached = path;
          failures = 0;
          nextTryAt = 0;
          lastError = null;
        } else {
          failures++;
          nextTryAt = deps.now() + BACKOFF_MS[Math.min(failures - 1, BACKOFF_MS.length - 1)];
        }
        return cached;
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  }

  function withLoginPath(path: string | undefined) {
    const parts = [cached, path, ...deps.candidates(deps.home)].filter(Boolean).join(delimiter).split(delimiter);
    return [...new Set(parts.filter(Boolean))].join(delimiter);
  }

  function report(path: string | undefined = process.env.PATH): LoginPathReport {
    const full = withLoginPath(path);
    return { source: cached ? "login shell" : "fallback", node: findExecutable("node", full), npm: findExecutable("npm", full), error: cached ? null : lastError };
  }

  return { loginShellPath: load, withLoginPath, report, hasLoginPath: () => cached !== "" };
}

function parse(out: string): string {
  const at = out.lastIndexOf(SENTINEL);
  if (at < 0) return "";
  const path = out.slice(at + SENTINEL.length).split("\n")[0].trim();
  return path.includes("/") ? path : "";
}

export function findExecutable(name: string, path: string | undefined): string | null {
  if (name.includes("/")) return isExecutable(name) ? name : null;
  for (const dir of (path ?? "").split(delimiter)) {
    if (!dir) continue;
    const file = join(dir, name);
    if (isExecutable(file)) return file;
  }
  return null;
}

function isExecutable(file: string) {
  try {
    if (!statSync(file).isFile()) return false;
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

const shared = createLoginPath();
export const loginShellPath = (options: { force?: boolean } = {}) => shared.loginShellPath(options.force === true);
export const withLoginPath = shared.withLoginPath;
export const loginPathReport = shared.report;

const PRIME_RETRY_MS = [10_000, 30_000, 90_000];

export async function primeLoginPath(log: (line: string) => void, onPath: () => void) {
  for (let attempt = 0; ; attempt++) {
    await loginShellPath({ force: true });
    onPath();
    const r = loginPathReport();
    const found = `node=${r.node ?? "not found"} npm=${r.npm ?? "not found"}`;
    if (r.source === "login shell") {
      log(`[path] ${found} (PATH from the login shell)`);
      return;
    }
    const wait = PRIME_RETRY_MS[attempt];
    log(`[path] ${found} (PATH from fallback folders; the login shell could not be read: ${r.error ?? "unknown"}${wait ? `; trying again in ${wait / 1000}s` : ""})`);
    if (!wait) return;
    await new Promise((resolve) => setTimeout(resolve, wait).unref());
  }
}
