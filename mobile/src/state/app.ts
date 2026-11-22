import { useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { RpcClient } from "../net/rpc";
import { pairWithHost, type PairOutcome } from "../net/pair";
import type { PairingInfo } from "../logic/pairing";
import { clearConnection, asyncCache, loadConnection, saveConnection, type Connection } from "./storage";
import type { SessionSort } from "@shared/protocol";
import { DEFAULT_SESSION_SORT } from "../logic/workspaces";
import { SortPrefsStore, type SortPrefs } from "./sortPrefs";
import { AppStore, type State } from "./store";
import { markEnd, markStart, record } from "./perf";

markStart("launch-list");

export const client = new RpcClient({
  log: (line) => console.log(line),
  onCall: (method, ms, ok) => method !== "mobile.ping" && record(`rpc ${method}`, ms, ok ? undefined : "failed"),
});
export const store = new AppStore(asyncCache);
store.attach(client);
export const sortPrefs = new SortPrefsStore(asyncCache);

let connection: Connection | null = null;
let bootstrapped = false;
const connectionListeners = new Set<() => void>();
const setConnection = (next: Connection | null) => {
  connection = next;
  for (const listener of connectionListeners) listener();
};

let booting: Promise<void> | null = null;
export function bootstrap(): Promise<void> {
  booting ??= (async () => {
    const [saved, cached] = await Promise.all([loadConnection(), store.loadCache(), sortPrefs.load()]);
    markEnd("launch-list", cached ? "cache" : "no cache");
    if (saved) {
      setConnection(saved);
      markStart("launch-sync");
      client.configure({ hosts: saved.hosts, port: saved.port, token: saved.token });
    }
    bootstrapped = true;
    for (const listener of connectionListeners) listener();
  })();
  return booting;
}

let offlineSince: number | null = null;
let foregroundAt: number | null = null;
client.onStatus((status) => {
  console.log(`[conn] ${status}${client.host ? ` via ${client.host}` : ""}`);
  if (status === "offline" && offlineSince === null) offlineSince = Date.now();
  if (status === "online") {
    markEnd("launch-sync", "connected");
    if (offlineSince !== null) record("reconnect", Date.now() - offlineSince, foregroundAt ? "after foreground" : "after drop");
    offlineSince = null;
    foregroundAt = null;
  }
});

AppState.addEventListener("change", (next) => {
  if (next !== "active") return;
  foregroundAt = Date.now();
  if (client.status === "online") {
    const started = Date.now();
    void client.call("mobile.ping", {}, 1500).then(() => record("foreground-check", Date.now() - started, "socket alive")).catch(() => {});
  }
  client.resume();
});

export async function pairAndConnect(info: PairingInfo, deviceName: string): Promise<PairOutcome> {
  const outcome = await pairWithHost(info, deviceName);
  if (!outcome.ok) return outcome;
  await store.reset();
  const saved: Connection = {
    hosts: [outcome.host, ...info.hosts.filter((h) => h !== outcome.host)],
    port: info.port,
    token: outcome.result.deviceToken,
    deviceId: outcome.result.deviceId,
    hostName: outcome.result.host,
    pairedAt: new Date().toISOString(),
  };
  await saveConnection(saved);
  setConnection(saved);
  store.attach(client);
  markStart("launch-sync");
  client.configure({ hosts: saved.hosts, port: saved.port, token: saved.token });
  return outcome;
}

export async function unpair() {
  client.configure(null);
  await store.reset();
  await clearConnection();
  setConnection(null);
  store.attach(client);
}

export async function updateHosts(hosts: string[], port: number) {
  if (!connection) return;
  const next = { ...connection, hosts, port };
  await saveConnection(next);
  setConnection(next);
  client.configure({ hosts, port, token: next.token });
}

export function useAppState<T>(selector: (state: State) => T): T {
  return useSyncExternalStore(store.subscribe, () => selector(store.getState()));
}

export function useSortPrefs(): SortPrefs {
  return useSyncExternalStore(sortPrefs.subscribe, sortPrefs.getState);
}

export function useSessionSort(workspaceId: string): SessionSort {
  return useSyncExternalStore(sortPrefs.subscribe, () => sortPrefs.getState().sessions[workspaceId] ?? DEFAULT_SESSION_SORT);
}

export function useConnection(): { connection: Connection | null; bootstrapped: boolean } {
  const subscribe = (listener: () => void) => {
    connectionListeners.add(listener);
    return () => connectionListeners.delete(listener);
  };
  const saved = useSyncExternalStore(subscribe, () => connection);
  const done = useSyncExternalStore(subscribe, () => bootstrapped);
  return { connection: saved, bootstrapped: done };
}
