import { join } from "node:path";
import { DEFAULT_SEARCH_SETTINGS, parseVscodeSearchSettings, type SearchSettings } from "../shared/searchSettings";
import { defaultPaths, fileIo, parseJsonc, type DefaultsIo } from "./defaults";

const CACHE_MS = 5000;

export function readSearchSettings(io: DefaultsIo, vscodeUserDir: string): SearchSettings {
  try {
    const text = io.readText(join(vscodeUserDir, "settings.json"));
    if (text === null) return DEFAULT_SEARCH_SETTINGS;
    const value = parseJsonc(text);
    return value && typeof value === "object" && !Array.isArray(value) ? parseVscodeSearchSettings(value as Record<string, unknown>) : DEFAULT_SEARCH_SETTINGS;
  } catch {
    return DEFAULT_SEARCH_SETTINGS;
  }
}

let cache: { at: number; value: SearchSettings } | null = null;

export function searchSettings(): SearchSettings {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const paths = defaultPaths();
  cache = { at: Date.now(), value: readSearchSettings(fileIo(paths), paths.vscodeUserDir) };
  return cache.value;
}
