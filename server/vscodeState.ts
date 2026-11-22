import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";


const SQLITE = "/usr/bin/sqlite3";
const CACHE_KEY = "localAgentHost.cachedSessions.v4";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID_IN_TEXT = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

export function vscodeUserDir(env: NodeJS.ProcessEnv = process.env) {
  return env.AGENT_NAV_VSCODE_USER_DIR ?? join(homedir(), "Library", "Application Support", "Code", "User");
}

export const stateFileOf = (userDir: string) => join(userDir, "globalStorage", "state.vscdb");
export const sessionDataDirOf = (userDir: string) => join(dirname(userDir), "agentSessionData");

export type CachedChat = { authority: string; sessionUuid: string | null; isRead: boolean | null };

export type CachedSession = {
  vsSessionId: string;
  provider: string;
  startMs: number | null;
  modifiedMs: number | null;
  summary: string;
  cwd: string | null;
  statusBits: number | null;
  external: boolean;
  initiator: string | null;
  chats: CachedChat[];
};

export type SessionMeta = {
  dir: string;
  claudeSessionId: string | null;
  peers: PeerMeta[];
  archived: boolean;
  isRead: boolean | null;
  customTitle: string | null;
  chatTitles: Map<string, string>;
  cwd: string | null;
  workspaceless: boolean;
  permissionMode: string | null;
  modelId: string | null;
  thinkingLevel: string | null;
  worktreePath: string | null;
  worktreeBranch: string | null;
  diffBase: string | null;
  initiator: string | null;
};

export type PeerMeta = {
  authority: string;
  uri: string;
  claudeSessionId: string | null;
  origin: "user" | "sideChat" | null;
  isRead: boolean | null;
  modelId: string | null;
  thinkingLevel: string | null;
  parentVsSessionId: string | null;
  cwd: string | null;
};

type ChatDirMeta = PeerMeta & { dir: string };

export type VscodeState = {
  cached: CachedSession[];
  sessions: SessionMeta[];
  peers: PeerMeta[];
  subagentDirs: Map<string, number>;
};

export async function readVscodeState(userDir: string): Promise<VscodeState> {
  const file = stateFileOf(userDir);
  if (!existsSync(SQLITE)) throw new Error("sqlite3 is not available at /usr/bin/sqlite3");
  if (!existsSync(file)) throw new Error(`VS Code state file not found: ${file}`);
  const cacheRows = await sqlite(["-readonly", "-json", file], `select value from ItemTable where key='${CACHE_KEY}';`);
  const cached = parseCache(cacheRows[0]?.value);
  const dataDir = sessionDataDirOf(userDir);
  const rows = existsSync(dataDir) ? await readMetadataRows(dataDir) : [];
  return assemble(cached, rows, existsSync(dataDir) ? countSubagentDirs(dataDir) : new Map());
}

function parseCache(text: unknown): CachedSession[] {
  if (typeof text !== "string" || !text) return [];
  let list: unknown;
  try {
    list = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  const out: CachedSession[] = [];
  for (const raw of list as Record<string, unknown>[]) {
    const vsSessionId = typeof raw.session === "string" ? UUID_IN_TEXT.exec(raw.session)?.[0] : undefined;
    if (!vsSessionId) continue;
    const initiator = raw.initiator && typeof raw.initiator === "object" ? (raw.initiator as { name?: unknown }).name : null;
    out.push({
      vsSessionId,
      provider: typeof raw.provider === "string" ? raw.provider : "",
      startMs: typeof raw.startTime === "number" ? raw.startTime : null,
      modifiedMs: typeof raw.modifiedTime === "number" ? raw.modifiedTime : null,
      summary: typeof raw.summary === "string" ? raw.summary : "",
      cwd: typeof raw.workingDirectory === "string" ? fileUriToPath(raw.workingDirectory) : null,
      statusBits: typeof raw.status === "number" ? raw.status : null,
      external: raw.external === true,
      initiator: typeof initiator === "string" ? initiator : null,
      chats: Array.isArray(raw.chats) ? (raw.chats as Record<string, unknown>[]).map(cachedChat) : [],
    });
  }
  return out;
}

function cachedChat(raw: Record<string, unknown>): CachedChat {
  const uri = typeof raw.chat === "string" ? parseChatUri(raw.chat) : null;
  return { authority: uri?.authority ?? "", sessionUuid: uri?.sessionUuid ?? null, isRead: typeof raw.isRead === "boolean" ? raw.isRead : null };
}

export function parseChatUri(uri: string): { authority: string; sessionUuid: string | null } | null {
  const m = /^ahp-chat:\/\/([^/]+)\/([A-Za-z0-9_-]+)/.exec(uri);
  if (!m) return null;
  return { authority: m[1], sessionUuid: sessionUuidOf(m[2]) };
}

function sessionUuidOf(b64: string) {
  try {
    return UUID_IN_TEXT.exec(Buffer.from(b64, "base64url").toString("utf8"))?.[0] ?? null;
  } catch {
    return null;
  }
}

export function fileUriToPath(uri: string): string | null {
  if (!uri.startsWith("file://")) return null;
  try {
    return decodeURIComponent(new URL(uri).pathname);
  } catch {
    return null;
  }
}

export function modelNameOf(id: string | null): string | null {
  if (!id) return null;
  const m = /^@provider=[^:]*:(.+)$/.exec(id.trim());
  const raw = m ? m[1] : id.trim();
  try {
    return decodeURIComponent(raw) || null;
  } catch {
    return raw || null;
  }
}

type MetaRow = { dir: string; key: string; value: string };

const SESSION_KEYS = [
  "defaultChatProviderData",
  "agentHost.chatProviderData",
  "agentHost.chatOrigin",
  "peerChats",
  "isArchived",
  "isRead",
  "customTitle",
  "claude.workingDirectories",
  "agentHost.chatWorkingDirectories",
  "agentHost.workspaceless",
  "claude.permissionMode",
  "claude.model",
  "configValues",
  "copilot.worktree.path",
  "copilot.worktree.branchName",
  "agentHost.diffBaseBranch",
  "vscode.session.initiator",
];

const SAFE_DIR = /^[A-Za-z0-9_-]+$/;

async function readMetadataRows(dataDir: string): Promise<MetaRow[]> {
  const dirs = readdirSync(dataDir).filter((d) => SAFE_DIR.test(d) && (UUID.test(d) || /^(subagent|[0-9a-f]{8}-[0-9a-f-]{27})-/.test(d)) && existsSync(join(dataDir, d, "session.db")));
  if (dataDir.includes('"') || dataDir.includes("\n")) throw new Error("Unsupported characters in the VS Code data folder path");
  const keyList = SESSION_KEYS.map((k) => `'${k}'`).join(",");
  const rows: MetaRow[] = [];
  const BATCH = 400;
  for (let i = 0; i < dirs.length; i += BATCH) {
    let script = "";
    for (const dir of dirs.slice(i, i + BATCH)) {
      script += `.open --readonly "${join(dataDir, dir, "session.db")}"\nselect '${dir}' as dir, key, value from session_metadata where key in (${keyList}) or key like 'customChatTitle:%';\n`;
    }
    rows.push(...(await sqlite(["-json", "-cmd", ".timeout 1000"], script)) as MetaRow[]);
  }
  return rows;
}

function countSubagentDirs(dataDir: string) {
  const counts = new Map<string, number>();
  for (const dir of readdirSync(dataDir)) {
    const m = /^subagent-([A-Za-z0-9_-]+?)-toolu_/.exec(dir);
    const parent = m ? sessionUuidOf(m[1]) : null;
    if (parent) counts.set(parent, (counts.get(parent) ?? 0) + 1);
  }
  return counts;
}

function assemble(cached: CachedSession[], rows: MetaRow[], subagentDirs: Map<string, number>): VscodeState {
  const byDir = new Map<string, Map<string, string>>();
  for (const row of rows) {
    if (typeof row.dir !== "string" || typeof row.key !== "string") continue;
    const map = byDir.get(row.dir) ?? new Map<string, string>();
    map.set(row.key, typeof row.value === "string" ? row.value : "");
    byDir.set(row.dir, map);
  }
  const sessions: SessionMeta[] = [];
  const chatDirs: ChatDirMeta[] = [];
  for (const [dir, map] of byDir) {
    if (UUID.test(dir)) {
      if (parseJson(map.get("defaultChatProviderData"))?.sdkSessionId || map.has("claude.workingDirectories")) sessions.push(sessionMeta(dir, map));
      continue;
    }
    const chat = chatDirMeta(dir, map);
    if (chat) chatDirs.push(chat);
  }
  return { cached, sessions, peers: mergePeers(sessions, chatDirs), subagentDirs };
}

function sessionMeta(dir: string, map: Map<string, string>): SessionMeta {
  const provider = parseJson(map.get("defaultChatProviderData"));
  const model = parseJson(map.get("claude.model"));
  const config = parseJson(map.get("configValues"));
  const wd = parseJson(map.get("claude.workingDirectories"));
  const chatTitles = new Map<string, string>();
  for (const [key, value] of map) if (key.startsWith("customChatTitle:") && value.trim()) chatTitles.set(key.slice("customChatTitle:".length), value.trim());
  const initiator = parseJson(map.get("vscode.session.initiator"));
  const cwdUri = Array.isArray(wd) && typeof wd[0] === "string" ? wd[0] : null;
  const modelId = str(model?.id) ?? str(provider?.model?.id);
  return {
    dir,
    claudeSessionId: str(provider?.sdkSessionId),
    peers: parsePeerList(map.get("peerChats"), dir),
    archived: map.get("isArchived") === "true",
    isRead: map.has("isRead") && map.get("isRead") !== "" ? map.get("isRead") === "true" : null,
    customTitle: map.get("customTitle")?.trim() || null,
    chatTitles,
    cwd: cwdUri ? fileUriToPath(cwdUri) : null,
    workspaceless: map.get("agentHost.workspaceless") === "true",
    permissionMode: map.get("claude.permissionMode")?.trim() || str(config?.permissionMode),
    modelId,
    thinkingLevel: str(model?.config?.thinkingLevel) ?? str(provider?.model?.config?.thinkingLevel),
    worktreePath: fileUriToPath(map.get("copilot.worktree.path") ?? ""),
    worktreeBranch: map.get("copilot.worktree.branchName")?.trim() || null,
    diffBase: map.get("agentHost.diffBaseBranch")?.trim() || null,
    initiator: str(initiator?.name),
  };
}

function parsePeerList(text: string | undefined, parentDir: string): PeerMeta[] {
  const list = parseJson(text);
  if (!Array.isArray(list)) return [];
  const out: PeerMeta[] = [];
  for (const raw of list as Record<string, unknown>[]) {
    const uri = typeof raw.uri === "string" ? parseChatUri(raw.uri) : null;
    if (!uri || uri.authority === "default" || uri.authority === "subagent") continue;
    const provider = parseJson(typeof raw.providerData === "string" ? raw.providerData : undefined);
    const origin = raw.origin && typeof raw.origin === "object" ? (raw.origin as { kind?: unknown }).kind : null;
    out.push({
      authority: uri.authority,
      uri: raw.uri as string,
      claudeSessionId: str(provider?.sdkSessionId),
      origin: origin === "sideChat" ? "sideChat" : origin === "user" ? "user" : null,
      isRead: typeof raw.isRead === "boolean" ? raw.isRead : null,
      modelId: str(provider?.model?.id),
      thinkingLevel: str(provider?.model?.config?.thinkingLevel),
      parentVsSessionId: uri.sessionUuid ?? parentDir,
      cwd: null,
    });
  }
  return out;
}

function chatDirMeta(dir: string, map: Map<string, string>): ChatDirMeta | null {
  const m = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-([A-Za-z0-9_-]+)$/.exec(dir);
  if (!m) return null;
  const provider = parseJson(map.get("agentHost.chatProviderData"));
  const origin = parseJson(map.get("agentHost.chatOrigin"));
  const wd = parseJson(map.get("claude.workingDirectories") ?? map.get("agentHost.chatWorkingDirectories"));
  const cwdUri = Array.isArray(wd) && typeof wd[0] === "string" ? wd[0] : null;
  const claudeSessionId = str(provider?.sdkSessionId);
  if (!claudeSessionId) return null;
  return {
    dir,
    authority: m[1],
    uri: `ahp-chat://${m[1]}/${m[2]}`,
    claudeSessionId,
    origin: origin?.kind === "sideChat" ? "sideChat" : origin?.kind === "user" ? "user" : null,
    isRead: null,
    modelId: str(provider?.model?.id),
    thinkingLevel: str(provider?.model?.config?.thinkingLevel),
    parentVsSessionId: sessionUuidOf(m[2]),
    cwd: cwdUri ? fileUriToPath(cwdUri) : null,
  };
}

function mergePeers(sessions: SessionMeta[], chatDirs: ChatDirMeta[]): PeerMeta[] {
  const out = new Map<string, PeerMeta>();
  const unresolved: PeerMeta[] = [];
  for (const peer of sessions.flatMap((s) => s.peers)) {
    if (peer.claudeSessionId) out.set(peer.claudeSessionId, peer);
    else unresolved.push(peer);
  }
  for (const dir of chatDirs) {
    const id = dir.claudeSessionId as string;
    const existing = out.get(id);
    if (existing) out.set(id, { ...existing, cwd: existing.cwd ?? dir.cwd, origin: existing.origin ?? dir.origin, modelId: existing.modelId ?? dir.modelId, thinkingLevel: existing.thinkingLevel ?? dir.thinkingLevel });
    else out.set(id, dir);
  }
  return [...out.values(), ...unresolved];
}

function parseJson(text: string | undefined): any {
  if (!text) return null;
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

const str = (value: unknown) => (typeof value === "string" && value.trim() ? value : null);

async function sqlite(args: string[], input: string): Promise<Record<string, unknown>[]> {
  const call = () =>
    new Promise<string>((resolve, reject) => {
      const child = execFile(SQLITE, args, { encoding: "utf8", maxBuffer: 1024 * 1024 * 1024, timeout: 60_000 }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
      child.stdin?.end(input);
    });
  let out: string;
  try {
    out = await call();
  } catch (error) {
    if (!/busy|locked/i.test(String(error))) throw error;
    await new Promise((r) => setTimeout(r, 300));
    out = await call();
  }
  return out
    .split(/\n(?=\[)/)
    .filter((part) => part.trim())
    .flatMap((part) => JSON.parse(part) as Record<string, unknown>[]);
}
