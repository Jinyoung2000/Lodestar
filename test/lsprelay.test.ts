import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findRelayDirs, hasRelayConfig, isRelayReady, planRelay, platformBinaryPath, readRelaySettings, RELAY_CONFIG_NAMES } from "../server/lspRelay";
import { BUNDLED_LANGUAGE_SERVERS, LANGUAGE_SERVERS, languageServersFor, planChildren, type LanguageServerSpec } from "../server/lspRegistry";
import { runsFolderCode } from "../server/folderTrust";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed++;
};
const json = (value: unknown) => JSON.stringify(value);

const root = mkdtempSync(join(tmpdir(), "lsp-relay-"));
const dir = (...parts: string[]) => {
  const path = join(root, ...parts);
  mkdirSync(path, { recursive: true });
  return path;
};
const file = (path: string, content = "") => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
};

for (const name of RELAY_CONFIG_NAMES) {
  const folder = dir("cfg", name);
  file(join(folder, name), "module.exports = {}");
  check(`활성 조건: ${name}`, hasRelayConfig(folder));
}
{
  const withRelay = dir("pkg", "with");
  file(join(withRelay, "package.json"), json({ name: "x", relay: { src: "./src", schema: "./schema.graphql" } }));
  const without = dir("pkg", "without");
  file(join(without, "package.json"), json({ name: "x" }));
  const broken = dir("pkg", "broken");
  file(join(broken, "package.json"), "{ not json");
  check("활성 조건: package.json 의 relay 항목", hasRelayConfig(withRelay));
  check("활성 조건: relay 항목이 없거나 package.json 이 깨졌으면 아님", !hasRelayConfig(without) && !hasRelayConfig(broken) && !hasRelayConfig(dir("pkg", "empty")));
}

{
  const mono = dir("mono");
  file(join(mono, "app", "relay.config.js"));
  file(join(mono, "app", "src", "deep", "x.tsx"));
  file(join(mono, "tools", "web", "relay.config.json"));
  file(join(mono, "tools", "web", "nested", "relay.config.js"));
  file(join(mono, "packages", "p", "package.json"), json({ relay: {} }));
  file(join(mono, "node_modules", "dep", "relay.config.js"));
  file(join(mono, ".hidden", "relay.config.js"));
  file(join(mono, "dist", "relay.config.js"));
  file(join(mono, "a", "b", "c", "d", "e", "relay.config.js"));
  check("폴더 찾기: 루트로 열면 하위 config 폴더마다", json(await findRelayDirs(mono)) === json([join(mono, "app"), join(mono, "packages", "p"), join(mono, "tools", "web")]), json(await findRelayDirs(mono)));
  check("폴더 찾기: config 를 찾은 폴더 안으로는 더 들어가지 않음", !(await findRelayDirs(mono)).some((found) => found.includes("nested")));
  check("폴더 찾기: node_modules, 숨김, 빌드 산출물 제외와 깊이 제한", !(await findRelayDirs(mono)).some((found) => /node_modules|\.hidden|dist|\/e$/.test(found)));
  check("폴더 찾기: config 폴더 자신을 열면 그 폴더 하나", json(await findRelayDirs(join(mono, "app"))) === json([join(mono, "app")]));
  check("폴더 찾기: config 폴더 안쪽 폴더를 열면 위쪽 config 폴더", json(await findRelayDirs(join(mono, "app", "src", "deep"))) === json([join(mono, "app")]));
  check("폴더 찾기: 어디에도 없으면 빈 목록", json(await findRelayDirs(dir("none", "a"))) === "[]");
}

check("바이너리: darwin arm64", platformBinaryPath("darwin", "arm64") === join("macos-arm64", "relay"));
check("바이너리: darwin x64, linux x64, win32 x64", platformBinaryPath("darwin", "x64") === join("macos-x64", "relay") && platformBinaryPath("linux", "x64") === join("linux-x64", "relay") && platformBinaryPath("win32", "x64") === join("win-x64", "relay.exe"));
check("바이너리: 모르는 플랫폼은 null", platformBinaryPath("freebsd", "x64") === null);
{
  const project = dir("plan", "mono", "app");
  const compiler = dir("plan", "mono", "node_modules", "relay-compiler");
  const exe = join(compiler, platformBinaryPath("darwin", "arm64")!);
  file(exe, "#!/bin/sh\n");
  chmodSync(exe, 0o755);
  file(join(compiler, "package.json"), json({ version: "20.1.1" }));
  const plan = planRelay(project, project, "darwin", "arm64");
  check("실행: 위로 올라가며 찾은 node_modules/relay-compiler 의 플랫폼 바이너리", "exe" in plan && plan.exe === exe && plan.cwd === project && plan.version === "20.1.1", json(plan));
  check("실행: 인자는 lsp, --output=quiet-with-errors", "args" in plan && json(plan.args) === json(["lsp", "--output=quiet-with-errors"]));
  file(join(project, ".vscode", "settings.json"), `{
    // jsonc 주석과 후행 쉼표
    "relay.lspOutputLevel": "verbose",
    "relay.pathToConfig": "relay.config.js",
    "relay.pathToLocateCommand": "./scripts/locate.mjs",
  }`);
  const withSettings = planRelay(project, project, "darwin", "arm64");
  check("실행: VS Code relay.* 설정(출력 수준, config 경로, locateCommand)", "args" in withSettings && json(withSettings.args) === json(["lsp", "--output=verbose", "relay.config.js", "--locateCommand=./scripts/locate.mjs"]), json(withSettings));
  file(join(project, ".vscode", "settings.json"), json({ "relay.pathToRelay": "./bin/my-relay" }));
  const custom = planRelay(project, project, "darwin", "arm64");
  check("실행: relay.pathToRelay 는 config 폴더 기준 경로", "exe" in custom && custom.exe === join(project, "bin", "my-relay"));
  rmSync(join(project, ".vscode"), { recursive: true });
  const settings = readRelaySettings(project, project);
  check("설정: 파일이 없으면 빈 설정", json(settings) === "{}");
  const noPackage = planRelay(dir("plan", "lonely"), dir("plan", "lonely"), "darwin", "arm64");
  check("실행 불가: relay-compiler 가 없으면 이유", "problem" in noPackage && /node_modules\/relay-compiler/.test(noPackage.problem), json(noPackage));
  check("실행 불가: 플랫폼 바이너리가 없으면 이유", "problem" in planRelay(project, project, "freebsd", "x64"));
  chmodSync(exe, 0o644);
  const notExecutable = planRelay(project, project, "darwin", "arm64");
  check("실행 불가: 실행 권한이 없으면 이유", "problem" in notExecutable && /not found or not executable/.test(notExecutable.problem));
  chmodSync(exe, 0o755);
  file(join(compiler, "package.json"), json({ version: "13.0.0" }));
  const tooOld = planRelay(project, project, "darwin", "arm64");
  check("실행 불가: 14 미만 relay-compiler 는 이유", "problem" in tooOld && /too old/.test(tooOld.problem));
}

check("준비 신호: window/showStatus 의 ready", isRelayReady({ method: "window/showStatus", id: 1, params: { message: "The Relay extension is ready", shortMessage: "Relay: ready", type: 3 } }));
check("준비 신호: 진행 중 상태는 아님", !isRelayReady({ method: "window/showStatus", id: 1, params: { message: "Building schemas and source programs for LSP", shortMessage: "Relay: creating state...", type: 2 } }));
check("준비 신호: 다른 메서드는 아님", !isRelayReady({ method: "window/logMessage", params: { message: "ready" } }));

check("레지스트리: TypeScript 가 첫 항목, Relay 가 두 번째", json(LANGUAGE_SERVERS.map((server) => server.id)) === json(["typescript", "relay"]));
check("레지스트리: Relay 의 담당 언어에 graphql 과 JS 계열", ["graphql", "typescript", "typescriptreact", "javascript", "javascriptreact"].every((id) => LANGUAGE_SERVERS[1]!.languages.includes(id)));
{
  const mono = dir("registry", "mono");
  file(join(mono, "app", "relay.config.js"));
  file(join(mono, "other", "relay.config.js"));
  const ts = await planChildren(dir("registry", "plain"));
  check("레지스트리: relay 가 없는 폴더는 TypeScript 만, 즉시 시작", ts.length === 1 && ts[0]!.primary === true && ts[0]!.eager === true && ts[0]!.dir === null, json(ts.map((child) => child.key)));
  const multi = await planChildren(mono);
  check("레지스트리: 루트로 열면 TS 하나와 config 폴더마다 Relay(지연 시작, 폴더 범위)", multi.length === 3 && multi[0]!.key === "typescript" && multi.slice(1).every((child) => child.serverId === "relay" && !child.eager && child.dir === child.rootDir) && json(multi.slice(1).map((child) => child.dir)) === json([join(mono, "app"), join(mono, "other")]), json(multi.map((child) => child.key)));
  check("레지스트리: Relay 가 여럿이면 라벨에 폴더 이름", multi[1]!.label === "Relay (app)" && (await planChildren(join(mono, "app")))[1]!.label === "Relay");
  const broken: LanguageServerSpec = {
    id: "broken",
    label: "Broken",
    languages: ["typescript"],
    activate: () => {
      throw new Error("boom");
    },
  };
  const original = console.error;
  console.error = () => {};
  const isolated = await planChildren(mono, [broken, ...LANGUAGE_SERVERS]);
  console.error = original;
  check("레지스트리: 한 항목의 활성화 실패는 다른 항목을 막지 않음", isolated.length === 3 && isolated[0]!.key === "typescript");
}

{
  const w = (id: string, path: string, parentId: string | null = null) => ({ id, dir: path, parentId });
  const repo = dir("trust", "repo");
  const review = dir("trust", "repo.worktrees", "pr-7-fix");
  const fromReview = dir("trust", "repo.worktrees.worktrees", "next");
  const home = dir("trust", "home");
  const download = dir("trust", "home", "someone-lib");
  const roots = {
    workspaces: [w("r", repo), w("pr", review, "r"), w("pr2", fromReview, "pr"), w("h", home), w("wt", dir("trust", "repo.worktrees", "feature"), "r")],
    reviews: [review],
    downloads: [download],
  };
  check("신뢰: 추가한 워크스페이스와 그 안의 파일", runsFolderCode(repo, roots) === true && runsFolderCode(join(repo, "src", "a.ts"), roots) === true);
  check("신뢰: 추가한 워크스페이스의 worktree", runsFolderCode(join(root, "trust", "repo.worktrees", "feature"), roots) === true);
  check("신뢰: PR 리뷰 체크아웃은 워크스페이스가 있어도 안 됨", runsFolderCode(review, roots) === false && runsFolderCode(join(review, "src"), roots) === false);
  check("신뢰: 리뷰 체크아웃에서 만든 worktree 도 안 됨", runsFolderCode(fromReview, roots) === false);
  check("신뢰: 추가한 폴더 안의 받은 클론은 안 됨", runsFolderCode(home, roots) === true && runsFolderCode(join(download, "x.ts"), roots) === false);
  check("신뢰: 받은 클론을 그대로 워크스페이스로 추가하면 됨", runsFolderCode(download, { ...roots, workspaces: [...roots.workspaces, w("d", download)] }) === true);
  check("신뢰: 어느 워크스페이스에도 없는 폴더는 안 됨", runsFolderCode(dir("trust", "elsewhere"), roots) === false);

  file(join(home, "app", "relay.config.js"));
  file(join(download, "relay.config.js"));
  const allowed = (path: string) => runsFolderCode(path, roots);
  const own = await planChildren(home, languageServersFor(allowed));
  check("신뢰: 추가한 폴더 안의 받은 클론에서는 Relay 를 띄우지 않음", json(own.map((child) => child.key)) === json(["typescript", `relay:${join(home, "app")}`]), json(own.map((child) => child.key)));
  const bundled = await planChildren(download, BUNDLED_LANGUAGE_SERVERS);
  check("신뢰: 추가하지 않은 폴더는 TypeScript 하나만(앱 번들)", json(bundled.map((child) => child.key)) === json(["typescript"]) && bundled[0]!.primary === true, json(bundled.map((child) => child.key)));
}

rmSync(root, { recursive: true, force: true });
console.log(failed === 0 ? "all passed" : `${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
