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
// Relay 는 JS 계열 파일 안의 graphql 태그와 .graphql 파일을 맡는다(meta.relay 확장의 documentSelector 와 같다).
const RELAY_LANGUAGES = [...TYPESCRIPT_LANGUAGES, "graphql"] as const;

// Relay LSP 가 initialize 에서 알리는 기능(relay-compiler 20.1.1 에서 확인). 서버가 뜨기 전에도 라우팅이 어떤 요청을 보낼지 정하는 데 쓴다.
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

// relay config 가 있는 폴더마다 서버 하나. 그 폴더 아래 문서를 처음 열 때 띄운다.
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
          // 시작할 수 없는 이유를 상태 줄에 보이려고, 프로세스 없이 곧바로 끝난 서버로 알린다.
          queueMicrotask(() => callbacks.exit(command.problem));
          return { send: () => {}, stop: () => {} };
        }
        return startRelay(command, callbacks);
      },
    }));
  },
};

export const LANGUAGE_SERVERS: readonly LanguageServerSpec[] = [typescript, relay];

// 사용자가 추가하지 않은 폴더(server/folderTrust.ts)에서 쓰는 목록: 앱에 들어 있는 TypeScript 서버만. Relay 는 그 폴더의 실행 파일이라 띄우지 않는다.
const bundledTypescript: LanguageServerSpec = {
  ...typescript,
  activate: (workspaceDir) => [{ ...(typescript.activate(workspaceDir) as ChildDef[])[0]!, start: (callbacks) => startTypescript(workspaceDir, callbacks, { bundledOnly: true }) }],
};
export const BUNDLED_LANGUAGE_SERVERS: readonly LanguageServerSpec[] = [bundledTypescript];

// 사용자가 추가한 워크스페이스의 목록. 워크스페이스 아래에서 찾은 Relay 폴더가 그 안의 받은 클론이나 리뷰 체크아웃이면(allowed 가 false) 띄우지 않는다.
// 워크스페이스 위쪽에서 찾은 config 폴더(모노레포 루트)는 그 워크스페이스가 든 저장소라 그대로 쓴다.
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
