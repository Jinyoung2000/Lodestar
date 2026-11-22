import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { absoluteOpenPath, argvOpenPaths, classifyOpenPath, dirNameOf, OpenQueue, planOpenWindow, resolvePosix, workspaceDirsOfPanes, worktreeParentDir, type PathFs } from "../shared/openPath";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed++;
};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const base = { home: "/Users/me", cwd: "/work" };

check("resolvePosix: . 와 .. 와 겹친 / 를 정리", resolvePosix("/a//b/./c/../d/", "/") === "/a/b/d");
check("resolvePosix: 상대 경로는 base 에서", resolvePosix("x/y", "/work") === "/work/x/y" && resolvePosix("../x", "/work/y") === "/work/x");
check("dirNameOf", dirNameOf("/a/b/c.ts") === "/a/b" && dirNameOf("/c.ts") === "/");
check("absoluteOpenPath: 홈, file://, 상대, 빈 글자", absoluteOpenPath("~/Repo/x", base) === "/Users/me/Repo/x" && absoluteOpenPath("~", base) === "/Users/me" && absoluteOpenPath("file:///a/b%20c/", base) === "/a/b c" && absoluteOpenPath("sub", base) === "/work/sub" && absoluteOpenPath("  ", base) === null);

{
  const entries: Record<string, "dir" | "file" | "other"> = { "/repo": "dir", "/repo/src": "dir", "/repo/src/a.ts": "file", "/sock": "other", "/link-dir": "dir", "/link-file": "file" };
  const links: Record<string, string> = { "/link-dir": "/repo/src", "/link-file": "/repo/src/a.ts", "/tmp": "/private/tmp", "/tmp/x": "/private/tmp/x" };
  const fs: PathFs = { kind: (p) => entries[p] ?? (links[p] ? "dir" : "missing"), real: (p) => links[p] ?? p };
  check("폴더", same(classifyOpenPath("/repo", base, fs), { kind: "folder", dir: "/repo" }));
  check("폴더 끝 슬래시", same(classifyOpenPath("/repo/", base, fs), { kind: "folder", dir: "/repo" }));
  check("파일: 든 폴더와 파일 이름", same(classifyOpenPath("/repo/src/a.ts", base, fs), { kind: "file", dir: "/repo/src", file: "a.ts" }));
  check("없는 경로", same(classifyOpenPath("/nope", base, fs), { kind: "missing", path: "/nope" }));
  check("없는 상대 경로는 절대 경로로 알린다", same(classifyOpenPath("nope", base, fs), { kind: "missing", path: "/work/nope" }));
  check("소켓 같은 것은 unsupported", same(classifyOpenPath("/sock", base, fs), { kind: "unsupported", path: "/sock" }));
  check("폴더 심볼릭 링크는 실제 폴더", same(classifyOpenPath("/link-dir", base, fs), { kind: "folder", dir: "/repo/src" }));
  check("파일 심볼릭 링크는 실제 파일이 든 폴더", same(classifyOpenPath("/link-file", base, fs), { kind: "file", dir: "/repo/src", file: "a.ts" }));
  check("빈 글자는 없는 경로", classifyOpenPath("", base, fs).kind === "missing");
}

{
  const real: PathFs = {
    kind: (p) => {
      try {
        const s = statSync(p);
        return s.isDirectory() ? "dir" : s.isFile() ? "file" : "other";
      } catch {
        return "missing";
      }
    },
    real: (p) => realpathSync(p),
  };
  const root = realpathSync(mkdtempSync(join(tmpdir(), "openpath-")));
  try {
    mkdirSync(join(root, "proj/src"), { recursive: true });
    writeFileSync(join(root, "proj/src/a.ts"), "x");
    symlinkSync(join(root, "proj"), join(root, "link-proj"));
    symlinkSync(join(root, "proj/src/a.ts"), join(root, "link-a.ts"));
    symlinkSync(join(root, "gone"), join(root, "broken"));
    check("임시 폴더 준비", root.length > 0);
    check("실제 폴더", same(classifyOpenPath(join(root, "proj"), base, real), { kind: "folder", dir: join(root, "proj") }));
    check("심볼릭 링크 폴더는 실제 경로", same(classifyOpenPath(join(root, "link-proj"), base, real), { kind: "folder", dir: join(root, "proj") }));
    check("심볼릭 링크 파일은 실제 파일의 폴더", same(classifyOpenPath(join(root, "link-a.ts"), base, real), { kind: "file", dir: join(root, "proj/src"), file: "a.ts" }));
    check("끊긴 링크는 없는 경로", classifyOpenPath(join(root, "broken"), base, real).kind === "missing");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  const viaTmp = mkdtempSync("/tmp/openpath-");
  try {
    const want = realpathSync(viaTmp);
    check("/tmp 로 준 폴더는 /private/tmp 실제 경로", same(classifyOpenPath(viaTmp, base, real), { kind: "folder", dir: want }) && want.startsWith("/private/tmp/"), want);
  } finally {
    rmSync(viaTmp, { recursive: true, force: true });
  }
}

{
  const opts = { defaultApp: false, cwd: "/work", home: "/Users/me" };
  check("패키징 앱: 실행 파일을 빼고 경로만", same(argvOpenPaths(["/Applications/Lodestar.app/Contents/MacOS/Lodestar", "/repo"], opts), ["/repo"]));
  check("개발 실행: electron 과 앱 경로를 뺀다", same(argvOpenPaths(["/x/electron", ".", "/repo"], { ...opts, defaultApp: true }), ["/repo"]));
  check("개발 실행의 second-instance 는 옵션이 앞으로 와도 앱 경로만 뺀다", same(argvOpenPaths(["/x/electron", "--foo", "--allow-file-access-from-files", "/app", "plainA"], { ...opts, defaultApp: true, cwd: "/tmp/p" }), ["/tmp/p/plainA"]));
  check("옵션과 -psn_ 은 뺀다", same(argvOpenPaths(["/x/Lodestar", "--disable-features=A", "-psn_0_123", "/repo"], opts), ["/repo"]));
  check("상대 경로는 작업 폴더 기준", same(argvOpenPaths(["/x/Lodestar", "sub"], { ...opts, cwd: "/work/p" }), ["/work/p/sub"]));
  check("경로 없음", same(argvOpenPaths(["/x/Lodestar"], opts), []) && same(argvOpenPaths(["/x/electron", "."], { ...opts, defaultApp: true }), []));
  check("같은 경로 두 번은 하나", same(argvOpenPaths(["/x/Lodestar", "/repo", "/repo/"], opts), ["/repo"]));
}

{
  const workspaces = [
    { id: "w-a", dir: "/repo" },
    { id: "w-b", dir: "/repo.worktrees/x" },
    { id: "w-c", dir: "/other" },
  ];
  const agents = [
    { id: "s1", workspaceId: "w-a" },
    { id: "s2", workspaceId: "w-b" },
    { id: "s3", workspaceId: null },
  ];
  const dirs = workspaceDirsOfPanes(
    [
      { kind: "agent", agentId: "s1" },
      { kind: "agent", agentId: "s2" },
      { kind: "agent", agentId: "s3" },
      { kind: "draft", workspaceId: "w-c" },
      { kind: "draft", workspaceId: null },
      { kind: "draft", workspaceId: "gone" },
      { kind: "agent", agentId: "unknown" },
    ],
    agents,
    workspaces,
  );
  check("세션 칸과 새 세션 칸의 폴더(worktree 는 자기 폴더)", same(dirs, ["/other", "/repo", "/repo.worktrees/x"]));
}

{
  const win = (id: string, ...dirs: string[]) => ({ id, dirs: new Set(dirs) });
  const windows = [win("w1", "/a"), win("w2", "/b", "/c"), win("w3", "/c")];
  const pick = (dir: string, extra: Partial<{ focusedId: string | null; lastActiveId: string | null; spareId: string | null }> = {}) => planOpenWindow({ windows, dir, focusedId: null, lastActiveId: null, spareId: null, ...extra });
  check("그 폴더를 보는 창이 있으면 그 창", same(pick("/a"), { kind: "existing", windowId: "w1" }));
  check("여럿이면 포커스 창", same(pick("/c", { focusedId: "w2" }), { kind: "existing", windowId: "w2" }));
  check("포커스 창이 안 보는 쪽이면 마지막 활성 창", same(pick("/c", { focusedId: "w1", lastActiveId: "w3" }), { kind: "existing", windowId: "w3" }));
  check("포커스와 마지막 활성이 없으면 가장 나중에 만든 창", same(pick("/c"), { kind: "existing", windowId: "w3" }));
  check("보는 창이 없으면 새 창", same(pick("/zzz"), { kind: "new" }));
  check("보는 창이 없고 빈 창이 있으면 그 창", same(pick("/zzz", { spareId: "w9" }), { kind: "spare", windowId: "w9" }));
  check("빈 창이 있어도 보는 창이 먼저", same(pick("/a", { spareId: "w9" }), { kind: "existing", windowId: "w1" }));
  check("부모 폴더와 worktree 는 다른 폴더", same(planOpenWindow({ windows: [win("w1", "/repo.worktrees/x")], dir: "/repo", focusedId: null, lastActiveId: null, spareId: null }), { kind: "new" }));
  check("창이 하나도 없으면 새 창", same(planOpenWindow({ windows: [], dir: "/a", focusedId: null, lastActiveId: null, spareId: null }), { kind: "new" }));
  const laid = [{ ...win("w1", "/a"), layout: "chat" }, { ...win("w2", "/a"), layout: "editor" }, { ...win("w3", "/b"), layout: "editor" }];
  check("reuseLayout editor 면 Editor 로 보던 창을 고른다", same(planOpenWindow({ windows: laid, dir: "/a", focusedId: "w1", lastActiveId: null, spareId: null, reuseLayout: "editor" }), { kind: "existing", windowId: "w2" }));
  check("Chat 으로만 보던 창은 두고 새 창", same(planOpenWindow({ windows: laid.slice(0, 1), dir: "/a", focusedId: "w1", lastActiveId: null, spareId: null, reuseLayout: "editor" }), { kind: "new" }));
  check("배치를 모르는 창(옛 페이지)은 고르지 않고 빈 창을 쓴다", same(planOpenWindow({ windows, dir: "/a", focusedId: null, lastActiveId: null, spareId: "w9", reuseLayout: "editor" }), { kind: "spare", windowId: "w9" }));
}

{
  const tree = { root: "/repo.worktrees/feat", mainRoot: "/repo" };
  check("worktree 뿌리는 원 레포 뿌리 아래", worktreeParentDir("/repo.worktrees/feat", tree) === "/repo");
  check("worktree 안쪽 폴더는 원 레포의 같은 위치", worktreeParentDir("/repo.worktrees/feat/packages/app", tree) === "/repo/packages/app");
  check("뿌리 밖이면 원 레포 뿌리", worktreeParentDir("/elsewhere", tree) === "/repo");
}

{
  const log: string[] = [];
  const queue = new OpenQueue<string, string>(async (path) => {
    log.push(`start ${path}`);
    await new Promise((r) => setTimeout(r, path === "slow" ? 30 : 1));
    if (path === "boom") throw new Error("boom");
    log.push(`end ${path}`);
    return `done ${path}`;
  });
  const early1 = queue.push("slow");
  const early2 = queue.push("fast");
  await new Promise((r) => setTimeout(r, 20));
  check("ready 전에는 처리하지 않고 쌓는다", log.length === 0 && queue.pending === 2 && !queue.isReady);
  const drained = queue.ready();
  const late = queue.push("late");
  const bad = queue.push("boom").then(
    () => "resolved",
    (e: Error) => `rejected ${e.message}`,
  );
  const after = queue.push("after");
  check("결과를 요청마다 돌려준다", (await early1) === "done slow" && (await early2) === "done fast" && (await late) === "done late");
  check("던진 요청은 거절되고 다음 요청은 막지 않는다", (await bad) === "rejected boom" && (await after) === "done after");
  await drained;
  check("들어온 순서대로 하나씩(앞 요청이 끝난 뒤 다음)", same(log, ["start slow", "end slow", "start fast", "end fast", "start late", "end late", "start boom", "start after", "end after"]), log.join(" | "));
  check("ready 뒤 요청은 바로 처리", queue.isReady && queue.pending === 0);
}

if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nall passed");
