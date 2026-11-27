import { execFile, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { idleUpdateStep, type IdleUpdateFacts, type IdleUpdateStepName } from "../shared/idleUpdate";
import { withLoginPath } from "./loginPath";
import { srcStamp } from "./srcStamp";

const execFileAsync = promisify(execFile);

const TICK_MS = 60_000; // lint-tokens: allow 상태를 보는 주기(ms)
const INSTALLED_APP = "/Applications/Lodestar.app";
const APP_EXE = join(INSTALLED_APP, "Contents", "MacOS", "Lodestar");
const APP_FILES = ["main.mjs", "preload.cjs", "pw-preload.cjs", "daemonSupervisor.mjs"];

export type IdleUpdateDeps = {
  home: string;
  srcRoot: string;
  enabled: () => boolean;
  busy: () => number;
  startedAt: number;
  restart: () => void;
  idleSeconds?: () => Promise<number>;
  log?: (line: string) => void;
  daemonControl?: string;
};

export class IdleUpdater {
  private timer: NodeJS.Timeout | null = null;
  private working = false;
  private lastFailure: IdleUpdateFacts["lastFailure"] = null;
  private lastReason = "";

  constructor(private deps: IdleUpdateDeps) {}

  start() {
    if (this.timer) return;
    this.note("watching for new source while idle");
    this.timer = setInterval(() => void this.tick().catch((error) => this.note(`tick failed: ${(error as Error).message}`)), TICK_MS);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private note(line: string) {
    this.deps.log?.(`[auto-update] ${line}`);
    try {
      mkdirSync(this.deps.home, { recursive: true });
      writeFileSync(join(this.deps.home, "auto-update.log"), `${new Date().toISOString()} ${line}\n`, { flag: "a" });
    } catch {
    }
  }

  async facts(): Promise<IdleUpdateFacts> {
    const [source, idleSeconds] = await Promise.all([srcStamp(this.deps.srcRoot), (this.deps.idleSeconds ?? hidIdleSeconds)()]);
    const repoStamp = readStamp(join(this.deps.srcRoot, "dist-electron", "build-stamp.json"));
    const repoApp = appHash(join(this.deps.srcRoot, "dist-electron"));
    return {
      enabled: this.deps.enabled(),
      busy: this.deps.busy(),
      idleSeconds,
      now: Date.now(),
      source: source?.stamp ?? null,
      sourceChangedAt: source?.changedAt ?? 0,
      repoBuilt: repoStamp?.src ?? null,
      appChanged: repoApp !== null && repoApp !== appHash(join(INSTALLED_APP, "Contents", "Resources", "app", "dist-electron")),
      packaged: repoApp !== null && repoApp === appHash(join(this.releaseApp(), "Contents", "Resources", "app", "dist-electron")),
      daemonStale: (repoStamp?.builtAt ?? 0) > this.deps.startedAt,
      working: this.working,
      lastFailure: this.lastFailure ?? this.rolledBack(),
    };
  }

  async tick() {
    const facts = await this.facts();
    const next = idleUpdateStep(facts);
    if (next.step === "wait") {
      if (next.reason !== this.lastReason && next.reason !== "off") this.note(`wait: ${next.reason} (idle ${Math.round(facts.idleSeconds)}s, busy ${facts.busy})`);
      this.lastReason = next.reason;
      return;
    }
    this.lastReason = next.step;
    const source = facts.source!;
    if (next.step === "build") await this.run("build", source, "npm", ["run", "build"], { AGENT_NAV_SRC_STAMP: source });
    else if (next.step === "package") {
      if (await this.run("package", source, "npx", ["--no-install", "electron-builder", "--mac", "--dir"])) await this.run("package", source, "npm", ["run", "postdist"]);
    } else if (next.step === "install") this.install(source);
    else {
      this.note("restart: the daemon restarts with the new build");
      this.deps.restart();
    }
  }

  private releaseApp() {
    return join(this.deps.srcRoot, "release", "mac-arm64", "Lodestar.app");
  }

  private async run(step: IdleUpdateStepName, source: string, command: string, args: string[], extraEnv: Record<string, string> = {}) {
    this.working = true;
    this.note(`${step}: ${command} ${args.join(" ")}`);
    try {
      mkdirSync(this.deps.home, { recursive: true });
      const out = createWriteStream(join(this.deps.home, "auto-update-build.log"), { flags: "a" });
      const code = await new Promise<number | null>((resolve) => {
        const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv, PATH: withLoginPath(process.env.PATH) };
        delete env.ELECTRON_RUN_AS_NODE;
        const child = spawn("nice", ["-n", "15", command, ...args], { cwd: this.deps.srcRoot, env, stdio: ["ignore", "pipe", "pipe"] });
        child.stdout.pipe(out, { end: false });
        child.stderr.pipe(out, { end: false });
        child.on("close", resolve);
        child.on("error", () => resolve(null));
      });
      out.end();
      if (code === 0) {
        this.note(`${step}: done`);
        return true;
      }
      this.lastFailure = { at: Date.now(), step, source };
      this.note(`${step}: failed (exit ${code}), see auto-update-build.log`);
      return false;
    } finally {
      this.working = false;
    }
  }

  private rolledBack(): IdleUpdateFacts["lastFailure"] {
    try {
      const info = JSON.parse(readFileSync(join(this.deps.home, "auto-update-rollback.json"), "utf8")) as { source?: string; at?: number };
      return typeof info.source === "string" && typeof info.at === "number" ? { at: info.at, step: "install", source: info.source } : null;
    } catch {
      return null;
    }
  }

  private install(source: string) {
    if (!existsSync(this.releaseApp())) {
      this.note("install: skipped, the packaged app is missing");
      return;
    }
    const appPid = this.deps.daemonControl ? installedAppPid() : process.ppid;
    if (!appPid) {
      this.lastFailure = { at: Date.now(), step: "install", source };
      this.note("install: skipped, the running app was not found");
      return;
    }
    this.working = true;
    const script = join(this.deps.home, "auto-update-install.sh");
    writeFileSync(script, installScript(this.releaseApp(), this.deps.home, source, appPid, this.deps.daemonControl));
    chmodSync(script, 0o755);
    this.note("install: the app quits, is replaced and relaunches");
    const installer = spawn("/bin/bash", [script], { detached: true, stdio: "ignore" });
    installer.once("error", (error) => {
      this.working = false;
      this.lastFailure = { at: Date.now(), step: "install", source };
      this.note(`install could not start: ${error.message}`);
    });
    installer.once("exit", (code, signal) => {
      this.working = false;
      if (code !== 0) this.lastFailure = { at: Date.now(), step: "install", source };
      this.note(`installer exited (code ${code}, signal ${signal})`);
    });
    installer.unref();
  }
}

function installedAppPid() {
  try {
    const pid = Number(execFileSync("/usr/bin/pgrep", ["-afx", APP_EXE], { encoding: "utf8", timeout: 1000 }).trim());
    return Number.isSafeInteger(pid) && pid > 1 ? pid : null;
  } catch {
    return null;
  }
}

function readStamp(file: string): { src: string | null; builtAt: number } | null {
  try {
    const info = JSON.parse(readFileSync(file, "utf8")) as { src?: string | null; builtAt?: number };
    return { src: typeof info.src === "string" ? info.src : null, builtAt: typeof info.builtAt === "number" ? info.builtAt : 0 };
  } catch {
    return null;
  }
}

function appHash(dir: string): string | null {
  const hash = createHash("sha1");
  for (const file of APP_FILES) {
    try {
      hash.update(readFileSync(join(dir, file)));
    } catch {
      return null;
    }
  }
  return hash.digest("hex");
}

async function hidIdleSeconds(): Promise<number> {
  try {
    const { stdout } = await execFileAsync("ioreg", ["-c", "IOHIDSystem"], { maxBuffer: 4 * 1024 * 1024 });
    const match = /"HIDIdleTime"\s*=\s*(\d+)/.exec(stdout);
    return match ? Number(match[1]) / 1e9 : 0;
  } catch {
    return 0;
  }
}

export function installScript(release: string, home: string, source: string, appPid = process.ppid, daemonControl?: string) {
  const log = join(home, "auto-update.log");
  const prev = join(home, "previous", "Lodestar.app");
  const q = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
  return `#!/bin/bash
LOG=${q(log)}
say() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) install: $*" >> "$LOG"; }
launch() { env -i HOME="$HOME" USER="$USER" LOGNAME="$USER" SHELL=/bin/zsh LANG=ko_KR.UTF-8 PATH="$(/bin/zsh -lc 'printf %s "$PATH"')" /usr/bin/open -g ${q(INSTALLED_APP)}; }
APP_EXE=${q(APP_EXE)}
stop_service() {
  ${daemonControl ? `printf '%s\\n' stop | /usr/bin/nc -w 8 -U ${q(daemonControl)} >/dev/null 2>&1
  /usr/bin/lockf -ks -t 10 ${q(join(home, "daemon-supervisor.lock"))} /usr/bin/true` : ":"}
}
P=${appPid}
if [ "$(/bin/ps -p "$P" -o comm=)" != "$APP_EXE" ]; then say "cannot identify running app, giving up"; exit 1; fi
kill -TERM "$P" || { say "could not quit running app"; exit 1; }
t0=$(date +%s)
while kill -0 "$P" 2>/dev/null; do sleep 2; [ $(( $(date +%s)-t0 )) -gt 300 ] && { say "app did not quit, giving up"; exit 1; }; done
stop_service || { say "daemon did not stop, giving up"; launch; exit 1; }
rm -rf ${q(prev)}; mkdir -p ${q(join(home, "previous"))}
mv ${q(INSTALLED_APP)} ${q(prev)} || { say "could not move the old app"; launch; exit 1; }
cp -R ${q(release)} ${q(INSTALLED_APP)} || { say "copy failed, restoring"; rm -rf ${q(INSTALLED_APP)}; mv ${q(prev)} ${q(INSTALLED_APP)}; launch; exit 1; }
launch
for i in $(seq 1 30); do
  sleep 2
  if curl -s -o /dev/null --max-time 2 http://127.0.0.1:\${AGENT_NAV_PORT:-7788}/; then say "new app is up (quit took $(( $(date +%s)-t0 ))s)"; exit 0; fi
done
say "new app did not respond, restoring the previous one"
echo "{\\"source\\":\\"${source}\\",\\"at\\":$(( $(date +%s) * 1000 ))}" > ${q(join(home, "auto-update-rollback.json"))}
P=$(/usr/bin/pgrep -afx "$APP_EXE"); [ -n "$P" ] && kill -TERM $P
sleep 5
stop_service || { say "daemon did not stop, keeping the new app"; launch; exit 1; }
rm -rf ${q(INSTALLED_APP)}; mv ${q(prev)} ${q(INSTALLED_APP)}
launch
say "restored"
`;
}
