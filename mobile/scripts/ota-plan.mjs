#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const NATIVE_DIRS = ["modules", "plugins", "patches"];
const NATIVE_MARKERS = ["android", "ios", "expo-module.config.json", "react-native.config.js"];

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};

const git = (...rest) => execFileSync("git", ["-C", APP_DIR, ...rest], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 }).trim();
const prefix = git("rev-parse", "--show-prefix");
const showJson = (commit, file) => JSON.parse(git("show", `${commit}:${prefix}${file}`));

function withoutVersions(expo) {
  const copy = structuredClone(expo);
  delete copy.version;
  if (copy.android) delete copy.android.versionCode;
  if (copy.ios) delete copy.ios.buildNumber;
  return JSON.stringify(copy);
}

function isNativePackage(lockPath) {
  const dir = join(APP_DIR, lockPath);
  if (!existsSync(dir)) return true;
  if (NATIVE_MARKERS.some((entry) => existsSync(join(dir, entry)))) return true;
  return readdirSync(dir).some((entry) => entry.endsWith(".podspec"));
}

function changedNativePackages(from, to) {
  const before = showJson(from, "package-lock.json").packages ?? {};
  const after = showJson(to, "package-lock.json").packages ?? {};
  const names = new Set([...Object.keys(before), ...Object.keys(after)].filter((key) => key.startsWith("node_modules/")));
  const changed = [...names].filter((key) => before[key]?.version !== after[key]?.version || before[key]?.resolved !== after[key]?.resolved);
  return changed.filter(isNativePackage);
}

function verdictFor(build, target, targetVersion) {
  if (build.version !== targetVersion) return { verdict: "OTHER_RUNTIME", reasons: [`this update targets runtime ${targetVersion}`] };
  const reasons = [];
  if (withoutVersions(showJson(build.commit, "app.json").expo) !== withoutVersions(showJson(target, "app.json").expo)) reasons.push("app.json native configuration changed");
  const accepted = new Map((build.jsCompatExceptions ?? []).map((entry) => [entry.path, entry.blob]));
  const blobAt = (file) => {
    try {
      return git("rev-parse", `${target}:${file}`);
    } catch {
      return null;
    }
  };
  const nativeFiles = git("diff", "--name-only", `${build.commit}..${target}`, "--", ...NATIVE_DIRS.map((dir) => `:(top)${prefix}${dir}`)).split("\n").filter(Boolean);
  const unreviewed = nativeFiles.filter((file) => accepted.get(file) !== blobAt(file));
  if (unreviewed.length) reasons.push(`native files changed: ${unreviewed.join(", ")}`);
  const byException = nativeFiles.length > 0 && unreviewed.length === 0;
  const packages = changedNativePackages(build.commit, target);
  if (packages.length) reasons.push(`native packages changed: ${packages.map((key) => key.replace(/^node_modules\//, "")).join(", ")}`);
  if (reasons.length) return { verdict: "BLOCKED", reasons };
  return byException ? { verdict: "SENDABLE", reasons: [`reviewed native changes: ${nativeFiles.join(", ")}`] } : { verdict: "SENDABLE", reasons: [] };
}

function plan() {
  const problems = [];
  const target = git("rev-parse", "HEAD");
  const upstream = option("--upstream") ?? "refs/heads/public";
  const dirty = git("status", "--porcelain", "--", ".", "../shared");
  if (dirty) problems.push(`uncommitted changes in mobile/ or shared/:\n${dirty}`);
  try {
    const missing = git("rev-list", "--count", `HEAD..${upstream}`);
    if (missing !== "0") problems.push(`HEAD is ${missing} commit(s) behind ${upstream}`);
  } catch {
    problems.push(`cannot read ${upstream}`);
  }
  const relayCheck = spawnSync(process.execPath, [join(APP_DIR, "scripts", "sync-relay.mjs"), "--check"], { encoding: "utf8" });
  if (relayCheck.status !== 0) problems.push(relayCheck.stderr.trim());
  const targetVersion = showJson(target, "app.json").expo.version;
  const builds = JSON.parse(readFileSync(join(APP_DIR, "native-builds.json"), "utf8"));
  const rows = builds.map((build) => ({ ...build, ...verdictFor(build, target, targetVersion) }));
  if (!rows.some((row) => row.verdict === "SENDABLE")) problems.push(`no registered Android build can take runtime ${targetVersion}`);
  if (rows.some((row) => row.verdict === "BLOCKED")) problems.push("a build on this runtime cannot take this JavaScript; build a new APK and register it in native-builds.json");
  return { target, targetVersion, rows, problems };
}

const result = plan();
console.log(`target ${result.target.slice(0, 7)} runtime ${result.targetVersion}`);
for (const row of result.rows) console.log(`  ${row.version} (versionCode ${row.versionCode}, built from ${row.commit.slice(0, 7)}): ${row.verdict}${row.reasons.length ? ` - ${row.reasons.join("; ")}` : ""}`);
if (result.problems.length) {
  console.error(`\nNot publishing:\n- ${result.problems.join("\n- ")}`);
  process.exit(1);
}
if (!flag("--publish")) {
  console.log("\nReady. Run again with --publish --message \"...\" to send it.");
  process.exit(0);
}
const message = option("--message");
if (!message) {
  console.error("--publish needs --message \"what changed\"");
  process.exit(2);
}
const sent = spawnSync("npm", ["run", "update:android", "--", "--message", message, "--non-interactive"], { cwd: APP_DIR, stdio: "inherit" });
process.exit(sent.status ?? 1);
