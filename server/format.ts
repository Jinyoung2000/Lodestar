import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { FormatChoice, FormatLanguage, FormatProblem, FormatResult, FormatterId } from "../shared/protocol";
import { defaultPaths, parseJsonc } from "./defaults";
import {
  defaultResolveEnv,
  eslintFormatEnabled,
  hasRepoConfig,
  lookupExtension,
  oxcFormatterEnabled,
  prettierConfigPath,
  prettierEnabled,
  prettierIgnorePath,
  expandSettingPath,
  resolveEslint,
  resolveOxfmt,
  resolvePrettier,
  type ResolveEnv,
  type Resolution,
  type ToolContext,
  type ToolLocation,
} from "./formatTools";
import { T } from "./strings";


const EXTENSION_FORMATTER: Record<string, FormatterId> = {
  "dbaeumer.vscode-eslint": "eslint",
  "esbenp.prettier-vscode": "prettier",
  "oxc.oxc-vscode": "oxc",
  "vscode.typescript-language-features": "tsserver",
};

type FormatterInfo = { extensionId: string; name: string; label: string; languages: string[]; range: boolean };

const ALL_LANGUAGES = ["typescript", "typescriptreact", "javascript", "javascriptreact", "json", "css", "scss", "markdown"];
const SCRIPT_LANGUAGES = ["typescript", "typescriptreact", "javascript", "javascriptreact"];

// ESLint 는 JS 와 TS 만 본다(마크다운이나 JSON 을 줘 봐야 파싱 오류뿐). oxfmt 와 eslint 는 범위 포맷을 못 한다.
const FORMATTERS: Record<FormatterId, FormatterInfo> = {
  oxc: { extensionId: "oxc.oxc-vscode", name: "Oxc", label: "oxfmt", languages: ALL_LANGUAGES, range: false },
  prettier: { extensionId: "esbenp.prettier-vscode", name: "Prettier - Code formatter", label: "Prettier", languages: ALL_LANGUAGES, range: true },
  eslint: { extensionId: "dbaeumer.vscode-eslint", name: "ESLint", label: "ESLint", languages: SCRIPT_LANGUAGES, range: false },
  tsserver: { extensionId: "vscode.typescript-language-features", name: "TypeScript and JavaScript Language Features", label: "TypeScript", languages: SCRIPT_LANGUAGES, range: true },
};
const FORMATTER_ORDER: FormatterId[] = ["oxc", "prettier", "eslint", "tsserver"];

const LANGUAGE_BY_EXT: Record<string, string> = { ts: "typescript", mts: "typescript", cts: "typescript", tsx: "typescriptreact", js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascriptreact", json: "json", css: "css", scss: "scss", md: "markdown" };
const LANGUAGE_NAME: Record<string, string> = { typescript: "TypeScript", typescriptreact: "TypeScript JSX", javascript: "JavaScript", javascriptreact: "JavaScript JSX", json: "JSON", css: "CSS", scss: "SCSS", markdown: "Markdown" };

export function languageIdOf(path: string) {
  return LANGUAGE_BY_EXT[path.slice(path.lastIndexOf(".") + 1)] ?? null;
}

export function languageNameOf(path: string) {
  const id = languageIdOf(path);
  return id ? LANGUAGE_NAME[id] : path.slice(path.lastIndexOf(".") + 1);
}


export type FormatLayer = { defaultFormatter: string | null; byLanguage: Record<string, string>; flat: Record<string, unknown>; formatOnSave: boolean | null };
export type FormatSettings = { user: FormatLayer; workspace: FormatLayer };

export const EMPTY_LAYER: FormatLayer = { defaultFormatter: null, byLanguage: {}, flat: {}, formatOnSave: null };

export function readFormatSettings(workspaceDir: string | null = null, env: NodeJS.ProcessEnv = process.env): FormatSettings {
  return {
    user: readLayer(join(defaultPaths(env).vscodeUserDir, "settings.json")),
    workspace: workspaceDir ? readLayer(join(workspaceDir, ".vscode", "settings.json")) : EMPTY_LAYER,
  };
}

function readLayer(file: string): FormatLayer {
  let raw: Record<string, unknown> = {};
  try {
    const value = parseJsonc(readFileSync(file, "utf8"));
    if (value && typeof value === "object" && !Array.isArray(value)) raw = value as Record<string, unknown>;
  } catch {
  }
  return parseFormatSettings(raw);
}

export function parseFormatSettings(raw: Record<string, unknown>): FormatLayer {
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  const byLanguage: Record<string, string> = {};
  const flat: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    const match = /^\[(.+)\]$/.exec(key);
    if (!match) {
      flat[key] = value;
      continue;
    }
    if (!value || typeof value !== "object") continue;
    for (const language of match[1].split(/\]\s*\[|,/)) {
      const formatter = str((value as Record<string, unknown>)["editor.defaultFormatter"]);
      if (formatter) byLanguage[language.trim()] = formatter;
    }
  }
  const onSave = raw["editor.formatOnSave"];
  return { defaultFormatter: str(raw["editor.defaultFormatter"]), byLanguage, flat, formatOnSave: typeof onSave === "boolean" ? onSave : null };
}

export type ConfiguredFormatter = { id: string; scope: "workspace" | "user" };

export function configuredFormatter(settings: FormatSettings, languageId: string): ConfiguredFormatter | null {
  const { user, workspace } = settings;
  if (workspace.byLanguage[languageId]) return { id: workspace.byLanguage[languageId], scope: "workspace" };
  if (user.byLanguage[languageId]) return { id: user.byLanguage[languageId], scope: "user" };
  if (workspace.defaultFormatter) return { id: workspace.defaultFormatter, scope: "workspace" };
  if (user.defaultFormatter) return { id: user.defaultFormatter, scope: "user" };
  return null;
}

export function flatSettings(settings: FormatSettings): Record<string, unknown> {
  return { ...settings.user.flat, ...settings.workspace.flat };
}

export function formatOnSaveOf(settings: FormatSettings): boolean | null {
  return settings.workspace.formatOnSave ?? settings.user.formatOnSave;
}

type Prepared = { ok: true; run: () => Promise<string | null> } | { ok: false; reason: "language" | "selection" | "missing"; detail: string | null };

export type FormatRequest = {
  dir: string;
  absolute: string;
  text: string;
  range?: { from: number; to: number };
  settings: FormatSettings;
  chosen?: Record<string, FormatterId>;
  formatter?: FormatterId;
  env?: ResolveEnv;
  bundledOnly?: boolean;
};

export async function runFormat(request: FormatRequest): Promise<FormatResult> {
  const { dir, absolute, settings, chosen = {}, formatter: once, env = defaultResolveEnv() } = request;
  const languageId = languageIdOf(absolute);
  const language = languageNameOf(absolute);
  const none = (): FormatResult => ({ text: null, formatter: null, language, problem: { kind: "none" } });
  if (!languageId) return none();
  const ctx: ToolContext = { workspaceDir: dir, file: absolute, flat: flatSettings(settings), env };
  const prepare = (id: FormatterId, ignoreSettings: boolean) => prepareFormatter(id, languageId, ctx, request, ignoreSettings);
  const done = async (id: FormatterId, prepared: Prepared & { ok: true }): Promise<FormatResult> => ({ text: await prepared.run(), formatter: id, language });
  const failed = async (problem: FormatProblem, exclude: FormatterId | null): Promise<FormatResult> => ({ text: null, formatter: null, language, problem, alternatives: await alternativesFor(languageId, ctx, request, exclude) });

  if (once) {
    const prepared = await prepare(once, true);
    if (prepared.ok) return done(once, prepared);
    return failed(problemOf(once, prepared, env), once);
  }

  const picked = chosen[languageId];
  if (picked) {
    const prepared = await prepare(picked, true);
    return prepared.ok ? done(picked, prepared) : failed(problemOf(picked, prepared, env), picked);
  }

  const configured = configuredFormatter(settings, languageId);
  if (configured) {
    const id = EXTENSION_FORMATTER[configured.id];
    const extension = installedExtension(env, configured.id);
    if (!extension) return failed({ kind: "unavailable", extensionId: configured.id }, null);
    if (!id) return failed({ kind: "unsupported", extension: extension.displayName }, null);
    const prepared = await prepare(id, false);
    return prepared.ok ? done(id, prepared) : failed(problemOf(id, prepared, env), id);
  }

  const providers: FormatterId[] = [];
  for (const id of FORMATTER_ORDER) {
    if (!FORMATTERS[id].languages.includes(languageId) || !installedExtension(env, FORMATTERS[id].extensionId)) continue;
    const prepared = await prepareFormatter(id, languageId, ctx, { ...request, range: undefined }, false);
    if (prepared.ok) providers.push(id);
  }
  if (providers.length === 0) return none();
  const configuredHere = providers.length > 1 ? providers.filter((id) => (id === "oxc" || id === "prettier") && hasRepoConfig(id, absolute)) : [];
  if (providers.length > 1 && configuredHere.length !== 1) return failed({ kind: "ambiguous" }, null);
  const only = configuredHere[0] ?? providers[0];
  const prepared = await prepare(only, false);
  return prepared.ok ? done(only, prepared) : failed(problemOf(only, prepared, env), only);
}

function installedExtension(env: ResolveEnv, id: string) {
  return id === FORMATTERS.tsserver.extensionId ? { id, displayName: FORMATTERS.tsserver.name } : lookupExtension(env, id);
}

function problemOf(id: FormatterId, prepared: Prepared & { ok: false }, env: ResolveEnv): FormatProblem {
  const extension = installedExtension(env, FORMATTERS[id].extensionId)?.displayName ?? FORMATTERS[id].name;
  return prepared.reason === "selection" ? { kind: "selectionUnsupported", extension } : { kind: "cannotFormat", extension, detail: prepared.detail };
}

async function prepareFormatter(id: FormatterId, languageId: string, ctx: ToolContext, request: Pick<FormatRequest, "text" | "range" | "dir" | "absolute" | "bundledOnly">, ignoreSettings: boolean): Promise<Prepared> {
  const info = FORMATTERS[id];
  if (!info.languages.includes(languageId)) return { ok: false, reason: "language", detail: null };
  if (request.range && !info.range) return { ok: false, reason: "selection", detail: null };
  if (request.bundledOnly && id !== "tsserver") return { ok: false, reason: "missing", detail: T.formatNotAddedFolder };
  const { text, range, absolute } = request;
  const { workspaceDir } = ctx;

  if (id === "tsserver") return { ok: true, run: async () => null };

  if (id === "oxc") {
    if (!ignoreSettings && !oxcFormatterEnabled(ctx.flat)) return { ok: false, reason: "missing", detail: "oxc.enable.oxfmt (or oxc.enable) is turned off." };
    const found = await resolveOxfmt(ctx);
    if (!found.tool) return missing(found);
    const tool = found.tool;
    const configPath = expandSettingPath(ctx.flat["oxc.fmt.configPath"], ctx.env.home);
    const args = ["--stdin-filepath", absolute, ...(configPath ? ["-c", isAbsolute(configPath) ? configPath : join(workspaceDir, configPath)] : []), ...(ctx.flat["oxc.fmt.disableNestedConfig"] === true ? ["--disable-nested-config"] : [])];
    return {
      ok: true,
      run: async () => {
        const result = await execTool(tool, args, workspaceDir, text);
        if (result.code !== 0) throw new Error(T.errFormatFailed("oxfmt", firstLine(result.stderr || result.stdout)));
        return result.stdout;
      },
    };
  }

  if (id === "prettier") {
    if (!ignoreSettings && !prettierEnabled(ctx.flat)) return { ok: false, reason: "missing", detail: "prettier.enable is turned off." };
    if (!ignoreSettings && ctx.flat["prettier.requireConfig"] === true && !hasRepoConfig("prettier", absolute)) return { ok: false, reason: "missing", detail: "prettier.requireConfig is on and no Prettier config file was found for this file." };
    const found = resolvePrettier(ctx);
    if (!found.tool) return missing(found);
    const tool = found.tool;
    const config = prettierConfigPath(ctx);
    const args = [
      "--stdin-filepath",
      absolute,
      "--ignore-path",
      prettierIgnorePath(ctx),
      ...(config ? ["--config", config] : []),
      ...(ctx.flat["prettier.useEditorConfig"] === false ? ["--no-editorconfig"] : []),
      ...(range ? ["--range-start", String(range.from), "--range-end", String(range.to)] : []),
    ];
    return {
      ok: true,
      run: async () => {
        const result = await execTool(tool, args, workspaceDir, text);
        if (result.code !== 0) throw new Error(T.errFormatFailed("Prettier", firstLine(result.stderr)));
        return result.stdout;
      },
    };
  }

  if (!ignoreSettings && !eslintFormatEnabled(ctx.flat)) return { ok: false, reason: "missing", detail: "eslint.format.enable is not turned on." };
  const found = await resolveEslint(ctx);
  if (!found.tool) return missing(found);
  const tool = found.tool;
  return {
    ok: true,
    run: async () => {
      // ESLint 확장의 포맷은 eslint --fix 와 같다. --fix-dry-run 은 디스크를 건드리지 않고 고친 결과를 JSON 의 output 에 준다(고칠 게 없으면 output 이 없다).
      const result = await execTool(tool, ["--fix-dry-run", "--format", "json", "--stdin", "--stdin-filename", absolute], workspaceDir, text);
      let parsed: { output?: string; messages?: { fatal?: boolean; message: string }[] }[];
      try {
        parsed = JSON.parse(result.stdout);
      } catch {
        throw new Error(T.errFormatFailed("ESLint", firstLine(result.stderr || result.stdout)));
      }
      const file = parsed[0];
      const fatal = file?.messages?.find((m) => m.fatal);
      if (fatal) throw new Error(T.errFormatFailed("ESLint", fatal.message));
      return file?.output ?? text;
    },
  };
}

function missing(found: Resolution): Prepared {
  return { ok: false, reason: "missing", detail: found.why };
}

async function alternativesFor(languageId: string, ctx: ToolContext, request: FormatRequest, exclude: FormatterId | null): Promise<FormatChoice[]> {
  const withConfig = (id: FormatterId) => (id === "tsserver" ? false : hasRepoConfig(id, ctx.file));
  const ordered = [...FORMATTER_ORDER.filter(withConfig), ...FORMATTER_ORDER.filter((id) => !withConfig(id))];
  const out: FormatChoice[] = [];
  for (const id of ordered) {
    if (id === exclude) continue;
    if (id === "eslint" && !withConfig(id)) continue;
    const prepared = await prepareFormatter(id, languageId, ctx, request, true);
    if (prepared.ok) out.push({ formatter: id, label: FORMATTERS[id].label });
  }
  return out;
}

export function formatLanguages(settings: FormatSettings, chosen: Record<string, FormatterId>): FormatLanguage[] {
  return ALL_LANGUAGES.map((id) => {
    const configured = configuredFormatter(settings, id);
    const known = configured ? (EXTENSION_FORMATTER[configured.id] ?? null) : null;
    return {
      id,
      name: LANGUAGE_NAME[id],
      chosen: chosen[id] ?? null,
      vscode: { raw: configured?.id ?? null, formatter: known, scope: configured?.scope ?? null, label: known ? FORMATTERS[known].label : null, supported: known ? FORMATTERS[known].languages.includes(id) : false },
      options: FORMATTER_ORDER.filter((formatter) => FORMATTERS[formatter].languages.includes(id)).map((formatter) => ({ formatter, label: FORMATTERS[formatter].label })),
    };
  });
}

function execTool(tool: ToolLocation, args: string[], cwd: string, input: string) {
  const [command, argv, env] = tool.loader === "node" ? [process.execPath, [tool.path, ...tool.args, ...args], { ...process.env, ELECTRON_RUN_AS_NODE: "1" }] : [tool.path, [...tool.args, ...args], process.env];
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = execFile(command, argv, { cwd, env, maxBuffer: 64 * 1024 * 1024, timeout: 30_000 }, (error, stdout, stderr) => {
      if (error && typeof (error as NodeJS.ErrnoException).code !== "number") {
        reject(error);
        return;
      }
      resolve({ code: error ? Number((error as NodeJS.ErrnoException).code) : 0, stdout, stderr });
    });
    child.stdin?.end(input);
  });
}

function firstLine(text: string) {
  return text.split("\n").find((line) => line.trim())?.trim().slice(0, 200) ?? "unknown error";
}
