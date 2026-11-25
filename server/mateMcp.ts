import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ASSISTANT_SERVER, ASSISTANT_TOOLS } from "../shared/assistant";
import { daemonEnv } from "./sessionEnv";

export type McpLaunch = { name: string; command: string; args: string[]; env: Record<string, string> };

const BRIDGE_BIN = resolve(dirname(fileURLToPath(import.meta.url)), "../bin/lodestar.mjs");

export function mateMcpLaunch(agentId: string): McpLaunch | null {
  if (!existsSync(BRIDGE_BIN)) return null;
  return {
    name: ASSISTANT_SERVER,
    command: process.execPath,
    args: [BRIDGE_BIN, "mate-mcp"],
    env: { ...daemonEnv(), LODESTAR_SESSION_ID: agentId, ELECTRON_RUN_AS_NODE: "1" },
  };
}

export function codexMcpConfig(launch: McpLaunch | null): Record<string, unknown> {
  if (!launch) return {};
  const key = `mcp_servers.${launch.name}`;
  return { [`${key}.command`]: launch.command, [`${key}.args`]: launch.args, [`${key}.env`]: launch.env, [`${key}.startup_timeout_sec`]: 20 };
}

export function acpMcpServers(launch: McpLaunch | null) {
  if (!launch) return [];
  return [{ name: launch.name, command: launch.command, args: launch.args, env: Object.entries(launch.env).map(([name, value]) => ({ name, value })) }];
}

const MATE_TOOL_NAMES = new Set<string>(Object.values(ASSISTANT_TOOLS));
const NEVER_MATE_KINDS = new Set(["edit", "delete", "move", "execute"]);

export function isMateToolCall(call: unknown): boolean {
  if (!call || typeof call !== "object") return false;
  const { name, title, toolCallId, kind } = call as { name?: unknown; title?: unknown; toolCallId?: unknown; kind?: unknown };
  if (typeof kind === "string" && NEVER_MATE_KINDS.has(kind)) return false;
  const labels = [name, title, toolCallId].filter((value): value is string => typeof value === "string");
  return labels.some((label) => label.includes(ASSISTANT_SERVER) || MATE_TOOL_NAMES.has(label) || [...MATE_TOOL_NAMES].some((tool) => label.endsWith(`__${tool}`) || label.endsWith(`.${tool}`) || label.endsWith(`/${tool}`)));
}
