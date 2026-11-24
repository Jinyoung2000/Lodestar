import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const shared = join(here, "..", "..", "shared");
const src = join(here, "..", "src");
const typesFromShared = (body) => body.replace(/^import type (.+) from "\.\/(.+)";$/gm, 'import type $1 from "@shared/$2";');

const copies = [
  { source: join(shared, "relayNoise.ts"), target: join(src, "net", "relayNoise.generated.ts"), name: "mobile/src/net/relayNoise.generated.ts", change: (body) => body },
  { source: join(shared, "mateCore.ts"), target: join(src, "logic", "mateCore.generated.ts"), name: "mobile/src/logic/mateCore.generated.ts", change: typesFromShared },
];

let stale = false;
for (const copy of copies) {
  const body = copy.change(readFileSync(copy.source, "utf8"));
  if (!process.argv.includes("--check")) writeFileSync(copy.target, body);
  else if (!existsSync(copy.target) || readFileSync(copy.target, "utf8") !== body) {
    console.error(`${copy.name} is out of date. Run npm run relay in mobile/.`);
    stale = true;
  }
}
if (stale) process.exit(1);
