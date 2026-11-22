import { existsSync } from "node:fs";
import { join } from "node:path";
import theme from "../web/material-icons/theme.json";
import { fileIconId, folderIconId, type IconTheme } from "../web/materialIcons";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed++;
};
const t: IconTheme = theme;

const file = (name: string, expected: string, scheme: "dark" | "light" = "dark") => check(`file ${name} [${scheme}] -> ${expected}`, fileIconId(t, name, scheme) === expected, fileIconId(t, name, scheme));
const folder = (name: string, open: boolean, expected: string, scheme: "dark" | "light" = "dark") => check(`folder ${name}${open ? " (open)" : ""} [${scheme}] -> ${expected}`, folderIconId(t, name, open, scheme) === expected, folderIconId(t, name, open, scheme));

file(".coderabbit.yaml", "coderabbit-ai");
file(".gitignore", "git");
file(".git-blame-ignore-revs", "git");
file("Dockerfile.query-rabbit", "docker");
file("Dockerfile.query-rabbit.dockerignore", "docker");
file(".dockerignore", "docker");
file("yarn.lock", "yarn");
file("README.md", "readme");
file("package.json", "nodejs");

file("docker-compose.yml", "docker");
file("tsconfig.json", "tsconfig");
file("vite.config.ts", "vite");
file("a.test.ts", "test-ts");
file("a.spec.tsx", "test-jsx");
file("types.d.ts", "typescript-def");
file("a.ts", "typescript");
file("A.TS", "typescript");
file("App.tsx", "react_ts");
file("a.yml", "yaml");
file("a.yaml", "yaml");
file("deploy.sh", "console");
file("schema.graphql", "graphql");
file("x.lock", "lock");
file("src/web/App.tsx", "react_ts");
file("C:\\work\\.gitignore", "git");
file("bin/deploy", "file");
file("notes.unknownext", "file");
file("", "file");
file("Makefile", "makefile");
file("setup.cfg", "settings");

file("Cargo.toml", "toml_light", "light");
file("Cargo.toml", "toml", "dark");
file("a.ts", "typescript", "light");
file("vercel.json", "vercel_light", "light");

folder("src", false, "folder-src");
folder("src", true, "folder-src-open");
folder("SRC", false, "folder-src");
folder("test", false, "folder-test");
folder(".github", true, "folder-github-open");
folder("node_modules", false, "folder-node");
folder("node_modules", true, "folder-node-open");
folder(".deploy", false, "folder");
folder(".deploy", true, "folder-open");
folder("unknown-dir", false, "folder");
folder("idea", false, "folder-intellij_light", "light");
folder("idea", true, "folder-intellij-open_light", "light");

const missing = new Set<string>();
const all = [...Object.values(t.fileNames), ...Object.values(t.fileExtensions), ...Object.values(t.languageIds), ...Object.values(t.folderNames), t.file, t.folder, t.folderExpanded];
for (const id of new Set(all)) if (!existsSync(join(import.meta.dirname, "../public/material-icons", `${id}.svg`))) missing.add(id);
check("매핑이 가리키는 SVG 가 모두 있다", missing.size === 0, [...missing].slice(0, 5).join(","));
check("열린 폴더 SVG 가 있다", [...new Set(Object.values(t.folderNames))].every((id) => existsSync(join(import.meta.dirname, "../public/material-icons", `${id}-open.svg`))));
check("라이선스 파일이 같이 있다", existsSync(join(import.meta.dirname, "../public/material-icons/LICENSE.txt")));

if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nall passed");
