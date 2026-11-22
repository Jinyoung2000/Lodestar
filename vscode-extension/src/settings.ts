import { homedir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";
import { normalizeOpenIn, type OpenIn } from "./chatState";
import type { DaemonSettings } from "./daemon";

export function readSettings(): DaemonSettings {
  const config = vscode.workspace.getConfiguration("lodestar");
  const port = config.get<number>("port", 7788);
  const home = config.get<string>("home", "").trim() || process.env.AGENT_NAV_HOME || join(homedir(), ".agent-nav");
  return { port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 7788, home };
}

export function readOpenIn(): OpenIn {
  return normalizeOpenIn(vscode.workspace.getConfiguration("lodestar").get("openSessionIn"));
}
