import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// 로그인 셸을 못 읽었을 때도 node, npm 이 있을 만한 사용자 폴더. 존재하는 폴더만, 우선순위 순서로 돌려준다.
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

// "v20.11.1" 같은 이름을 숫자 배열로. 큰 버전이 먼저 오게 정렬할 때 쓴다.
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

// fnm: 기본 별칭(aliases/default)이 있으면 그것, 없으면 설치된 가장 높은 버전. 저장 위치가 OS 와 버전에 따라 달라서 셋을 다 본다.
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

// nvm: alias/default 가 가리키는 버전의 bin. 별칭이 숫자 접두(20, 20.11), 전체 버전, 다른 별칭(lts/iron)일 수 있다. 풀리지 않으면 설치된 가장 높은 버전.
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
