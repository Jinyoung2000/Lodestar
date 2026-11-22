import { join, resolve } from "node:path";

export function logDirFor(agentNavHome: string | undefined, userHome: string, legacyName: string): string {
  const legacy = join(userHome, "Library", "Logs", legacyName);
  if (!agentNavHome || resolve(agentNavHome) === resolve(userHome, ".agent-nav")) return legacy;
  return join(resolve(agentNavHome), "logs");
}
