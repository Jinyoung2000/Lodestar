import { execFile, spawn, type ChildProcess } from "node:child_process";
import type { SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";

const live = new Map<number, ChildProcess>();

export function liveGroupLeaders(): number[] {
  return [...live.keys()];
}

const STDERR_TAIL_MAX = 4000;

export type GroupedSpawner = {
  spawn: (options: SpawnOptions) => SpawnedProcess;
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

export function trackGroupLeader(child: ChildProcess) {
  if (child.pid === undefined) return;
  const pid = child.pid;
  live.set(pid, child);
  const forget = () => live.delete(pid);
  child.once("exit", forget);
  child.once("error", forget);
}

export function spawnInGroup(options: SpawnOptions): SpawnedProcess {
  return groupedSpawner().spawn(options);
}

export type ProcRow = { pid: number; ppid: number; pgid: number };

export type KillDeps = {
  signal: (pid: number, signal: NodeJS.Signals) => boolean;
  alive: (pid: number) => boolean;
  snapshot: () => Promise<ProcRow[]>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
};

export type TerminateReport = { roots: number; members: number; stillAliveAfterTerm: number; killed: number; remaining: number; ms: number };

export async function terminateGroups(roots: number[], deps: KillDeps, options: { graceMs?: number; pollMs?: number; settleMs?: number } = {}): Promise<TerminateReport> {
  const started = deps.now();
  const graceMs = options.graceMs ?? 1500;
  const pollMs = options.pollMs ?? 50;
  const settleMs = options.settleMs ?? 300;
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
