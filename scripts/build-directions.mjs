// design-system/directions/<id>.json 을 읽어 web/directions/<id>.css 를 만든다. 시안은 tokens.json 의 토큰 이름을 덮어쓰는 값 집합이고,
// html[data-direction="<id>"] 일 때만 적용돼 기본 화면에는 영향이 없다. 없는 토큰 이름은 오타라서 실패한다.
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
  const lines = ["/* 생성 파일. scripts/build-directions.mjs 가 design-system/directions/" + name + " 에서 만든다. 직접 고치지 않는다. */", "/* lint-tokens: generated */", `html[data-direction="${direction.id}"] {`];
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
