import { homedir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";
import { normalizeOpenIn, type OpenIn } from "./chatState";
import type { DaemonSettings } from "./daemon";

// 시험용 VS Code 는 셸 환경 변수를 확장 호스트에 못 넘기므로 설정(lodestar.home)이 먼저다.
export function readSettings(): DaemonSettings {
  const config = vscode.workspace.getConfiguration("lodestar");
  const port = config.get<number>("port", 7788);
  const home = config.get<string>("home", "").trim() || process.env.AGENT_NAV_HOME || join(homedir(), ".agent-nav");
  return { port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 7788, home };
}

// 세션을 사이드바 Chat 뷰에 열지 에디터 탭에 열지.
export function readOpenIn(): OpenIn {
  return normalizeOpenIn(vscode.workspace.getConfiguration("lodestar").get("openSessionIn"));
}
