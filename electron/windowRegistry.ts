import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseRegistry, serializeRegistry, type Registry } from "../shared/windows";

export function loadRegistry(file: string): Registry {
  try {
    return parseRegistry(readFileSync(file, "utf8"));
  } catch {
    return parseRegistry(null);
  }
}

export function saveRegistry(file: string, registry: Registry) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, serializeRegistry(registry));
  } catch (error) {
    console.error("[windows] could not save the window list", error);
  }
}
