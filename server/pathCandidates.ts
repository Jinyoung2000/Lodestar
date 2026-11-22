import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export function candidateDirs(home: string): string[] {
  const dirs = [join(home, ".local/bin"), join(home, ".volta/bin"), join(home, ".bun/bin"), ...fnmDirs(home), ...nvmDirs(home), "/opt/homebrew/bin", "/usr/local/bin"];
  return dirs.filter(isDir);
}

function isDir(path: string) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function listDirs(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function versionParts(name: string) {
  return name.replace(/^v/, "").split(".").map((part) => Number.parseInt(part, 10) || 0);
}

export function newestFirst(names: string[]): string[] {
  return [...names].sort((a, b) => {
    const x = versionParts(a);
    const y = versionParts(b);
    for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
    return 0;
  });
}

function fnmDirs(home: string): string[] {
  for (const root of [join(home, ".local/share/fnm"), join(home, "Library/Application Support/fnm"), join(home, ".fnm")]) {
    const alias = join(root, "aliases/default/bin");
    if (isDir(alias)) return [alias];
    const versions = newestFirst(listDirs(join(root, "node-versions")));
    const found = versions.map((v) => join(root, "node-versions", v, "installation/bin")).find(isDir);
    if (found) return [found];
  }
  return [];
}

function nvmDirs(home: string): string[] {
  const root = process.env.NVM_DIR && isDir(process.env.NVM_DIR) ? process.env.NVM_DIR : join(home, ".nvm");
  const installed = newestFirst(listDirs(join(root, "versions/node")));
  if (installed.length === 0) return [];
  let alias = readAlias(root, "default");
  for (let hops = 0; hops < 5 && alias; hops++) {
    const next = readAlias(root, alias);
    if (!next) break;
    alias = next;
  }
  const wanted = alias && /^v?\d/.test(alias) ? (alias.startsWith("v") ? alias : `v${alias}`) : null;
  const match = wanted ? installed.find((name) => name === wanted || name.startsWith(`${wanted}.`)) : undefined;
  return [join(root, "versions/node", match ?? installed[0], "bin")];
}

function readAlias(root: string, name: string): string | null {
  try {
    return readFileSync(join(root, "alias", name), "utf8").trim() || null;
  } catch {
    return null;
  }
}
