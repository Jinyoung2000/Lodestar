// 시험이 쓰는 데몬. 기본은 시험이 자기 데몬을 임시 홈과 빈 포트로 띄우고 끝나면 끈다.
// AGENT_NAV_PORT 를 주면 그 데몬을 대상으로 한다. 그때는 AGENT_NAV_HOME 도 함께 줘야 하고, 사용자의 앱(7788, ~/.agent-nav)은 어떤 경우에도 대상이 될 수 없다.
import { execFileSync, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type TestDaemon = { port: number; home: string; token: string; stop: () => void };

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const USER_PORT = 7788;

// settings 는 데몬이 뜰 때 읽는 settings.json 의 값, env 는 데몬에 더 줄 환경 변수(AGENT_NAV_MOBILE_PORT 같은 것)다. 둘 다 자기 데몬을 띄울 때만 쓰인다.
export type TestDaemonOptions = { settings?: Record<string, unknown>; env?: Record<string, string> };

export async function useTestDaemon(options: TestDaemonOptions = {}): Promise<TestDaemon> {
  const given = process.env.AGENT_NAV_PORT;
  return given === undefined ? startOwn(options) : attach(Number(given), process.env.AGENT_NAV_HOME);
}

// 빈 포트 하나(시험이 자기 포트를 골라 데몬에 알릴 때)
export const freeTestPort = () => freePort();

function attach(port: number, home: string | undefined): TestDaemon {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(`AGENT_NAV_PORT is not a usable port: ${port}`);
  if (port === USER_PORT) throw new Error(`Port ${USER_PORT} is the real app. Unset AGENT_NAV_PORT to let the test start its own daemon.`);
  if (!home) throw new Error("AGENT_NAV_PORT needs AGENT_NAV_HOME of that daemon. The test never falls back to ~/.agent-nav.");
  if (resolve(home) === resolve(homedir(), ".agent-nav")) throw new Error("AGENT_NAV_HOME is the real app's folder (~/.agent-nav). Use a test daemon's folder.");
  return { port, home, token: readFileSync(join(home, "token"), "utf8").trim(), stop: () => {} };
}

// freePort 가 포트를 돌려준 뒤 데몬이 묶기 전에 다른 프로세스가 가로챌 수 있어(동시에 도는 검사들), 데몬이 못 뜨면 새 포트로 한 번 더 시도한다.
async function startOwn(options: TestDaemonOptions): Promise<TestDaemon> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await startOnce(options);
    } catch (error) {
      if (attempt >= 3) throw error;
    }
  }
}

async function startOnce(options: TestDaemonOptions): Promise<TestDaemon> {
  const home = mkdtempSync(join(tmpdir(), "agent-nav-security-home-"));
  const repo = seedRepo();
  seedState(home, repo);
  if (options.settings) writeFileSync(join(home, "settings.json"), JSON.stringify(options.settings));
  const port = await freePort();
  // 파이프로 받으면 읽는 쪽이 없을 때 데몬이 멈추므로 로그는 파일로 보낸다.
  const logFile = join(home, "daemon.log");
  const log = openSync(logFile, "a");
  const child = spawn(join(ROOT, "node_modules/.bin/tsx"), ["server/index.ts"], {
    cwd: ROOT,
    env: { ...ownEnv(), AGENT_NAV_HOME: home, AGENT_NAV_PORT: String(port), AGENT_NAV_SRC: repo, AGENT_NAV_NO_MENTIONS: "1", ...options.env },
    stdio: ["ignore", log, log],
  });
  closeSync(log);
  let exited = false;
  child.on("exit", () => (exited = true));
  const stop = () => {
    if (!exited) child.kill("SIGTERM");
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  };
  process.once("exit", stop);
  try {
    await waitUntil(() => !exited && existsSync(join(home, "token")) && answers(port), 40_000);
  } catch (error) {
    const tail = existsSync(logFile) ? readFileSync(logFile, "utf8").split("\n").slice(-15).join("\n") : "";
    stop();
    throw new Error(`The test daemon did not start on ${port}: ${(error as Error).message}\n${tail}`);
  }
  return { port, home, token: readFileSync(join(home, "token"), "utf8").trim(), stop };
}

// 상위(사용자의 앱이나 피드백 검사)가 넘긴 AGENT_NAV_*, ELECTRON_* 를 물려받지 않는다. 홈, 포트, 소스 폴더는 이 시험이 정한 값만 쓴다.
function ownEnv() {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("AGENT_NAV_") || key.startsWith("ELECTRON_")) delete env[key];
  return env;
}

// 접근 검사와 경로 탈출 시험이 쓸 폴더 하나와 세션 하나. 세션은 모델을 부르지 않는 기록뿐이다.
function seedRepo() {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "agent-nav-test-repo-")));
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd: repo, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "tsconfig.json"), '{ "compilerOptions": {} }\n');
  git("add", ".");
  git("commit", "-q", "-m", "init");
  return repo;
}

function seedState(home: string, repo: string) {
  mkdirSync(home, { recursive: true });
  const now = new Date().toISOString();
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo }).toString().trim();
  const agent = {
    id: "00000000-0000-4000-8000-000000000001",
    workspaceId: "ws-test",
    cwd: repo,
    worktree: null,
    forkedFrom: null,
    resumeFrom: null,
    startCommit: head,
    feedbackId: null,
    title: "seeded session",
    sessionId: null,
    status: "idle",
    permissionMode: "default",
    model: null,
    effort: null,
    activeModel: null,
    activeEffort: null,
    backgroundTasks: 0,
    createdAt: now,
    updatedAt: now,
  };
  writeFileSync(join(home, "state.json"), JSON.stringify({ workspaces: [{ id: "ws-test", name: "agent-nav-test", dir: repo, parentId: null }], agents: [agent] }));
}

function freePort() {
  return new Promise<number>((resolvePort, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolvePort(port));
    });
  });
}

function answers(port: number) {
  return new Promise<boolean>((resolveAnswer) => {
    const req = request({ host: "127.0.0.1", port, path: "/", timeout: 1000 }, (res) => {
      res.resume();
      resolveAnswer(true);
    });
    req.on("error", () => resolveAnswer(false));
    req.on("timeout", () => req.destroy());
    req.end();
  });
}

async function waitUntil(ready: () => boolean | Promise<boolean>, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await ready()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out after ${timeoutMs / 1000}s`);
}
