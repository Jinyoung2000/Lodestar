import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseVscodeEditorOptions, resolveEditorOptions, type EditorOptions } from "../shared/editorOptions";
import { EFFORT_LEVELS, type DefaultSource, type EffortLevel, type PermissionMode, type RequestQueuing, type Resolved, type ResolvedDefaults, type SessionSort, type Settings } from "../shared/protocol";


const PERMISSION_MODES: PermissionMode[] = ["default", "acceptEdits", "plan", "auto", "bypassPermissions"];
const VSCODE_MODEL_KEY = "chat.currentLanguageModel.panel.agent-host-claude";
const VSCODE_SORT_KEY = "agentSessions.sorting";
const VSCODE_MODEL_CONFIG_KEY = "chat.modelConfiguration.panel.agent-host-claude";
const SQLITE = "/usr/bin/sqlite3";
// 파일 읽기와 sqlite 호출은 동기라 데몬이 잠깐 선다. 같은 값을 자주 다시 읽지 않게 하는 시간.
const CACHE_MS = 5000;

export type DefaultsPaths = {
  vscodeUserDir: string;
  // ~/.claude/settings.json
  claudeSettings: string;
};

// 시험에서만 환경변수로 바꾼다. 실제 값은 읽기만 한다.
export function defaultPaths(env: NodeJS.ProcessEnv = process.env): DefaultsPaths {
  return {
    vscodeUserDir: env.AGENT_NAV_VSCODE_USER_DIR ?? join(homedir(), "Library", "Application Support", "Code", "User"),
    claudeSettings: env.AGENT_NAV_CLAUDE_SETTINGS ?? join(homedir(), ".claude", "settings.json"),
  };
}

// 바깥 세계를 읽는 두 함수. 단위 시험은 이 둘을 가짜로 바꾼다.
export type DefaultsIo = {
  readText: (file: string) => string | null;
  // state.vscdb 의 ItemTable 에서 key 의 value. 읽을 수 없으면 null.
  vscodeState: (key: string) => string | null;
};

export function fileIo(paths: DefaultsPaths): DefaultsIo {
  const db = join(paths.vscodeUserDir, "globalStorage", "state.vscdb");
  return {
    readText: (file) => {
      try {
        return readFileSync(file, "utf8");
      } catch {
        return null;
      }
    },
    vscodeState: (key) => {
      try {
        if (!existsSync(db) || !existsSync(SQLITE)) return null;
        const out = execFileSync(SQLITE, ["-readonly", "-cmd", ".timeout 500", db, `select value from ItemTable where key='${key}'`], { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] });
        const value = out.replace(/\r?\n$/, "");
        return value || null;
      } catch {
        return null;
      }
    },
  };
}

export function parseJsonc(text: string): unknown {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  // 문자열 밖의 끝 쉼표 제거. 위에서 문자열을 건너뛰며 만든 out 에서 다시 문자열을 건너뛰며 본다.
  let clean = "";
  for (let k = 0; k < out.length; k++) {
    const c = out[k];
    if (c === '"') {
      let j = k + 1;
      while (j < out.length && out[j] !== '"') j += out[j] === "\\" ? 2 : 1;
      clean += out.slice(k, j + 1);
      k = j;
    } else if (c === ",") {
      let n = k + 1;
      while (n < out.length && /\s/.test(out[n])) n++;
      if (out[n] === "}" || out[n] === "]") continue;
      clean += c;
    } else {
      clean += c;
    }
  }
  return JSON.parse(clean);
}

function readJson(io: DefaultsIo, file: string, jsonc: boolean): Record<string, unknown> {
  try {
    const text = io.readText(file);
    if (text === null) return {};
    const value = jsonc ? parseJsonc(text) : JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const asPermission = (v: unknown): PermissionMode | null => (typeof v === "string" && (PERMISSION_MODES as string[]).includes(v) ? (v as PermissionMode) : null);
const asEffort = (v: unknown): EffortLevel | null => (typeof v === "string" && (EFFORT_LEVELS as string[]).includes(v) ? (v as EffortLevel) : null);
const asQueuing = (v: unknown): RequestQueuing | null => (v === "queue" || v === "steer" ? v : null);
const asModel = (v: unknown): string | null => (typeof v === "string" && v.trim() && v.trim() !== "default" ? v.trim() : null);

export type SourceValues = {
  model: string | null;
  effort: EffortLevel | null;
  permissionMode: PermissionMode | null;
  diffInlineWhenNarrow: boolean | null;
  sessionSort: SessionSort | null;
  requestQueuing: RequestQueuing | null;
  previewEditors: boolean | null;
  editorOptions: Partial<EditorOptions>;
};

const EMPTY: SourceValues = { model: null, effort: null, permissionMode: null, diffInlineWhenNarrow: null, sessionSort: null, requestQueuing: null, previewEditors: null, editorOptions: {} };

// "agent-host-claude:@provider=anthropic:opus%5B1m%5D" 에서 모델 이름(opus[1m])만.
export function vscodeModelName(key: string): string | null {
  const m = /^agent-host-claude:@provider=[^:]*:(.+)$/.exec(key.trim());
  if (!m) return null;
  try {
    return asModel(decodeURIComponent(m[1]));
  } catch {
    return asModel(m[1]);
  }
}

export function readVscode(io: DefaultsIo, paths: DefaultsPaths): SourceValues {
  const settings = readJson(io, join(paths.vscodeUserDir, "settings.json"), true);
  const values: SourceValues = { ...EMPTY };

  const initial = asPermission(settings["claudeCode.initialPermissionMode"]);
  values.permissionMode = initial === "bypassPermissions" && settings["claudeCode.allowDangerouslySkipPermissions"] !== true ? null : initial;

  const inline = settings["diffEditor.useInlineViewWhenSpaceIsLimited"];
  values.diffInlineWhenNarrow = typeof inline === "boolean" ? inline : null;
  const sortOf = (v: unknown): SessionSort | null => (v === "created" || v === "updated" ? v : null);
  values.sessionSort = sortOf(settings["agentSessions.sorting"]) ?? sortOf(io.vscodeState(VSCODE_SORT_KEY)?.replace(/^"|"$/g, ""));

  const queuing = settings["chat.requestQueuing.defaultAction"];
  values.requestQueuing = asQueuing(queuing);
  const preview = settings["workbench.editor.enablePreview"];
  values.previewEditors = typeof preview === "boolean" ? preview : null;
  values.editorOptions = parseVscodeEditorOptions(settings);

  const currentKey = io.vscodeState(VSCODE_MODEL_KEY);
  if (currentKey) {
    values.model = vscodeModelName(currentKey);
    const raw = io.vscodeState(VSCODE_MODEL_CONFIG_KEY);
    if (raw && values.model) {
      try {
        const config = JSON.parse(raw) as Record<string, { thinkingLevel?: unknown } | null>;
        // 키는 모델 키 그대로(인코딩 포함)지만, 인코딩만 다른 경우도 같은 모델로 본다.
        const entry = config[currentKey.trim()] ?? Object.entries(config).find(([k]) => vscodeModelName(k) === values.model)?.[1];
        values.effort = asEffort(entry?.thinkingLevel);
      } catch {
        // 깨진 값은 지정 없음으로 본다
      }
    }
  }
  return values;
}

export function readClaude(io: DefaultsIo, paths: DefaultsPaths): SourceValues {
  const settings = readJson(io, paths.claudeSettings, false);
  const permissions = settings.permissions && typeof settings.permissions === "object" ? (settings.permissions as Record<string, unknown>) : {};
  return {
    ...EMPTY,
    model: asModel(settings.model),
    effort: asEffort(settings.effortLevel),
    // dontAsk 처럼 agent-nav 에 없는 모드는 여기서 걸러져 다음 순위로 간다
    permissionMode: asPermission(permissions.defaultMode),
  };
}

type Chosen = Pick<Settings, "defaultPermissionMode" | "defaultModel" | "defaultEffort" | "diffInlineWhenNarrow" | "requestQueuing" | "previewEditors"> & { editorOptions?: Settings["editorOptions"] };

export function resolveFrom(chosen: Chosen, vscode: SourceValues, claude: SourceValues): ResolvedDefaults {
  function pick<T>(explicit: T | null, key: keyof SourceValues, builtin: T, useClaude = true): Resolved<T> {
    const layers: [DefaultSource, unknown][] = [
      ["agent-nav", explicit],
      ["vscode", vscode[key]],
      ["claude", useClaude ? claude[key] : null],
    ];
    for (const [source, value] of layers) if (value !== null && value !== undefined) return { value: value as T, source };
    return { value: builtin, source: "builtin" };
  }
  return {
    model: pick<string | null>(asModel(chosen.defaultModel), "model", null),
    effort: pick<EffortLevel | null>(asEffort(chosen.defaultEffort), "effort", null),
    permissionMode: pick<PermissionMode>(asPermission(chosen.defaultPermissionMode), "permissionMode", "default"),
    diffInlineWhenNarrow: pick<boolean>(typeof chosen.diffInlineWhenNarrow === "boolean" ? chosen.diffInlineWhenNarrow : null, "diffInlineWhenNarrow", true, false),
    sessionSort: pick<SessionSort>(null, "sessionSort", "updated", false),
    requestQueuing: pick<RequestQueuing>(asQueuing(chosen.requestQueuing), "requestQueuing", "queue", false),
    previewEditors: pick<boolean>(typeof chosen.previewEditors === "boolean" ? chosen.previewEditors : null, "previewEditors", false, false),
    editorOptions: resolveEditorOptions(chosen.editorOptions, vscode.editorOptions),
  };
}

export class DefaultsReader {
  private cache: { at: number; vscode: SourceValues; claude: SourceValues } | null = null;

  constructor(
    private paths: DefaultsPaths = defaultPaths(),
    private io: DefaultsIo = fileIo(paths),
    private now: () => number = Date.now,
  ) {}

  resolve(chosen: Chosen, fresh = false): ResolvedDefaults {
    if (fresh || !this.cache || this.now() - this.cache.at > CACHE_MS) {
      this.cache = { at: this.now(), vscode: readVscode(this.io, this.paths), claude: readClaude(this.io, this.paths) };
    }
    return resolveFrom(chosen, this.cache.vscode, this.cache.claude);
  }
}

// 데몬 로그용 한 줄
export function describeDefaults(d: ResolvedDefaults) {
  const one = <T>(r: Resolved<T>) => `${r.value ?? "(cli)"}[${r.source}]`;
  return `model=${one(d.model)} effort=${one(d.effort)} permission=${one(d.permissionMode)} diffInline=${one(d.diffInlineWhenNarrow)} sort=${one(d.sessionSort)} queuing=${one(d.requestQueuing)} preview=${one(d.previewEditors)}`;
}

// 데몬이 하나만 쓰는 읽기 객체. 경로는 시작할 때 환경변수에서 정한다.
export const defaultsReader = new DefaultsReader();
