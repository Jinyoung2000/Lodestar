import { execFile } from "node:child_process";
import * as vscode from "vscode";

// Lodestar.app 의 appId(루트 package.json 의 build.appId). 사용자가 단추를 눌렀을 때만 부른다.
export const APP_BUNDLE_ID = "dev.gene.agent-nav";

// 앱을 앞으로 가져온다. 이미 떠 있으면 앞으로만 오고, 꺼져 있으면 앱이 데몬과 함께 뜬다.
// AGENT_NAV_VSEXT_DRY_RUN=1 이면 실행하지 않고 기록만 한다(시험용: 앱이 앞으로 나오지 않게).
export function launchApp(log: (line: string) => void) {
  if (process.env.AGENT_NAV_VSEXT_DRY_RUN === "1") {
    log(`dry run: open -b ${APP_BUNDLE_ID}`);
    return;
  }
  execFile("/usr/bin/open", ["-b", APP_BUNDLE_ID], (error) => {
    if (error) void vscode.window.showErrorMessage("Could not open Lodestar. Is Lodestar.app installed?");
  });
}
