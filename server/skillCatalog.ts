import { readdirSync, readFileSync, realpathSync, statSync, type Dirent } from "node:fs";
import { dirname, join, sep } from "node:path";
import { markShadowed, parseSkillMarkdown, sortSkills, type SkillCatalog, type SkillEntry, type SkillOverride, type SkillSource, type SkillsRpcMethods } from "../shared/skills";

// SKILLS: 스킬 목록 화면이 부르는 skills.list 의 디스크 훑기. 읽기만 한다. 시험: test/skills.test.ts
// 찾는 위치는 Claude Code 공식 문서(code.claude.com/docs/en/skills)의 표를 따른다. 문서에 없는 것은 ‘추측’이라고 적었다.
//  - 개인 ~/.claude/skills/<이름>/SKILL.md, 프로젝트 <폴더>/.claude/skills/<이름>/SKILL.md(시작 폴더와 저장소 루트까지의 상위 폴더)
//  - 옛 .claude/commands/**/*.md 는 스킬과 합쳐져 같은 `/이름` 으로 동작하므로 함께 보인다(폴더는 콜론으로 이어 붙인다)
//  - 플러그인 <설치 폴더>/skills/<이름>/SKILL.md 는 plugin:이름 으로 부른다
//  - 계정 동기화 스킬은 ~/.claude/skills/synced 아래에 내려받는다(문서). 계정 동기화 플러그인은 ~/.claude/plugins/synced 아래(추측: 폴더 구조를 보고 정했다)
//  - 시작 폴더보다 아래의 .claude/skills 는 그 안의 파일을 처음 읽을 때 로드되므로 훑지 않는다.

export type SkillRoots = { home: string; workspaces: { id: string; name: string; dir: string }[] };

type Json = Record<string, unknown>;

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function readJson(path: string): Json {
  try {
    const value = JSON.parse(readText(path)) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
  } catch {
    return {};
  }
}

function dirEntries(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

// 폴더이거나 폴더를 가리키는 링크(~/.claude/skills 의 항목 대부분이 ~/.agents/skills 로 가는 링크다)
function isDirLike(parent: string, entry: Dirent): boolean {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return statSync(join(parent, entry.name)).isDirectory();
  } catch {
    return false;
  }
}

function realOf(path: string): string | null {
  try {
    const real = realpathSync(path);
    return real === path ? null : real;
  } catch {
    return null;
  }
}

type Overrides = Record<string, SkillOverride>;
function overridesOf(settings: Json): Overrides {
  const raw = settings.skillOverrides;
  const out: Overrides = {};
  if (raw && typeof raw === "object") for (const [name, value] of Object.entries(raw)) if (value === "off" || value === "name-only" || value === "user-invocable-only") out[name] = value;
  return out;
}

function make(path: string, name: string, kind: SkillEntry["kind"], source: SkillSource, overrides: Overrides): SkillEntry | null {
  const text = readText(path);
  if (!text) return null;
  const parsed = parseSkillMarkdown(text);
  return {
    id: path,
    name,
    description: parsed.description,
    kind,
    source,
    path,
    realPath: realOf(path),
    override: overrides[name] ?? null,
    shadow: null,
  };
}

// <root>/<이름>/SKILL.md 들. prefix 는 플러그인 이름 공간(plugin:). 스킬 이름은 frontmatter 의 name 이 폴더 이름보다 앞선다(문서). 플러그인에서는 name 이 마지막 조각만 바꾼다.
function skillsIn(root: string, source: SkillSource, overrides: Overrides, prefix = ""): SkillEntry[] {
  const found: SkillEntry[] = [];
  for (const entry of dirEntries(root)) {
    if (!isDirLike(root, entry)) continue;
    const path = join(root, entry.name, "SKILL.md");
    const text = readText(path);
    if (!text) continue;
    const parsed = parseSkillMarkdown(text);
    const made = make(path, `${prefix}${parsed.name ?? entry.name}`, "skill", source, overrides);
    if (made) found.push(made);
  }
  return found;
}

// 폴더 하나가 스킬 폴더 자체(SKILL.md 가 바로 있음)이거나 스킬 폴더들의 묶음인 경우를 모두 받는다. 플러그인 manifest 의 skills 경로용.
function skillsAt(dir: string, source: SkillSource, overrides: Overrides, prefix: string): SkillEntry[] {
  if (readText(join(dir, "SKILL.md"))) {
    const text = readText(join(dir, "SKILL.md"));
    const parsed = parseSkillMarkdown(text);
    const made = make(join(dir, "SKILL.md"), `${prefix}${parsed.name ?? dir.split(sep).pop()}`, "skill", source, overrides);
    return made ? [made] : [];
  }
  return skillsIn(dir, source, overrides, prefix);
}

// .claude/commands/**/*.md. 하위 폴더는 콜론으로 이은 이름이 된다(frontend/component.md 는 frontend:component).
function commandsIn(root: string, source: SkillSource, overrides: Overrides, prefix = "", rel: string[] = [], depth = 0): SkillEntry[] {
  const found: SkillEntry[] = [];
  const here = join(root, ...rel);
  for (const entry of dirEntries(here)) {
    if (entry.name.startsWith(".")) continue;
    if (isDirLike(here, entry)) {
      if (depth < 4) found.push(...commandsIn(root, source, overrides, prefix, [...rel, entry.name], depth + 1));
    } else if (entry.name.endsWith(".md")) {
      const name = [...rel, entry.name.slice(0, -3)].join(":");
      const made = make(join(here, entry.name), `${prefix}${name}`, "command", source, overrides);
      if (made) found.push(made);
    }
  }
  return found;
}

// 워크스페이스 폴더에서 저장소 루트까지(.git 이 있는 폴더) 올라가며 .claude 를 가진 폴더들. 홈 폴더의 .claude 는 개인 범위라 여기서 빼고, .git 을 못 찾으면 워크스페이스 폴더만 본다.
function projectDirs(dir: string, home: string): string[] {
  const chain: string[] = [];
  for (let cur = dir; ; cur = dirname(cur)) {
    if (cur === home || cur === dirname(cur)) return [dir];
    chain.push(cur);
    try {
      statSync(join(cur, ".git"));
      return chain;
    } catch {
      // 저장소 루트가 아니면 계속 올라간다
    }
  }
}

type Enabled = Record<string, boolean>;
const enabledOf = (settings: Json): Enabled => (settings.enabledPlugins && typeof settings.enabledPlugins === "object" ? (settings.enabledPlugins as Enabled) : {});

// 켜짐 여부는 설정 파일의 enabledPlugins 를 사용자, 프로젝트, 로컬 순으로 겹쳐 마지막 값을 쓴다(뒤가 앞을 덮는다고 보는 것은 설정 일반 규칙에서 온 추측이다).
function pluginEnabled(id: string, layers: Json[]): boolean {
  let value: boolean | undefined;
  for (const layer of layers) {
    const map = enabledOf(layer);
    if (id in map) value = map[id] === true;
  }
  return value === true;
}

function pluginSkills(roots: SkillRoots, userSettings: Json): SkillEntry[] {
  const found: SkillEntry[] = [];
  const installed = (readJson(join(roots.home, ".claude", "plugins", "installed_plugins.json")).plugins ?? {}) as Record<string, unknown>;
  const seenInstall = new Set<string>();
  const overrides: Overrides = {};
  for (const [id, installs] of Object.entries(installed)) {
    if (!Array.isArray(installs)) continue;
    // 사용자 범위 설치를 먼저 본다. 같은 설치 폴더를 사용자와 프로젝트가 함께 가리키면 사용자 범위로 한 번만 보인다.
    const sorted = [...installs].filter((i): i is Json => !!i && typeof i === "object").sort((a, b) => (a.scope === "user" ? -1 : 0) - (b.scope === "user" ? -1 : 0));
    for (const install of sorted) {
      const installPath = typeof install.installPath === "string" ? install.installPath : "";
      if (!installPath || seenInstall.has(installPath)) continue;
      const projectPath = typeof install.projectPath === "string" ? install.projectPath : undefined;
      const scope = install.scope === "user" || !projectPath ? "user" : "project";
      let layers: Json[] = [userSettings];
      if (scope === "project") {
        // 프로젝트 범위 설치는 그 프로젝트 안의 워크스페이스에서만 쓰인다
        if (!roots.workspaces.some((w) => w.dir === projectPath || w.dir.startsWith(`${projectPath}${sep}`))) continue;
        layers = [userSettings, readJson(join(projectPath!, ".claude", "settings.json")), readJson(join(projectPath!, ".claude", "settings.local.json"))];
      }
      if (!pluginEnabled(id, layers)) continue;
      seenInstall.add(installPath);
      const manifest = readJson(join(installPath, ".claude-plugin", "plugin.json"));
      const plugin = typeof manifest.name === "string" && manifest.name ? manifest.name : id.split("@")[0]!;
      found.push(...pluginEntries(installPath, manifest, { kind: "plugin", plugin, scope, ...(projectPath ? { projectPath } : {}) }, overrides));
    }
  }
  return found;
}

// 계정에서 동기화된 플러그인: ~/.claude/plugins/synced/<묶음>/<이름>~g<세대>/skills/...
function syncedPluginSkills(home: string): SkillEntry[] {
  const found: SkillEntry[] = [];
  const base = join(home, ".claude", "plugins", "synced");
  for (const bucket of dirEntries(base)) {
    if (!isDirLike(base, bucket)) continue;
    for (const entry of dirEntries(join(base, bucket.name))) {
      if (!isDirLike(join(base, bucket.name), entry) || !entry.name.includes("~")) continue;
      const dir = join(base, bucket.name, entry.name);
      const manifest = readJson(join(dir, ".claude-plugin", "plugin.json"));
      const plugin = typeof manifest.name === "string" && manifest.name ? manifest.name : entry.name.split("~")[0]!;
      found.push(...pluginEntries(dir, manifest, { kind: "plugin", plugin, scope: "synced" }, {}));
    }
  }
  return found;
}

// 플러그인 폴더의 skills/ 와 commands/, manifest 가 알린 skills, commands 경로(폴더 밖으로 나가는 경로는 무시)
function pluginEntries(dir: string, manifest: Json, source: Extract<SkillSource, { kind: "plugin" }>, overrides: Overrides): SkillEntry[] {
  const prefix = `${source.plugin}:`;
  const extra = (key: string) => {
    const value = manifest[key];
    const list = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
    return list.filter((p): p is string => typeof p === "string" && !p.split("/").includes("..")).map((p) => join(dir, p));
  };
  const found = [...skillsIn(join(dir, "skills"), source, overrides, prefix)];
  for (const path of extra("skills")) found.push(...skillsAt(path, source, overrides, prefix));
  found.push(...commandsIn(join(dir, "commands"), source, overrides, prefix));
  for (const path of extra("commands")) found.push(...commandsIn(path, source, overrides, prefix));
  const seen = new Set<string>();
  return found.filter((e) => !seen.has(e.path) && !!seen.add(e.path));
}

export function scanSkills(roots: SkillRoots): SkillCatalog {
  const { home } = roots;
  const claude = join(home, ".claude");
  const userSettings = readJson(join(claude, "settings.json"));
  const userOverrides = overridesOf(userSettings);
  const entries: SkillEntry[] = [];

  const user: SkillSource = { kind: "user" };
  // synced 폴더 자체는 SKILL.md 가 없어 skillsIn 이 건너뛴다
  entries.push(...skillsIn(join(claude, "skills"), user, userOverrides), ...commandsIn(join(claude, "commands"), user, userOverrides));

  const account: SkillSource = { kind: "account" };
  const synced = join(claude, "skills", "synced");
  for (const bucket of dirEntries(synced)) if (isDirLike(synced, bucket)) entries.push(...skillsIn(join(synced, bucket.name), account, userOverrides));

  // 같은 폴더를 여러 워크스페이스가 공유하면(저장소 루트의 .claude) 먼저 온 워크스페이스에 한 번만 붙인다
  const seenDirs = new Set<string>();
  for (const ws of roots.workspaces) {
    for (const dir of projectDirs(ws.dir, home)) {
      if (seenDirs.has(dir)) continue;
      seenDirs.add(dir);
      const source: SkillSource = { kind: "project", workspaceId: ws.id, workspaceName: ws.name, dir };
      const overrides = { ...overridesOf(readJson(join(dir, ".claude", "settings.json"))), ...overridesOf(readJson(join(dir, ".claude", "settings.local.json"))) };
      entries.push(...skillsIn(join(dir, ".claude", "skills"), source, overrides), ...commandsIn(join(dir, ".claude", "commands"), source, overrides));
    }
  }

  entries.push(...pluginSkills(roots, userSettings), ...syncedPluginSkills(home));
  return { skills: sortSkills(markShadowed(entries)), home, scannedAt: Date.now() };
}

// --- RPC 와 파일 읽기 허용 ---

let provider: (() => SkillRoots) | null = null;

export function skillCatalogHandlers(roots: () => SkillRoots): { [M in keyof SkillsRpcMethods]: (params: SkillsRpcMethods[M]["params"]) => SkillsRpcMethods[M]["result"] } {
  provider = roots;
  return { "skills.list": () => scanSkills(roots()) };
}

// 에디터 탭이 워크스페이스 밖의 SKILL.md 를 읽을 수 있게 하는 허용 목록(실제 경로). 목록 화면이 보여 준 파일만 읽는다.
// 목록을 아직 만들지 않았거나(데몬을 다시 띄운 뒤 복원된 탭) 방금 만든 스킬이면 못 찾으니, 못 찾을 때 한 번 더 훑는다(3초에 한 번까지).
let allowed = new Set<string>();
let allowedAt = 0;
const ALLOW_REFRESH_MS = 3000;

function refreshAllowed(now: number) {
  if (!provider) return;
  allowedAt = now;
  allowed = new Set(scanSkills(provider()).skills.flatMap((e) => [e.path, e.realPath ?? e.path]));
}

// 스킬 파일처럼 생긴 경로만 허용 목록을 본다(SKILL.md, 또는 commands 폴더 아래의 .md). 모노레포의 평범한 파일 읽기가 전체 훑기를 일으키지 않게 하는 문턱이다.
export const SKILL_FILE_PATTERN = /(?:^|\/)SKILL\.md$|\/commands\/.+\.md$/;

// 목록에 있는 파일이면 실제 경로를, 아니면 null
export function skillFileRealPath(absolute: string, now = Date.now()): string | null {
  if (!SKILL_FILE_PATTERN.test(absolute)) return null;
  let real: string;
  try {
    real = realpathSync(absolute);
  } catch {
    return null;
  }
  if (allowed.has(real) || allowed.has(absolute)) return real;
  if (now - allowedAt < ALLOW_REFRESH_MS) return null;
  refreshAllowed(now);
  return allowed.has(real) || allowed.has(absolute) ? real : null;
}
