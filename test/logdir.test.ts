import { logDirFor } from "../electron/logDir";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed++;
};

const user = "/Users/me";
const legacy = "/Users/me/Library/Logs/agent-nav";
check("no AGENT_NAV_HOME: legacy folder", logDirFor(undefined, user, "agent-nav") === legacy);
check("default home spelled out: legacy folder", logDirFor("/Users/me/.agent-nav", user, "agent-nav") === legacy && logDirFor("/Users/me/.agent-nav/", user, "agent-nav") === legacy);
check("test home: logs under that home", logDirFor("/tmp/agent-nav-checks", user, "agent-nav") === "/tmp/agent-nav-checks/logs");
check("empty string is treated as unset", logDirFor("", user, "agent-nav") === legacy);
if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("all passed");
