import { spawn } from "node:child_process";

export const KEYCHAIN_SERVICE = "lodestar-linear";
export const KEYCHAIN_ACCOUNT = "api-key";

export type KeyStore = {
  read(): Promise<string | null>;
  write(key: string): Promise<void>;
  clear(): Promise<void>;
};

export type SecurityResult = { code: number; stdout: string; stderr: string };
export type SecurityRunner = (args: string[], stdin?: string) => Promise<SecurityResult>;

export class KeychainError extends Error {}

export function validKeyShape(key: string): boolean {
  return /^[A-Za-z0-9_-]{16,256}$/.test(key);
}

export function systemSecurity(timeoutMs = 10_000): SecurityRunner {
  return (args, stdin) =>
    new Promise((resolve, reject) => {
      const child = spawn("/usr/bin/security", args, { stdio: ["pipe", "pipe", "pipe"] });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
      child.stdout.on("data", (c: Buffer) => out.push(c));
      child.stderr.on("data", (c: Buffer) => err.push(c));
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(new KeychainError(`Could not run the security tool: ${error.message}`));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? -1, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") });
      });
      child.stdin.on("error", () => undefined);
      child.stdin.end(stdin ?? "");
    });
}

function quoted(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function keychainStore(run: SecurityRunner, service = KEYCHAIN_SERVICE): KeyStore {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(service)) throw new KeychainError("Invalid keychain service name.");
  const read = async () => {
    const result = await run(["find-generic-password", "-s", service, "-a", KEYCHAIN_ACCOUNT, "-w"]);
    // 44: 항목 없음(errSecItemNotFound)
    if (result.code === 44) return null;
    if (result.code !== 0) throw new KeychainError(`Could not read the Linear key from the keychain (security exited ${result.code}).`);
    const key = result.stdout.trim();
    return key || null;
  };
  return {
    read,
    async write(key) {
      if (!validKeyShape(key)) throw new KeychainError("That does not look like a Linear API key.");
      const line = `add-generic-password -U -s ${quoted(service)} -a ${quoted(KEYCHAIN_ACCOUNT)} -w ${quoted(key)}\n`;
      const result = await run(["-i"], line);
      // security -i 는 명령이 실패해도 종료 코드가 0 일 수 있어 다시 읽어 맞는지 확인한다.
      if ((await read()) !== key) throw new KeychainError(`Could not save the Linear key to the keychain${result.code === 0 ? "" : ` (security exited ${result.code})`}.`);
    },
    async clear() {
      const result = await run(["delete-generic-password", "-s", service, "-a", KEYCHAIN_ACCOUNT]);
      if (result.code !== 0 && result.code !== 44) throw new KeychainError(`Could not remove the Linear key from the keychain (security exited ${result.code}).`);
    },
  };
}

export function memoryStore(initial: string | null): KeyStore {
  let current = initial;
  return {
    read: async () => current,
    write: async (key) => {
      current = key;
    },
    clear: async () => {
      current = null;
    },
  };
}

export function apiBaseOf(env: NodeJS.ProcessEnv): { base: string; fake: boolean } {
  const custom = env.AGENT_NAV_LINEAR_API?.trim();
  return custom ? { base: custom.replace(/\/+$/, ""), fake: true } : { base: "https://api.linear.app", fake: false };
}

export function keyStoreFor(env: NodeJS.ProcessEnv = process.env, run: SecurityRunner = systemSecurity()): KeyStore {
  const { fake } = apiBaseOf(env);
  if (fake && env.AGENT_NAV_LINEAR_KEY) return memoryStore(env.AGENT_NAV_LINEAR_KEY);
  return keychainStore(run, fake ? env.AGENT_NAV_LINEAR_KEYCHAIN_SERVICE || KEYCHAIN_SERVICE : KEYCHAIN_SERVICE);
}
