import { execFile } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, normalize, sep } from "node:path";


export type ToolOrigin = "configured" | "vite-plus" | "workspace" | "package" | "module" | "global" | "path" | "bundled" | "ancestor";
export type ToolLocation = { path: string; loader: "node" | "native"; args: string[]; origin: ToolOrigin };
export type Resolution = { tool: ToolLocation | null; why: string };

export type ResolveEnv = {
  home: string;
  pathVar: string;
  extensionsDir: string;
  builtinExtensionsDir: string;
  globalRoots: () => Promise<string[]>;
};

export function defaultResolveEnv(env: NodeJS.ProcessEnv = process.env): ResolveEnv {
  const home = homedir();
  return {
    home,
    pathVar: env.PATH ?? "",
    extensionsDir: env.AGENT_NAV_VSCODE_EXTENSIONS_DIR ?? join(home, ".vscode", "extensions"),
    builtinExtensionsDir: env.AGENT_NAV_VSCODE_BUILTIN_EXTENSIONS_DIR ?? "/Applications/Visual Studio Code.app/Contents/Resources/app/extensions",
    globalRoots: () => (globalRootsCache ??= findGlobalRoots(home)),
  };
}

export type ToolContext = {
  workspaceDir: string;
  file: string;
  flat: Record<string, unknown>;
  env: ResolveEnv;
};

let globalRootsCache: Promise<string[]> | undefined;

function findGlobalRoots(home: string): Promise<string[]> {
  const root = (command: string) =>
    new Promise<string | null>((resolve) => {
      execFile(command, ["root", "-g"], { timeout: 2000, shell: true }, (error, stdout) => resolve(error ? null : stdout.trim() || null));
    });
  return Promise.all([root("npm"), root("pnpm")]).then(([npm, pnpm]) => [npm, pnpm, join(home, ".bun", "install", "global", "node_modules")].filter((v): v is string => !!v));
}


export type ExtensionInfo = { id: string; displayName: string; dir: string; version: string };

export function findExtension(extensionsDir: string, id: string): ExtensionInfo | null {
  let names: string[];
  try {
    names = readdirSync(extensionsDir);
  } catch {
    return null;
  }
  let obsolete: Record<string, unknown> = {};
  try {
    obsolete = JSON.parse(readFileSync(join(extensionsDir, ".obsolete"), "utf8")) as Record<string, unknown>;
  } catch {
  }
  const prefix = `${id.toLowerCase()}-`;
  const matches = names
    .filter((name) => name.toLowerCase().startsWith(prefix) && /^\d/.test(name.slice(prefix.length)) && !obsolete[name])
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  const name = matches[0];
  if (!name) return null;
  const dir = join(extensionsDir, name);
  let pkg: { displayName?: string; version?: string } = {};
  try {
    pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as typeof pkg;
  } catch {
    return null;
  }
  return { id, displayName: localized(dir, pkg.displayName) ?? id, dir, version: pkg.version ?? name.slice(prefix.length) };
}

export function findBuiltinExtension(builtinDir: string, id: string): ExtensionInfo | null {
  if (!id.toLowerCase().startsWith("vscode.")) return null;
  const dir = join(builtinDir, id.slice("vscode.".length));
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { displayName?: string; version?: string };
    return { id, displayName: localized(dir, pkg.displayName) ?? id, dir, version: pkg.version ?? "" };
  } catch {
    return null;
  }
}

export function lookupExtension(env: Pick<ResolveEnv, "extensionsDir" | "builtinExtensionsDir">, id: string) {
  return findExtension(env.extensionsDir, id) ?? findBuiltinExtension(env.builtinExtensionsDir, id);
}

function localized(dir: string, value: string | undefined) {
  if (!value) return null;
  const key = /^%(.+)%$/.exec(value)?.[1];
  if (!key) return value;
  try {
    const nls = JSON.parse(readFileSync(join(dir, "package.nls.json"), "utf8")) as Record<string, string | { message?: string }>;
    const entry = nls[key];
    return typeof entry === "string" ? entry : (entry?.message ?? null);
  } catch {
    return null;
  }
}

export function expandSettingPath(value: unknown, home: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (typeof value !== "string" || !value) return null;
  const expanded = value.replaceAll(/\$\{(userHome|env:([^}]+))\}/g, (_all, _name: string, variable: string | undefined) => (variable === undefined ? home : (env[variable] ?? "")));
  return /[$&;|`><!%^]/.test(expanded) ? null : expanded;
}

function inWorkspace(workspaceDir: string, path: string, home: string) {
  if (path === "~" || path.startsWith("~/")) return join(home, path.slice(1));
  return isAbsolute(path) ? normalize(path) : normalize(join(workspaceDir, path));
}

function isFile(path: string) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDir(path: string) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function loaderOf(path: string): "node" | "native" {
  if (/\.(c|m)?js$/.test(path)) return "node";
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.alloc(80);
    const read = readSync(fd, buffer, 0, 80, 0);
    const head = buffer.toString("utf8", 0, read);
    return head.startsWith("#!") && /\bnode\b/.test(head.split("\n")[0]) ? "node" : "native";
  } catch {
    return "native";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function located(path: string, origin: ToolOrigin, args: string[] = []): ToolLocation {
  const real = realpathSync(path);
  return { path: real, loader: loaderOf(real), args, origin };
}

function firstBin(nodeModulesDirs: string[], bin: string): string | null {
  for (const dir of nodeModulesDirs) {
    const candidate = join(dir, ".bin", bin);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function packageBin(startDirs: string[], packageName: string, bin: string): string | null {
  for (const start of startDirs) {
    for (let current = start; ; current = dirname(current)) {
      const pkgDir = join(current, "node_modules", packageName);
      const found = binOfPackage(pkgDir, bin);
      if (found) return found;
      if (dirname(current) === current) break;
    }
  }
  return null;
}

function binOfPackage(pkgDir: string, bin: string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as { bin?: string | Record<string, string> };
    const entry = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.[bin];
    if (!entry) return null;
    const path = join(pkgDir, entry);
    return existsSync(path) ? path : null;
  } catch {
    return null;
  }
}

const SKIP_DIRS = new Set(["node_modules", ".git"]);
const SCAN_DEPTH = 5;
const SCAN_LIMIT = 4000;
const packageDirCache = new Map<string, { at: number; dirs: string[] }>();
const PACKAGE_CACHE_MS = 30_000;

export function packageDirs(workspaceDir: string): string[] {
  const hit = packageDirCache.get(workspaceDir);
  if (hit && Date.now() - hit.at < PACKAGE_CACHE_MS) return hit.dirs;
  const dirs: string[] = [];
  let visited = 0;
  const walk = (dir: string, depth: number) => {
    if (visited++ > SCAN_LIMIT) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.name === "package.json" && e.isFile())) dirs.push(dir);
    if (depth >= SCAN_DEPTH) return;
    for (const entry of entries) if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name), depth + 1);
  };
  walk(workspaceDir, 0);
  packageDirCache.set(workspaceDir, { at: Date.now(), dirs });
  return dirs;
}

function nestedPackageDirs(workspaceDir: string, file: string) {
  const all = packageDirs(workspaceDir).filter((dir) => dir !== workspaceDir);
  const containing = all.filter((dir) => file.startsWith(dir + sep)).sort((a, b) => b.length - a.length);
  return [...containing, ...all.filter((dir) => !containing.includes(dir)).sort()];
}

export function oxcFormatterEnabled(flat: Record<string, unknown>) {
  const own = flat["oxc.enable.oxfmt"];
  if (typeof own === "boolean") return own;
  const master = flat["oxc.enable"];
  return typeof master === "boolean" ? master : true;
}

export async function resolveOxfmt(ctx: ToolContext): Promise<Resolution> {
  const { workspaceDir, file, flat, env } = ctx;
  const configured = flat["oxc.path.oxfmt"];
  if (typeof configured === "string" && configured) {
    const expanded = expandSettingPath(configured, env.home);
    if (!expanded) return { tool: null, why: `oxc.path.oxfmt ("${configured}") contains characters the Oxc extension rejects.` };
    let path = inWorkspace(workspaceDir, expanded, env.home);
    if (path.endsWith(".exe")) path = path.slice(0, -4);
    return isFile(path) ? { tool: located(path, "configured"), why: "" } : { tool: null, why: `oxc.path.oxfmt points to ${path}, which does not exist.` };
  }
  const vitePlus = packageBin([workspaceDir], "vite-plus", "vp");
  if (vitePlus) return { tool: located(vitePlus, "vite-plus", ["fmt"]), why: "" };
  const workspaceBin = firstBin([join(workspaceDir, "node_modules")], "oxfmt");
  if (workspaceBin) return { tool: located(workspaceBin, "workspace"), why: "" };
  const nested = firstBin(
    nestedPackageDirs(workspaceDir, file).map((dir) => join(dir, "node_modules")),
    "oxfmt",
  );
  if (nested) return { tool: located(nested, "package"), why: "" };
  const module = packageBin([workspaceDir], "oxfmt", "oxfmt");
  if (module) return { tool: located(module, "module"), why: "" };
  const roots = await env.globalRoots();
  const globalBin = firstBin(roots, "oxfmt") ?? packageBin(roots.map((root) => dirname(root)), "oxfmt", "oxfmt");
  if (globalBin) return { tool: located(globalBin, "global"), why: "" };
  for (const dir of env.pathVar.split(delimiter)) {
    const candidate = dir && join(dir, "oxfmt");
    if (candidate && isFile(candidate)) return { tool: { path: candidate, loader: "native", args: [], origin: "path" }, why: "" };
  }
  return { tool: null, why: "oxfmt was not found in this workspace, its packages, parent folders, the global npm, pnpm and bun folders, or PATH." };
}

export function prettierEnabled(flat: Record<string, unknown>) {
  return flat["prettier.enable"] !== false;
}

const MIN_PRETTIER = [1, 13, 0];

function versionAtLeast(version: string, min: number[]) {
  const parts = version.split(/[.-]/).map((p) => Number.parseInt(p, 10) || 0);
  for (let i = 0; i < min.length; i++) {
    if ((parts[i] ?? 0) !== min[i]) return (parts[i] ?? 0) > min[i];
  }
  return true;
}

export function resolvePrettier(ctx: ToolContext): Resolution {
  const { workspaceDir, file, flat, env } = ctx;
  let moduleDir: string | null = null;
  let origin: ToolOrigin = "ancestor";
  const configured = flat["prettier.prettierPath"];
  if (typeof configured === "string" && configured) {
    const path = inWorkspace(workspaceDir, configured, env.home);
    if (existsSync(path)) {
      moduleDir = path;
      origin = "configured";
    }
  }
  if (!moduleDir) moduleDir = findPrettierModule(dirname(file));
  if (!moduleDir) {
    const extension = findExtension(env.extensionsDir, "esbenp.prettier-vscode");
    const bundled = extension && join(extension.dir, "node_modules", "prettier");
    if (bundled && isDir(bundled)) {
      moduleDir = bundled;
      origin = "bundled";
    }
  }
  if (!moduleDir) return { tool: null, why: "Prettier was not found in this workspace, and the Prettier extension (with its bundled Prettier) is not installed." };
  let version = "0.0.0";
  let bin: string | undefined;
  try {
    const pkg = JSON.parse(readFileSync(join(moduleDir, "package.json"), "utf8")) as { version?: string; bin?: string | Record<string, string> };
    version = pkg.version ?? version;
    bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.prettier;
  } catch {
    return { tool: null, why: `Failed to load the Prettier module at ${moduleDir}.` };
  }
  if (!versionAtLeast(version, MIN_PRETTIER)) return { tool: null, why: `Prettier ${version} is outdated. The Prettier extension needs 1.13.0 or newer.` };
  const script = bin ? join(moduleDir, bin) : null;
  if (!script || !existsSync(script)) return { tool: null, why: `The Prettier module at ${moduleDir} has no command line entry.` };
  return { tool: { path: realpathSync(script), loader: "node", args: [], origin }, why: "" };
}

function findPrettierModule(startDir: string): string | null {
  for (let dir = startDir; ; dir = dirname(dir)) {
    const modules = join(dir, "node_modules");
    const direct = join(modules, "prettier");
    if (existsSync(direct)) return direct;
    if (existsSync(modules)) {
      try {
        for (const entry of readdirSync(modules)) {
          if (entry.startsWith(".") || entry.startsWith("@")) continue;
          const nested = join(modules, entry, "node_modules", "prettier");
          if (existsSync(nested)) return nested;
        }
      } catch {
      }
    }
    if (existsSync(join(dir, ".do-not-use-prettier-vscode-root")) || dirname(dir) === dir) return null;
  }
}

export function prettierIgnorePath(ctx: ToolContext): string {
  const name = typeof ctx.flat["prettier.ignorePath"] === "string" && ctx.flat["prettier.ignorePath"] ? (ctx.flat["prettier.ignorePath"] as string) : ".prettierignore";
  const direct = inWorkspace(ctx.workspaceDir, name, ctx.env.home);
  if (existsSync(direct)) return direct;
  for (let dir = dirname(ctx.file); ; dir = dirname(dir)) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
    if (existsSync(join(dir, ".do-not-use-prettier-vscode-root")) || dirname(dir) === dir) return direct;
  }
}

export function prettierConfigPath(ctx: ToolContext): string | null {
  const configured = ctx.flat["prettier.configPath"];
  return typeof configured === "string" && configured ? inWorkspace(ctx.workspaceDir, configured, ctx.env.home) : null;
}

export function eslintFormatEnabled(flat: Record<string, unknown>) {
  return flat["eslint.format.enable"] === true;
}

const ESLINT_FLAT_CONFIGS = ["eslint.config.js", "eslint.config.mjs", "eslint.config.cjs", "eslint.config.ts", "eslint.config.mts", "eslint.config.cts"];

export async function resolveEslint(ctx: ToolContext): Promise<Resolution> {
  const { workspaceDir, file, env } = ctx;
  let base = workspaceDir;
  for (let dir = dirname(file); dir.startsWith(workspaceDir); dir = dirname(dir)) {
    if (ESLINT_FLAT_CONFIGS.some((name) => existsSync(join(dir, name)))) {
      base = dir;
      break;
    }
    if (dir === workspaceDir || dirname(dir) === dir) break;
  }
  const local = packageBin([base], "eslint", "eslint");
  if (local) return { tool: located(local, "workspace"), why: "" };
  const roots = await env.globalRoots();
  const global = packageBin(roots.map((root) => dirname(root)), "eslint", "eslint");
  if (global) return { tool: located(global, "global"), why: "" };
  return { tool: null, why: "ESLint was not found in this workspace or in the global npm folder. The ESLint extension does not bundle it." };
}

const CONFIG_FILES = {
  prettier: [".prettierrc", ".prettierrc.json", ".prettierrc.yml", ".prettierrc.yaml", ".prettierrc.json5", ".prettierrc.js", ".prettierrc.cjs", ".prettierrc.mjs", ".prettierrc.ts", "prettier.config.js", "prettier.config.cjs", "prettier.config.mjs", "prettier.config.ts", ".prettierrc.toml"],
  oxc: [".oxfmtrc.json", ".oxfmtrc.jsonc", "oxfmt.config.ts", "oxfmt.config.mts", "oxfmt.config.js", "oxfmt.config.mjs"],
  eslint: [...ESLINT_FLAT_CONFIGS, ".eslintrc", ".eslintrc.js", ".eslintrc.cjs", ".eslintrc.json", ".eslintrc.yml", ".eslintrc.yaml"],
} as const;

export function hasRepoConfig(tool: "prettier" | "oxc" | "eslint", file: string): boolean {
  for (let dir = dirname(file); ; dir = dirname(dir)) {
    if (CONFIG_FILES[tool].some((name) => existsSync(join(dir, name)))) return true;
    if (tool === "prettier") {
      try {
        const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { prettier?: unknown };
        if (pkg.prettier !== undefined) return true;
      } catch {
      }
    }
    if (dirname(dir) === dir) return false;
  }
}
