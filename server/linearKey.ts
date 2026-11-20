import { spawn } from "node:child_process";

// LINEAR: Linear 개인 API 키의 저장소. 운영은 맥 키체인(generic password, service lodestar-linear, account api-key)만 쓴다.
// 키는 프로세스 인자에 올리지 않는다. 저장은 `security -i`(명령을 stdin 에서 읽는 모드)로 명령 줄째 stdin 에 넘기고, 읽기는 -w 출력만 받는다.
// 시험 전용 환경 변수(AGENT_NAV_LINEAR_KEY, AGENT_NAV_LINEAR_KEYCHAIN_SERVICE)는 AGENT_NAV_LINEAR_API 가 함께 있을 때(= 가짜 서버를 가리킬 때)만 듣는다.
// 그래서 환경 변수의 키는 실제 api.linear.app 으로는 절대 나가지 않는다.

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

// Linear 키(lin_api_...)가 쓰는 글자만. 따옴표, 공백, 줄바꿈이 있으면 명령 줄을 깨뜨릴 수 있어 저장 전에 거절한다.
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

// 시험용 저장소: 환경 변수의 키로 시작하는 메모리 저장소. 쓰기와 지우기는 메모리에서만 일어나 키체인을 건드리지 않는다.
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
