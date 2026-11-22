import { readdirSync, readFileSync, realpathSync, statSync, type Dirent } from "node:fs";
import { dirname, join, sep } from "node:path";
import { markShadowed, parseSkillMarkdown, sortSkills, type SkillCatalog, type SkillEntry, type SkillOverride, type SkillSource, type SkillsRpcMethods } from "../shared/skills";

// 찾는 위치는 Claude Code 공식 문서(code.claude.com/docs/en/skills)의 표를 따른다. 문서에 없는 것은 ‘추측’이라고 적었다.

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

function skillsAt(dir: string, source: SkillSource, overrides: Overrides, prefix: string): SkillEntry[] {
  if (readText(join(dir, "SKILL.md"))) {
    const text = readText(join(dir, "SKILL.md"));
    const parsed = parseSkillMarkdown(text);
    const made = make(join(dir, "SKILL.md"), `${prefix}${parsed.name ?? dir.split(sep).pop()}`, "skill", source, overrides);
    return made ? [made] : [];
  }
  return skillsIn(dir, source, overrides, prefix);
}

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

function projectDirs(dir: string, home: string): string[] {
  const chain: string[] = [];
  for (let cur = dir; ; cur = dirname(cur)) {
    if (cur === home || cur === dirname(cur)) return [dir];
    chain.push(cur);
    try {
      statSync(join(cur, ".git"));
      return chain;
    } catch {
    }
  }
}

type Enabled = Record<string, boolean>;
const enabledOf = (settings: Json): Enabled => (settings.enabledPlugins && typeof settings.enabledPlugins === "object" ? (settings.enabledPlugins as Enabled) : {});

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
    const sorted = [...installs].filter((i): i is Json => !!i && typeof i === "object").sort((a, b) => (a.scope === "user" ? -1 : 0) - (b.scope === "user" ? -1 : 0));
    for (const install of sorted) {
      const installPath = typeof install.installPath === "string" ? install.installPath : "";
      if (!installPath || seenInstall.has(installPath)) continue;
      const projectPath = typeof install.projectPath === "string" ? install.projectPath : undefined;
      const scope = install.scope === "user" || !projectPath ? "user" : "project";
      let layers: Json[] = [userSettings];
      if (scope === "project") {
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
  entries.push(...skillsIn(join(claude, "skills"), user, userOverrides), ...commandsIn(join(claude, "commands"), user, userOverrides));

  const account: SkillSource = { kind: "account" };
  const synced = join(claude, "skills", "synced");
  for (const bucket of dirEntries(synced)) if (isDirLike(synced, bucket)) entries.push(...skillsIn(join(synced, bucket.name), account, userOverrides));

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

let provider: (() => SkillRoots) | null = null;

export function skillCatalogHandlers(roots: () => SkillRoots): { [M in keyof SkillsRpcMethods]: (params: SkillsRpcMethods[M]["params"]) => SkillsRpcMethods[M]["result"] } {
  provider = roots;
  return { "skills.list": () => scanSkills(roots()) };
}

let allowed = new Set<string>();
let allowedAt = 0;
const ALLOW_REFRESH_MS = 3000;

function refreshAllowed(now: number) {
  if (!provider) return;
  allowedAt = now;
  allowed = new Set(scanSkills(provider()).skills.flatMap((e) => [e.path, e.realPath ?? e.path]));
}

export const SKILL_FILE_PATTERN = /(?:^|\/)SKILL\.md$|\/commands\/.+\.md$/;

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
