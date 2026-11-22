
export type SkillSource =
  | { kind: "user" }
  | { kind: "account" }
  | { kind: "project"; workspaceId: string; workspaceName: string; dir: string }
  | { kind: "plugin"; plugin: string; scope: "user" | "project" | "synced"; projectPath?: string };

export type SkillOverride = "name-only" | "user-invocable-only" | "off";

export type SkillShadow = { id: string; reason: "name" | "same-file" | "skill-over-command" };

export type SkillEntry = {
  id: string;
  name: string;
  description: string;
  kind: "skill" | "command";
  source: SkillSource;
  path: string;
  realPath: string | null;
  override: SkillOverride | null;
  shadow: SkillShadow | null;
};

export type SkillCatalog = { skills: SkillEntry[]; home: string; scannedAt: number };

export type SkillsRpcMethods = {
  "skills.list": { params: Record<string, never>; result: SkillCatalog };
};

export type ParsedSkill = { name: string | null; description: string };

const KEY_LINE = /^([A-Za-z_][\w-]*):(?:[ \t]+(.*))?[ \t]*$/;

export function splitFrontmatter(text: string): { front: string[] | null; body: string } {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  if (lines[0]?.trimEnd() !== "---") return { front: null, body: lines.join("\n") };
  const end = lines.findIndex((l, i) => i > 0 && l.trimEnd() === "---");
  if (end < 0) return { front: null, body: lines.join("\n") };
  return { front: lines.slice(1, end), body: lines.slice(end + 1).join("\n") };
}

const firstBodyLine = (body: string) => (body.split("\n").map((l) => l.trim()).find(Boolean) ?? "").replace(/\s+/g, " ");

function readValue(first: string, rest: string[]): string {
  const indented = (l: string) => /^[ \t]/.test(l) || l.trim() === "";
  const block: string[] = [];
  for (const l of rest) {
    if (!indented(l)) break;
    block.push(l);
  }
  const trimmed = first.trim();
  const squash = (text: string) => text.replace(/\s+/g, " ").trim();
  if (/^[>|][+-]?\d?$/.test(trimmed)) return squash(block.join(" "));
  const quote = trimmed[0];
  if (quote === '"' || quote === "'") {
    const flat = [trimmed, ...block].join(" ");
    let out = "";
    for (let i = 1; i < flat.length; i++) {
      const c = flat[i]!;
      if (quote === '"' && c === "\\") out += flat[++i] === "n" ? " " : (flat[i] ?? "");
      else if (quote === "'" && c === "'" && flat[i + 1] === "'") out += flat[i++];
      else if (c === quote) break;
      else out += c;
    }
    return squash(out);
  }
  return squash([trimmed, ...block].map((p) => p.replace(/\s+#.*$/, "")).join(" "));
}

// SKILL.md 에서 name 과 description 을 읽는다. description 이 없으면 본문 첫 비어 있지 않은 줄을 쓴다(공식 문서).
export function parseSkillMarkdown(text: string): ParsedSkill {
  const { front, body } = splitFrontmatter(text);
  if (!front) return { name: null, description: firstBodyLine(body) };
  const found: Record<string, string> = {};
  for (let i = 0; i < front.length; i++) {
    const m = KEY_LINE.exec(front[i]!);
    const key = m?.[1];
    if (key === "name" || key === "description") found[key] = readValue(m?.[2] ?? "", front.slice(i + 1));
  }
  return { name: found.name || null, description: found.description || firstBodyLine(body) };
}

export function markShadowed(entries: SkillEntry[]): SkillEntry[] {
  const scopeKey = (s: SkillSource) => (s.kind === "project" ? `project:${s.workspaceId}:${s.dir}` : s.kind);
  const user = entries.filter((e) => e.source.kind === "user" && e.kind === "skill");
  return entries.map((entry) => {
    let shadow: SkillShadow | null = null;
    if (entry.source.kind === "project" && entry.kind === "skill") {
      const byName = user.find((u) => u.name === entry.name);
      const same = entry.realPath ?? entry.path;
      const byFile = user.find((u) => (u.realPath ?? u.path) === same);
      if (byFile) shadow = { id: byFile.id, reason: "same-file" };
      else if (byName) shadow = { id: byName.id, reason: "name" };
    }
    if (!shadow && entry.kind === "command" && (entry.source.kind === "user" || entry.source.kind === "project")) {
      const key = scopeKey(entry.source);
      const skill = entries.find((e) => e.kind === "skill" && e.name === entry.name && scopeKey(e.source) === key);
      if (skill) shadow = { id: skill.id, reason: "skill-over-command" };
    }
    return shadow ? { ...entry, shadow } : entry;
  });
}

export type SkillFilter = "all" | "user" | "project" | "plugin" | "account";
export const SKILL_FILTERS: readonly SkillFilter[] = ["all", "user", "project", "plugin", "account"];

export function sourceLabel(source: SkillSource): string {
  if (source.kind === "user") return "User";
  if (source.kind === "account") return "Account";
  if (source.kind === "project") return `Project ${source.workspaceName}`;
  return `Plugin ${source.plugin}`;
}

const SOURCE_RANK: Record<SkillSource["kind"], number> = { user: 0, project: 1, plugin: 2, account: 3 };
export function sortSkills(entries: SkillEntry[]): SkillEntry[] {
  return [...entries].sort((a, b) => SOURCE_RANK[a.source.kind] - SOURCE_RANK[b.source.kind] || sourceLabel(a.source).localeCompare(sourceLabel(b.source)) || a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
}

export function filterSkills(entries: SkillEntry[], query: string, filter: SkillFilter): SkillEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return entries.filter((e) => {
    if (filter !== "all" && e.source.kind !== filter) return false;
    const haystack = `${e.name} ${e.description} ${sourceLabel(e.source)}`.toLowerCase();
    return words.every((w) => haystack.includes(w));
  });
}

export function countBySource(entries: SkillEntry[]): Record<SkillFilter, number> {
  const count: Record<SkillFilter, number> = { all: entries.length, user: 0, project: 0, plugin: 0, account: 0 };
  for (const e of entries) count[e.source.kind]++;
  return count;
}

export function skillOpenTarget(entry: SkillEntry, workspaces: { id: string; dir: string }[], activeWorkspaceId: string | null): { workspaceId: string; path: string } | null {
  if (entry.source.kind === "project") {
    const ws = workspaces.find((w) => w.id === (entry.source as { workspaceId: string }).workspaceId);
    if (ws) {
      const prefix = ws.dir.endsWith("/") ? ws.dir : `${ws.dir}/`;
      if (entry.path.startsWith(prefix)) return { workspaceId: ws.id, path: entry.path.slice(prefix.length) };
      return { workspaceId: ws.id, path: entry.path };
    }
  }
  const host = workspaces.find((w) => w.id === activeWorkspaceId) ?? workspaces[0];
  return host ? { workspaceId: host.id, path: entry.path } : null;
}
