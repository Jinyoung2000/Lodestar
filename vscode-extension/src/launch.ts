import { execFile } from "node:child_process";
import * as vscode from "vscode";

export const APP_BUNDLE_ID = "dev.gene.agent-nav";

export function launchApp(log: (line: string) => void) {
  if (process.env.AGENT_NAV_VSEXT_DRY_RUN === "1") {
    log(`dry run: open -b ${APP_BUNDLE_ID}`);
    return;
  }
  execFile("/usr/bin/open", ["-b", APP_BUNDLE_ID], (error) => {
    if (error) void vscode.window.showErrorMessage("Could not open Lodestar. Is Lodestar.app installed?");
  });
}
