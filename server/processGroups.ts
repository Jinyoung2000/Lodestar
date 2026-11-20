import { execFile, spawn, type ChildProcess } from "node:child_process";
import type { SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";

// SDK 가 띄우는 모든 Claude CLI 를 자기 프로세스 그룹의 리더로 띄우고(detached → setsid, pid == pgid) 살아 있는 동안 기록한다.
// CLI 의 MCP 서버와 Bash 도구가 낳는 자식은 그 그룹을 물려받으므로, 종료 때 그룹 단위로 신호를 보내면 한꺼번에 정리된다.
// 6회차 점검: 메인과 데몬이 0.8초에 끝났는데 CLI 3개와 자식 21개가 600초 뒤에도 남았다(데몬이 SIGTERM 으로 죽어 exit 처리를 못 했음).

const live = new Map<number, ChildProcess>();

export function liveGroupLeaders(): number[] {
  return [...live.keys()];
}

const STDERR_TAIL_MAX = 4000;

export type GroupedSpawner = {
  spawn: (options: SpawnOptions) => SpawnedProcess;
  // CLI 가 비정상 종료했을 때 오류 문구에 붙일 stderr 끝부분. SDK 의 기본 spawn 은 이걸 오류에 붙여 주지만 사용자 지정 spawn 은 그렇지 않다.
  stderrTail: () => string;
};

export function groupedSpawner(): GroupedSpawner {
  let tail = "";
  return {
    spawn: (options) => {
      const child = spawn(options.command, options.args, { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"], signal: options.signal, windowsHide: true, detached: true });
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (text: string) => {
        tail = (tail + text).slice(-STDERR_TAIL_MAX);
      });
      child.stderr?.on("error", () => undefined);
      if (child.pid !== undefined) {
        live.set(child.pid, child);
        const forget = () => live.delete(child.pid!);
        child.once("exit", forget);
        child.once("error", forget);
      }
      return child;
    },
    stderrTail: () => tail.trim(),
  };
}

// CODEX: SDK 를 거치지 않고 직접 띄운 프로세스(Codex 앱 서버)도 같은 종료 정리에 들어가게 등록한다. detached 로 띄운 자식이어야 한다(pid == pgid).
export function trackGroupLeader(child: ChildProcess) {
  if (child.pid === undefined) return;
  const pid = child.pid;
  live.set(pid, child);
  const forget = () => live.delete(pid);
  child.once("exit", forget);
  child.once("error", forget);
}

// 오류 문구가 없는 호출처(메타, 사이드, 빠른 질문 등)가 쓰는 짧은 형태
export function spawnInGroup(options: SpawnOptions): SpawnedProcess {
  return groupedSpawner().spawn(options);
}

// --- 종료 때 정리 ---

export type ProcRow = { pid: number; ppid: number; pgid: number };

export type KillDeps = {
  // 신호를 보낸다. 음수 pid 는 그룹 전체. 이미 없으면 false.
  signal: (pid: number, signal: NodeJS.Signals) => boolean;
  alive: (pid: number) => boolean;
  snapshot: () => Promise<ProcRow[]>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
};

export type TerminateReport = { roots: number; members: number; stillAliveAfterTerm: number; killed: number; remaining: number; ms: number };

// 그룹 리더들과 그 그룹의 모든 프로세스, 그리고 거기서 파생돼 다른 그룹으로 옮겨 간 자손(setsid 한 도구)까지 모아 SIGTERM 을 보내고,
// 유예 안에 안 끝난 것만 SIGKILL 한다. 자손은 부모가 죽어 launchd 로 넘어가기 전에 모아야 하므로 신호 전에 한 번에 스냅샷을 뜬다.
export async function terminateGroups(roots: number[], deps: KillDeps, options: { graceMs?: number; pollMs?: number; settleMs?: number } = {}): Promise<TerminateReport> {
  const started = deps.now();
  const graceMs = options.graceMs ?? 1500;
  const pollMs = options.pollMs ?? 50;
  const settleMs = options.settleMs ?? 300;
  // pid 0, 1, 음수는 그룹 신호가 엉뚱한 곳(전체, init)으로 가므로 절대 넘기지 않는다
  roots = roots.filter((pid) => Number.isInteger(pid) && pid > 1);
  if (roots.length === 0) return { roots: 0, members: 0, stillAliveAfterTerm: 0, killed: 0, remaining: 0, ms: 0 };

  const rows = await deps.snapshot().catch(() => [] as ProcRow[]);
  const rootSet = new Set(roots);
  const members = new Set<number>(roots);
  for (const row of rows) if (rootSet.has(row.pgid)) members.add(row.pid);
  const children = new Map<number, number[]>();
  for (const row of rows) children.set(row.ppid, [...(children.get(row.ppid) ?? []), row.pid]);
  const queue = [...members];
  while (queue.length) {
    for (const child of children.get(queue.pop()!) ?? []) {
      if (members.has(child)) continue;
      members.add(child);
      queue.push(child);
    }
  }

  const send = (signal: NodeJS.Signals) => {
    for (const root of roots) deps.signal(-root, signal);
    // 그룹 밖으로 옮겨 간 자손에게는 개별로 보낸다
    for (const pid of members) if (!rootSet.has(pid)) deps.signal(pid, signal);
  };
  send("SIGTERM");

  const alive = () => [...members].filter((pid) => deps.alive(pid));
  let left = alive();
  const deadline = started + graceMs;
  while (left.length > 0 && deps.now() < deadline) {
    await deps.sleep(pollMs);
    left = alive();
  }
  const stillAliveAfterTerm = left.length;
  let killed = 0;
  if (left.length > 0) {
    killed = left.length;
    for (const root of roots) deps.signal(-root, "SIGKILL");
    for (const pid of left) deps.signal(pid, "SIGKILL");
    const settleBy = deps.now() + settleMs;
    while (left.length > 0 && deps.now() < settleBy) {
      await deps.sleep(pollMs);
      left = alive();
    }
  }
  return { roots: roots.length, members: members.size, stillAliveAfterTerm, killed, remaining: left.length, ms: deps.now() - started };
}

export const systemKillDeps: KillDeps = {
  signal: (pid, signal) => {
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  },
  alive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      // EPERM 은 있지만 우리 것이 아닌 경우라 살아 있다고 본다
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  },
  snapshot: () =>
    new Promise((resolve, reject) => {
      execFile("ps", ["-A", "-o", "pid=,ppid=,pgid="], { timeout: 2000, maxBuffer: 1 << 24 }, (error, stdout) => {
        if (error) return reject(error);
        const rows: ProcRow[] = [];
        for (const line of stdout.split("\n")) {
          const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)$/);
          if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]) });
        }
        resolve(rows);
      });
    }),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: Date.now,
};
