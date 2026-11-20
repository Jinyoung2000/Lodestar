// 모바일 번들(Metro)은 앱 폴더 밖의 shared/ 를 읽지 못한다. src/ 에서 shared 를 가져오는 줄은 전부 `import type` 이어야 한다(Babel 이 지운다).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, run, test } from "./harness";

function walk(dir: string, out: string[] = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(path);
  }
  return out;
}

test("src/ 의 shared 가져오기는 모두 import type", () => {
  const files = walk(join(import.meta.dirname, "..", "src"));
  const bad: string[] = [];
  let typeImports = 0;
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/^(import|export)\b[^;]*?from\s+["']([^"']+)["']/gms)) {
      if (!/(^@shared\/|(^|\/)shared\/|\.\.\/\.\.?\/server)/.test(match[2])) continue;
      if (/^import\s+type\b/.test(match[0])) typeImports++;
      else bad.push(`${file}: ${match[0].split("\n")[0]}`);
    }
  }
  expect(bad.length === 0, bad.join("\n"));
  expect(typeImports > 0, "found no type imports at all, the scan is broken");
  return `${typeImports} type-only imports in ${files.length} files`;
});

void run();
