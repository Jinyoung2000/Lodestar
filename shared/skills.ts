// SKILLS: 스킬 목록 화면의 타입과 순수 함수. 디스크를 훑는 쪽은 server/skillCatalog.ts, 화면은 web/SkillsView.tsx. 시험: test/skills.test.ts

export type SkillSource =
  // ~/.claude/skills 와 ~/.claude/commands
  | { kind: "user" }
  // ~/.claude/skills/synced: claude.ai 계정에서 내려받은 스킬
  | { kind: "account" }
  // <프로젝트>/.claude/skills 와 .claude/commands. dir 은 .claude 를 가진 폴더(워크스페이스 폴더 또는 그 상위 폴더)
  | { kind: "project"; workspaceId: string; workspaceName: string; dir: string }
  // 켜진 플러그인. scope 는 installed_plugins.json 의 설치 범위이거나(user, project) 계정 동기화(synced)
  | { kind: "plugin"; plugin: string; scope: "user" | "project" | "synced"; projectPath?: string };

// 설정 skillOverrides 값(on 은 기본이라 담지 않는다)
export type SkillOverride = "name-only" | "user-invocable-only" | "off";

// 어느 항목이 이 항목을 가리는지. name 은 같은 이름, same-file 은 같은 실제 파일(한 번만 로드), skill-over-command 는 같은 범위의 .claude/commands 파일
export type SkillShadow = { id: string; reason: "name" | "same-file" | "skill-over-command" };

export type SkillEntry = {
  // SKILL.md(또는 명령 파일) 경로. 심볼릭 링크는 풀지 않은 그대로라 항목마다 다르다.
  id: string;
  // 입력창 `/` 에 치는 이름(플러그인은 plugin:skill)
  name: string;
  description: string;
  kind: "skill" | "command";
  source: SkillSource;
  path: string;
  // 링크를 풀었을 때 path 와 다른 경우의 실제 경로
  realPath: string | null;
  override: SkillOverride | null;
  shadow: SkillShadow | null;
};

export type SkillCatalog = { skills: SkillEntry[]; home: string; scannedAt: number };

export type SkillsRpcMethods = {
  // 디스크의 스킬 전부. 사용자, 계정 동기화, 워크스페이스 프로젝트, 켜진 플러그인. 읽기만 한다.
  "skills.list": { params: Record<string, never>; result: SkillCatalog };
};

// --- frontmatter ---

export type ParsedSkill = { name: string | null; description: string };

const KEY_LINE = /^([A-Za-z_][\w-]*):(?:[ \t]+(.*))?[ \t]*$/;

// 첫 줄이 ---인 파일의 frontmatter 칸과 본문. 없으면 frontmatter 는 null.
export function splitFrontmatter(text: string): { front: string[] | null; body: string } {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  if (lines[0]?.trimEnd() !== "---") return { front: null, body: lines.join("\n") };
  const end = lines.findIndex((l, i) => i > 0 && l.trimEnd() === "---");
  if (end < 0) return { front: null, body: lines.join("\n") };
  return { front: lines.slice(1, end), body: lines.slice(end + 1).join("\n") };
}

const firstBodyLine = (body: string) => (body.split("\n").map((l) => l.trim()).find(Boolean) ?? "").replace(/\s+/g, " ");

// 키 하나의 값을 읽는다. 따옴표, `>` `|` 블록, 여러 줄 평문을 다룬다. Claude Code 는 YAML 로 엄밀하게 읽히지 않는 값(평문 안의 ': ' 등)도 받아 주므로 문법 검사는 하지 않는다.
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
    // 여는 따옴표 뒤부터 닫는 따옴표까지(큰따옴표는 \ 이스케이프, 작은따옴표는 '' ). 닫히지 않으면 끝까지 받는다.
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
  // 평문: ' #' 뒤는 주석, 이어지는 들여쓴 줄은 한 값이다.
  return squash([trimmed, ...block].map((p) => p.replace(/\s+#.*$/, "")).join(" "));
}

// SKILL.md 에서 name 과 description 을 읽는다. description 이 없으면 본문 첫 비어 있지 않은 줄을 쓴다(공식 문서).
// 시험으로 확인한 것: 평문 description 안에 ': ' 가 있어도(엄밀한 YAML 로는 오류) Claude Code 는 전체 값을 그대로 받는다. 그래서 문법 검사는 하지 않는다.
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

// --- 이름 충돌 ---

// 같은 이름이 여러 곳에 있을 때 어느 것이 이기는지. 근거는 Claude Code 문서의 우선순위 표다.
//  - 개인 스킬(~/.claude/skills)이 프로젝트 스킬을 이긴다(프로젝트가 개인을 이기는 것이 아니다).
//  - 같은 범위에서는 스킬이 .claude/commands 파일을 이긴다.
//  - 같은 실제 파일을 가리키는 위치가 여럿이면 한 번만 로드한다.
//  - 플러그인 스킬은 plugin:skill 로 이름 공간이 달라 충돌하지 않는다.
// 계정 동기화(synced) 스킬과 다른 범위의 우선순위는 문서에 없어 가리지 않는다.
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

// --- 화면 모델 ---

export type SkillFilter = "all" | "user" | "project" | "plugin" | "account";
export const SKILL_FILTERS: readonly SkillFilter[] = ["all", "user", "project", "plugin", "account"];

// 오른쪽에 보이는 출처 글자. 프로젝트는 워크스페이스 이름, 플러그인은 플러그인 이름을 붙인다.
export function sourceLabel(source: SkillSource): string {
  if (source.kind === "user") return "User";
  if (source.kind === "account") return "Account";
  if (source.kind === "project") return `Project ${source.workspaceName}`;
  return `Plugin ${source.plugin}`;
}

// 목록 순서: 출처 묶음(User, Project, Plugin, Account) 안에서 이름순. 같은 이름이면 경로순.
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

// 항목을 에디터 탭으로 열 때 쓸 워크스페이스와 경로. 프로젝트 스킬은 그 워크스페이스 폴더 기준 상대 경로라 Files 트리에서 연 탭과 같은 탭이 된다.
// 워크스페이스 밖 파일(사용자, 플러그인, 계정)은 아무 워크스페이스 id 에 절대 경로를 붙여 보내고, 데몬이 목록에 있는 SKILL.md 만 읽게 한다(server/skillCatalog.ts).
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
