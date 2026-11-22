import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Agent, Workspace } from "../shared/protocol";
import { chatFolderGuidance, projectsParent } from "../shared/sessionFolders";
import { sessionRef } from "../shared/sessionRef";
import { findExecutable, withLoginPath } from "./loginPath";
import { HOME } from "./store";

const DAEMON_PORT = process.env.AGENT_NAV_PORT ?? "7788";

export function daemonEnv(): Record<string, string> {
  return { LODESTAR_DAEMON_PORT: DAEMON_PORT, LODESTAR_DAEMON_HOME: HOME };
}

export function sessionEnv(agentId: string): Record<string, string> {
  return { LODESTAR_SESSION_ID: agentId, LODESTAR_SESSION_REF: sessionRef(agentId), ...daemonEnv() };
}

const realOrNull = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
};

let cachedCommand: { at: number; command: string | null } | null = null;
const COMMAND_TTL_MS = 60_000;

export function lodestarCommand(): string | null {
  if (cachedCommand && Date.now() - cachedCommand.at < COMMAND_TTL_MS) return cachedCommand.command;
  const loginPath = withLoginPath(process.env.PATH);
  const ownBin = resolve(dirname(fileURLToPath(import.meta.url)), "../bin/lodestar.mjs");
  const own = existsSync(ownBin) ? realOrNull(ownBin) : null;
  const onPath = findExecutable("lodestar", loginPath);
  const node = findExecutable("node", loginPath);
  const command = onPath && (!own || realOrNull(onPath) === own) ? "lodestar" : own && node ? `node "${own}"` : onPath ? "lodestar" : null;
  cachedCommand = { at: Date.now(), command };
  return command;
}

export function chatGuidance(agent: Pick<Agent, "id" | "workspaceId" | "feedbackId">, workspaces: readonly Workspace[], options: { explicitId: boolean }): string | null {
  if (agent.workspaceId !== null || agent.feedbackId) return null;
  const command = lodestarCommand();
  if (!command) return null;
  return chatFolderGuidance({ parent: projectsParent(workspaces, homedir()), command, ...(options.explicitId ? { sessionId: agent.id } : {}) });
}
