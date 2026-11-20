import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const dataHome = () => process.env.AGENT_NAV_HOME ?? join(homedir(), ".agent-nav");

export const settingsFile = () => join(dataHome(), "settings.json");

export function savedSettings(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(settingsFile(), "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}
