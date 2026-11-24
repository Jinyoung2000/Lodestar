import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const shared = join(here, "..", "..", "shared");
const src = join(here, "..", "src");
const typesFromShared = (body) => body.replace(/^import type (.+) from "\.\/(.+)";$/gm, 'import type $1 from "@shared/$2";');

const browserScript = (source, globalName) => () => {
  const { outputFiles } = buildSync({ entryPoints: [source], bundle: true, format: "iife", globalName, minify: true, target: "es2019", write: false, legalComments: "none" });
  return `export const ${globalName.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase()}_SCRIPT = ${JSON.stringify(outputFiles[0].text.trim())};\n`;
};

const copies = [
  { source: join(shared, "relayNoise.ts"), target: join(src, "net", "relayNoise.generated.ts"), name: "mobile/src/net/relayNoise.generated.ts", change: (body) => body },
  { source: join(shared, "mateCore.ts"), target: join(src, "logic", "mateCore.generated.ts"), name: "mobile/src/logic/mateCore.generated.ts", change: typesFromShared },
  { build: browserScript(join(shared, "mermaid.ts"), "LodestarMermaid"), target: join(src, "logic", "mermaidScript.generated.ts"), name: "mobile/src/logic/mermaidScript.generated.ts" },
];

let stale = false;
for (const copy of copies) {
  const body = copy.build ? copy.build() : copy.change(readFileSync(copy.source, "utf8"));
  if (!process.argv.includes("--check")) writeFileSync(copy.target, body);
  else if (!existsSync(copy.target) || readFileSync(copy.target, "utf8") !== body) {
    console.error(`${copy.name} is out of date. Run npm run relay in mobile/.`);
    stale = true;
  }
}
if (stale) process.exit(1);
