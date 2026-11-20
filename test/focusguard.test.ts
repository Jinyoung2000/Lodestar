// Bash 명령의 포커스 가드(server/focusGuard.ts) 판정 시험. 순수 함수와 데몬의 훅 함수(가짜 훅 입력)만 부르고 명령은 실행하지 않는다. 실행: npm test
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "agent-nav-focusguard-unit-"));
process.env.AGENT_NAV_HOME = join(home, "nav");
mkdirSync(process.env.AGENT_NAV_HOME, { recursive: true });

const { guardBashCommand, FOCUS_DENY_REASON } = await import("../server/focusGuard");
const { AgentRunner } = await import("../server/agents");
const { Store } = await import("../server/store");

const cases: { name: string; run: () => void }[] = [];
const test = (name: string, run: () => void) => cases.push({ name, run });
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
};
const rewritten = (command: string) => {
  const r = guardBashCommand(command);
  return r.action === "rewrite" ? r.command : r.action === "deny" ? `DENY ${r.matched}` : "PASS";
};
const same = (command: string, wanted: string) => {
  const got = rewritten(command);
  expect(got === wanted, `${command}\n  got    ${got}\n  wanted ${wanted}`);
};
const passes = (command: string) => same(command, "PASS");
const denies = (command: string) => {
  const r = guardBashCommand(command);
  expect(r.action === "deny" && r.reason === FOCUS_DENY_REASON, `${command} should be denied, got ${JSON.stringify(r)}`);
};

test("open -a 앱 URL 에 -g 를 붙인다", () => {
  same('open -a Aside "https://x"', 'open -g -a Aside "https://x"');
  same("open -a Aside https://x", "open -g -a Aside https://x");
  same("open -b com.apple.Safari https://x", "open -g -b com.apple.Safari https://x");
  same("open /Applications/Foo.app", "open -g /Applications/Foo.app");
  same("/usr/bin/open -a Foo", "/usr/bin/open -g -a Foo");
});

test("-g 가 이미 있으면 그대로 둔다", () => {
  passes("open -ga Aside");
  passes("open -g -a Aside https://x");
  passes("open -nga Aside");
  passes("open --background -a Aside");
  passes("open -a Aside -g https://x");
});

test("-j 같은 다른 플래그는 유지하고 -g 만 더한다", () => {
  same("open -j -a Aside https://x", "open -g -j -a Aside https://x");
  same("open -ja Aside", "open -g -ja Aside");
  same("open -n -a Foo --args --flag", "open -g -n -a Foo --args --flag");
});

test("--args 뒤의 -g 는 앱 인자라 세지 않는다", () => {
  same("open -a Foo --args -g", "open -g -a Foo --args -g");
});

test("&&, ;, |, 줄바꿈으로 이어진 명령 안의 open", () => {
  same('open -a "Google Chrome" url && sleep 1', 'open -g -a "Google Chrome" url && sleep 1');
  same("cd x; open -a Foo", "cd x; open -g -a Foo");
  same("sleep 1 && open -a Foo || echo fail", "sleep 1 && open -g -a Foo || echo fail");
  same("echo hi | open -f", "echo hi | open -g -f");
  same("cd x\nopen -a Foo\nls", "cd x\nopen -g -a Foo\nls");
  same("open -a A u1 && open -ga B u2 && open -a C u3", "open -g -a A u1 && open -ga B u2 && open -g -a C u3");
});

test("브라우저 기본 열기도 앱을 활성화하므로 -g 를 붙인다", () => {
  same("open https://url", "open -g https://url");
  same("open http://127.0.0.1:5199/a?b=1&c=2", "open -g http://127.0.0.1:5199/a?b=1&c=2");
});

test("따옴표 안의 open -a 문자열은 건드리지 않는다", () => {
  passes('echo "open -a Foo"');
  passes("echo 'open -a Foo' && ls");
  passes('git commit -m "open -a Aside fix"');
  passes("grep 'open -a' file");
  same('echo "open -a Foo"; open -a Bar', 'echo "open -a Foo"; open -g -a Bar');
});

test("open 이 명령 자리에 있지 않으면 건드리지 않는다", () => {
  passes("git open");
  passes("echo open -a Foo");
  passes("xdg-open url");
  passes("gh browse");
  passes("man open");
});

test("앞머리(환경변수, env, sudo, time, nohup, 예약어, 명령 치환) 뒤의 open", () => {
  same("FOO=1 open -a Foo", "FOO=1 open -g -a Foo");
  same("env FOO=1 open -a Foo", "env FOO=1 open -g -a Foo");
  same("nohup open -a Foo &", "nohup open -g -a Foo &");
  same("time open -a Foo", "time open -g -a Foo");
  same("if true; then open -a Foo; fi", "if true; then open -g -a Foo; fi");
  same("for u in a b; do open -a Foo $u; done", "for u in a b; do open -g -a Foo $u; done");
  same("echo $(open -a Foo)", "echo $(open -g -a Foo)");
  same("(open -a Foo)", "(open -g -a Foo)");
  same("echo a | xargs -n 1 open", "echo a | xargs -n 1 open -g");
});

test("리다이렉션의 & 는 명령 경계가 아니다", () => {
  same("open -a Foo >/dev/null 2>&1", "open -g -a Foo >/dev/null 2>&1");
  same("open -a Foo &>/dev/null; echo ok", "open -g -a Foo &>/dev/null; echo ok");
});

test("osascript activate 와 System Events 입력은 막는다", () => {
  denies(`osascript -e 'tell application "Aside" to activate'`);
  denies(`osascript -e 'tell application "System Events" to keystroke "a"'`);
  denies(`osascript -e 'tell application "System Events" to key code 36'`);
  denies(`osascript -e 'tell application "System Events" to click at {10, 10}'`);
  denies(`osascript -e 'tell application "System Events" to set frontmost of process "Aside" to true'`);
  denies(`osascript -e 'tell application "Google Chrome"' -e 'activate' -e 'end tell'`);
  denies(`osascript -e "tell application \\"Aside\\" to activate"`);
  denies(`cd x && osascript -e 'tell app "Finder" to activate'`);
  denies(`osascript -l JavaScript -e 'Application("Aside").activate()'`);
  denies(`osascript -lJavaScript -e 'Application("System Events").keystroke("a")'`);
  denies(`osascript <<'EOF'\ntell application "Aside"\n  activate\nend tell\nEOF`);
  denies(`osascript <<EOF\ntell application "System Events" to keystroke "x"\nEOF`);
  denies("cliclick c:100,100");
});

test("무관한 osascript 는 통과한다", () => {
  passes(`osascript -e 'display notification "done" with title "Lodestar"'`);
  passes(`osascript -e 'display notification "please activate it" with title "x"'`);
  passes(`osascript -e 'tell application "Finder" to get name of startup disk'`);
  passes(`osascript -e 'return (get volume settings)'`);
  passes(`osascript -e 'set x to 1 -- activate later'`);
  passes(`osascript -l JavaScript -e 'Application("Finder").name()'`);
  passes(`echo "osascript -e 'tell app \\"X\\" to activate'"`);
});

test("스크립트 파일은 읽을 수 있을 때만 본다", () => {
  const read = (path: string) => (path === "/tmp/a.scpt" ? 'tell application "Aside" to activate' : path === "/tmp/b.scpt" ? 'display notification "x"' : null);
  expect(guardBashCommand("osascript /tmp/a.scpt", { readScript: read }).action === "deny", "script file with activate");
  expect(guardBashCommand("osascript /tmp/b.scpt", { readScript: read }).action === "pass", "harmless script file");
  expect(guardBashCommand("osascript /tmp/unknown.scpt", { readScript: read }).action === "pass", "unreadable file passes");
});

test("deny 가 rewrite 보다 먼저다", () => {
  const r = guardBashCommand(`open -a Foo && osascript -e 'tell app "Foo" to activate'`);
  expect(r.action === "deny", `got ${r.action}`);
});

test("빈 명령, 주석, 이상한 입력에도 죽지 않는다", () => {
  passes("");
  passes("   ");
  passes("# open -a Foo");
  passes("echo 'unterminated open -a Foo");
  same("open -a Foo # comment", "open -g -a Foo # comment");
  passes("ls -la");
  passes("npm test && git status");
});

const store = new Store();
const runner = new AgentRunner(store, () => undefined);
const now = new Date().toISOString();
store.addAgent({ id: "fg", workspaceId: null, cwd: home, worktree: null, forkedFrom: null, resumeFrom: null, startCommit: null, feedbackId: null, title: "t", sessionId: null, status: "idle", permissionMode: "bypassPermissions", model: null, effort: null, activeModel: null, activeEffort: null, backgroundTasks: 0, createdAt: now, updatedAt: now } as unknown as Parameters<typeof store.addAgent>[0]);
type Hook = (agentId: string, input: Record<string, unknown>) => { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string; updatedInput?: Record<string, unknown> } };
const hook = (command: unknown, event = "PreToolUse") => (runner as unknown as { guardFocus: Hook }).guardFocus("fg", { hook_event_name: event, tool_name: "Bash", tool_input: { command, description: "d" } });
const notices = () => store.timeline("fg").filter((i) => i.kind === "notice");

test("훅: open 은 updatedInput 으로 고치고 permissionDecision 은 건드리지 않으며 알림 줄을 남긴다", () => {
  const out = hook('open -a Aside "https://x"').hookSpecificOutput;
  expect(out?.updatedInput?.command === 'open -g -a Aside "https://x"' && out?.updatedInput?.description === "d", JSON.stringify(out));
  expect(out?.permissionDecision === undefined, "허용 여부는 CLI 판정에 맡긴다");
  expect(notices().length === 1, "알림 줄 1개");
});

test("훅: osascript activate 는 deny 와 이유를 돌려주고 알림 줄을 남긴다", () => {
  const out = hook(`osascript -e 'tell application "Aside" to activate'`).hookSpecificOutput;
  expect(out?.permissionDecision === "deny" && out.permissionDecisionReason === FOCUS_DENY_REASON, JSON.stringify(out));
  expect(notices().length === 2, "알림 줄 2개");
});

test("훅: 무관한 명령, 다른 이벤트, 이상한 입력은 빈 결과이고 알림이 없다", () => {
  expect(JSON.stringify(hook("ls -la")) === "{}", "ls");
  expect(JSON.stringify(hook("open -a Foo", "PostToolUse")) === "{}", "다른 이벤트");
  expect(JSON.stringify(hook(undefined)) === "{}" && JSON.stringify(hook(42)) === "{}", "command 가 문자열이 아님");
  expect(notices().length === 2, "알림 그대로");
});

test("훅: 설정을 끄면 아무것도 하지 않고, 다시 켜면 읽는다(훅이 설정을 그때그때 읽는다)", () => {
  store.updateSettings({ focusGuard: false });
  expect(JSON.stringify(hook("open -a Foo")) === "{}" && JSON.stringify(hook(`osascript -e 'tell app "X" to activate'`)) === "{}", "꺼짐");
  store.updateSettings({ focusGuard: "yes" as never });
  expect(store.settings.focusGuard === false, "boolean 이 아닌 값은 무시");
  store.updateSettings({ focusGuard: true });
  expect(hook("open -a Foo").hookSpecificOutput?.updatedInput?.command === "open -g -a Foo", "켜짐");
});

test("훅: 모르는 세션이어도 판정은 그대로 나간다(알림 줄만 못 남긴다)", () => {
  const guard = (command: string) => (runner as unknown as { guardFocus: Hook }).guardFocus("no-such", { hook_event_name: "PreToolUse", tool_input: { command } }).hookSpecificOutput;
  expect(guard(`osascript -e 'tell app "X" to activate'`)?.permissionDecision === "deny", "deny");
  expect(guard("open -a Foo")?.updatedInput?.command === "open -g -a Foo", "rewrite");
});

test("설정 기본값은 켬", () => {
  const fresh = new Store();
  expect(fresh.settings.focusGuard === true, "default true");
});

let failed = 0;
for (const { name, run } of cases) {
  try {
    run();
    console.log(`ok   ${name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${name}\n${(error as Error).message}`);
  }
}
if (failed) {
  console.log(`${failed} failed`);
  process.exit(1);
}
console.log(`${cases.length} focusguard cases passed`);
process.exit(0);
