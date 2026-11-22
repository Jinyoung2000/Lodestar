import { existsSync, readFileSync, writeFileSync } from "node:fs";

export function writeIfChanged(path, text) {
  if (existsSync(path) && readFileSync(path, "utf8") === text) return false;
  writeFileSync(path, text);
  return true;
}
