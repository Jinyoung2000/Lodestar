import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

export type LspPlan =
  | { kind: "native"; exe: string; version: string; tsDir: string }
  | { kind: "tsls"; tsserverPath: string | null; workspaceVersion: string | null; reason: string | null };

export type WorkspaceTypeScript = { dir: string; version: string | null };

export async function planLanguageServer(workspaceDir: string, platform = process.platform, arch = process.arch): Promise<LspPlan> {
  const workspace = findWorkspaceTypeScript(workspaceDir);
  if (!workspace) return { kind: "tsls", tsserverPath: null, workspaceVersion: null, reason: null };

  const name = workspace.version ? `TypeScript ${workspace.version}` : "TypeScript";
  const tsserverPath = join(workspace.dir, "lib/tsserver.js");
  const hasTsserver = existsSync(tsserverPath);
  const major = majorOf(workspace.version);
  const wantsNative = major !== null ? major >= 7 : !hasTsserver;
  if (!wantsNative) {
    return {
      kind: "tsls",
      tsserverPath: hasTsserver ? tsserverPath : null,
      workspaceVersion: workspace.version,
      reason: hasTsserver ? null : `Workspace ${name} at ${workspace.dir}/lib has no tsserver.js.`,
    };
  }

  const found = await resolveNativeExe(workspace.dir, platform, arch);
  if (found.exe) return { kind: "native", exe: found.exe, version: workspace.version ?? "7", tsDir: workspace.dir };
  return {
    kind: "tsls",
    tsserverPath: null,
    workspaceVersion: workspace.version,
    reason: `Workspace ${name} has no tsserver.js and its native executable was not found (${found.problem}).`,
  };
}

export function findWorkspaceTypeScript(dir: string): WorkspaceTypeScript | null {
  for (let current = dir; ; current = dirname(current)) {
    const candidate = join(current, "node_modules/typescript");
    const manifest = readManifest(join(candidate, "package.json"));
    if (manifest) return { dir: candidate, version: typeof manifest.version === "string" ? manifest.version : null };
    if (dirname(current) === current) return null;
  }
}

export function majorOf(version: string | null) {
  const major = Number(/^(\d+)\./.exec(version ?? "")?.[1]);
  return Number.isFinite(major) ? major : null;
}

export async function resolveNativeExe(tsDir: string, platform = process.platform, arch = process.arch): Promise<{ exe: string | null; problem: string }> {
  let problem = "no getExePath.js and no @typescript/typescript-" + `${platform}-${arch} package`;
  const getExePath = join(tsDir, "lib/getExePath.js");
  if (existsSync(getExePath)) {
    try {
      const mod = (await import(pathToFileURL(getExePath).href)) as { default?: () => string };
      const exe = mod.default?.();
      if (exe && isExecutable(exe)) return { exe, problem: "" };
      problem = `getExePath.js returned ${JSON.stringify(exe)}`;
    } catch (error) {
      problem = `getExePath.js failed: ${(error as Error).message}`;
    }
  }
  const exe = findNativeExe(tsDir, platform, arch);
  return exe ? { exe, problem: "" } : { exe: null, problem };
}

export function findNativeExe(tsDir: string, platform = process.platform, arch = process.arch): string | null {
  const pkg = `typescript-${platform}-${arch}`;
  const bin = platform === "win32" ? "tsc.exe" : "tsc";
  const starts = new Set([tsDir, safeRealpath(tsDir)]);
  for (const start of starts) {
    for (let current = dirname(start); ; current = dirname(current)) {
      const bases = basename(current) === "node_modules" ? [current] : [join(current, "node_modules")];
      for (const base of bases) {
        const exe = join(base, "@typescript", pkg, "lib", bin);
        if (isExecutable(exe)) return exe;
      }
      if (dirname(current) === current) break;
    }
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

function readManifest(path: string): { version?: unknown } | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as { version?: unknown };
  } catch {
    return null;
  }
}

function safeRealpath(path: string) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
