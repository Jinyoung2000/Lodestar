import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { MOBILE_METHODS } from "../shared/mobile";
import { paletteCommands } from "../web/commands";
import { cardOpensInSessionPanel, sessionPanelShown, sessionPanelToggleable } from "../web/centerPanels";
import { countBySource, filterSkills, markShadowed, parseSkillMarkdown, skillOpenTarget, sortSkills, sourceLabel, type SkillEntry } from "../shared/skills";
import { readWorkspaceFileWithStat } from "../server/files";
import { SKILL_FILE_PATTERN, scanSkills, skillCatalogHandlers, skillFileRealPath } from "../server/skillCatalog";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed++;
};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const md = (front: string, body = "# Title\n\nBody line.") => `---\n${front}\n---\n${body}`;
{
  const plain = parseSkillMarkdown(md("name: alpha\ndescription: Use when you need alpha."));
  check("평문 name 과 description", same(plain, { name: "alpha", description: "Use when you need alpha." }));
  check("큰따옴표 값(이스케이프)", parseSkillMarkdown(md('description: "Say \\"hi\\" now"')).description === 'Say "hi" now');
  check("작은따옴표 값('' 이스케이프)", parseSkillMarkdown(md("description: 'it''s fine'")).description === "it's fine");
  check("따옴표 안의 ': ' 는 그대로", parseSkillMarkdown(md('description: "Triggers on: x"')).description === "Triggers on: x");
  check("> 접는 블록", parseSkillMarkdown(md("description: >\n  first line\n  second line\nname: n")).description === "first line second line");
  check("| 블록 뒤의 다음 키를 읽는다", same(parseSkillMarkdown(md("description: |-\n  a\n  b\nname: after")), { name: "after", description: "a b" }));
  check("여러 줄 평문", parseSkillMarkdown(md("description: one\n  two\n  three")).description === "one two three");
  check("값 뒤 주석은 뗀다", parseSkillMarkdown(md("description: keep # drop")).description === "keep");
  check("CRLF 와 BOM", parseSkillMarkdown("﻿---\r\nname: crlf\r\ndescription: ok\r\n---\r\nbody").name === "crlf");
  check("description 이 없으면 본문 첫 비어 있지 않은 줄", parseSkillMarkdown(md("name: x", "\n\nFirst real line\nSecond")).description === "First real line");
  check("frontmatter 가 없으면 본문 첫 줄, name 은 null", same(parseSkillMarkdown("\n# Heading\nbody"), { name: null, description: "# Heading" }));
  check("닫는 --- 가 없으면 frontmatter 가 아니다", parseSkillMarkdown("---\nname: x\nno end").name === null);
  const colon = parseSkillMarkdown(md("name: raycast\ndescription: Use when asked. Common use: wrapping a call, or: more", "Body"));
  check("평문 description 안의 ': ' 도 전부 받는다", same(colon, { name: "raycast", description: "Use when asked. Common use: wrapping a call, or: more" }));
  check("닫히지 않은 따옴표는 끝까지 받는다", parseSkillMarkdown(md('description: "never closed', "Body")).description === "never closed");
  check("name 이 비어 있으면 null", parseSkillMarkdown(md("name:\ndescription: d")).name === null);
}

const entry = (over: Partial<SkillEntry> & Pick<SkillEntry, "id" | "name" | "source">): SkillEntry => ({ description: "", kind: "skill", path: over.id, realPath: null, override: null, shadow: null, ...over });
const WS = { kind: "project", workspaceId: "w1", workspaceName: "app", dir: "/r/app" } as const;
const WS2 = { kind: "project", workspaceId: "w2", workspaceName: "other", dir: "/r/other" } as const;
{
  const list = markShadowed([
    entry({ id: "/h/.claude/skills/a/SKILL.md", name: "a", source: { kind: "user" } }),
    entry({ id: "/r/app/.claude/skills/a/SKILL.md", name: "a", source: WS }),
    entry({ id: "/r/other/.claude/skills/a/SKILL.md", name: "a", source: WS2 }),
    entry({ id: "/r/app/.claude/skills/b/SKILL.md", name: "b", source: WS }),
    entry({ id: "/p/a", name: "plug:a", source: { kind: "plugin", plugin: "plug", scope: "user" } }),
    entry({ id: "/h/.claude/skills/synced/x/a/SKILL.md", name: "a", source: { kind: "account" } }),
    entry({ id: "/r/app/.claude/commands/b.md", name: "b", kind: "command", source: WS }),
    entry({ id: "/r/app/.claude/skills/c/SKILL.md", name: "c-project", realPath: "/real/c", source: WS }),
    entry({ id: "/h/.claude/skills/c/SKILL.md", name: "c-user", realPath: "/real/c", source: { kind: "user" } }),
  ]);
  const by = (id: string) => list.find((e) => e.id === id)!;
  check("개인 스킬이 같은 이름의 프로젝트 스킬을 가린다(모든 워크스페이스)", same(by("/r/app/.claude/skills/a/SKILL.md").shadow, { id: "/h/.claude/skills/a/SKILL.md", reason: "name" }) && by("/r/other/.claude/skills/a/SKILL.md").shadow?.reason === "name");
  check("개인 스킬은 가려지지 않는다", by("/h/.claude/skills/a/SKILL.md").shadow === null);
  check("플러그인과 계정 동기화 스킬은 가리지도 가려지지도 않는다", by("/p/a").shadow === null && by("/h/.claude/skills/synced/x/a/SKILL.md").shadow === null);
  check("같은 범위에서는 스킬이 명령 파일을 이긴다", same(by("/r/app/.claude/commands/b.md").shadow, { id: "/r/app/.claude/skills/b/SKILL.md", reason: "skill-over-command" }));
  check("이름이 달라도 같은 실제 파일이면 한 번만 로드(개인 쪽)", same(by("/r/app/.claude/skills/c/SKILL.md").shadow, { id: "/h/.claude/skills/c/SKILL.md", reason: "same-file" }));
}

{
  const a = entry({ id: "1", name: "zeta", description: "Deploy the Thing", source: { kind: "user" } });
  const b = entry({ id: "2", name: "alpha", description: "Review", source: WS });
  const c = entry({ id: "3", name: "fig:use", description: "Draw", source: { kind: "plugin", plugin: "fig", scope: "user" } });
  const d = entry({ id: "4", name: "docx", description: "Word", source: { kind: "account" } });
  const all = [d, c, b, a];
  check("정렬: User, Project, Plugin, Account 순, 안에서 이름순", same(sortSkills(all).map((e) => e.id), ["1", "2", "3", "4"]));
  check("검색은 이름과 설명과 출처를 낱말 단위로(대소문자 무시)", same(filterSkills(all, "DEPLOY thing", "all").map((e) => e.id), ["1"]) && same(filterSkills(all, "plugin fig", "all").map((e) => e.id), ["3"]));
  check("출처 필터", same(filterSkills(all, "", "project").map((e) => e.id), ["2"]) && filterSkills(all, "", "all").length === 4);
  check("출처별 개수", same(countBySource(all), { all: 4, user: 1, project: 1, plugin: 1, account: 1 }));
  check("출처 글자", sourceLabel(a.source) === "User" && sourceLabel(b.source) === "Project app" && sourceLabel(c.source) === "Plugin fig" && sourceLabel(d.source) === "Account");
  const workspaces = [{ id: "w1", dir: "/r/app" }, { id: "w2", dir: "/r/other" }];
  check("프로젝트 스킬은 그 워크스페이스 기준 상대 경로", same(skillOpenTarget(entry({ id: "/r/app/.claude/skills/x/SKILL.md", name: "x", source: WS }), workspaces, "w2"), { workspaceId: "w1", path: ".claude/skills/x/SKILL.md" }));
  check("저장소 루트(워크스페이스 위) 프로젝트 스킬은 절대 경로", same(skillOpenTarget(entry({ id: "/r/.claude/skills/x/SKILL.md", name: "x", source: WS }), workspaces, "w2"), { workspaceId: "w1", path: "/r/.claude/skills/x/SKILL.md" }));
  check("밖의 스킬은 활성 워크스페이스에 절대 경로", same(skillOpenTarget(a, workspaces, "w2"), { workspaceId: "w2", path: "1" }));
  check("활성 워크스페이스가 없으면 첫 워크스페이스", skillOpenTarget(a, workspaces, null)?.workspaceId === "w1");
  check("워크스페이스가 하나도 없으면 열 수 없다", skillOpenTarget(a, [], null) === null);
}

{
  const skills = paletteCommands().find((c) => c.command === "skills");
  check("명령 팔레트에 Skills: Open, 키는 없다", skills?.title === "Skills: Open" && skills.keycaps.length === 0, JSON.stringify(skills));
  check("스킬 화면에서는 세션 오른쪽 패널을 보이지도 여닫지도 않고, 카드는 보드로 보낸다", !sessionPanelShown("skills", true) && !sessionPanelToggleable("skills") && !cardOpensInSessionPanel("skills"));
}

const base = realpathSync(mkdtempSync(join(tmpdir(), "skills-test-")));
const put = (path: string, text: string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
};
const home = join(base, "home");
const agents = join(base, "agents");
const repo = join(base, "repo");
const ws = join(repo, "packages", "app");
const cache = join(home, ".claude", "plugins", "cache");
try {
  put(join(home, ".claude", "skills", "alpha", "SKILL.md"), md("description: Alpha user skill"));
  put(join(agents, "beta", "SKILL.md"), md("description: Beta through a link"));
  mkdirSync(join(home, ".claude", "skills"), { recursive: true });
  symlinkSync(join(agents, "beta"), join(home, ".claude", "skills", "beta"));
  put(join(home, ".claude", "skills", "kill.zip"), "not a folder");
  put(join(home, ".claude", "skills", "folder-x", "SKILL.md"), md("name: custom\ndescription: Renamed by frontmatter"));
  put(join(home, ".claude", "skills", "broken", "SKILL.md"), md("description: Triggers on: x and more", "Body first line"));
  put(join(home, ".claude", "skills", "empty-dir", "readme.txt"), "no SKILL.md here");
  put(join(home, ".claude", "commands", "ship.md"), md("description: Ship it"));
  put(join(home, ".claude", "commands", "frontend", "component.md"), "Make a component");
  put(join(home, ".claude", "skills", "synced", "bucket-1", "docx", "SKILL.md"), md("name: docx\ndescription: Word files"));
  mkdirSync(join(repo, ".git"), { recursive: true });
  put(join(repo, ".claude", "skills", "alpha", "SKILL.md"), md("description: Alpha project skill"));
  put(join(ws, ".claude", "skills", "gamma", "SKILL.md"), md("description: Gamma"));
  put(join(ws, ".claude", "commands", "gamma.md"), "Gamma as a command");
  put(join(ws, ".claude", "settings.local.json"), JSON.stringify({ skillOverrides: { gamma: "name-only" } }));
  put(join(ws, "deeper", ".claude", "skills", "lazy", "SKILL.md"), md("description: Lazy"));
  const plugin = (dir: string, name: string, skill: string) => {
    put(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name }));
    put(join(dir, "skills", skill, "SKILL.md"), md(`description: ${name} ${skill}`));
  };
  plugin(join(cache, "m", "on-dir", "1.0.0"), "renamed", "use");
  plugin(join(cache, "m", "off", "1.0.0"), "off", "hidden");
  plugin(join(cache, "m", "inproj", "1.0.0"), "inproj", "scoped");
  plugin(join(cache, "m", "elsewhere", "1.0.0"), "elsewhere", "nope");
  put(join(cache, "m", "on-dir", "1.0.0", "commands", "run.md"), md("description: plugin command"));
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "on@m": true, "off@m": false, "inproj@m": true, "elsewhere@m": true }, skillOverrides: { alpha: "off" } }));
  const install = (scope: string, installPath: string, projectPath?: string) => ({ scope, installPath, version: "1.0.0", ...(projectPath ? { projectPath } : {}) });
  writeFileSync(
    join(home, ".claude", "plugins", "installed_plugins.json"),
    JSON.stringify({
      version: 2,
      plugins: {
        "on@m": [install("project", join(cache, "m", "on-dir", "1.0.0"), join(base, "nowhere")), install("user", join(cache, "m", "on-dir", "1.0.0"))],
        "off@m": [install("user", join(cache, "m", "off", "1.0.0"))],
        "inproj@m": [install("project", join(cache, "m", "inproj", "1.0.0"), repo)],
        "elsewhere@m": [install("project", join(cache, "m", "elsewhere", "1.0.0"), join(base, "nowhere"))],
        "missing@m": [install("user", join(cache, "m", "gone", "1.0.0"))],
      },
    }),
  );
  const synced = join(home, ".claude", "plugins", "synced", "bucket-1", "cowork~g2");
  put(join(synced, "skills", "manage", "SKILL.md"), md("description: synced plugin skill"));

  const roots = { home, workspaces: [{ id: "w1", name: "app", dir: ws }] };
  const { skills } = scanSkills(roots);
  const names = (kind: string) => skills.filter((e) => e.source.kind === kind).map((e) => e.name);
  const find = (name: string, kind?: string) => skills.find((e) => e.name === name && (!kind || e.source.kind === kind))!;

  check("사용자: 폴더, 링크 폴더, frontmatter 이름, 값 안에 콜론이 든 description, 명령(콜론 이름)", same(names("user").sort(), ["alpha", "beta", "broken", "custom", "frontend:component", "ship"]), names("user").join(","));
  check("폴더가 아닌 항목과 SKILL.md 없는 폴더, synced 폴더 자체는 건너뛴다", !skills.some((e) => e.path.includes("kill.zip") || e.path.includes("empty-dir") || e.name === "synced"));
  check("링크 폴더: path 는 링크 그대로, realPath 는 실제 파일", find("beta").path === join(home, ".claude", "skills", "beta", "SKILL.md") && find("beta").realPath === join(agents, "beta", "SKILL.md"));
  check("링크가 아니면 realPath 는 null", find("alpha", "user").realPath === null);
  check("frontmatter name 이 폴더 이름을 이긴다", find("custom").description === "Renamed by frontmatter");
  check("description 안의 ': ' 는 전부 받는다", find("broken").description === "Triggers on: x and more");
  check("옛 명령 파일은 kind=command", find("ship").kind === "command" && find("frontend:component").kind === "command");
  check("계정 동기화", same(names("account"), ["docx"]));
  check("프로젝트: 저장소 루트까지 올라간다(루트와 하위 폴더 모두)", same(names("project").sort(), ["alpha", "gamma", "gamma"]), names("project").join(","));
  check("하위 폴더의 .claude/skills 는 훑지 않는다", !skills.some((e) => e.name === "lazy"));
  check("프로젝트 출처에 워크스페이스 이름", skills.filter((e) => e.source.kind === "project").every((e) => e.source.kind === "project" && e.source.workspaceName === "app"));
  check("개인 alpha 가 프로젝트 alpha 를 가린다", find("alpha", "project").shadow?.reason === "name" && find("alpha", "user").shadow === null);
  check("같은 범위의 gamma 명령은 스킬에 가려진다", skills.find((e) => e.name === "gamma" && e.kind === "command")?.shadow?.reason === "skill-over-command");
  check("skillOverrides: 사용자 설정은 개인 스킬에, 프로젝트 settings.local.json 은 그 프로젝트에", find("alpha", "user").override === "off" && find("gamma", "project").override === "name-only");
  check("플러그인: 켜진 것만, manifest 이름 + 콜론 이름", same(names("plugin").sort(), ["inproj:scoped", "renamed:run", "renamed:use", "cowork:manage"].sort()), names("plugin").join(","));
  check("꺼진 플러그인, 워크스페이스 밖 프로젝트 범위 플러그인, 사라진 설치 폴더는 없다", !skills.some((e) => /off:|elsewhere:|gone/.test(e.name + e.path)));
  check("같은 설치 폴더를 사용자와 프로젝트가 가리키면 사용자 범위로 한 번만", skills.filter((e) => e.name === "renamed:use").length === 1 && find("renamed:use").source.kind === "plugin" && (find("renamed:use").source as { scope: string }).scope === "user");
  check("프로젝트 범위 플러그인은 scope 와 projectPath 를 가진다", same(find("inproj:scoped").source, { kind: "plugin", plugin: "inproj", scope: "project", projectPath: repo }));
  check("계정 동기화 플러그인은 폴더 이름의 ~ 앞이 이름", (find("cowork:manage").source as { scope: string }).scope === "synced");
  check("id 가 모두 다르다", new Set(skills.map((e) => e.id)).size === skills.length);

  const handlers = skillCatalogHandlers(() => roots);
  const catalog = handlers["skills.list"]({});
  check("skills.list: home 과 같은 목록", catalog.home === home && catalog.skills.length === skills.length);
  check("skills.list 는 모바일 허용 목록에 없다", !(MOBILE_METHODS as readonly string[]).includes("skills.list"));

  check("읽기 허용 문턱: SKILL.md 와 commands 아래 .md 만 목록을 본다", SKILL_FILE_PATTERN.test("/a/b/SKILL.md") && SKILL_FILE_PATTERN.test("/h/.claude/commands/x/y.md") && !SKILL_FILE_PATTERN.test("/r/src/index.ts") && !SKILL_FILE_PATTERN.test("/r/NOT_SKILL.md") && !SKILL_FILE_PATTERN.test("/h/.claude/settings.json"));
  const target = join(home, ".claude", "skills", "beta", "SKILL.md");
  check("목록에 있는 링크 SKILL.md 는 실제 경로로 허용", skillFileRealPath(target, Date.now()) === join(agents, "beta", "SKILL.md"));
  check("목록에 없는 파일은 허용하지 않는다", skillFileRealPath(join(home, ".claude", "settings.json"), Date.now() + 10_000) === null);
  check("없는 경로는 null", skillFileRealPath(join(base, "missing", "SKILL.md"), Date.now() + 20_000) === null);

  const outside = await readWorkspaceFileWithStat(ws, target);
  check("워크스페이스 밖 목록 SKILL.md: 본문을 읽고 읽기 전용", outside.text?.includes("Beta through a link") === true && outside.readOnly === true);
  const inside = await readWorkspaceFileWithStat(ws, ".claude/skills/gamma/SKILL.md");
  check("워크스페이스 안 SKILL.md 는 기존대로 쓰기 가능", inside.text?.includes("Gamma") === true && inside.readOnly === false);
  let refused = "";
  try {
    await readWorkspaceFileWithStat(ws, join(homedir(), ".claude", ".credentials.json"));
  } catch (error) {
    refused = (error as Error).message;
  }
  check("워크스페이스 밖 자격 증명 파일은 거절", refused !== "", refused);

  put(join(home, ".claude", "skills", "fresh", "SKILL.md"), md("description: Fresh"));
  handlers["skills.list"]({});
  check("목록을 다시 받은 뒤 새 스킬은 허용 목록에도 오른다(3초 한도 지난 뒤 한 번 더 훑는다)", skillFileRealPath(join(home, ".claude", "skills", "fresh", "SKILL.md"), Date.now() + 60_000) !== null);
} finally {
  rmSync(base, { recursive: true, force: true });
}

if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nall passed");
