import { isAbsolute } from "node:path";
import type { ServerEvent } from "../shared/protocol";
import { folderOf } from "../shared/sessionFolders";
import { createWorkspaceEntry, listEmptyDirs, listFiles, listIgnoredFiles, openInVSCode, readWorkspaceBinary, readWorkspaceFileWithStat, renameWorkspaceEntry, resolveInside, saveWorkspaceFile, statWorkspaceFile, trashWorkspaceEntry } from "./files";
import { formatLanguages, formatOnSaveOf, installFormatterExtension, readFormatSettings, runFormat } from "./format";
import { headTextOf } from "./headText";
import { revealInFileManager } from "./reveal";
import { searchWorkspace } from "./search";
import { searchSettings } from "./searchSettings";
import { replaceInWorkspace } from "./searchReplace";
import type { Store } from "./store";
import type { HandlersFor, MethodsIn } from "./rpcHandlers";

export type FileHandlerDeps = { store: Store; broadcast: (event: ServerEvent) => void; folderCodeAllowed: (dir: string) => boolean };

export function fileHandlers(deps: FileHandlerDeps): HandlersFor<Exclude<MethodsIn<"files">, "files.write"> | MethodsIn<"search"> | MethodsIn<"format">> {
  const { store, broadcast, folderCodeAllowed } = deps;
  return {
    "files.list": ({ workspaceId }) => listFiles(store.workspace(workspaceId).dir),
    "files.ignored": ({ workspaceId }) => listIgnoredFiles(store.workspace(workspaceId).dir),
    "files.search": ({ workspaceId, query, matchCase, wholeWord, regex, context, include, exclude, ignore, ranges }) =>
      searchWorkspace(store.workspace(workspaceId).dir, { query: String(query ?? ""), matchCase: !!matchCase, wholeWord: !!wholeWord, regex: !!regex, context: Number(context), include: typeof include === "string" ? include : "", exclude: typeof exclude === "string" ? exclude : "", ignore: ignore !== false, ranges: ranges === true, excludeGlobs: searchSettings().exclude }),
    "search.settings": () => searchSettings(),
    "search.replace": async ({ workspaceId, files }) => {
      const workspace = store.workspace(workspaceId);
      const response = await replaceInWorkspace(workspace.dir, files);
      if (response.results.some((result) => result.status === "applied" && result.applied > 0)) broadcast({ type: "workspaceChanged", workspaceIds: [workspace.id] });
      return response;
    },
    "files.read": ({ workspaceId, path }) => readWorkspaceFileWithStat(store.workspace(workspaceId).dir, path),
    "files.readBinary": ({ workspaceId, path }) => readWorkspaceBinary(store.workspace(workspaceId).dir, path),
    "files.readOfAgent": async ({ agentId, path }) => {
      const agent = store.agent(agentId);
      const root = isAbsolute(String(path)) ? (folderOf(store.agentRoots(agent), String(path)) ?? agent.cwd) : agent.cwd;
      return { text: (await readWorkspaceFileWithStat(root, path)).text };
    },
    "files.stat": ({ workspaceId, path }) => statWorkspaceFile(store.workspace(workspaceId).dir, path),
    "files.headText": ({ workspaceId, path }) => headTextOf(store.workspace(workspaceId).dir, String(path)),
    "files.save": ({ workspaceId, path, text, baseMtimeMs, force }) => saveWorkspaceFile(store.workspace(workspaceId).dir, path, String(text), baseMtimeMs ?? null, force === true),
    "files.create": ({ workspaceId, path, kind, text }) => createWorkspaceEntry(store.workspace(workspaceId).dir, String(path), kind === "folder" ? "folder" : "file", typeof text === "string" ? text : ""),
    "files.dirs": ({ workspaceId }) => listEmptyDirs(store.workspace(workspaceId).dir),
    "files.rename": async ({ workspaceId, from, to }) => {
      await renameWorkspaceEntry(store.workspace(workspaceId).dir, String(from), String(to));
      return null;
    },
    "files.trash": ({ workspaceId, path }) => trashWorkspaceEntry(store.workspace(workspaceId).dir, String(path)),
    "files.reveal": async ({ workspaceId, path }) => {
      await revealInFileManager(resolveInside(store.workspace(workspaceId).dir, String(path)));
      return null;
    },
    "format.run": ({ workspaceId, path, text, range, formatter }) => {
      const dir = store.workspace(workspaceId).dir;
      const absolute = resolveInside(dir, path);
      const own = folderCodeAllowed(dir) && folderCodeAllowed(absolute);
      return runFormat({ dir, absolute, text: String(text), range, formatter, settings: readFormatSettings(own ? dir : null), chosen: store.settings.formatters ?? {}, bundledOnly: !own });
    },
    "format.config": ({ workspaceId } = {}) => {
      const dir = workspaceId ? store.workspace(workspaceId).dir : null;
      const settings = readFormatSettings(dir && folderCodeAllowed(dir) ? dir : null);
      const languages = formatLanguages(settings, store.settings.formatters ?? {});
      const chosen = store.settings.formatOnSave;
      if (typeof chosen === "boolean") return { formatOnSave: chosen, source: "agent-nav" as const, languages };
      const fromVscode = formatOnSaveOf(settings);
      return fromVscode === null ? { formatOnSave: false, source: "builtin" as const, languages } : { formatOnSave: fromVscode, source: "vscode" as const, languages };
    },
    "format.installExtension": async ({ extensionId }) => {
      await installFormatterExtension(String(extensionId));
      return null;
    },
    "files.openInVSCode": async ({ workspaceId, path, line, column }) => {
      await openInVSCode(store.workspace(workspaceId).dir, path, line, column);
      return null;
    },
  };
}
