import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeIfChanged } from "./writeIfChanged.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tokens = JSON.parse(readFileSync(join(root, "design-system/tokens.json"), "utf8"));
const dir = join(root, "design-system/directions");
const out = join(root, "web/directions");
mkdirSync(out, { recursive: true });

const SECTIONS = ["radius", "spacing", "size"];
const ids = [];
for (const name of readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) {
  const direction = JSON.parse(readFileSync(join(dir, name), "utf8"));
  const lines = ["/* lint-tokens: generated */", `html[data-direction="${direction.id}"] {`];
  for (const section of SECTIONS) {
    const known = new Set(tokens[section].tokens.map((t) => t.name));
    for (const [token, value] of Object.entries(direction[section] ?? {})) {
      if (!known.has(token)) throw new Error(`${name}: ${section} 토큰 "${token}" 이 tokens.json 에 없다`);
      lines.push(`  --${token}: ${value};`);
    }
  }
  lines.push("}");
  writeIfChanged(join(out, `${direction.id}.css`), lines.join("\n") + "\n");
  ids.push(direction.id);
}
console.log(`web/directions: ${ids.join(", ")}`);
