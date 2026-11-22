import { basename } from "node:path";
import type { ChildDef } from "./lspMux";
import { findRelayDirs, isRelayReady, planRelay, startRelay } from "./lspRelay";
import { startTypescript } from "./lspTypescript";

export type LanguageServerSpec = {
  id: string;
  label: string;
  languages: readonly string[];
  activate(workspaceDir: string): Promise<ChildDef[]> | ChildDef[];
};

const TYPESCRIPT_LANGUAGES = ["typescript", "typescriptreact", "javascript", "javascriptreact"] as const;
const RELAY_LANGUAGES = [...TYPESCRIPT_LANGUAGES, "graphql"] as const;

const RELAY_STATIC_CAPABILITIES = {
  hoverProvider: true,
  definitionProvider: true,
  referencesProvider: true,
  completionProvider: { resolveProvider: true },
  codeActionProvider: { codeActionKinds: ["quickfix"] },
  renameProvider: { prepareProvider: true },
  inlayHintProvider: true,
};

const typescript: LanguageServerSpec = {
  id: "typescript",
  label: "TypeScript",
  languages: TYPESCRIPT_LANGUAGES,
  activate: (workspaceDir) => [
    {
      key: "typescript",
      serverId: "typescript",
      label: "TypeScript",
      primary: true,
      eager: true,
      languages: TYPESCRIPT_LANGUAGES,
      dir: null,
      rootDir: workspaceDir,
      start: (callbacks) => startTypescript(workspaceDir, callbacks),
    },
  ],
};

const relay: LanguageServerSpec = {
  id: "relay",
  label: "Relay",
  languages: RELAY_LANGUAGES,
  activate: async (workspaceDir) => {
    const dirs = await findRelayDirs(workspaceDir);
    return dirs.map((dir) => ({
      key: `relay:${dir}`,
      serverId: "relay",
      label: dirs.length > 1 ? `Relay (${basename(dir)})` : "Relay",
      languages: RELAY_LANGUAGES,
      dir,
      rootDir: dir,
      staticCapabilities: RELAY_STATIC_CAPABILITIES,
      isReadySignal: isRelayReady,
      start: (callbacks) => {
        const command = planRelay(dir, workspaceDir);
        if ("problem" in command) {
          queueMicrotask(() => callbacks.exit(command.problem));
          return { send: () => {}, stop: () => {} };
        }
        return startRelay(command, callbacks);
      },
    }));
  },
};

export const LANGUAGE_SERVERS: readonly LanguageServerSpec[] = [typescript, relay];

const bundledTypescript: LanguageServerSpec = {
  ...typescript,
  activate: (workspaceDir) => [{ ...(typescript.activate(workspaceDir) as ChildDef[])[0]!, start: (callbacks) => startTypescript(workspaceDir, callbacks, { bundledOnly: true }) }],
};
export const BUNDLED_LANGUAGE_SERVERS: readonly LanguageServerSpec[] = [bundledTypescript];

export function languageServersFor(allowed: (dir: string) => boolean): readonly LanguageServerSpec[] {
  const scoped: LanguageServerSpec = {
    ...relay,
    activate: async (workspaceDir) => (await relay.activate(workspaceDir)).filter((child) => !child.dir || !child.dir.startsWith(`${workspaceDir}/`) || allowed(child.dir)),
  };
  return [typescript, scoped];
}

export async function planChildren(workspaceDir: string, servers: readonly LanguageServerSpec[] = LANGUAGE_SERVERS): Promise<ChildDef[]> {
  const planned = await Promise.all(
    servers.map(async (server) => {
      try {
        return await server.activate(workspaceDir);
      } catch (error) {
        console.error(`[lsp] ${server.id} activation failed: ${(error as Error).message}`);
        return [];
      }
    }),
  );
  return planned.flat();
}
