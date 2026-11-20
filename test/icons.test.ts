import { readFileSync } from "node:fs";

const css = readFileSync("node_modules/@vscode/codicons/dist/codicon.css", "utf8");
const glyphs = new Set([...css.matchAll(/^\.codicon-([a-z0-9-]+):before/gm)].map((m) => m[1]));
const source = readFileSync("web/icons.tsx", "utf8");
const used = new Set([...source.matchAll(/make\("([a-z0-9-]+)"\)/g)].map((m) => m[1]));

const missing = [...used].filter((name) => !glyphs.has(name));
if (used.size < 60) throw new Error(`아이콘 이름을 ${used.size}개만 찾았다. 파싱이 깨졌는지 확인한다`);
if (missing.length > 0) throw new Error(`codicon 표에 없는 이름: ${missing.join(", ")}`);
console.log(`icons 시험 통과 (${used.size}개 이름)`);
