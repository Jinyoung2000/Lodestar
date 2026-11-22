import { rankFiles } from "../web/fileSearch";
import { buildPicks, isExcludedPath, routeOf, splitByRanges, splitLineSuffix, usableRecent } from "../web/quickOpenModel";
import { prepareQuery, scoreFileItem } from "../web/quickOpenScore";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed++;
};

const FILES = [
  "app-website/packages/cli/src/cli.ts",
  "app-website/packages/cli/templates/cli.ts.tmpl",
  "app-client/src/utils/jobs.ts",
  "app-client/src/utils/string.ts",
  "app-client/src/utils/file.ts",
  "app-client/src/utils/image.ts",
  "app-client/src/utils/filter.ts",
  "app-website/packages/cli/src/client.ts",
  "app-website/packages/cli/README.md",
  "app-website/docs/click-lines.ts",
  "node_modules/cli-table/cli.ts",
  "web/Overlays.tsx",
  "web/FileTypeIcon.tsx",
  "README.md",
];

const names = (picks: { path: string }[]) => picks.map((p) => p.path);
const build = (filter: string, extra: Partial<Parameters<typeof buildPicks>[0]> = {}) => buildPicks({ files: FILES, recent: [], filter, workspaceDir: "/Users/me/work/app", includeExcluded: false, ...extra });

{
  const { results } = build("cli.ts");
  const order = names(results);
  check("cli.ts: 이름이 cli.ts 인 파일이 첫째", order[0] === "app-website/packages/cli/src/cli.ts", order[0]);
  check("cli.ts: cli.ts.tmpl 이 둘째", order[1] === "app-website/packages/cli/templates/cli.ts.tmpl", order[1]);
  const scattered = ["app-client/src/utils/jobs.ts", "app-client/src/utils/string.ts", "app-client/src/utils/file.ts", "app-client/src/utils/image.ts", "app-client/src/utils/filter.ts"];
  const firstScattered = Math.min(...scattered.map((p) => (order.includes(p) ? order.indexOf(p) : Infinity)));
  const lastNameMatch = Math.max(order.indexOf("app-website/packages/cli/src/client.ts"), order.indexOf("app-website/docs/click-lines.ts"));
  check("cli.ts: 경로에만 흩어져 맞는 파일은 이름에 맞는 파일(client.ts, click-lines.ts) 뒤", firstScattered > lastNameMatch, `firstScattered ${firstScattered}, lastNameMatch ${lastNameMatch}`);
  check("cli.ts: client.ts 는 이름 일치(cli 로 시작)지만 cli.ts 와 cli.ts.tmpl 뒤", order.indexOf("app-website/packages/cli/src/client.ts") > 1, order.join(", "));
  check("cli.ts: node_modules 는 기본 제외", !order.includes("node_modules/cli-table/cli.ts"));
  check("cli.ts: 첫째 행 이름 전체가 강조 구간", JSON.stringify(results[0].labelMatch) === JSON.stringify([{ start: 0, end: 6 }]), JSON.stringify(results[0].labelMatch));
}

check("includeExcluded 면 node_modules 도 나옴", names(build("cli.ts", { includeExcluded: true }).results).includes("node_modules/cli-table/cli.ts"));

{
  const order = names(build("readme").results);
  check("readme: 둘 다 이름 앞 일치, 짧은 경로가 앞", order[0] === "README.md" && order[1] === "app-website/packages/cli/README.md", order.join(", "));
}

check("fti: FileTypeIcon.tsx", names(build("fti").results)[0] === "web/FileTypeIcon.tsx", names(build("fti").results).join(", "));

check("packages/cli/readme: 경로 질의", names(build("packages/cli/readme").results)[0] === "app-website/packages/cli/README.md", names(build("packages/cli/readme").results).join(", "));

{
  const order = names(build("cli readme").results);
  check("cli readme: 두 낱말 모두", order.length === 1 && order[0] === "app-website/packages/cli/README.md", order.join(", "));
}

check('"cli.ts" 따옴표는 흩어진 일치를 안 받음', names(build('"cli.ts"').results).every((p) => /cli\.ts/i.test(p)), names(build('"cli.ts"').results).join(", "));
check("맞는 게 없으면 빈 결과", build("zzzzz").results.length === 0);

{
  const a = splitLineSuffix("cli.ts:12");
  check("cli.ts:12", a.filter === "cli.ts" && a.line === 12 && a.column === undefined, JSON.stringify(a));
  const b = splitLineSuffix("cli.ts:12:3");
  check("cli.ts:12:3", b.filter === "cli.ts" && b.line === 12 && b.column === 3, JSON.stringify(b));
  const c = splitLineSuffix("cli.ts:");
  check("cli.ts: 는 1 줄", c.filter === "cli.ts" && c.line === 1, JSON.stringify(c));
  const d = splitLineSuffix("cli.ts");
  check("접미사 없음", d.filter === "cli.ts" && d.line === undefined, JSON.stringify(d));
  const e = splitLineSuffix("src/app#8");
  check("# 도 줄 표시", e.filter === "src/app" && e.line === 8, JSON.stringify(e));
  const f = splitLineSuffix(":40");
  check(":40 은 파일 없이 줄만", f.filter === "" && f.line === 40, JSON.stringify(f));
}

check("node_modules, .git 제외", isExcludedPath("a/node_modules/b.js") && isExcludedPath(".git/config") && isExcludedPath("x/.DS_Store") && isExcludedPath("a.code-search"));
check("보통 파일은 제외 안 함", !isExcludedPath("src/node_modules_notes.md") && !isExcludedPath("src/git/a.ts"));

{
  const recent = ["web/Overlays.tsx", "app-website/packages/cli/README.md", "../outside/notes.md"];
  const empty = build("", { recent });
  check("빈 질의: 최근 파일만 순서대로", names(empty.history).join() === recent.join() && empty.results.length === 0, names(empty.history).join());
  check("최근 파일은 recent 표시", empty.history.every((p) => p.recent));
  const typed = build("readme", { recent });
  check("readme: 최근 README 가 history, 결과에서는 빠짐", names(typed.history).join() === "app-website/packages/cli/README.md" && !names(typed.results).includes("app-website/packages/cli/README.md") && names(typed.results)[0] === "README.md", `${names(typed.history)} | ${names(typed.results)}`);
  const outside = empty.history[2];
  check("워크스페이스 밖 파일은 ~ 로 줄인 폴더", outside.label === "notes.md" && outside.description === "~/work/outside", `${outside.label} | ${outside.description}`);
  check("안쪽 파일 폴더는 상대 경로, 루트 파일은 빈 문자열", empty.history[0].description === "web" && build("", { recent: ["README.md"] }).history[0].description === "");
  const filtered = usableRecent([{ workspaceId: "w", path: "web/Overlays.tsx" }, { workspaceId: "w", path: "gone.ts" }, { workspaceId: "w", path: "../x.ts" }, { workspaceId: "other", path: "web/Overlays.tsx" }], "w", FILES);
  check("usableRecent: 지워진 파일 빼고 밖의 파일 유지, 다른 폴더 것 제외", filtered.join() === "web/Overlays.tsx,../x.ts", filtered.join());
}

{
  check("> 는 명령 팔레트", routeOf(">go")?.kind === "commands");
  const at = routeOf("@render");
  check("@ 는 심볼 검색, 뒤의 글자를 넘김", at?.kind === "symbols" && at.query === "render");
  check("보통 질의는 라우팅 없음", routeOf("cli.ts") === null && routeOf("a@b") === null);
  const parts = splitByRanges("cli.ts", [{ start: 0, end: 3 }, { start: 5, end: 6 }]);
  check("강조 조각", JSON.stringify(parts) === JSON.stringify([{ text: "cli", hit: true }, { text: ".t", hit: false }, { text: "s", hit: true }]), JSON.stringify(parts));
}

{
  const q = prepareQuery("cli.ts");
  const prefix = scoreFileItem({ label: "cli.ts", description: "a", path: "a/cli.ts" }, q, true).score;
  const middle = scoreFileItem({ label: "my-cli.ts", description: "a", path: "a/my-cli.ts" }, q, true).score;
  const pathOnly = scoreFileItem({ label: "jobs.ts", description: "cli/src", path: "cli/src/jobs.ts" }, q, true).score;
  check("점수 구간: 앞 일치 > 중간 일치 > 경로에만", prefix > middle && middle > pathOnly && pathOnly > 0, `${prefix} ${middle} ${pathOnly}`);
  const folder = scoreFileItem({ label: "jobs.ts", description: "cli/src", path: "cli/src/jobs.ts" }, prepareQuery("cli"), true).score;
  const folderWord = scoreFileItem({ label: "jobs.ts", description: "cli/src", path: "cli/src/jobs.ts" }, prepareQuery("cli/src/jobs"), true).score;
  check("폴더 이름 질의(cli)는 그 폴더의 파일을, 경로 질의(cli/src/jobs)는 경로 전체를 이어서 찾음", folder > 0 && folderWord > 0, `${folder} ${folderWord}`);
  const ranked = rankFiles(FILES, "cli.ts");
  check("rankFiles(@ 메뉴, 첨부 메뉴)도 같은 순위", ranked[0] === "app-website/packages/cli/src/cli.ts" && ranked.indexOf("app-client/src/utils/jobs.ts") > 1, ranked.slice(0, 4).join(", "));
}

{
  const dirs = ["packages/app", "packages/cli", "packages/web", "services/api", "services/worker", "libs/ui", "libs/utils", "docs", "scripts", "tools/build"];
  const stems = ["index", "client", "server", "helpers", "string", "file", "image", "filter", "config", "types", "cli", "controller", "view", "model", "router"];
  const big: string[] = [];
  for (let i = 0; i < 50000; i++) big.push(`${dirs[i % dirs.length]}/src/${["a", "b", "c", "d", "e"][i % 5]}${Math.floor(i / 50)}/${stems[i % stems.length]}${i}.${["ts", "tsx", "json", "md"][i % 4]}`);
  big.push("packages/cli/src/cli.ts");
  buildPicks({ files: big, recent: [], filter: "cli.ts", workspaceDir: "/w", includeExcluded: false });
  for (const q of ["c", "cli", "cli.ts", "packages/cli", "index tsx"]) {
    const start = performance.now();
    const picks = buildPicks({ files: big, recent: [], filter: q, workspaceDir: "/w", includeExcluded: false });
    const ms = performance.now() - start;
    check(`5만 개에서 "${q}" ${ms.toFixed(0)}ms (후보 ${picks.matched})`, ms < 400);
    if (q === "cli.ts") check("5만 개: cli.ts 첫째", picks.results[0].path === "packages/cli/src/cli.ts", picks.results[0].path);
  }
}

if (failed) {
  console.log(`${failed} failed`);
  process.exit(1);
}
console.log("quickopen: all passed");
