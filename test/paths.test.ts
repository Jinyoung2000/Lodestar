import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "agent-nav-paths-home-"));
process.env.AGENT_NAV_HOME = home;
const { resolveInside } = await import("../server/files");
const gitOps = await import("../server/git");
const { Store } = await import("../server/store");

const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
};

const base = realpathSync(mkdtempSync(join(tmpdir(), "agent-nav-paths-")));
const real = join(base, "real");
const link = join(base, "link");
mkdirSync(join(real, "src"), { recursive: true });
symlinkSync(real, link);
writeFileSync(join(real, "src/a.ts"), "a\n");
execFileSync("git", ["init", "-q", "-b", "main"], { cwd: real });
execFileSync("git", ["-c", "user.email=t@e.com", "-c", "user.name=t", "add", "."], { cwd: real });
execFileSync("git", ["-c", "user.email=t@e.com", "-c", "user.name=t", "commit", "-q", "-m", "init"], { cwd: real });

try {
  const root = await gitOps.repoRoot(link);
  expect(root === real, `git 이 실제 경로를 돌려준다: ${root}`);
  expect(resolveInside(link, join(real, "src/a.ts")) === join(real, "src/a.ts"), "링크 폴더 기준으로 실제 경로를 받아들인다");
  expect(resolveInside(link, join(real, "src/new/file.ts")) === join(real, "src/new/file.ts"), "아직 없는 새 파일도 받아들인다");
  expect(resolveInside(real, join(link, "src/a.ts")) === join(real, "src/a.ts"), "반대로 실제 폴더 기준에 링크 경로를 줘도 실제 경로로 돌려준다");
  expect(resolveInside(link, "src/a.ts") === join(link, "src/a.ts"), "상대 경로는 입력한 폴더 기준 그대로");

  for (const bad of ["../outside.txt", join(base, "outside.txt"), "/etc/passwd", join(link, "../outside.txt")]) {
    let rejected = false;
    try {
      resolveInside(link, bad);
    } catch {
      rejected = true;
    }
    expect(rejected, `거절돼야 함: ${bad}`);
  }
  mkdirSync(join(base, "sibling"));
  let siblingRejected = false;
  try {
    resolveInside(link, join(real, "../sibling/x.txt"));
  } catch {
    siblingRejected = true;
  }
  expect(siblingRejected, "형제 폴더는 거절");

  writeFileSync(
    join(home, "state.json"),
    JSON.stringify({
      workspaces: [
        { id: "w1", name: "real", dir: real, parentId: null },
        { id: "w2", name: "link", dir: link, parentId: null },
      ],
      agents: [
        { id: "a1", workspaceId: "w2", cwd: join(link, "src"), worktree: { root: link, branch: "x", base: "main" } },
        { id: "a2", workspaceId: null, cwd: join(link, "chat") },
      ],
    }),
  );
  const store = new Store();
  expect(store.workspaces.length === 1 && store.workspaces[0].dir === real && store.workspaces[0].id === "w1", `폴더가 하나로 합쳐진다: ${JSON.stringify(store.workspaces)}`);
  expect(store.agent("a1").workspaceId === "w1", "세션이 남은 폴더로 옮겨진다");
  expect(store.agent("a1").cwd === join(real, "src") && store.agent("a1").worktree?.root === real, "세션 cwd 와 worktree 경로가 실제 경로");
  expect(store.agent("a2").cwd === join(link, "chat"), "폴더 없는 세션의 cwd 는 건드리지 않는다");
  expect(store.addWorkspace(link).id === "w1", "링크로 폴더를 추가해도 같은 폴더로 인식");
  console.log("ok   paths: 링크 폴더 경로 검사, 밖으로 나가는 경로 거절, 저장된 경로 정규화와 합치기");
} finally {
  rmSync(base, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
}
