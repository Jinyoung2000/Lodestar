import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, "..", "..", "shared", "relayNoise.ts");
const target = join(here, "..", "src", "net", "relayNoise.generated.ts");
const body = readFileSync(source, "utf8");

if (process.argv.includes("--check")) {
  if (!existsSync(target) || readFileSync(target, "utf8") !== body) {
    console.error("mobile/src/net/relayNoise.generated.ts is out of date. Run npm run relay in mobile/.");
    process.exit(1);
  }
} else {
  writeFileSync(target, body);
}
