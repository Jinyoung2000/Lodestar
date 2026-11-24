import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { cursorApproves, cursorMode } from "../../shared/cursorPermission";
import type { CodexMeta, CodexModelInfo } from "../../shared/protocol";
import { AcpConnection, acpEnv, acpProcessDir, type AcpLaunch } from "../antigravity/acp";
import { currentEffort, effortLevels, isAuthText, type AcpConfigOption } from "../antigravity/mapping";
import { AcpRunner, type AcpProvider, type AntigravityHost } from "../antigravity/runner";
import { findExecutable, withLoginPath } from "../loginPath";
import { T } from "../strings";

const PROVIDER_ENV_KEYS = ["CURSOR_API_KEY", "CURSOR_AUTH_TOKEN"];
const MODELS_TIMEOUT_MS = 30_000;
const VERSION_TIMEOUT_MS = 5_000;
const DEFAULT_MODEL_VALUES = new Set(["default", "auto"]);

type CursorModel = { value?: string; name?: string; configOptions?: AcpConfigOption[] };

export function cursorBin(env: NodeJS.ProcessEnv = process.env): string {
  if (env.AGENT_NAV_CURSOR) return env.AGENT_NAV_CURSOR;
  const local = join(env.HOME ?? homedir(), ".local", "bin");
  for (const name of ["cursor-agent", "agent"]) {
    const native = join(local, name);
    if (findExecutable(native, undefined)) return native;
  }
  return findExecutable("cursor-agent", withLoginPath(env.PATH)) ?? join(local, "cursor-agent");
}

export function cursorLaunch(extraDirs: string[]): AcpLaunch {
  return {
    label: "Cursor",
    args: [...extraDirs.flatMap((dir) => ["--add-dir", dir]), "acp"],
    env: () => acpEnv(PROVIDER_ENV_KEYS),
    cwd: () => acpProcessDir("cursor"),
    clientMeta: { parameterizedModelPicker: true },
  };
}

export function parseCursorModels(models: CursorModel[]): CodexModelInfo[] {
  return models
    .filter((model): model is CursorModel & { value: string } => typeof model.value === "string" && model.value.length > 0)
    .map((model) => ({
      value: model.value,
      displayName: model.name?.trim() || model.value,
      description: "",
      isDefault: DEFAULT_MODEL_VALUES.has(model.value),
      supportedEffortLevels: effortLevels(model.configOptions),
      defaultEffort: currentEffort(model.configOptions ?? []),
    }));
}

function readVersion(bin: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(bin, ["--version"], { env: acpEnv(PROVIDER_ENV_KEYS), timeout: VERSION_TIMEOUT_MS }, (error, stdout) => resolve(error ? null : String(stdout).trim().split("\n")[0] || null));
  });
}

async function readCursorMeta(live: AcpConnection | null): Promise<CodexMeta> {
  const base: CodexMeta = { installed: true, version: null, loggedIn: false, account: null, models: [], defaultModel: null, defaultEffort: null, error: null, fetchedAt: new Date().toISOString() };
  const bin = cursorBin();
  let temporary: AcpConnection | null = null;
  try {
    const connection = live ?? (temporary = await AcpConnection.start({ onNotification: () => undefined, onRequest: async () => ({}), onExit: () => undefined }, bin, cursorLaunch([])));
    const listed = await connection.request<{ models?: CursorModel[] }>("cursor/list_available_models", {}, MODELS_TIMEOUT_MS);
    base.models = parseCursorModels(listed?.models ?? []);
    base.loggedIn = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { ...base, installed: false, error: T.cursorNotInstalled(bin) };
    const message = error instanceof Error ? error.message : String(error);
    if (isAuthText(message)) base.error = T.cursorNotLoggedIn;
    else {
      base.loggedIn = true;
      base.error = message;
    }
  } finally {
    temporary?.close();
  }
  base.defaultModel = base.models.find((model) => model.isDefault)?.value ?? null;
  base.version = await readVersion(bin);
  return base;
}

export const CURSOR_PROVIDER: AcpProvider = {
  harness: "cursor",
  tag: "cursor",
  idPrefix: "cursor",
  processPerSession: true,
  bin: () => cursorBin(),
  launch: cursorLaunch,
  sessionIdOf: (agent) => agent.cursorSessionId ?? null,
  sessionPatch: (sessionId) => ({ cursorSessionId: sessionId }),
  mode: cursorMode,
  approves: (mode, call) => cursorApproves(mode, call?.kind),
  readMeta: readCursorMeta,
  text: {
    cutOff: T.daemonStoppedMidReplyCursor,
    notInstalled: T.cursorNotInstalled,
    notLoggedIn: T.cursorNotLoggedIn,
    ended: T.cursorEnded,
    resumeFailed: T.cursorResumeFailed,
    refused: T.cursorRefused,
    stopped: T.cursorStopped,
  },
};

export class CursorRunner extends AcpRunner {
  constructor(host: AntigravityHost) {
    super(host, CURSOR_PROVIDER);
  }
}
