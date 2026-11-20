import { join, resolve } from "node:path";

// 데몬 로그를 둘 폴더. 기본 홈(~/.agent-nav)을 쓰는 앱은 옛 이름의 ~/Library/Logs/agent-nav 를 그대로 쓰고,
// AGENT_NAV_HOME 을 바꿔 띄운 시험 인스턴스는 그 홈 아래 logs/ 로 보낸다. 시험 데몬의 오류가 사용자의 앱 로그에 섞이지 않게 한다.
export function logDirFor(agentNavHome: string | undefined, userHome: string, legacyName: string): string {
  const legacy = join(userHome, "Library", "Logs", legacyName);
  if (!agentNavHome || resolve(agentNavHome) === resolve(userHome, ".agent-nav")) return legacy;
  return join(resolve(agentNavHome), "logs");
}
