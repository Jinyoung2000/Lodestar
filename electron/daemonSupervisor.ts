import { fork, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { lockDaemonFile } from "../server/daemonLock";
import { isNewerVersion } from "../shared/release";
import { RestartScheduler, restartWaitMs } from "../shared/restartGate";
import { daemonSocket, type DaemonEvent, type DaemonState } from "./daemonSocket";
import { LineStamper, stampLine } from "./logStamp";

const [home, appRoot, srcRoot, logDir] = process.argv.slice(2);
const lock = lockDaemonFile(join(home, "daemon-supervisor.lock"));
if (lock === null) process.exit(75);
const port = Number(process.env.AGENT_NAV_PORT);
const appVersion = process.env.AGENT_NAV_APP_VERSION ?? "";
const path = daemonSocket(home);
const logFile = join(logDir, "daemon.log");
const delays = [500, 1000, 2000, 4000, 8000];
const clients = new Set<Socket>();
let daemon: ChildProcess | null = null;
let startedAt = 0;
let attempt = 0;
let state: DaemonState["state"] = "restarting";
let respawn: ReturnType<typeof setTimeout> | null = null;
let stopping = false;
let restarting = false;
let reloadOnReady = false;
let logBytes = existsSync(logFile) ? statSync(logFile).size : 0;

function log(text: string) {
  if (!text) return;
  try {
    if (logBytes >= 20 * 1024 * 1024) {
      renameSync(logFile, `${logFile}.1`);
      logBytes = 0;
    }
    appendFileSync(logFile, text);
    logBytes += Buffer.byteLength(text);
  } catch (error) {
    console.error("Lodestar daemon log write failed", error);
  }
}

function send(client: Socket, event: DaemonEvent) {
  client.write(`${JSON.stringify(event)}\n`);
}

function status(): DaemonState {
  return { state, attempt, maxAttempts: delays.length, port, pid: daemon?.pid ?? null, version: appVersion };
}

function report(next: DaemonState["state"], reload = false) {
  state = next;
  const event = reload ? { ...status(), reload: true as const } : status();
  for (const client of clients) send(client, event);
}

function runFromSourceOn() {
  try {
    return (JSON.parse(readFileSync(join(home, "settings.json"), "utf8")) as { runFromSource?: unknown }).runFromSource === true;
  } catch {
    return false;
  }
}

function repoBuildProblem(): string | null {
  if (!runFromSourceOn()) return "run from the source folder is off";
  if (!existsSync(srcRoot)) return "source folder not found";
  try {
    if (!statSync(join(srcRoot, "dist", "index.html")).isFile() ||
      !statSync(join(srcRoot, "dist-electron", "daemonSupervisor.mjs")).isFile() ||
      statSync(join(srcRoot, "dist-electron", "daemon.mjs")).size < 1000 ||
      !readdirSync(join(srcRoot, "dist", "assets")).length) return "repo build incomplete";
  } catch {
    return "repo build missing";
  }
  const repoVersion = packageVersion(srcRoot);
  if (appVersion && (!repoVersion || isNewerVersion(appVersion, repoVersion))) return `repo build ${repoVersion ?? "unknown"} is older than the app ${appVersion}`;
  return existsSync(join(srcRoot, "node_modules")) ? null : "repo dependencies missing";
}

function packageVersion(root: string): string | null {
  try {
    const version = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: unknown }).version;
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  }
}

function start(forceBundle = false) {
  startedAt = Date.now();
  restartGate.reset();
  const note = appRoot === srcRoot ? null : forceBundle ? "repo build failed to start" : repoBuildProblem();
  const repo = appRoot !== srcRoot && note === null;
  const root = repo ? srcRoot : appRoot;
  const kind = repo ? "repo" : "bundle";
  const output = new LineStamper();
  const errors = new LineStamper();
  log(stampLine(`[supervisor] starting daemon from ${kind} (${root})${note ? `: ${note}` : ""}`));
  const child = fork(join(root, "dist-electron", "daemon.mjs"), [], {
    env: { ...process.env, AGENT_NAV_DAEMON_CONTROL: path, AGENT_NAV_ROOT: root, AGENT_NAV_RUNTIME: kind, AGENT_NAV_RUNTIME_NOTE: note ?? "" },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  daemon = child;
  report("restarting");
  child.stdout?.on("data", (chunk) => log(output.feed(chunk)));
  child.stderr?.on("data", (chunk) => log(errors.feed(chunk)));
  child.on("error", (error) => log(stampLine(`[supervisor] daemon process error: ${error.message}`)));
  let ready = false;
  const readyDeadline = setTimeout(() => {
    if (stopping || restarting) return;
    log(stampLine(`[supervisor] daemon from ${kind} did not report readiness`));
    stopDaemon();
  }, repo ? 8000 : 12_000);
  child.on("message", (message: { type?: string }) => {
    if (stopping || restarting) return;
    if (message.type === "daemon-ready") {
      clearTimeout(readyDeadline);
      ready = true;
      report("running", reloadOnReady);
      reloadOnReady = false;
    }
    if (message.type === "restart") restart();
  });
  child.once("close", (code, signal) => {
    clearTimeout(readyDeadline);
    log(stampLine(`[supervisor] daemon exited code=${code} signal=${signal}`));
    daemon = null;
    if (stopping) process.exit(0);
    if (restarting) {
      restarting = false;
      attempt = 0;
      start();
    } else if (!ready && repo) start(true);
    else scheduleRespawn();
  });
}

function scheduleRespawn() {
  if (Date.now() - startedAt >= 30_000) attempt = 0;
  if (attempt >= delays.length) {
    report("stopped");
    return;
  }
  const delay = delays[attempt++];
  report("restarting");
  respawn = setTimeout(() => {
    respawn = null;
    start(attempt >= 3);
  }, delay);
}

function stopDaemon() {
  if (respawn) clearTimeout(respawn);
  respawn = null;
  const child = daemon;
  if (!child) return false;
  report("restarting");
  const force = setTimeout(() => child.kill("SIGKILL"), 4500);
  child.once("close", () => clearTimeout(force));
  if (child.connected) child.send({ type: "shutdown" }, (error) => { if (error) child.kill("SIGTERM"); });
  else child.kill("SIGTERM");
  return true;
}

function restart() {
  if (restarting || stopping) return;
  restarting = true;
  reloadOnReady = true;
  if (stopDaemon()) return;
  restarting = false;
  attempt = 0;
  start();
}

const restartGate = new RestartScheduler({
  now: Date.now,
  wait: () => daemon ? restartWaitMs({ now: Date.now(), startedAt }) : 0,
  run: restart,
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
});

function shutdown() {
  if (stopping) return;
  stopping = true;
  restartGate.cancel();
  if (!stopDaemon()) process.exit(0);
}

rmSync(path, { force: true });
const server = createServer((client) => {
  clients.add(client);
  client.on("error", (error) => log(stampLine(`[supervisor] desktop connection: ${error.message}`)));
  client.on("close", () => clients.delete(client));
  send(client, status());
  const commands = createInterface({ input: client });
  commands.on("error", () => client.destroy());
  commands.on("line", (command) => {
    if (command === "stop") return shutdown();
    if (command !== "restart") return;
    const outcome = stopping ? false : restartGate.request().deferred ? "deferred" : true;
    send(client, { restart: outcome });
  });
});
server.on("error", (error) => {
  log(stampLine(`[supervisor] control socket: ${error.message}`));
  process.exit(1);
});
server.listen(path, () => start());
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, shutdown);
process.on("exit", () => rmSync(path, { force: true }));
