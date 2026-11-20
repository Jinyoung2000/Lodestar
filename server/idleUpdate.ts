import { execFile, spawn } from "node:child_process";
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
// 앱 본체: 이 파일들이 바뀌면 데몬 재시작으로는 반영되지 않고 앱을 다시 설치해야 한다.
const APP_FILES = ["main.mjs", "preload.cjs", "pw-preload.cjs"];

export type IdleUpdateDeps = {
  home: string;
  srcRoot: string;
  enabled: () => boolean;
  busy: () => number;
  // 이 데몬이 뜬 시각. 레포 빌드가 이보다 새로우면 데몬을 다시 띄워야 반영된다.
  startedAt: number;
  // 데몬 재시작 요청(server/index.ts 의 restartScheduler). 창은 다시 읽는다.
  restart: () => void;
  // 시험에서 바꾼다. 비우면 맥의 HID 유휴 시간.
  idleSeconds?: () => Promise<number>;
  log?: (line: string) => void;
};

// IDLEUPDATE: 자리를 비운 사이 새 소스를 스스로 반영한다. 단계는 shared/idleUpdate.ts 가 정하고, 여기서는 사실을 모으고 단계를 실행한다.
// 앱 설치는 앱 자신을 끄기 때문에 떼어 낸 셸 스크립트가 한다: 앱 종료, 교체, 재실행, 새 앱이 응답하지 않으면 이전 앱으로 되돌림.
// 기록은 ~/.agent-nav/auto-update.log, 빌드 출력은 auto-update-build.log.
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
      // 기록 실패는 업데이트를 막지 않는다
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
      // 같은 이유로 기다리는 동안은 한 번만 적는다.
      if (next.reason !== this.lastReason && next.reason !== "off") this.note(`wait: ${next.reason} (idle ${Math.round(facts.idleSeconds)}s, busy ${facts.busy})`);
      this.lastReason = next.reason;
      return;
    }
    this.lastReason = next.step;
    const source = facts.source!;
    if (next.step === "build") await this.run("build", source, "npm", ["run", "build"], { AGENT_NAV_SRC_STAMP: source });
    else if (next.step === "package") {
      // --no-install: 레포에 설치된 electron-builder 만 쓴다. 없을 때 npx 가 레지스트리에서 새로 받아 실행하는 일을 아무도 없는 사이에 하지 않는다(실패로 기록되고 30분 뒤 다시 본다).
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

  // 레포에서 명령 하나를 낮은 우선순위로 돌린다. 출력은 auto-update-build.log 에 이어 붙인다.
  private async run(step: IdleUpdateStepName, source: string, command: string, args: string[], extraEnv: Record<string, string> = {}) {
    this.working = true;
    this.note(`${step}: ${command} ${args.join(" ")}`);
    try {
      mkdirSync(this.deps.home, { recursive: true });
      const out = createWriteStream(join(this.deps.home, "auto-update-build.log"), { flags: "a" });
      const code = await new Promise<number | null>((resolve) => {
        const child = spawn("nice", ["-n", "15", command, ...args], { cwd: this.deps.srcRoot, env: { ...process.env, ...extraEnv, PATH: withLoginPath(process.env.PATH) }, stdio: ["ignore", "pipe", "pipe"] });
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

  // 설치 스크립트가 새 앱이 뜨지 않아 되돌렸으면 그 소스와 시각을 남겨 둔다.
  private rolledBack(): IdleUpdateFacts["lastFailure"] {
    try {
      const info = JSON.parse(readFileSync(join(this.deps.home, "auto-update-rollback.json"), "utf8")) as { source?: string; at?: number };
      return typeof info.source === "string" && typeof info.at === "number" ? { at: info.at, step: "install", source: info.source } : null;
    } catch {
      return null;
    }
  }

  private install(source: string) {
    if (!existsSync(this.releaseApp())) return;
    this.working = true;
    const script = join(this.deps.home, "auto-update-install.sh");
    writeFileSync(script, installScript(this.releaseApp(), this.deps.home, source));
    chmodSync(script, 0o755);
    this.note("install: the app quits, is replaced and relaunches");
    spawn("/bin/bash", [script], { detached: true, stdio: "ignore" }).unref();
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

// 앱 본체 파일의 해시. 하나라도 없으면 null.
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

// 입력(키보드, 마우스)이 없었던 초. 읽지 못하면 0(쓰는 중으로 본다: 닫는 쪽).
async function hidIdleSeconds(): Promise<number> {
  try {
    const { stdout } = await execFileAsync("ioreg", ["-c", "IOHIDSystem"], { maxBuffer: 4 * 1024 * 1024 });
    const match = /"HIDIdleTime"\s*=\s*(\d+)/.exec(stdout);
    return match ? Number(match[1]) / 1e9 : 0;
  } catch {
    return 0;
  }
}

// 앱을 끄고 갈아 끼운 뒤 다시 연다. 새 앱이 60초 안에 응답하지 않으면 이전 앱으로 되돌리고 그 소스를 기록한다(30분 동안 다시 시도하지 않는다).
export function installScript(release: string, home: string, source: string) {
  const log = join(home, "auto-update.log");
  const prev = join(home, "previous", "Lodestar.app");
  const q = (s: string) => JSON.stringify(s);
  return `#!/bin/bash
LOG=${q(log)}
say() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) install: $*" >> "$LOG"; }
launch() { env -i HOME="$HOME" USER="$USER" LOGNAME="$USER" SHELL=/bin/zsh LANG=ko_KR.UTF-8 PATH="$(/bin/zsh -lc 'printf %s "$PATH"')" /usr/bin/open -g ${q(INSTALLED_APP)}; }
P=$(pgrep -f "${INSTALLED_APP}/Contents/MacOS/Lodestar$")
[ -n "$P" ] && kill -TERM $P
t0=$(date +%s)
while pgrep -f "${INSTALLED_APP}/Contents/MacOS/Lodestar" >/dev/null; do sleep 2; [ $(( $(date +%s)-t0 )) -gt 300 ] && { say "app did not quit, giving up"; exit 1; }; done
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
P=$(pgrep -f "${INSTALLED_APP}/Contents/MacOS/Lodestar$"); [ -n "$P" ] && kill -TERM $P
sleep 5
rm -rf ${q(INSTALLED_APP)}; mv ${q(prev)} ${q(INSTALLED_APP)}
launch
say "restored"
`;
}
