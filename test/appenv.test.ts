import { claudeEnv, stripAppEnv } from "../server/claude";

const fake = {
  AGENT_NAV_PORT: "7788",
  AGENT_NAV_HOME: "/Users/x/.agent-nav",
  AGENT_NAV_ROOT: "/Applications/agent-nav.app/Contents/Resources",
  AGENT_NAV_RUNTIME: "bundle",
  ELECTRON_RUN_AS_NODE: "1",
  ELECTRON_NO_ATTACH_CONSOLE: "1",
  CLAUDECODE: "1",
  CLAUDE_CODE_ENTRYPOINT: "cli",
  PATH: "/usr/bin:/bin",
  HOME: "/Users/x",
  MY_TOKEN: "keep",
  NODE_ENV: "development",
};

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed++;
};

const stripped = stripAppEnv(fake);
check("AGENT_NAV_* variables are removed", Object.keys(stripped).every((k) => !k.startsWith("AGENT_NAV_")), Object.keys(stripped).join(","));
check("ELECTRON_* variables are removed", Object.keys(stripped).every((k) => !k.startsWith("ELECTRON_")));
check("Inherited Claude Code session variables are still removed", stripped.CLAUDECODE === undefined && stripped.CLAUDE_CODE_ENTRYPOINT === undefined);
check("Variables the user set in their shell are kept", stripped.PATH === fake.PATH && stripped.HOME === fake.HOME && stripped.MY_TOKEN === "keep" && stripped.NODE_ENV === "development");
check("The input object is not modified", fake.AGENT_NAV_PORT === "7788");

const env = claudeEnv(fake);
check("claudeEnv drops the app variables and tags the client app", env.AGENT_NAV_PORT === undefined && env.ELECTRON_RUN_AS_NODE === undefined && env.CLAUDE_AGENT_SDK_CLIENT_APP?.startsWith("agent-nav/") === true);

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("all passed");
