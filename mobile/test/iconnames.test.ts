import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { MATERIAL_ICONS } from "../src/ui/iconNames";
import { expect, run, test } from "./harness";

// 안드로이드에서 아이콘이 빈칸으로 나오는 것을 막는다: 소스에서 <Icon name=...> 에 쓰는 SF 이름이 모두 표에 있어야 한다.
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sources(path) : /\.tsx$/.test(name) ? [path] : [];
  });
}

test("<Icon name> 에 쓰는 SF 이름이 모두 Material 이름으로 매핑된다", () => {
  const used = new Set<string>();
  for (const file of sources(join(__dirname, "../src"))) {
    if (file.endsWith("Icon.tsx") || file.endsWith("Icon.android.tsx")) continue;
    for (const call of readFileSync(file, "utf8").matchAll(/<Icon name=(\{[^}]*\}|"[^"]*")/g)) for (const literal of call[1].matchAll(/"([a-z][a-z.]*)"/g)) used.add(literal[1]);
  }
  expect(used.size >= 20, `found only ${used.size} names`);
  const missing = [...used].filter((name) => !(name in MATERIAL_ICONS));
  expect(missing.length === 0, `no Material symbol for ${missing.join(", ")}`);
  return `${used.size} names`;
});

void run();
