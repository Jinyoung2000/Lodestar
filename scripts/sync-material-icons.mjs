import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const extensions = join(homedir(), ".vscode/extensions");
const source = process.argv[2] ?? join(extensions, readdirSync(extensions).filter((name) => name.startsWith("pkief.material-icon-theme-")).sort().at(-1) ?? "");
const theme = JSON.parse(readFileSync(join(source, "dist/material-icons.json"), "utf8"));
const version = JSON.parse(readFileSync(join(source, "package.json"), "utf8")).version;

const publicDir = join(root, "public/material-icons");
rmSync(publicDir, { recursive: true, force: true });
mkdirSync(publicDir, { recursive: true });
let copied = 0;
for (const [id, { iconPath }] of Object.entries(theme.iconDefinitions)) {
  const from = resolve(join(source, "dist"), iconPath);
  if (!existsSync(from)) continue;
  copyFileSync(from, join(publicDir, `${id}.svg`));
  copied++;
}
copyFileSync(join(source, "LICENSE.txt"), join(publicDir, "LICENSE.txt"));

// 열린 폴더 아이콘은 닫힌 폴더 id 에 -open 을 붙인 것과 같다. 다르면 따로 적는다.
const expandedOverrides = (closed, expanded) => Object.fromEntries(Object.entries(closed).filter(([name, id]) => expanded[name] !== `${id}-open`).map(([name]) => [name, expanded[name]]));
const light = theme.light;
const out = {
  version,
  file: theme.file,
  folder: theme.folder,
  folderExpanded: theme.folderExpanded,
  fileNames: theme.fileNames,
  fileExtensions: theme.fileExtensions,
  languageIds: theme.languageIds,
  folderNames: theme.folderNames,
  folderExpandedOverrides: expandedOverrides(theme.folderNames, theme.folderNamesExpanded),
  light: {
    fileNames: light.fileNames,
    fileExtensions: light.fileExtensions,
    languageIds: light.languageIds,
    folderNames: light.folderNames,
    folderExpandedOverrides: expandedOverrides(light.folderNames, light.folderNamesExpanded),
  },
};
mkdirSync(join(root, "web/material-icons"), { recursive: true });
writeFileSync(join(root, "web/material-icons/theme.json"), JSON.stringify(out));
console.log(`material-icon-theme ${version}: ${copied} svg, theme.json ${JSON.stringify(out).length} bytes`);
