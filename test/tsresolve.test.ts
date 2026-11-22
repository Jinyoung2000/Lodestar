import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findNativeExe, findWorkspaceTypeScript, majorOf, planLanguageServer } from "../server/tsResolve";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed++;
};

const platform = process.platform;
const arch = process.arch;
const pkgName = `typescript-${platform}-${arch}`;
const root = mkdtempSync(join(tmpdir(), "ts-resolve-"));
let counter = 0;

type Layout = { version?: string; tsserver?: boolean; getExePath?: "ok" | "throws" | "missing-exe"; platformPackage?: boolean | "not-executable"; link?: boolean };

function workspace(layout: Layout) {
  const base = join(root, `case-${++counter}`);
  const nodeModules = join(base, "node_modules");
  const store = layout.link ? join(base, "node_modules/.pnpm/typescript@x/node_modules") : nodeModules;
  const tsDir = join(store, "typescript");
  mkdirSync(join(tsDir, "lib"), { recursive: true });
  writeFileSync(join(tsDir, "package.json"), JSON.stringify({ name: "typescript", version: layout.version ?? "7.0.2", type: "module" }));
  if (layout.tsserver) writeFileSync(join(tsDir, "lib/tsserver.js"), "");
  if (layout.platformPackage) {
    const exeDir = join(store, "@typescript", pkgName, "lib");
    mkdirSync(exeDir, { recursive: true });
    writeFileSync(join(exeDir, "tsc"), "#!/bin/sh\n");
    chmodSync(join(exeDir, "tsc"), layout.platformPackage === "not-executable" ? 0o644 : 0o755);
  }
  if (layout.getExePath === "ok") {
    writeFileSync(
      join(tsDir, "lib/getExePath.js"),
      `import path from "node:path";\nimport { fileURLToPath } from "node:url";\nexport default function getExePath() {\n  const here = path.dirname(fileURLToPath(import.meta.url));\n  return path.join(here, "..", "..", "@typescript", "${pkgName}", "lib", "tsc");\n}\n`,
    );
  } else if (layout.getExePath === "throws") {
    writeFileSync(join(tsDir, "lib/getExePath.js"), `export default function getExePath() { throw new Error("Unable to resolve platform package"); }\n`);
  } else if (layout.getExePath === "missing-exe") {
    writeFileSync(join(tsDir, "lib/getExePath.js"), `export default function getExePath() { return "/nonexistent/tsc"; }\n`);
  }
  if (layout.link) symlinkSync(tsDir, join(nodeModules, "typescript"));
  const project = join(base, "packages/app/src");
  mkdirSync(project, { recursive: true });
  return { base, project, nodeModules };
}

async function main() {
  check("majorOf: 7.0.2, 5.9.3, 7.0.0-beta, 이상한 값", majorOf("7.0.2") === 7 && majorOf("5.9.3") === 5 && majorOf("7.0.0-beta.1") === 7 && majorOf("x") === null && majorOf(null) === null);

  const none = join(root, "empty");
  mkdirSync(none, { recursive: true });
  check("워크스페이스 위로 typescript 가 없으면 null", findWorkspaceTypeScript(none) === null);
  const noPlan = await planLanguageServer(none);
  check("TypeScript 없음: typescript-language-server, 이유 없음", noPlan.kind === "tsls" && noPlan.reason === null && noPlan.tsserverPath === null);

  const ts5 = workspace({ version: "5.9.3", tsserver: true });
  const ts5Plan = await planLanguageServer(ts5.project);
  check(
    "TS5 + tsserver.js: typescript-language-server 에 워크스페이스 tsserver.js, 위쪽 node_modules 에서 찾음",
    ts5Plan.kind === "tsls" && ts5Plan.tsserverPath === join(ts5.nodeModules, "typescript/lib/tsserver.js") && ts5Plan.reason === null && ts5Plan.workspaceVersion === "5.9.3",
    JSON.stringify(ts5Plan),
  );

  const ts7 = workspace({ version: "7.0.2", getExePath: "ok", platformPackage: true });
  const ts7Plan = await planLanguageServer(ts7.project);
  const expectedExe = join(ts7.nodeModules, "@typescript", pkgName, "lib/tsc");
  check("TS7 + getExePath: 네이티브, getExePath 가 준 경로", ts7Plan.kind === "native" && ts7Plan.version === "7.0.2", JSON.stringify(ts7Plan));
  check("TS7 + getExePath: 경로가 실제 설치한 파일", ts7Plan.kind === "native" && existsSync(ts7Plan.exe) && realpathSync(ts7Plan.exe) === realpathSync(expectedExe), expectedExe);

  const platformOnly = workspace({ version: "7.0.2", platformPackage: true });
  const platformPlan = await planLanguageServer(platformOnly.project);
  check("TS7 + 플랫폼 패키지만(getExePath.js 없음): 네이티브, 패키지 탐색", platformPlan.kind === "native" && platformPlan.exe === join(platformOnly.nodeModules, "@typescript", pkgName, "lib/tsc"), JSON.stringify(platformPlan));

  const throwing = workspace({ version: "7.0.2", getExePath: "throws", platformPackage: true });
  const throwingPlan = await planLanguageServer(throwing.project);
  check("getExePath 가 던져도 플랫폼 패키지를 직접 찾음", throwingPlan.kind === "native", JSON.stringify(throwingPlan));

  const broken = workspace({ version: "7.0.2" });
  const brokenPlan = await planLanguageServer(broken.project);
  check(
    "TS7 인데 실행 파일이 없음: typescript-language-server + 이유",
    brokenPlan.kind === "tsls" && brokenPlan.tsserverPath === null && /TypeScript 7\.0\.2 has no tsserver\.js and its native executable was not found/.test(brokenPlan.reason ?? ""),
    JSON.stringify(brokenPlan),
  );

  const missingExe = workspace({ version: "7.0.2", getExePath: "missing-exe" });
  const missingPlan = await planLanguageServer(missingExe.project);
  check("getExePath 가 없는 파일을 가리킴: 이유에 반환값이 남음", missingPlan.kind === "tsls" && /getExePath\.js returned "\/nonexistent\/tsc"/.test(missingPlan.reason ?? ""), JSON.stringify(missingPlan));

  const notExec = workspace({ version: "7.0.2", platformPackage: "not-executable" });
  check("실행 권한이 없는 파일은 실행 파일로 치지 않음", findNativeExe(join(notExec.nodeModules, "typescript")) === null);

  const linked = workspace({ version: "7.0.2", platformPackage: true, link: true });
  const linkedPlan = await planLanguageServer(linked.project);
  check("pnpm 식 심볼릭 링크: 실제 위치 옆에서 플랫폼 패키지를 찾음", linkedPlan.kind === "native" && linkedPlan.exe.includes(".pnpm/typescript@x/node_modules/@typescript"), JSON.stringify(linkedPlan));

  const otherArch = findNativeExe(join(platformOnly.nodeModules, "typescript"), "linux", "x64");
  check("다른 플랫폼 이름으로는 못 찾음", otherArch === null);

  const ts6NoServer = workspace({ version: "6.0.0" });
  const ts6Plan = await planLanguageServer(ts6NoServer.project);
  check("TS6 인데 tsserver.js 가 없음: 번들 서버 + 이유", ts6Plan.kind === "tsls" && ts6Plan.tsserverPath === null && /has no tsserver\.js/.test(ts6Plan.reason ?? ""), JSON.stringify(ts6Plan));

  const unknown = workspace({ version: "weird", platformPackage: true });
  writeFileSync(join(unknown.nodeModules, "typescript/package.json"), JSON.stringify({ name: "typescript" }));
  const unknownPlan = await planLanguageServer(unknown.project);
  check("버전 모르고 tsserver.js 없음: 네이티브 시도", unknownPlan.kind === "native" && unknownPlan.version === "7", JSON.stringify(unknownPlan));

  const firstWins = workspace({ version: "5.9.3", tsserver: true });
  mkdirSync(join(firstWins.project, "node_modules/typescript/lib"), { recursive: true });
  writeFileSync(join(firstWins.project, "node_modules/typescript/package.json"), JSON.stringify({ name: "typescript", version: "7.0.2" }));
  const nearest = findWorkspaceTypeScript(firstWins.project);
  check("가장 가까운 node_modules/typescript 가 우선", nearest?.version === "7.0.2" && nearest.dir.startsWith(firstWins.project), JSON.stringify(nearest));
}

main()
  .catch((error) => {
    console.error(error);
    failed++;
  })
  .finally(() => {
    rmSync(root, { recursive: true, force: true });
    if (failed) {
      console.error(`${failed} failed`);
      process.exit(1);
    }
    console.log("all passed");
  });
