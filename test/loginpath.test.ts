// 로그인 셸 PATH 읽기: 실패하면 캐시하지 않고 다시 읽는지, 후보 폴더가 합쳐지는지, 실행 파일을 PATH 에서 찾는지 단독 시험(실제 셸을 부르지 않는다).
// 실행: npm test
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

delete process.env.NVM_DIR;
const { createLoginPath, findExecutable } = await import("../server/loginPath");
const { candidateDirs, newestFirst } = await import("../server/pathCandidates");

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed++;
};

const root = realpathSync(mkdtempSync(join(tmpdir(), "loginpath-")));
const dir = (...parts: string[]) => {
  const path = join(root, ...parts);
  mkdirSync(path, { recursive: true });
  return path;
};
const out = (path: string) => `Last login: Mon\nwelcome banner from .zshrc\n\n__LODESTAR_PATH__${path}\n`;

// 1. 로그인 셸 읽기가 실패하면 캐시하지 않고, 대기 시간이 지나면 다시 읽는다
{
  const home = dir("home1");
  const calls: string[] = [];
  let clock = 1_000;
  let mode: "fail" | "lc-only" | "ok" = "fail";
  const login = createLoginPath({
    home,
    now: () => clock,
    shell: "/bin/zsh",
    run: async (_shell, args) => {
      calls.push(args[0]);
      if (mode === "fail") throw new Error("Command failed: timed out");
      if (mode === "lc-only" && args[0] === "-lic") throw new Error("interactive shell hung");
      return out("/Users/x/.local/bin:/usr/bin");
    },
  });
  check("first read fails: empty result, tried -lic then -lc", (await login.loginShellPath()) === "" && calls.join(",") === "-lic,-lc", calls.join(","));
  check("a failed read is not cached", !login.hasLoginPath());
  check("report says fallback and keeps the reason", login.report().source === "fallback" && /-lic: .*timed out/.test(login.report().error ?? ""), JSON.stringify(login.report().error));
  await login.loginShellPath();
  check("within the backoff it does not spawn the shell again", calls.length === 2, String(calls.length));
  clock += 6_000;
  mode = "lc-only";
  check("after the backoff it reads again and falls back to -lc when -lic fails", (await login.loginShellPath()) === "/Users/x/.local/bin:/usr/bin" && calls.slice(2).join(",") === "-lic,-lc", calls.slice(2).join(","));
  check("a good read is cached and used as is", login.hasLoginPath() && (await login.loginShellPath()) === "/Users/x/.local/bin:/usr/bin" && calls.length === 4);
  check("the banner printed by .zshrc does not leak into PATH", !login.withLoginPath("/usr/sbin").includes("banner"));
  mode = "fail";
  check("a forced read that fails keeps the PATH read earlier", (await login.loginShellPath(true)) === "/Users/x/.local/bin:/usr/bin" && login.hasLoginPath());
  mode = "ok";
  clock += 10 * 60_000;
  check("a forced read bypasses the cache and the backoff", (await login.loginShellPath(true)) === "/Users/x/.local/bin:/usr/bin" && calls.length > 6);
}

// 2. 두 호출이 겹치면 셸은 한 번만 뜬다
{
  let spawned = 0;
  const login = createLoginPath({
    home: dir("home2"),
    run: async () => {
      spawned++;
      await new Promise((r) => setTimeout(r, 30));
      return out("/a/bin");
    },
  });
  await Promise.all([login.loginShellPath(), login.loginShellPath(), login.loginShellPath(true)]);
  check("concurrent reads share one shell", spawned === 1, String(spawned));
}

// 3. 후보 폴더: 존재하는 폴더만, 우선순위 순서로
{
  const home = dir("home3");
  dir("home3", ".local/bin");
  dir("home3", ".volta/bin");
  dir("home3", ".bun/bin");
  dir("home3", ".nvm/versions/node/v18.19.0/bin");
  dir("home3", ".nvm/versions/node/v20.9.0/bin");
  dir("home3", ".nvm/versions/node/v20.11.1/bin");
  dir("home3", ".nvm/alias");
  writeFileSync(join(home, ".nvm/alias/default"), "20\n");
  const dirs = candidateDirs(home);
  const index = (suffix: string) => dirs.findIndex((d) => d.endsWith(suffix));
  check("user folders that exist are listed", index(".local/bin") === 0 && index(".volta/bin") === 1 && index(".bun/bin") === 2, dirs.join(","));
  check("nvm default alias 20 picks the newest 20.x", index("v20.11.1/bin") === 3 && index("v20.9.0/bin") === -1 && index("v18.19.0/bin") === -1, dirs.join(","));
  check("folders that do not exist are left out", !dirs.some((d) => d.includes(".fnm") || d.includes("Application Support")));
  check("homebrew folders come last when they exist", dirs.filter((d) => d.startsWith("/opt/homebrew") || d.startsWith("/usr/local")).every((d, i, all) => dirs.indexOf(d) >= dirs.length - all.length));

  writeFileSync(join(home, ".nvm/alias/default"), "v18\n");
  check("alias v18 picks 18.19.0", candidateDirs(home).some((d) => d.endsWith("v18.19.0/bin")) && !candidateDirs(home).some((d) => d.endsWith("v20.11.1/bin")));
  writeFileSync(join(home, ".nvm/alias/default"), "lts/*\n");
  check("alias lts/* (not a version) falls back to the newest installed", candidateDirs(home).some((d) => d.endsWith("v20.11.1/bin")));
  dir("home3", ".nvm/alias/lts");
  writeFileSync(join(home, ".nvm/alias/lts/iron"), "v20.9.0\n");
  writeFileSync(join(home, ".nvm/alias/default"), "lts/iron\n");
  check("alias chain lts/iron -> v20.9.0 is followed", candidateDirs(home).some((d) => d.endsWith("v20.9.0/bin")) && !candidateDirs(home).some((d) => d.endsWith("v20.11.1/bin")));
  check("versions sort numerically, not as text", newestFirst(["v9.0.0", "v10.1.0", "v10.0.9"]).join(",") === "v10.1.0,v10.0.9,v9.0.0");

  const fnmHome = dir("home4");
  dir("home4", ".local/share/fnm/node-versions/v20.0.0/installation/bin");
  dir("home4", ".local/share/fnm/node-versions/v22.1.0/installation/bin");
  check("fnm without a default alias picks the newest version", candidateDirs(fnmHome).some((d) => d.endsWith("v22.1.0/installation/bin")));
  dir("home4", ".local/share/fnm/aliases/default/bin");
  check("fnm default alias wins when it exists", candidateDirs(fnmHome).some((d) => d.endsWith("aliases/default/bin")) && !candidateDirs(fnmHome).some((d) => d.endsWith("v22.1.0/installation/bin")));
}

// 4. 읽기 전이거나 실패한 동안에도 sessions 가 쓰는 PATH 에 후보가 붙는다 (GUI 로 뜬 데몬의 /usr/bin:/bin)
{
  const home = dir("home5");
  const local = dir("home5", ".local/bin");
  const login = createLoginPath({ home, run: async () => { throw new Error("no shell"); } });
  const before = login.withLoginPath("/usr/bin:/bin:/usr/sbin:/sbin");
  check("before the login shell is read, ~/.local/bin is already in PATH", before.split(":").includes(local) && before.startsWith("/usr/bin:/bin"), before);
  const fake = createLoginPath({ home, run: async () => out("/login/bin:/usr/bin") });
  await fake.loginShellPath();
  const after = fake.withLoginPath("/usr/bin:/bin");
  check("after the read, the login PATH comes first and nothing is duplicated", after.startsWith("/login/bin:/usr/bin:/bin") && after.split(":").length === new Set(after.split(":")).size, after);
}

// 5. findExecutable: 실행할 수 있는 파일만, PATH 순서대로
{
  const bin1 = dir("bin1");
  const bin2 = dir("bin2");
  writeFileSync(join(bin1, "plain"), "x");
  chmodSync(join(bin1, "plain"), 0o644);
  writeFileSync(join(bin2, "plain"), "#!/bin/sh\n");
  chmodSync(join(bin2, "plain"), 0o755);
  dir("bin1", "adir");
  writeFileSync(join(bin2, "target"), "#!/bin/sh\n");
  chmodSync(join(bin2, "target"), 0o755);
  symlinkSync(join(bin2, "target"), join(bin1, "linked"));
  const path = `${bin1}:${bin2}`;
  check("a non-executable file earlier in PATH is skipped", findExecutable("plain", path) === join(bin2, "plain"));
  check("a directory with the same name is not an executable", findExecutable("adir", path) === null);
  check("a symlink to an executable is found", findExecutable("linked", path) === join(bin1, "linked"));
  check("a missing name gives null, an empty PATH gives null", findExecutable("nope", path) === null && findExecutable("plain", "") === null && findExecutable("plain", undefined) === null);
  check("an absolute path is checked directly", findExecutable(join(bin2, "plain"), "") === join(bin2, "plain") && findExecutable(join(bin1, "plain"), "") === null);
}

if (failed) {
  console.error(`${failed} check(s) failed`);
  process.exit(1);
}
