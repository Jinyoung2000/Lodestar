// 데몬 종료 정리 단독 시험: 저장 먼저(server/shutdown.ts), CLI 프로세스 그룹 정리(server/processGroups.ts).
// 가짜 프로세스 표로 순서를 보고, 마지막에 실제 프로세스 그룹으로 자식이 남지 않는지 본다.
// 실행: npm test
import { execFileSync } from "node:child_process";
import { groupedSpawner, liveGroupLeaders, systemKillDeps, terminateGroups, type KillDeps, type ProcRow } from "../server/processGroups";
import { createDaemonShutdown } from "../server/shutdown";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed++;
};

// --- 가짜 프로세스 표 ---
type Fake = { pid: number; ppid: number; pgid: number; stubborn?: boolean };
function fakeSystem(procs: Fake[]) {
  let clock = 0;
  const alive = new Map(procs.map((p) => [p.pid, p]));
  const sent: string[] = [];
  const kill = (pid: number) => alive.delete(pid);
  const deps: KillDeps = {
    signal: (pid, signal) => {
      sent.push(`${signal}:${pid}`);
      const targets = pid < 0 ? [...alive.values()].filter((p) => p.pgid === -pid) : alive.has(pid) ? [alive.get(pid)!] : [];
      if (targets.length === 0) return false;
      for (const p of targets) if (signal === "SIGKILL" || !p.stubborn) kill(p.pid);
      return true;
    },
    alive: (pid) => alive.has(pid),
    snapshot: async (): Promise<ProcRow[]> => [...alive.values()].map(({ pid, ppid, pgid }) => ({ pid, ppid, pgid })),
    sleep: async (ms) => void (clock += ms),
    now: () => clock,
  };
  return { deps, alive, sent };
}

// 1. 그룹 단위: CLI(100)와 같은 그룹의 MCP 자식, 그룹을 벗어난 도구 자손까지 정리된다
{
  const sys = fakeSystem([
    { pid: 100, ppid: 10, pgid: 100 }, // CLI
    { pid: 101, ppid: 100, pgid: 100 }, // MCP 서버
    { pid: 102, ppid: 101, pgid: 100 }, // MCP 의 자식 (npm exec)
    { pid: 103, ppid: 100, pgid: 103 }, // setsid 한 백그라운드 sleep
    { pid: 104, ppid: 103, pgid: 103 },
    { pid: 200, ppid: 10, pgid: 200 }, // 다른 세션의 CLI
    { pid: 900, ppid: 1, pgid: 900 }, // 무관한 프로세스
  ]);
  const report = await terminateGroups([100, 200], sys.deps);
  check("every member of both groups is gone", ![100, 101, 102, 103, 104, 200].some((p) => sys.alive.has(p)));
  check("an unrelated process is untouched", sys.alive.has(900));
  check("groups are signalled as a whole (negative pid)", sys.sent.includes("SIGTERM:-100") && sys.sent.includes("SIGTERM:-200"));
  check("a descendant that left the group is signalled individually", sys.sent.includes("SIGTERM:103") && sys.sent.includes("SIGTERM:104"));
  check("nothing needed SIGKILL when everything exits on SIGTERM", report.killed === 0 && report.remaining === 0 && !sys.sent.some((s) => s.startsWith("SIGKILL")), JSON.stringify(report));
  check("report counts the members it found", report.members === 6 && report.roots === 2, JSON.stringify(report));
}

// 2. SIGTERM 을 무시하는 프로세스에게만 유예 뒤 SIGKILL
{
  const sys = fakeSystem([
    { pid: 100, ppid: 10, pgid: 100 },
    { pid: 101, ppid: 100, pgid: 100, stubborn: true },
  ]);
  const report = await terminateGroups([100], sys.deps, { graceMs: 1500 });
  const firstKill = sys.sent.findIndex((s) => s.startsWith("SIGKILL"));
  check("a process that ignores SIGTERM is killed after the grace", !sys.alive.has(101) && report.killed === 1 && report.remaining === 0, JSON.stringify(report));
  check("SIGKILL comes after SIGTERM", firstKill > sys.sent.findIndex((s) => s.startsWith("SIGTERM")));
  check("the grace was waited out first", report.ms >= 1500, String(report.ms));
}

// 3. 루트가 없거나 위험한 pid 면 아무것도 보내지 않는다
{
  const sys = fakeSystem([{ pid: 900, ppid: 1, pgid: 900 }]);
  const empty = await terminateGroups([], sys.deps);
  const unsafe = await terminateGroups([0, 1, -5], sys.deps);
  check("no roots: nothing sent", empty.roots === 0 && sys.sent.length === 0);
  check("pid 0, 1 and negative numbers are refused", unsafe.roots === 0 && sys.sent.length === 0);
}

// --- 종료 순서 ---
function shutdownHarness(options: { terminateThrows?: boolean; leaders?: number[] } = {}) {
  const steps: string[] = [];
  let clock = 0;
  let leaders = options.leaders ?? [100, 200];
  const run = createDaemonShutdown({
    flush: () => steps.push("flush"),
    notifyFlushed: () => steps.push("notifyFlushed"),
    closeRuns: () => steps.push("closeRuns"),
    closeMeta: () => steps.push("closeMeta"),
    groupLeaders: () => leaders,
    terminate: async (roots) => {
      steps.push(`terminate:${roots.join("+")}`);
      if (options.terminateThrows) throw new Error("ps failed");
      return { roots: roots.length, members: 5, stillAliveAfterTerm: 0, killed: 0, remaining: 0, ms: 12 };
    },
    sleep: async (ms) => {
      steps.push(`sleep:${ms}`);
      clock += ms;
      leaders = leaders.filter((p) => p !== 200); // 입력을 닫자 200 은 스스로 끝났다
    },
    exit: (code) => steps.push(`exit:${code}`),
    log: (m) => steps.push(`log:${m.split(" ").slice(0, 2).join(" ")}`),
    now: () => clock,
    setTimer: () => 0,
  });
  return { run, steps };
}

{
  const h = shutdownHarness();
  await h.run("test");
  const plain = h.steps.filter((s) => !s.startsWith("log:"));
  check("order: flush, notify, close inputs, flush again, polite wait, terminate, exit", plain.join(">") === "flush>notifyFlushed>closeMeta>closeRuns>flush>sleep:300>terminate:100>exit:0", plain.join(">"));
  check("the first flush happens before any CLI is touched", h.steps.indexOf("flush") < h.steps.indexOf("closeRuns"));
  check("only groups still alive after the polite wait are terminated", h.steps.includes("terminate:100"));
}
{
  const h = shutdownHarness();
  await Promise.all([h.run("signal SIGTERM"), h.run("shutdown message")]);
  check("calling it twice (SIGTERM and shutdown message together) runs once", h.steps.filter((s) => s === "exit:0").length === 1 && h.steps.filter((s) => s === "notifyFlushed").length === 1);
}
{
  const h = shutdownHarness({ leaders: [] });
  await h.run("no clis");
  check("with no CLI running it neither waits nor terminates", !h.steps.some((s) => s.startsWith("sleep") || s.startsWith("terminate:100")) && h.steps.at(-1) === "exit:0", h.steps.join(">"));
}
{
  const h = shutdownHarness({ terminateThrows: true });
  await h.run("ps broke");
  check("a failing terminate still ends with exit", h.steps.at(-1) === "exit:0");
}
{
  // 저장이 던져도 CLI 정리와 종료는 계속된다
  const steps: string[] = [];
  const run = createDaemonShutdown({
    flush: () => {
      throw new Error("disk full");
    },
    notifyFlushed: () => steps.push("notify"),
    closeRuns: () => steps.push("closeRuns"),
    closeMeta: () => undefined,
    groupLeaders: () => [],
    terminate: async () => ({ roots: 0, members: 0, stillAliveAfterTerm: 0, killed: 0, remaining: 0, ms: 0 }),
    sleep: async () => undefined,
    exit: () => steps.push("exit"),
    log: () => undefined,
    now: () => 0,
    setTimer: () => 0,
  });
  await run("flush fails");
  check("a flush failure does not block closing CLIs or exiting", steps.join(">") === "notify>closeRuns>exit", steps.join(">"));
}
{
  // 상한 타이머: 정리가 멈추면 남은 단계를 건너뛰고 나간다
  let fire: (() => void) | null = null;
  const exits: number[] = [];
  const run = createDaemonShutdown({
    flush: () => undefined,
    notifyFlushed: () => undefined,
    closeRuns: () => undefined,
    closeMeta: () => undefined,
    groupLeaders: () => [1234],
    terminate: () => new Promise(() => undefined),
    sleep: async () => undefined,
    exit: (c) => exits.push(c),
    log: () => undefined,
    now: () => 0,
    setTimer: (fn) => {
      fire = fn;
      return 0;
    },
  });
  void run("hang");
  await new Promise((r) => setImmediate(r));
  check("a hung terminate has not exited yet", exits.length === 0);
  (fire as (() => void) | null)?.();
  check("the hard limit exits without waiting for terminate", exits.length === 1 && exits[0] === 0);
}

// --- 실제 프로세스 그룹 ---
const psAlive = (pids: number[]) => execFileSync("ps", ["-A", "-o", "pid="]).toString().split("\n").map((l) => Number(l.trim())).filter((p) => pids.includes(p));
{
  const spawner = groupedSpawner();
  const abort = new AbortController();
  // CLI 흉내: 자기 그룹의 리더이고, MCP 흉내(그룹 안 자식)와 setsid 흉내(perl 로 새 세션을 연 자손)를 둔다.
  const script = `sleep 3571 & perl -e 'use POSIX; POSIX::setsid(); exec "sleep","3572"' & echo $! > /dev/null; wait`;
  const child = spawner.spawn({ command: "/bin/sh", args: ["-c", script], cwd: "/tmp", env: process.env as Record<string, string>, signal: abort.signal }) as import("node:child_process").ChildProcess;
  await new Promise((r) => setTimeout(r, 600));
  const pid = child.pid!;
  // 시험 환경의 셸 명령줄에 같은 글자가 들어 있을 수 있어 명령줄이 아니라 부모와 그룹으로 고른다
  const members = () =>
    execFileSync("ps", ["-A", "-o", "pid=,ppid=,pgid="]).toString().split("\n").map((l) => l.trim().split(/\s+/).map(Number)).filter(([p, pp, pg]) => p === pid || pp === pid || pg === pid).map(([p]) => p);
  check("the spawned CLI is tracked as a group leader", liveGroupLeaders().includes(pid));
  check("the child is its own process group leader", execFileSync("ps", ["-o", "pgid=", "-p", String(pid)]).toString().trim() === String(pid));
  const found = members();
  const report = await terminateGroups([pid], systemKillDeps, { graceMs: 1500 });
  await new Promise((r) => setTimeout(r, 300));
  const left = psAlive(found);
  check("real group: leader, in-group child and the setsid descendant are all gone", found.length >= 3 && left.length === 0, `found=${found.length} left=${left.length} ${JSON.stringify(report)}`);
  check("the tracker forgets the exited leader", !liveGroupLeaders().includes(pid));
}

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("all passed");
