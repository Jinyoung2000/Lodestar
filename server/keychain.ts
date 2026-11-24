import { execFile, spawn } from "node:child_process";

const SERVICE = "Lodestar Custom Provider";
const TIMEOUT_MS = 15_000;
const NOT_FOUND = 44;

export const securityBin = () => process.env.AGENT_NAV_SECURITY ?? "/usr/bin/security";

const quote = (value: string) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

export function isStorableKey(key: string) {
  return key.length > 0 && key.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(key);
}

export function readProviderKey(providerId: string): Promise<string | null> {
  return new Promise((resolve, reject) => {
    execFile(securityBin(), ["find-generic-password", "-s", SERVICE, "-a", providerId, "-w"], { timeout: TIMEOUT_MS }, (error, stdout) => {
      if (!error) return resolve(String(stdout).replace(/\n$/, "") || null);
      if ((error as unknown as { code?: unknown }).code === NOT_FOUND) return resolve(null);
      reject(new Error("Could not read the key from the Keychain"));
    });
  });
}

export function saveProviderKey(providerId: string, label: string, key: string): Promise<void> {
  if (!isStorableKey(key)) return Promise.reject(new Error("The key has characters the Keychain cannot store"));
  return new Promise((resolve, reject) => {
    const child = spawn(securityBin(), ["-i"], { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (text: string) => (stderr += text));
    child.once("error", () => {
      clearTimeout(timer);
      reject(new Error("Could not open the Keychain"));
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0 && !stderr.trim()) resolve();
      else reject(new Error("Could not save the key to the Keychain"));
    });
    child.stdin.end(`add-generic-password -U -s ${quote(SERVICE)} -a ${quote(providerId)} -l ${quote(`${SERVICE}: ${label}`)} -w ${quote(key)}\n`);
  });
}

export function deleteProviderKey(providerId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(securityBin(), ["delete-generic-password", "-s", SERVICE, "-a", providerId], { timeout: TIMEOUT_MS }, (error) => {
      if (!error || (error as { code?: unknown }).code === NOT_FOUND) return resolve();
      reject(new Error("Could not remove the key from the Keychain"));
    });
  });
}
