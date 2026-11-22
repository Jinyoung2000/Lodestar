import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APPLY_IDLE_SECONDS, BUILD_IDLE_SECONDS, RETRY_MS, SOURCE_QUIET_SECONDS, idleUpdateStep, type IdleUpdateFacts } from "../shared/idleUpdate";
import { installScript } from "../server/idleUpdate";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed++;
};

const NOW = 10_000_000;
const base: IdleUpdateFacts = {
  enabled: true,
  busy: 0,
  idleSeconds: APPLY_IDLE_SECONDS + 1,
  now: NOW,
  source: "200:10",
  sourceChangedAt: NOW - (SOURCE_QUIET_SECONDS + 1) * 1000,
  repoBuilt: "100:9",
  appChanged: false,
  packaged: false,
  daemonStale: false,
  working: false,
  lastFailure: null,
};
const reason = (patch: Partial<IdleUpdateFacts>) => {
  const next = idleUpdateStep({ ...base, ...patch });
  return next.step === "wait" ? next.reason : next.step;
};
const built = { repoBuilt: "200:10" };

check("new source, idle and quiet: build", reason({}) === "build");
check("setting off: wait", reason({ enabled: false }) === "off");
check("busy sessions: wait", reason({ busy: 1 }) === "busy");
check("something already running: wait", reason({ working: true }) === "in progress");
check("source unknown: wait", reason({ source: null }) === "source unknown");
check("user active (below the build threshold): wait", reason({ idleSeconds: BUILD_IDLE_SECONDS - 1 }) === "user active");
check("source touched a minute ago: wait for it to settle", reason({ sourceChangedAt: NOW - 60_000 }) === "source changing");
check("build failed on this source recently: wait", reason({ lastFailure: { at: NOW - 60_000, step: "build", source: "200:10" } }) === "build failed recently");
check("build failed long ago or on older source: build", reason({ lastFailure: { at: NOW - RETRY_MS - 1, step: "build", source: "200:10" } }) === "build" && reason({ lastFailure: { at: NOW - 60_000, step: "build", source: "150:10" } }) === "build");

check("app shell changed, not packaged yet: package", reason({ ...built, appChanged: true }) === "package");
check("app shell changed and packaged: install", reason({ ...built, appChanged: true, packaged: true }) === "install");
check("install waits for the longer idle", reason({ ...built, appChanged: true, packaged: true, idleSeconds: APPLY_IDLE_SECONDS - 1 }) === "user active");
check("package only needs the build idle", reason({ ...built, appChanged: true, idleSeconds: BUILD_IDLE_SECONDS + 1 }) === "package");
check("install rolled back for this source: wait", reason({ ...built, appChanged: true, packaged: true, lastFailure: { at: NOW - 60_000, step: "install", source: "200:10" } }) === "install failed recently");
check("a build failure does not block install", reason({ ...built, appChanged: true, packaged: true, lastFailure: { at: NOW - 60_000, step: "build", source: "200:10" } }) === "install");

check("only daemon or web changed: restart", reason({ ...built, daemonStale: true }) === "restart");
check("restart waits for the longer idle", reason({ ...built, daemonStale: true, idleSeconds: APPLY_IDLE_SECONDS - 1 }) === "user active");
check("app shell change wins over a plain restart", reason({ ...built, daemonStale: true, appChanged: true, packaged: true }) === "install");
check("everything current: wait", reason({ ...built }) === "current");
check("busy blocks restart too", reason({ ...built, daemonStale: true, busy: 1 }) === "busy");

const script = installScript("/tmp/release/Lodestar.app", "/tmp/home", "200:10");
const file = join(mkdtempSync(join(tmpdir(), "idleupdate-")), "install.sh");
writeFileSync(file, script);
let syntax = true;
try {
  execFileSync("/bin/bash", ["-n", file]);
} catch {
  syntax = false;
}
check("install script is valid bash", syntax);
const echoLine = script.split("\n").find((line) => line.startsWith("echo ") && line.includes("rollback.json")) ?? "";
const written = execFileSync("/bin/bash", ["-c", echoLine.replace(/ > .*$/, "")]).toString();
let parsed: { source?: string; at?: number } = {};
try {
  parsed = JSON.parse(written);
} catch {
}
check("rollback record is JSON with the source and a time", parsed.source === "200:10" && typeof parsed.at === "number" && parsed.at > 1_700_000_000_000, written.trim());
check("script keeps the previous app and restores it when the new one does not respond", script.includes("/tmp/home/previous/Lodestar.app") && script.includes("restoring the previous one"));

console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
